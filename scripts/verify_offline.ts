// Seal and open with no network: sealing needs only a recipient's cached public key, and opening only the recipient's
// key pair. Neither ever needs the chain.
//
//   pnpm verify:offline                                  (also run by pnpm verify)
//   node scripts/verify_offline.ts --fixtures <file>     replay another fixture file (scripts/test uses it)
//
// 1. The operating system takes the network away (scripts/lib/os-sandbox.ts): the script runs itself again under
//    sandbox-exec (macOS) or in a new network namespace (Linux), and from inside checks that a TCP connection, a UDP
//    datagram and a name lookup all fail. That is what makes "no network" hold for every line of code in the process.
//    Where no sandbox is available the report says so; LETTERLOCK_REQUIRE_NETWORK_SANDBOX=1 (CI) makes that a failure.
// 2. The in-process guard (scripts/lib/no-network.ts) is installed before any Letterlock code is loaded: it refuses and
//    counts every attempt made through Node's APIs. Each way out it closes (scripts/lib/network-probes.ts, aimed at an
//    IP address, so no probe is stopped by DNS instead) must be refused and counted, and so must the SDK's own chain
//    client: letterlock().resolve() must fail with CHAIN_UNAVAILABLE caused by the block. Loading the SDK must make no
//    attempt, each probe exactly one, and resolve() only fetches to its RPC, so nothing else hides in the tally.
// 3. With the attempt counter noted, and required unchanged at the end (after any timers the work left have run; an
//    attempt later still, after the result line, sets exit code 1):
//    - round trips to cached keys: fixtures/envelopes.json caches each software key as resolve() returns it; every
//      cached key must equal the key re-derived from its PRF stand-in; notes from 0 bytes to the largest one a drop
//      carries are sealed to the CACHED public key and opened with the re-derived key pair, byte for byte;
//    - a seal to the live mainnet key as deployments/143.json caches it (the deploy smoke test's DEMO KEY), checked
//      field by field; it is not opened, because the stand-in behind that key is kept outside the repository;
//    - every offline fixture in fixtures/envelopes.json is replayed and must give its recorded outcome, and the file
//      must hold exactly the cases scripts/fixtures.ts plans (FIXTURE_CASES), in order, each recording the outcome it
//      was built to show, with every outcome among them: no case can drop out of the replay unseen;
//    - the fixture file's seed section must match the plan scripts/seed.ts sends (scripts/lib/plan.ts).
// The last line of output is `VERIFY_OFFLINE_RESULT {json}`, which scripts/verify.ts reads. Exit code 1 on any failure.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { blockNetwork, blockedInChain } from "./lib/no-network.ts";
import { REQUIRE_SANDBOX_ENV, SANDBOX_ENV, networkSandbox, osNetworkCheck, type OsNetworkCheck } from "./lib/os-sandbox.ts";

const { values: opts } = parseArgs({ options: { fixtures: { type: "string" } } });

// 1. Under the OS-level block, or a note that there is none.
type OsBlock = { tool: string | null; required: boolean; ok: boolean; detail: string; check?: OsNetworkCheck };
let osBlock: OsBlock;
const required = process.env[REQUIRE_SANDBOX_ENV] === "1";
const sandboxedBy = process.env[SANDBOX_ENV];
if (!sandboxedBy) {
  const sandbox = networkSandbox();
  if ("wrap" in sandbox) {
    const [cmd, ...args] = sandbox.wrap([process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)]);
    const r = spawnSync(cmd!, args, { stdio: "inherit", env: { ...process.env, [SANDBOX_ENV]: sandbox.tool } });
    if (r.error) throw r.error;
    process.exit(r.status ?? 1);
  }
  osBlock = { tool: null, required, ok: !required, detail: `none on this machine (${sandbox.unavailable}): the in-process guard only` };
} else {
  const c = await osNetworkCheck(); // before blockNetwork(): nothing in this process stands in the way
  osBlock = {
    tool: sandboxedBy, required, ok: c.blocked, check: c,
    detail: `${c.blocked ? "no network" : "the network is still reachable"} under ${sandboxedBy}: TCP ${c.tcp}, UDP ${c.udp}, DNS ${c.dns}`,
  };
}

const block = blockNetwork(); // before the SDK, its dependencies or viem are loaded
const atInstall = block.attempts.length;

