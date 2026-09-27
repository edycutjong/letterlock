// Turns the network off inside this Node.js process: every way a script or a library reaches another host throws
// NetworkBlocked and is counted. scripts/verify_offline.ts installs it before any Letterlock code runs, proves each
// path is closed (fetch, sockets, TLS, HTTP, DNS, UDP, and the SDK's own RPC client), then seals and opens with the
// count checked afterwards.
//
// Patched: globalThis.fetch (viem's HTTP transport, undici), WebSocket and EventSource; node:net connect,
// createConnection and Socket.prototype.connect; node:tls connect; node:http and node:https request and get; node:http2
// connect; node:dns lookup, lookupService and every resolve*, callback and promise forms; node:dgram createSocket.
// syncBuiltinESMExports() carries the patches to modules that imported these functions by name.
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

export class NetworkBlocked extends Error {
  readonly code = "ERR_NETWORK_BLOCKED";
  constructor(what: string) {
    super(`network blocked (scripts/lib/no-network.ts): ${what}`);
    this.name = "NetworkBlocked";
  }
}

/** True when `e` or any error in its cause chain is a NetworkBlocked. */
export const blockedInChain = (e: unknown): boolean => {
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 32; depth++) {
    if (x instanceof NetworkBlocked) return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
};

export type NetworkBlock = {
  /** Every attempt made since the block was installed, in order: "fetch https://…", "net.connect …". */
  readonly attempts: readonly string[];
};

let installed: NetworkBlock | undefined;

const describe = (args: readonly unknown[]): string => {
  const [a, b] = args;
  if (typeof a === "string" || a instanceof URL) return String(a);
  if (typeof a === "number") return `${typeof b === "string" ? b : "localhost"}:${a}`;
  if (a && typeof a === "object") {
    const o = a as { href?: unknown; host?: unknown; hostname?: unknown; port?: unknown; path?: unknown };
    if (typeof o.href === "string") return o.href;
    return `${String(o.hostname ?? o.host ?? o.path ?? "?")}${o.port !== undefined ? `:${String(o.port)}` : ""}`;
  }
  return String(a);
};

/** Installs the block once per process and returns its attempt log. */
export const blockNetwork = (): NetworkBlock => {
  if (installed) return installed;
  const attempts: string[] = [];
  const deny = (what: string): never => {
    attempts.push(what);
    throw new NetworkBlocked(what);
  };
  const thrower = (name: string) => (...args: unknown[]): never => deny(`${name} ${describe(args)}`);
  const patch = (target: object, names: readonly string[], prefix: string) => {
    for (const name of names) {
      if (typeof (target as Record<string, unknown>)[name] === "function")
        Object.defineProperty(target, name, { value: thrower(`${prefix}.${name}`), writable: true, configurable: true });
    }
  };

  const blockedFetch = (input: string | URL | Request): Promise<Response> => {
    try {
      return deny(`fetch ${input instanceof Request ? input.url : String(input)}`);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  Object.defineProperty(globalThis, "fetch", { value: blockedFetch, writable: true, configurable: true });
  for (const name of ["WebSocket", "EventSource"] as const) {
    if (name in globalThis)
      Object.defineProperty(globalThis, name, {
        value: class { constructor(url: unknown) { deny(`${name} ${String(url)}`); } },
        writable: true,
        configurable: true,
      });
  }

  patch(net, ["connect", "createConnection"], "net");
  Object.defineProperty(net.Socket.prototype, "connect", { value: thrower("net.Socket.connect"), writable: true, configurable: true });
  patch(tls, ["connect"], "tls");
  patch(http, ["request", "get"], "http");
  patch(https, ["request", "get"], "https");
  patch(http2, ["connect"], "http2");
  const resolvers = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx",
    "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"] as const;
  patch(dns, resolvers, "dns");
  patch(dns.promises, resolvers, "dns.promises");
  patch(dns.Resolver.prototype, resolvers, "dns.Resolver");
  patch(dns.promises.Resolver.prototype, resolvers, "dns.promises.Resolver");
  patch(dgram, ["createSocket"], "dgram");
  syncBuiltinESMExports();

  installed = { attempts };
  return installed;
};
