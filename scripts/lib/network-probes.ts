// Every way out of a Node.js process that scripts/lib/no-network.ts closes, each as one attempt against a target.
// scripts/verify_offline.ts runs them all after blockNetwork() and requires each to be refused by the block, and
// counted. scripts/test/no-network.test.ts runs them against listeners on 127.0.0.1, once without the block, where each
// must reach its listener (or, for the few that have nothing to reach, complete), and once with it, where each must be
// refused and counted while the listeners hear nothing. So no probe passes because of something else: the target is an
// IP address, so none of them depends on DNS failing, and each is a live way out when the block is off.
import child_process from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import type { EventEmitter } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import worker_threads from "node:worker_threads";

export type ProbeTarget = {
  /** An IP address, never a name: a probe must not be stopped by a DNS failure instead of the block. */
  readonly host: string;
  readonly tcpPort: number;
  readonly udpPort: number;
  /** The name the resolver probes ask for. */
  readonly name: string;
};

/** What verify_offline aims every probe at: Cloudflare's resolver by address, and the RPC name the SDK uses. */
export const OFFLINE_TARGET: ProbeTarget = { host: "1.1.1.1", tcpPort: 443, udpPort: 53, name: "rpc.monad.xyz" };

/**
 * What a probe reaches when nothing stops it: a TCP connection or a UDP datagram to the target, or (for a resolver
 * lookup, a binding handed out without being used, or an addon) only a completed call.
 */
export type Reach = "tcp" | "udp" | "call";

export type Probe = { readonly name: string; readonly reaches: Reach; readonly attempt: (t: ProbeTarget) => Promise<unknown> };

/** Settles when the emitter reports success or failure; later errors are swallowed (the probe has its answer). */
const settle = (emitter: EventEmitter, ok: readonly string[], fail: readonly string[] = ["error"]): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    for (const e of ok) emitter.once(e, () => resolve());
    for (const e of fail) emitter.once(e, (err: unknown) => reject(err));
  }).finally(() => { emitter.on("error", () => {}); });

const closing = <T extends { destroy(): void }>(s: T) => (p: Promise<void>) => p.finally(() => s.destroy());

/** JavaScript a worker or a child process runs, as a script or a module: one TCP connection to the target, then exit. */
const connectCode = (t: ProbeTarget) =>
  `const s=process.getBuiltinModule('node:net').connect(${t.tcpPort},'${t.host}');s.on('connect',()=>s.destroy());s.on('error',()=>{});`;
const node = process.execPath;
const quoted = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

type Raw = { binding(name: string): Record<string, new (...a: never[]) => Record<string, (...a: unknown[]) => unknown>> };
const raw = (name: string) => (process as unknown as Raw).binding(name);

const tcp = (name: string, attempt: (t: ProbeTarget) => Promise<unknown>): Probe => ({ name, reaches: "tcp", attempt });
const udp = (name: string, attempt: (t: ProbeTarget) => Promise<unknown>): Probe => ({ name, reaches: "udp", attempt });
const call = (name: string, attempt: (t: ProbeTarget) => Promise<unknown>): Probe => ({ name, reaches: "call", attempt });
const url = (scheme: string, t: ProbeTarget) => `${scheme}://${t.host}:${t.tcpPort}/`;