const { ROOT } = await import("./lib/git.ts");
const sdk = await import("letterlock");
const { FIXTURE_FILE, FIXTURE_CASES, REQUIRED_OUTCOMES, keyFor, replay } = await import("./fixtures.ts");
const plan = await import("./lib/plan.ts");
const { OFFLINE_TARGET, PROBES } = await import("./lib/network-probes.ts");
// Loading the SDK and its dependencies must not try the network: an attempt made while a module loads would otherwise
// be added, unseen, to the probes' tally below.
const loadAttempts = block.attempts.slice(atInstall);

type Check = { group: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (group: string, name: string, ok: boolean, detail: string) => { checks.push({ group, name, ok, detail }); };
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split("\n")[0]!.slice(0, 200);
const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms).unref())]);

if (osBlock.tool || osBlock.required) check("OS-level block", osBlock.tool ? `${osBlock.tool}: no network` : "a network sandbox", osBlock.ok, osBlock.detail);
check("network", "attempts while loading the SDK", loadAttempts.length === 0, loadAttempts.length === 0 ? "none" : loadAttempts.join("; "));

// 2. Every way out is refused, and counted.
const deployer = JSON.parse(readFileSync(join(ROOT, "deployments/143.json"), "utf8")) as {
  address: `0x${string}`; deployer: `0x${string}`; smokeTest: { publishedKey: `0x${string}`; epoch: number; kid: string };
};
// Each probe makes exactly one attempt, and the SDK's resolve() only fetches from its RPC endpoint (viem retries, so
// more than once): an attempt from anything else that lands while the probes run makes the tally wrong, and fails.
const probeStart = block.attempts.length;
for (const probe of PROBES) {
  const before = block.attempts.length;
  try {
    await within(5000, probe.attempt(OFFLINE_TARGET));
    check("network", probe.name, false, `reached ${OFFLINE_TARGET.host}`);
  } catch (e) {
    const made = block.attempts.slice(before);
    const ok = blockedInChain(e) && made.length === 1;
    check("network", probe.name, ok, ok ? `refused by ${made[0]!.split(" ")[0]}`
      : !blockedInChain(e) ? `failed, but not by the block: ${errText(e)}`
      : made.length === 0 ? "refused, but not counted" : `refused, but ${made.length} attempts counted: ${made.join("; ")}`);
  }
}
const sdkRpc = new URL(sdk.DEPLOYMENTS.monad.rpcUrl).href; // "https://rpc.monad.xyz/", as fetch is handed it
{
  const before = block.attempts.length;
  try {
    await sdk.letterlock({ chain: "monad" }).resolve(deployer.deployer);
    check("network", "SDK resolve()", false, "resolved a key with the network off");
  } catch (e) {
    const made = block.attempts.slice(before);
    const foreign = made.filter((a) => a !== `fetch ${sdkRpc}`);
    const ok = sdk.isLetterlockError(e, "CHAIN_UNAVAILABLE") && blockedInChain(e) && made.length > 0 && foreign.length === 0;
    check("network", "SDK resolve()", ok, ok ? `CHAIN_UNAVAILABLE, caused by the block (${made.length} fetches to ${sdkRpc})`
      : foreign.length ? `attempts that are not the SDK's RPC: ${foreign.join("; ")}` : `unexpected: ${errText(e)}`);
  }
}
const probeAttempts = block.attempts.length;

// 3. The offline work. Nothing below may try the network.
type CachedKey = { ref: string; recipient: string; chainId: number; directory: `0x${string}`; epoch: number; publicKey: `0x${string}`; kid: string };
type Fixture = { id: string; envelope: unknown; open: string; expect: { outcome: string; plaintext?: string } };
const fixtureFile = opts.fixtures === undefined ? FIXTURE_FILE : resolve(opts.fixtures);
const fixtures = JSON.parse(readFileSync(fixtureFile, "utf8")) as {
  keys: CachedKey[];
  offline: Fixture[];
  seed: { notes: { id: string; text: string }[]; tampered: Record<string, unknown>; oldEpoch: { id: string; text: string } };
};

for (const k of fixtures.keys) {
  const derived = keyFor(k.ref);
  const same = k.publicKey === `0x${sdk.toHex(derived.publicKey)}` && k.kid === sdk.fingerprint(derived.publicKey) &&
    k.epoch === derived.epoch && k.recipient === derived.recipient;
  check("cached keys", k.ref, same, same ? `kid ${k.kid}` : "the cached key is not the one its PRF stand-in derives");
}

