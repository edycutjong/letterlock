// The in-process network guard (scripts/lib/no-network.ts) against every probe scripts/verify_offline.ts runs
// (scripts/lib/network-probes.ts), with listeners on 127.0.0.1 standing in for the network:
// - without the guard, each probe reaches its listener (a TCP connection, a UDP datagram), or for the few with nothing
//   to reach, completes: each is a live way out by itself, and none of them needs DNS (the target is an IP address);
// - with the guard, each is refused with NetworkBlocked AND counted, and the listeners hear nothing.
// A way out the guard misses (a worker, a child process, a dgram socket built directly, a raw binding) fails here.
// Each run is a child process, so the guard never touches this one; the listeners live in the child, started before
// the guard is installed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROBES } from "../lib/network-probes.ts";

const PROBES_URL = new URL("../lib/network-probes.ts", import.meta.url).href;
const GUARD_URL = new URL("../lib/no-network.ts", import.meta.url).href;

type Result = { name: string; reaches: string; outcome: string; counted: number; tcp: number; udp: number };

const HARNESS = `
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
const guarded = process.env.PROBE_GUARD === "1";
const { PROBES } = await import(process.env.PROBES_URL);
let tcp = 0, udp = 0;
const server = net.createServer((s) => { tcp++; s.on("error", () => {}); s.destroy(); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const listener = dgram.createSocket("udp4");
listener.on("message", () => { udp++; });
await new Promise((r) => listener.bind(0, "127.0.0.1", r));
const target = { host: "127.0.0.1", tcpPort: server.address().port, udpPort: listener.address().port, name: "localhost" };
let block, blockedInChain = () => false;
if (guarded) ({ blockNetwork: block, blockedInChain } = await import(process.env.GUARD_URL)), block = block();
else dns.setServers([target.host + ":" + target.udpPort]); // dns.resolve4 asks the listener, not the network
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
for (const p of PROBES) {
  const t0 = tcp, u0 = udp, a0 = block ? block.attempts.length : 0;
  let outcome;
  try {
    await Promise.race([p.attempt(target), sleep(3000).then(() => { throw new Error("__timeout__"); })]);
    outcome = "completed";
  } catch (e) {
    outcome = blockedInChain(e) ? "refused" : e?.message === "__timeout__" ? "timeout" : "failed: " + String(e?.message ?? e).split("\\n")[0].slice(0, 120);
  }
  await sleep(60); // a connection or datagram the probe made reaches the listener by now
  results.push({ name: p.name, reaches: p.reaches, outcome, counted: (block ? block.attempts.length : 0) - a0, tcp: tcp - t0, udp: udp - u0 });
}
process.stdout.write("PROBE_RESULTS " + JSON.stringify(results) + "\\n");
process.exit(0);
`;

const runProbes = (guarded: boolean): Promise<Result[]> =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "--no-warnings", "-e", HARNESS], {
      env: { ...process.env, PROBE_GUARD: guarded ? "1" : "0", PROBES_URL, GUARD_URL },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => {
      const line = /^PROBE_RESULTS (.*)$/m.exec(out)?.[1];
      if (code !== 0 || !line) reject(new Error(`the probe run exited ${code}:\n${out}\n${err}`));
      else resolve(JSON.parse(line) as Result[]);
    });
  });

test("every probe is a live way out: without the guard it reaches its listener, or completes", async () => {
  const results = await runProbes(false);
  assert.deepEqual(results.map((r) => r.name), PROBES.map((p) => p.name));
  const dead = results.filter((r) => (r.reaches === "tcp" ? r.tcp < 1 : r.reaches === "udp" ? r.udp < 1 : r.outcome !== "completed"));
  assert.deepEqual(dead, [], "each of these did not reach anything without the guard, so the guard is not what stops it");
});

test("with the guard, every probe is refused with NetworkBlocked and counted, and nothing reaches a listener", async () => {
  const results = await runProbes(true);
  assert.deepEqual(results.map((r) => r.name), PROBES.map((p) => p.name));
  const through = results.filter((r) => r.outcome !== "refused" || r.counted < 1 || r.tcp !== 0 || r.udp !== 0);
  assert.deepEqual(through, [], "each of these got past the guard, or was stopped without being counted");
});

test("the probes cover the ways out that once got past the guard: a worker, a child process, a dgram socket built directly, raw bindings", () => {
  const names = PROBES.map((p) => p.name);
  for (const n of ["new worker_threads.Worker", "child_process.execFileSync", "new dgram.Socket (own lookup)", "process.binding tcp_wrap",
    "process.binding udp_wrap", "process.binding cares_wrap", "new http.ClientRequest"])
    assert.ok(names.includes(n), `no probe named ${n}`);
  assert.equal(new Set(names).size, names.length, "probe names are unique");
});

test("verify_offline aims the probes at an IP address, so a DNS failure can never be what refuses one", async () => {
  const { OFFLINE_TARGET } = await import("../lib/network-probes.ts");
  const { isIP } = await import("node:net");
  assert.notEqual(isIP(OFFLINE_TARGET.host), 0, `${OFFLINE_TARGET.host} is not an IP address`);
  assert.ok(fileURLToPath(PROBES_URL).endsWith("network-probes.ts"));
});