export const PROBES: readonly Probe[] = [
  // globals
  tcp("fetch", async (t) => fetch(url("http", t), { method: "POST" })),
  tcp("WebSocket", async (t) => {
    const ws = new WebSocket(url("ws", t));
    await new Promise<void>((resolve) => { ws.onopen = ws.onerror = ws.onclose = () => resolve(); });
    ws.close();
  }),
  // node:net, node:tls
  tcp("net.connect", async (t) => { const s = net.connect(t.tcpPort, t.host); await closing(s)(settle(s, ["connect"])); }),
  tcp("net.createConnection", async (t) => { const s = net.createConnection(t.tcpPort, t.host); await closing(s)(settle(s, ["connect"])); }),
  tcp("new net.Socket().connect", async (t) => { const s = new net.Socket().connect(t.tcpPort, t.host); await closing(s)(settle(s, ["connect"])); }),
  tcp("tls.connect", async (t) => {
    const s = tls.connect({ host: t.host, port: t.tcpPort, rejectUnauthorized: false });
    await closing(s)(settle(s, ["secureConnect"]));
  }),
  // node:http, node:https, node:http2
  tcp("http.get", async (t) => { const r = http.get(url("http", t)); await closing(r)(settle(r, ["response"])); }),
  tcp("http.request", async (t) => { const r = http.request(url("http", t)); r.end(); await closing(r)(settle(r, ["response"])); }),
  tcp("new http.ClientRequest", async (t) => { const r = new http.ClientRequest(url("http", t)); r.end(); await closing(r)(settle(r, ["response"])); }),
  tcp("https.get", async (t) => { const r = https.get(url("https", t), { rejectUnauthorized: false }); await closing(r)(settle(r, ["response"])); }),
  tcp("https.request", async (t) => {
    const r = https.request(url("https", t), { rejectUnauthorized: false });
    r.end();
    await closing(r)(settle(r, ["response"]));
  }),
  tcp("http2.connect", async (t) => { const s = http2.connect(url("http", t)); await closing(s)(settle(s, ["connect"])); }),
  // node:dgram: the second one passes its own lookup, so dns.lookup's patch cannot be what refuses it
  udp("dgram.createSocket", async (t) => {
    const s = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => { s.once("error", reject); s.send(Buffer.from([0]), t.udpPort, t.host, (e) => (e ? reject(e) : resolve())); })
      .finally(() => s.close());
  }),
  udp("new dgram.Socket (own lookup)", async (t) => {
    const Socket = dgram.Socket as unknown as new (o: dgram.SocketOptions) => dgram.Socket; // typed without its constructor
    const s = new Socket({ type: "udp4", lookup: (host: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, host, 4) } as dgram.SocketOptions);
    await new Promise<void>((resolve, reject) => { s.once("error", reject); s.send(Buffer.from([0]), t.udpPort, t.host, (e) => (e ? reject(e) : resolve())); })
      .finally(() => s.close());
  }),
  // node:dns: the resolvers ask the target's UDP port; lookup goes through the system's resolver
  call("dns.lookup", (t) => new Promise((resolve, reject) => { dns.lookup(t.name, (e, a) => (e ? reject(e) : resolve(a))); })),
  call("dns.promises.lookup", (t) => dns.promises.lookup(t.name)),
  udp("dns.resolve4", (t) => new Promise((resolve, reject) => { dns.resolve4(t.name, (e, a) => (e ? reject(e) : resolve(a))); })),
  udp("new dns.Resolver().resolve4", (t) => {
    const r = new dns.Resolver({ timeout: 250, tries: 1 });
    r.setServers([`${t.host}:${t.udpPort}`]);
    return new Promise((resolve, reject) => { r.resolve4(t.name, (e, a) => (e ? reject(e) : resolve(a))); }).finally(() => r.cancel());
  }),
  udp("new dns.promises.Resolver().resolve4", (t) => {
    const r = new dns.promises.Resolver({ timeout: 250, tries: 1 });
    r.setServers([`${t.host}:${t.udpPort}`]);
    return r.resolve4(t.name).finally(() => r.cancel());
  }),
  // node:worker_threads, node:child_process: each starts code this process's patches do not reach
  tcp("new worker_threads.Worker", async (t) => {
    const w = new worker_threads.Worker(connectCode(t), { eval: true });
    await settle(w, ["exit"]);
  }),
  tcp("child_process.spawn", async (t) => { await settle(child_process.spawn(node, ["-e", connectCode(t)], { stdio: "ignore" }), ["exit"]); }),
  tcp("child_process.spawnSync", async (t) => child_process.spawnSync(node, ["-e", connectCode(t)], { stdio: "ignore" })),
  tcp("child_process.exec", async (t) => { await settle(child_process.exec(`${quoted(node)} -e ${quoted(connectCode(t))}`), ["exit"]); }),
  tcp("child_process.execSync", async (t) => child_process.execSync(`${quoted(node)} -e ${quoted(connectCode(t))}`, { stdio: "ignore" })),
  tcp("child_process.execFile", async (t) => { await settle(child_process.execFile(node, ["-e", connectCode(t)]), ["exit"]); }),
  tcp("child_process.execFileSync", async (t) => child_process.execFileSync(node, ["-e", connectCode(t)], { stdio: "ignore" })),
  tcp("child_process.fork", async (t) => {
    await settle(child_process.fork("/dev/null", [], { execArgv: ["-e", connectCode(t)], stdio: "ignore" }), ["exit"]);
  }),
  tcp("ChildProcess.prototype.spawn", async (t) => {
    const cp = new child_process.ChildProcess() as child_process.ChildProcess & { spawn(o: object): number }; // spawn() is untyped
    const done = settle(cp, ["exit"]);
    cp.spawn({ file: node, args: [node, "-e", connectCode(t)], stdio: ["ignore", "ignore", "ignore"] });
    await done;
  }),
  // process.binding: the raw handles. tcp_wrap connects and udp_wrap sends with them; the rest are only handed out
  tcp("process.binding tcp_wrap", async (t) => {
    const { TCP, TCPConnectWrap, constants } = raw("tcp_wrap") as unknown as {
      TCP: new (type: number) => { connect(req: object, host: string, port: number): number; close(): void };
      TCPConnectWrap: new () => { oncomplete?: (status: number) => void };
      constants: { SOCKET: number };
    };
    const handle = new TCP(constants.SOCKET);
    const req = new TCPConnectWrap();
    await new Promise<void>((resolve, reject) => {
      req.oncomplete = () => resolve();
      const err = handle.connect(req, t.host, t.tcpPort);
      if (err) reject(new Error(`tcp_wrap connect: ${err}`));
    }).finally(() => handle.close());
  }),
  udp("process.binding udp_wrap", async (t) => {
    const { UDP, SendWrap } = raw("udp_wrap") as unknown as {
      UDP: new () => { bind(ip: string, port: number, flags: number): number; send(...a: unknown[]): number; close(): void };
      SendWrap: new () => object;
    };
    const handle = new UDP();
    try {
      const bound = handle.bind("0.0.0.0", 0, 0);
      if (bound) throw new Error(`udp_wrap bind: ${bound}`);
      const sent = handle.send(new SendWrap(), [Buffer.from([0])], 1, t.udpPort, t.host, false);
      if (sent < 0) throw new Error(`udp_wrap send: ${sent}`);
      await new Promise((r) => setTimeout(r, 50)); // a datagram needs no answer; give it time to leave
    } finally {
      handle.close();
    }
  }),
  ...["cares_wrap", "tls_wrap", "pipe_wrap", "process_wrap", "spawn_sync"].map((name) => call(`process.binding ${name}`, async () => {
    const b = raw(name);
    if (!b || typeof b !== "object") throw new Error(`process.binding ${name} gave nothing`);
    return Object.keys(b).length;
  })),
  // a native addon makes its own system calls: loading one is refused (the path does not exist; the call is the point)
  call("process.dlopen", async () => {
    try {
      process.dlopen({ exports: {} } as NodeJS.Module, "/nonexistent/letterlock-network-probe.node");
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_DLOPEN_FAILED") return "dlopen ran and found no file";
      throw e;
    }
  }),
];