const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const cached = (ref: string): CachedKey => {
  const k = fixtures.keys.find((x) => x.ref === ref);
  if (!k) throw new Error(`fixtures/envelopes.json caches no key ${ref}`);
  return k;
};
/** Seals to the cached public key only; opens with the key pair re-derived from the PRF stand-in. */
const roundTrip = async (ref: string, plaintext: Uint8Array) => {
  const c = cached(ref);
  const envelope = await sdk.seal({
    chainId: c.chainId,
    directory: c.directory,
    to: { recipient: c.recipient, publicKey: sdk.fromHex(c.publicKey), epoch: c.epoch },
    plaintext,
  });
  const wire = sdk.encodeEnvelope(envelope);
  const opened = await sdk.open(sdk.decodeEnvelope(wire), keyFor(ref));
  return { ok: equal(opened, plaintext) && envelope.kid === c.kid, wireBytes: wire.length };
};

// The largest note one drop carries: the wire form of its envelope must fit MAX_ENVELOPE_BYTES.
const wireSize = async (n: number) => {
  const c = cached("maya@1");
  const e = await sdk.seal({ chainId: c.chainId, directory: c.directory, to: { recipient: c.recipient, publicKey: sdk.fromHex(c.publicKey), epoch: c.epoch }, plaintext: bytesOf(n) });
  return sdk.encodeEnvelope(e).length;
};
let lo = 0;
let hi = sdk.MAX_ENVELOPE_BYTES;
while (lo < hi) {
  const mid = Math.ceil((lo + hi) / 2);
  if ((await wireSize(mid)) <= sdk.MAX_ENVELOPE_BYTES) lo = mid; else hi = mid - 1;
}
const maxPlaintext = lo;
check("round trips", `largest note in one drop`, (await wireSize(maxPlaintext)) <= sdk.MAX_ENVELOPE_BYTES && (await wireSize(maxPlaintext + 1)) > sdk.MAX_ENVELOPE_BYTES,
  `${maxPlaintext.toLocaleString("en-US")} bytes (its envelope is at most ${sdk.MAX_ENVELOPE_BYTES.toLocaleString("en-US")} bytes on the wire)`);

for (const [ref, sizes] of [["maya@1", [0, 1, plan.SEED_NOTES[0].text.length, 1024, 4096, maxPlaintext]], ["kai@2", [64]], [`agent:${plan.FIXTURE_AGENT.id}@1`, [256]]] as const) {
  for (const n of sizes) {
    const r = await roundTrip(ref, bytesOf(n));
    check("round trips", `${ref} ${n} B`, r.ok, r.ok ? `opened byte for byte (${r.wireBytes} B envelope)` : "did not open to the same bytes");
  }
}

// The live mainnet key, as deployments/143.json caches it: sealed offline, bound to chain 143 and the directory.
{
  const envelope = await sdk.seal({
    chainId: 143,
    directory: deployer.address,
    to: { recipient: deployer.deployer, publicKey: sdk.fromHex(deployer.smokeTest.publishedKey), epoch: deployer.smokeTest.epoch },
    plaintext: new TextEncoder().encode(plan.SEED_NOTES[0].text),
  });
  const decoded = sdk.decodeEnvelope(sdk.encodeEnvelope(envelope));
  const ok = decoded.chainId === 143 && decoded.directory === deployer.address.toLowerCase() && decoded.recipient === deployer.deployer.toLowerCase() &&
    decoded.epoch === deployer.smokeTest.epoch && decoded.kid === deployer.smokeTest.kid;
  check("mainnet key", "seal to the cached DEMO KEY", ok,
    ok ? `chain 143, directory ${deployer.address}, kid ${decoded.kid}; not opened (its PRF stand-in is kept outside the repository)` : "the envelope does not name the cached key");
}

// The fixture file holds exactly the planned cases: dropping one, a negative one above all, fails here.
const planned = FIXTURE_CASES.map((c) => c.id as string);
const held = fixtures.offline.map((f) => f.id);
const missing = planned.filter((id) => !held.includes(id));
const unplanned = held.filter((id) => !planned.includes(id));
const asPlanned = held.length === planned.length && held.every((id, i) => id === planned[i]);
check("fixtures", "the planned cases, each once, in order", asPlanned, asPlanned ? `${planned.length} cases (FIXTURE_CASES in scripts/fixtures.ts)`
  : [missing.length ? `missing: ${missing.join(", ")}` : "", unplanned.length ? `not planned: ${unplanned.join(", ")}` : "",
    !missing.length && !unplanned.length ? "repeated or out of order" : ""].filter(Boolean).join("; "));
