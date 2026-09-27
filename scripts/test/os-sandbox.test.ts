// The OS-level network block (scripts/lib/os-sandbox.ts) on its own, with no in-process guard anywhere: a child process
// run under it tries a raw TCP connection through process.binding('tcp_wrap') (below every JavaScript patch), a
// net.connect and a UDP datagram to listeners in this process, and every one must fail while the listeners hear
// nothing. The same child run without the sandbox reaches them: the control that shows the attempts are live. And
// osNetworkCheck(), which scripts/verify_offline.ts trusts before it counts a run as sandboxed, reports "blocked" under
// the sandbox. Skipped where this machine has no sandbox, unless LETTERLOCK_REQUIRE_NETWORK_SANDBOX=1.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import { after, before, test } from "node:test";
import { REQUIRE_SANDBOX_ENV, networkSandbox } from "../lib/os-sandbox.ts";

const sandbox = networkSandbox();
if (!("wrap" in sandbox) && process.env[REQUIRE_SANDBOX_ENV] === "1") throw new Error(`a network sandbox is required: ${sandbox.unavailable}`);
const skip = "wrap" in sandbox ? false : `no network sandbox on this machine: ${sandbox.unavailable}`;

const CHILD = `
const net = require("node:net"), dgram = require("node:dgram");
const tcpPort = Number(process.env.TCP_PORT), udpPort = Number(process.env.UDP_PORT);
const within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("no answer"), { code: "TIMEOUT" })), 2000))]);
const fail = (code) => Object.assign(new Error(String(code)), { code: String(code) });
(async () => {
  const out = {};
  try {
    await within(new Promise((res, rej) => {
      const { TCP, TCPConnectWrap, constants } = process.binding("tcp_wrap");
      const h = new TCP(constants.SOCKET), req = new TCPConnectWrap();
      req.oncomplete = (status) => { h.close(); status === 0 ? res() : rej(fail(status)); };
      const e = h.connect(req, "127.0.0.1", tcpPort);
      if (e) rej(fail(e));
    }));
    out.rawTcp = "connected";
  } catch (e) { out.rawTcp = e.code; }
  try {
    await within(new Promise((res, rej) => { const s = net.connect(tcpPort, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(); }); s.on("error", rej); }));
    out.tcp = "connected";
  } catch (e) { out.tcp = e.code; }
  try {
    await within(new Promise((res, rej) => {
      const s = dgram.createSocket("udp4");
      s.on("error", rej);
      s.send(Buffer.from([0]), udpPort, "127.0.0.1", (e) => { s.close(); e ? rej(e) : res(); });
    }));
    out.udp = "sent";
  } catch (e) { out.udp = e.code; }
  process.stdout.write("OS_RESULT " + JSON.stringify(out) + "\\n");
  process.exit(0);
})();
`;

let server: net.Server;
let listener: dgram.Socket;
const hits = { tcp: 0, udp: 0 };
before(async () => {
  server = net.createServer((s) => { hits.tcp++; s.on("error", () => {}); s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  listener = dgram.createSocket("udp4");
  listener.on("message", () => { hits.udp++; });
  await new Promise<void>((r) => listener.bind(0, "127.0.0.1", r));
});
after(() => { server?.close(); listener?.close(); });

const run = (argv: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const p = spawn(cmd!, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => resolve({ code, out, err }));
  });

const attempt = async (sandboxed: boolean) => {
  const argv = [process.execPath, "--no-deprecation", "-e", CHILD];
  const ports = { TCP_PORT: String((server.address() as net.AddressInfo).port), UDP_PORT: String(listener.address().port) };
  const r = await run(sandboxed && "wrap" in sandbox ? sandbox.wrap(argv) : argv, ports);
  const line = /^OS_RESULT (.*)$/m.exec(r.out)?.[1];
  assert.ok(line, `the child printed no result (exit ${r.code}): ${r.out}\n${r.err}`);
  await new Promise((res) => setTimeout(res, 100));
  return JSON.parse(line) as { rawTcp: string; tcp: string; udp: string };
};

test("without the sandbox, the child reaches the listeners (the control)", { skip }, async () => {
  const start = { ...hits };
  const r = await attempt(false);
  assert.deepEqual(r, { rawTcp: "connected", tcp: "connected", udp: "sent" });
  assert.ok(hits.tcp - start.tcp >= 2 && hits.udp - start.udp >= 1, `listeners heard ${JSON.stringify(hits)}`);
});

test("under the sandbox, a raw TCP handle, net.connect and a UDP datagram all fail, and the listeners hear nothing", { skip }, async () => {
  const start = { ...hits };
  const r = await attempt(true);
  assert.notEqual(r.rawTcp, "connected");
  assert.notEqual(r.tcp, "connected");
  assert.notEqual(r.udp, "sent");
  assert.deepEqual(hits, start);
});

test("osNetworkCheck() reports no network under the sandbox", { skip }, async () => {
  const code = `const { osNetworkCheck } = await import(${JSON.stringify(new URL("../lib/os-sandbox.ts", import.meta.url).href)});
process.stdout.write("CHECK " + JSON.stringify(await osNetworkCheck(2000)) + "\\n");`;
  const argv = [process.execPath, "--input-type=module", "--no-warnings", "-e", code];
  const r = await run("wrap" in sandbox ? sandbox.wrap(argv) : argv);
  const line = /^CHECK (.*)$/m.exec(r.out)?.[1];
  assert.ok(line, `no result (exit ${r.code}): ${r.err}`);
  const c = JSON.parse(line) as { blocked: boolean; tcp: string; udp: string; dns: string };
  assert.equal(c.blocked, true, JSON.stringify(c));
});
