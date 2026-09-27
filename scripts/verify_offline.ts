// Seal and open with the network switched off: sealing needs only a recipient's cached public key, and opening only
// the recipient's key pair. Neither ever needs the chain.
//
//   pnpm verify:offline      (also run by pnpm verify)
//
// 1. The network is switched off in this process (scripts/lib/no-network.ts) before any Letterlock code is loaded.
// 2. Each way out is tried and must be refused: fetch, a TCP socket, TLS, HTTPS, DNS, UDP, and the SDK's own chain
//    client (letterlock().resolve() must fail with CHAIN_UNAVAILABLE caused by the block).
// 3. With the attempt counter noted, and required unchanged at the end:
//    - round trips to cached keys: fixtures/envelopes.json caches each software key as resolve() returns it; every
//      cached key must equal the key re-derived from its PRF stand-in; notes from 0 bytes to the largest one a drop
//      carries are sealed to the CACHED public key and opened with the re-derived key pair, byte for byte;
//    - a seal to the live mainnet key as deployments/143.json caches it (the deploy smoke test's DEMO KEY), checked
//      field by field; it is not opened, because the stand-in behind that key is kept outside the repository;
//    - every offline fixture in fixtures/envelopes.json is replayed and must give its recorded outcome;
//    - the fixture file's seed section must match the plan scripts/seed.ts sends (scripts/lib/plan.ts).
// The last line of output is `VERIFY_OFFLINE_RESULT {json}`, which scripts/verify.ts reads. Exit code 1 on any failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blockNetwork, blockedInChain } from "./lib/no-network.ts";

const block = blockNetwork(); // before the SDK, its dependencies or viem are loaded

const { ROOT } = await import("./lib/git.ts");
const sdk = await import("letterlock");
const { FIXTURE_FILE, keyFor, replay } = await import("./fixtures.ts");
const plan = await import("./lib/plan.ts");
const dgram = await import("node:dgram");
const dns = await import("node:dns");
const https = await import("node:https");
const net = await import("node:net");
const tls = await import("node:tls");

type Check = { group: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (group: string, name: string, ok: boolean, detail: string) => { checks.push({ group, name, ok, detail }); };
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split("\n")[0]!.slice(0, 200);

// 2. Every way out is refused.
const refused = async (name: string, attempt: () => unknown) => {
  try {
    await attempt();
    check("network", name, false, "reached the network");
  } catch (e) {
    check("network", name, blockedInChain(e), blockedInChain(e) ? "refused" : `failed, but not by the block: ${errText(e)}`);
  }
};
const deployer = JSON.parse(readFileSync(join(ROOT, "deployments/143.json"), "utf8")) as {
  address: `0x${string}`; deployer: `0x${string}`; smokeTest: { publishedKey: `0x${string}`; epoch: number; kid: string };
};
await refused("fetch", () => fetch("https://rpc.monad.xyz", { method: "POST" }));
await refused("net.connect", () => new Promise((resolve, reject) => { const s = net.connect(443, "rpc.monad.xyz"); s.once("connect", resolve); s.once("error", reject); }));
await refused("new net.Socket().connect", () => new net.Socket().connect(443, "rpc.monad.xyz"));
await refused("tls.connect", () => tls.connect(443, "rpc.monad.xyz"));
await refused("https.get", () => https.get("https://rpc.monad.xyz"));
await refused("dns.lookup", () => dns.promises.lookup("rpc.monad.xyz"));
await refused("dgram.createSocket", () => dgram.createSocket("udp4"));
try {
  await sdk.letterlock({ chain: "monad" }).resolve(deployer.deployer);
  check("network", "SDK resolve()", false, "resolved a key with the network off");
} catch (e) {
  const ok = sdk.isLetterlockError(e, "CHAIN_UNAVAILABLE") && blockedInChain(e);
  check("network", "SDK resolve()", ok, ok ? "CHAIN_UNAVAILABLE, caused by the block" : `unexpected: ${errText(e)}`);
}
const probeAttempts = block.attempts.length;

// 3. The offline work. Nothing below may try the network.
type CachedKey = { ref: string; recipient: string; chainId: number; directory: `0x${string}`; epoch: number; publicKey: `0x${string}`; kid: string };
type Fixture = { id: string; envelope: unknown; open: string; expect: { outcome: string; plaintext?: string } };
const fixtures = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as {
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

for (const f of fixtures.offline) {
  const got = await replay(f.envelope, keyFor(f.open));
  const ok = got.outcome === f.expect.outcome && got.plaintext === f.expect.plaintext;
  check("fixtures", f.id, ok, `${f.open.padEnd(9)} → ${got.outcome}${ok ? "" : ` (recorded: ${f.expect.outcome})`}`);
}

const seedMatches = JSON.stringify(fixtures.seed.notes.map(({ id, text }) => ({ id, text }))) === JSON.stringify(plan.SEED_NOTES) &&
  (["from", "ctByte", "xor"] as const).every((k) => fixtures.seed.tampered[k] === plan.SEED_TAMPER[k]) &&
  fixtures.seed.oldEpoch.id === plan.SEED_OLD_EPOCH.id && fixtures.seed.oldEpoch.text === plan.SEED_OLD_EPOCH.text;
check("fixtures", "seed section = scripts/lib/plan.ts", seedMatches, seedMatches ? "the notes, the tampered byte and the old-epoch note match" : "run pnpm fixtures --write");

const workAttempts = block.attempts.length - probeAttempts;
check("network", "attempts during the offline work", workAttempts === 0, workAttempts === 0 ? "none" : block.attempts.slice(probeAttempts).join("; "));

for (const group of [...new Set(checks.map((c) => c.group))]) {
  const of = checks.filter((c) => c.group === group);
  console.log(`${group} (${of.filter((c) => c.ok).length}/${of.length})`);
  for (const c of of) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(36)} ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok).length;
const fixtureChecks = checks.filter((c) => c.group === "fixtures" && c.name !== "seed section = scripts/lib/plan.ts");
console.log(`VERIFY_OFFLINE_RESULT ${JSON.stringify({
  checks: checks.length,
  passed: checks.length - failed,
  failed,
  fixtures: { cases: fixtureChecks.length, passed: fixtureChecks.filter((c) => c.ok).length },
  roundTrips: checks.filter((c) => c.group === "round trips").length,
  networkAttempts: { refusedProbes: probeAttempts, duringOfflineWork: workAttempts },
  maxPlaintextBytes: maxPlaintext,
})}`);
process.exitCode = failed ? 1 : 0;
