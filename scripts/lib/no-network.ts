// The in-process half of the offline proof (scripts/verify_offline.ts): it refuses, and counts, every attempt this
// Node.js process makes to reach another host through Node's JavaScript APIs, so a seal or an open that tries the
// network throws NetworkBlocked and shows up in the count.
//
// What it cannot see is anything that skips those APIs: a native addon's own system calls, or a process that is
// already running. So it is not the part that makes "no network" true: verify_offline runs under an OS-level network
// block as well (scripts/lib/os-sandbox.ts: sandbox-exec on macOS, a network namespace on Linux), which refuses the
// process every socket whatever code asks for it. This guard's job is to make an attempt visible and countable.
//
// Refused and counted, from the moment blockNetwork() runs:
//   globals               fetch, WebSocket, EventSource
//   node:net              connect, createConnection, Socket.prototype.connect (TLS sockets and the http and https
//                         agents connect through it, so an http.ClientRequest built directly is refused there)
//   node:tls              connect
//   node:http, node:https request, get
//   node:http2            connect
//   node:dns              lookup, lookupService, every resolve*, reverse: callback, promise and Resolver forms
//   node:dgram            createSocket, the Socket constructor, and Socket.prototype bind, connect, send and sendto
//   node:worker_threads   Worker: a worker starts with its own fetch and sockets, none of them patched
//   node:child_process    spawn, spawnSync, exec, execSync, execFile, execFileSync, fork, ChildProcess.prototype.spawn:
//                         a child process has its own network
//   process.binding       tcp_wrap, udp_wrap, cares_wrap, tls_wrap, pipe_wrap, process_wrap, spawn_sync: the raw
//                         handles under all of the above
//   process.dlopen        loading a native addon, which could make its own system calls
// syncBuiltinESMExports() carries the patches to ES modules that imported these functions by name, before or after.
// scripts/lib/network-probes.ts tries each of these ways out; scripts/test/no-network.test.ts shows that each one
// reaches a local listener without the block and is refused and counted with it.
import child_process from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import worker_threads from "node:worker_threads";

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

/** The process.binding() names that hand out raw sockets, resolvers or process spawners. */
export const RAW_BINDINGS: readonly string[] = ["tcp_wrap", "udp_wrap", "cares_wrap", "tls_wrap", "pipe_wrap", "process_wrap", "spawn_sync"];

let installed: NetworkBlock | undefined;

const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
const describe = (args: readonly unknown[]): string => {
  const [a, b] = args;
  if (typeof a === "string" || a instanceof URL) return short(String(a));
  if (typeof a === "number") return `${typeof b === "string" ? b : "localhost"}:${a}`;
  if (a && typeof a === "object") {
    const o = a as { href?: unknown; host?: unknown; hostname?: unknown; port?: unknown; path?: unknown; file?: unknown; type?: unknown };
    if (typeof o.href === "string") return short(o.href);
    if (typeof o.file === "string") return short(o.file); // ChildProcess.prototype.spawn({ file, args })
    const where = o.hostname ?? o.host ?? o.path ?? o.type;
    return `${String(where ?? "?")}${o.port !== undefined ? `:${String(o.port)}` : ""}`;
  }
  return a === undefined ? "" : short(String(a));
};

/** Installs the block once per process and returns its attempt log. */
export const blockNetwork = (): NetworkBlock => {
  if (installed) return installed;
  const attempts: string[] = [];
  const deny = (what: string): never => {
    attempts.push(what);
    throw new NetworkBlocked(what);
  };
  const thrower = (name: string) => (...args: unknown[]): never => deny(`${name} ${describe(args)}`.trimEnd());
  const define = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, { value, writable: true, configurable: true });
  const patch = (target: object, names: readonly string[], prefix: string) => {
    for (const name of names) {
      if (typeof (target as Record<string, unknown>)[name] === "function") define(target, name, thrower(`${prefix}.${name}`));
    }
  };
  /** A class whose constructor refuses: `new X(...)` throws before anything is created. */
  const refusingClass = (name: string) => class { constructor(...args: unknown[]) { thrower(name)(...args); } };

  const blockedFetch = (input: string | URL | Request): Promise<Response> => {
    try {
      return deny(`fetch ${input instanceof Request ? input.url : String(input)}`);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  define(globalThis, "fetch", blockedFetch);
  for (const name of ["WebSocket", "EventSource"] as const) {
    if (name in globalThis) define(globalThis, name, refusingClass(name));
  }

  patch(net, ["connect", "createConnection"], "net");
  define(net.Socket.prototype, "connect", thrower("net.Socket.connect"));
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
  // the constructor creates the raw UDP handle; the prototype is patched too, for a socket made some other way
  patch(dgram.Socket.prototype, ["bind", "connect", "send", "sendto"], "dgram.Socket");
  define(dgram, "Socket", refusingClass("dgram.Socket"));
  define(worker_threads, "Worker", refusingClass("worker_threads.Worker"));
  patch(child_process, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "child_process");
  patch(child_process.ChildProcess.prototype, ["spawn"], "child_process.ChildProcess.prototype");
  const binding = (process as unknown as { binding(name: string): unknown }).binding.bind(process); // deprecated, so untyped
  define(process, "binding", (name: string) => (RAW_BINDINGS.includes(name) ? deny(`process.binding ${name}`) : binding(name)));
  define(process, "dlopen", thrower("process.dlopen"));
  syncBuiltinESMExports();

  installed = { attempts };
  return installed;
};