const shown = new Set<string>();
for (const f of fixtures.offline) {
  const want = FIXTURE_CASES.find((c) => c.id === f.id)?.want;
  const got = await replay(f.envelope, keyFor(f.open));
  const ok = got.outcome === f.expect.outcome && got.plaintext === f.expect.plaintext && f.expect.outcome === want;
  if (ok) shown.add(got.outcome);
  check("fixtures", f.id, ok, `${f.open.padEnd(9)} → ${got.outcome}${ok ? "" : ` (recorded: ${f.expect.outcome}, planned: ${want ?? "no such case"})`}`);
}
const absent = REQUIRED_OUTCOMES.filter((o) => !shown.has(o));
check("fixtures", "every outcome is shown", absent.length === 0, absent.length ? `no passing case shows ${absent.join(", ")}` : REQUIRED_OUTCOMES.join(", "));

const seedMatches = JSON.stringify(fixtures.seed.notes.map(({ id, text }) => ({ id, text }))) === JSON.stringify(plan.SEED_NOTES) &&
  (["from", "ctByte", "xor"] as const).every((k) => fixtures.seed.tampered[k] === plan.SEED_TAMPER[k]) &&
  fixtures.seed.oldEpoch.id === plan.SEED_OLD_EPOCH.id && fixtures.seed.oldEpoch.text === plan.SEED_OLD_EPOCH.text;
check("fixtures", "seed section = scripts/lib/plan.ts", seedMatches, seedMatches ? "the notes, the tampered byte and the old-epoch note match" : "run pnpm fixtures --write");

// Anything the work left scheduled runs before the count: a timer set during a seal that fires after the result line
// would otherwise try the network unseen. Our own wait has fired by the time the next check looks, so only work left
// by others is seen (it must keep the process alive, or an await with nothing else pending would end it early).
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pendingWork = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout" || r === "Immediate");
for (const until = Date.now() + 10_000; pendingWork().length && Date.now() < until;) await sleep(50);
const leftPending = pendingWork();
check("network", "work left scheduled at the end", leftPending.length === 0,
  leftPending.length === 0 ? "none" : `${leftPending.length} (${[...new Set(leftPending)].join(", ")}) still pending after 10 s`);
const workAttempts = block.attempts.length - probeAttempts;
check("network", "attempts during the offline work", workAttempts === 0, workAttempts === 0 ? "none" : block.attempts.slice(probeAttempts).join("; "));
// Anything later still (after the result line) fails the run from here.
const counted = block.attempts.length;
process.on("exit", () => {
  const late = block.attempts.slice(counted);
  if (!late.length) return;
  console.error(`FAIL  network attempts after the result line: ${late.length}: ${late.slice(0, 5).join("; ")}${late.length > 5 ? "; ..." : ""}`);
  process.exitCode = 1;
});

if (!osBlock.tool && !osBlock.required) console.log(`OS-level block: ${osBlock.detail}`);
for (const group of [...new Set(checks.map((c) => c.group))]) {
  const of = checks.filter((c) => c.group === group);
  console.log(`${group} (${of.filter((c) => c.ok).length}/${of.length})`);
  for (const c of of) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(40)} ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok).length;
const replayed = fixtures.offline.map((f) => checks.find((c) => c.group === "fixtures" && c.name === f.id)!);
console.log(`VERIFY_OFFLINE_RESULT ${JSON.stringify({
  checks: checks.length,
  passed: checks.length - failed,
  failed,
  osBlock: { tool: osBlock.tool, ok: osBlock.ok, detail: osBlock.detail },
  fixtures: { cases: replayed.length, passed: replayed.filter((c) => c.ok).length, planned: planned.length, asPlanned, outcomes: [...shown] },
  roundTrips: checks.filter((c) => c.group === "round trips").length,
  networkAttempts: {
    probes: PROBES.length + 1,
    probesRefused: checks.filter((c) => c.group === "network" && (PROBES.some((p) => p.name === c.name) || c.name === "SDK resolve()") && c.ok).length,
    whileLoading: loadAttempts.length,
    refusedProbes: probeAttempts - probeStart,
    duringOfflineWork: workAttempts,
  },
  maxPlaintextBytes: maxPlaintext,
})}`);
process.exitCode = failed ? 1 : 0;
