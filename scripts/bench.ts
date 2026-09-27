// Resolve + seal latency against the live Monad mainnet directory, and the gas its real transactions paid.
//
//   pnpm bench                      N = 200 against https://rpc.monad.xyz; writes bench/results.json and bench/RESULTS.md
//   pnpm bench --n 20 --no-write    a quick look; nothing is written
//   pnpm bench --rpc <url>          another endpoint (only its origin is recorded: a path may carry an API key)
//
// Read-only: no key, no transaction. The recipient is the mainnet directory's deployer, whose published key is the
// deploy smoke test's DEMO KEY (deployments/143.json); every resolve must return exactly that key and epoch.
//
// Timed with performance.now(), one operation at a time (nothing overlaps); every round runs these four, in this order
// in even rounds and in the reverse order in odd ones:
//   resolve         ll.resolve(deployer): one keyOf eth_call over HTTPS. The client's one-time chain and directory
//                   checks run before the first round and are timed on their own, as the cold first resolve
//   seal            seal() of a fixed note to the key that resolve returned: HPKE on this machine, no network
//   resolve+seal    ll.sealTo(deployer, note): the SDK's own resolve-then-seal, timed as one call
//   rpc round trip  eth_blockNumber on the same endpoint: the network's share of a resolve, for context
// Percentiles are nearest-rank (scripts/lib/stats.ts). A failed call is counted and reported, never retried into the
// samples. The gas figures are read from the receipts of the transactions deployments/143.json records.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEPLOYMENTS, VERSION, encodeEnvelope, isLetterlockError, letterlock, seal, toHex, type Envelope, type ResolvedKey } from "letterlock";
import { createPublicClient, formatEther, formatGwei, http, type Hex } from "viem";
import { monad } from "viem/chains";
import { ROOT, SDK_RUNTIME_PATHS, gitContext } from "./lib/git.ts";
import { SEED_NOTES } from "./lib/plan.ts";
import { round3, summarize } from "./lib/stats.ts";

const { values: opts } = parseArgs({
  options: {
    n: { type: "string", default: "200" },
    warmup: { type: "string", default: "5" },
    rpc: { type: "string" },
    "no-write": { type: "boolean", default: false },
  },
});
const count = (name: string, v: string, min: number): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got ${v}`);
  return n;
};
const N = count("n", opts.n!, 1);
const WARMUP = count("warmup", opts.warmup!, 0);
const rpcUrl = opts.rpc ?? DEPLOYMENTS.monad.rpcUrl;
const rpcShown = new URL(rpcUrl).origin; // a path or query may hold an API key: never recorded
const hide = (s: string) => s.split(rpcUrl).join(rpcShown);

type Record143 = {
  chainId: number;
  address: `0x${string}`;
  deployer: `0x${string}`;
  deployTx: Hex;
  agentRegisterTx: Hex;
  publishTx: Hex;
  publishForAgentTx: Hex;
  dropTx: Hex;
  gasUsed: Record<string, number>;
  smokeTest: { publishedKey: Hex; epoch: number; kid: string; envelopeBytes: number };
};
const record = JSON.parse(readFileSync(join(ROOT, "deployments/143.json"), "utf8")) as Record143;
if (record.chainId !== 143 || record.address !== DEPLOYMENTS.monad.directory)
  throw new Error("deployments/143.json and the SDK's DEPLOYMENTS.monad name different directories");

const recipient = record.deployer;
const expected = { publicKey: record.smokeTest.publishedKey.toLowerCase(), epoch: record.smokeTest.epoch, kid: record.smokeTest.kid };
const note = SEED_NOTES[0].text;
const plaintext = new TextEncoder().encode(note);

const ll = letterlock({ chain: "monad", rpcUrl });
const rpc = createPublicClient({ chain: monad, transport: http(rpcUrl) });

type Failure = { round: number; op: string; code: string; message: string };
const failures: Failure[] = [];
const mismatches: string[] = [];
let resolvesChecked = 0;
let envelopesChecked = 0;
const now = () => performance.now();

/** Runs one timed operation; a failure is recorded and returns undefined. */
const timed = async <T>(round: number, op: string, f: () => Promise<T>): Promise<{ value: T; ms: number } | undefined> => {
  const t0 = now();
  try {
    const value = await f();
    return { value, ms: now() - t0 };
  } catch (e) {
    const message = hide(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240);
    failures.push({ round, op, code: isLetterlockError(e) ? e.code : e instanceof Error ? e.name : "Error", message });
    return undefined;
  }
};

const checkKey = (round: number, k: ResolvedKey) => {
  resolvesChecked++;
  const got = { publicKey: `0x${toHex(k.publicKey)}`, epoch: k.epoch, kid: k.kid };
  if (got.publicKey !== expected.publicKey || got.epoch !== expected.epoch || got.kid !== expected.kid)
    mismatches.push(`round ${round}: resolve returned ${JSON.stringify(got)}, deployments/143.json records ${JSON.stringify(expected)}`);
};
const checkEnvelope = (round: number, e: Envelope) => {
  envelopesChecked++;
  if (e.kid !== expected.kid || e.epoch !== expected.epoch || e.chainId !== 143 || e.directory !== record.address.toLowerCase() || e.recipient !== recipient.toLowerCase())
    mismatches.push(`round ${round}: envelope header ${JSON.stringify({ chainId: e.chainId, directory: e.directory, recipient: e.recipient, epoch: e.epoch, kid: e.kid })}`);
};

const loadAverage = () => os.loadavg().map((x) => Math.round(x * 100) / 100);
const startedAt = new Date();
const loadAtStart = loadAverage();
console.log(`bench: N=${N} (+${WARMUP} warm-up rounds) against ${rpcShown}, recipient ${recipient} (${record.smokeTest.kid}), a ${plaintext.length}-byte note`);

// The cold first resolve: eth_chainId, eth_getCode and NO_AGENT() (the client's one-time checks), then keyOf.
const cold = await timed(-1, "cold resolve", () => ll.resolve(recipient));
if (!cold) throw new Error(`the first resolve failed: ${JSON.stringify(failures[0])}`);
checkKey(-1, cold.value);
if (mismatches.length) throw new Error(`the directory no longer returns the recorded DEMO KEY: ${mismatches[0]}`);

for (let w = 0; w < WARMUP; w++) {
  await timed(-2, "warm-up", () => ll.resolve(recipient));
  await timed(-2, "warm-up", () => ll.sealTo(recipient, plaintext));
  await timed(-2, "warm-up", () => rpc.getBlockNumber({ cacheTime: 0 }));
}
const warmupFailures = failures.length;

const samples = { resolve: [] as number[], seal: [] as number[], resolveAndSeal: [] as number[], rpcRoundTrip: [] as number[] };
let envelopeBytes = 0;
const firstBlock = await rpc.getBlockNumber({ cacheTime: 0 });
// One round: resolve then seal its result, the SDK's sealTo, and a plain round trip. The order is reversed every other
// round, so no operation always runs right after another one.
const resolveThenSeal = async (i: number) => {
  const r = await timed(i, "resolve", () => ll.resolve(recipient));
  if (!r) return;
  samples.resolve.push(r.ms);
  checkKey(i, r.value);
  const s = await timed(i, "seal", () => seal({ chainId: ll.chainId, directory: ll.directory, to: r.value, plaintext }));
  if (!s) return;
  samples.seal.push(s.ms);
  checkEnvelope(i, s.value);
  envelopeBytes = encodeEnvelope(s.value).length;
};
const sealTo = async (i: number) => {
  const c = await timed(i, "resolve+seal", () => ll.sealTo(recipient, plaintext));
  if (c) { samples.resolveAndSeal.push(c.ms); checkEnvelope(i, c.value); }
};
const roundTrip = async (i: number) => {
  const b = await timed(i, "rpc round trip", () => rpc.getBlockNumber({ cacheTime: 0 }));
  if (b) samples.rpcRoundTrip.push(b.ms);
};
for (let i = 0; i < N; i++) {
  for (const op of i % 2 === 0 ? [resolveThenSeal, sealTo, roundTrip] : [roundTrip, sealTo, resolveThenSeal]) await op(i);
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${N} rounds`);
}
const lastBlock = await rpc.getBlockNumber({ cacheTime: 0 });
const finishedAt = new Date();
const loadAtEnd = loadAverage();

// Gas: the receipts of the directory's own mainnet transactions, next to what deployments/143.json recorded.
const TXS = [
  { name: "deploy", hash: record.deployTx, what: "Letterlock deploy (creation code + registry argument)" },
  { name: "agentRegister", hash: record.agentRegisterTx, what: "ERC-8004 register() of agent 10260 (the registry's gas, not Letterlock's)" },
  { name: "publish", hash: record.publishTx, what: "publish(pub, 1): an address's first key" },
  { name: "publishForAgent", hash: record.publishForAgentTx, what: "publishForAgent(10260, pub, 1): an agent's first key (reads the live registry)" },
  { name: "drop", hash: record.dropTx, what: `drop() of a ${record.smokeTest.envelopeBytes}-byte envelope` },
] as const;
type GasRow = {
  name: string; what: string; tx: Hex; block: number; status: string; gasUsed: number; gasLimit: number;
  effectiveGasPriceGwei: string; costMON: string; recordedGasUsed: number | null; matchesRecord: boolean; explorer: string;
};
const gas: GasRow[] = [];
for (const t of TXS) {
  const [receipt, tx] = await Promise.all([rpc.getTransactionReceipt({ hash: t.hash }), rpc.getTransaction({ hash: t.hash })]);
  const costWei = receipt.gasUsed * receipt.effectiveGasPrice;
  gas.push({
    name: t.name,
    what: t.what,
    tx: t.hash,
    block: Number(receipt.blockNumber),
    status: receipt.status,
    gasUsed: Number(receipt.gasUsed),
    gasLimit: Number(tx.gas),
    effectiveGasPriceGwei: formatGwei(receipt.effectiveGasPrice),
    costMON: formatEther(costWei),
    recordedGasUsed: record.gasUsed[t.name] ?? null,
    matchesRecord: record.gasUsed[t.name] === Number(receipt.gasUsed),
    explorer: `${DEPLOYMENTS.monad.explorer}/tx/${t.hash}`,
  });
}
// No mainnet receipt exists yet for a rotation (a second publish): forge's gas snapshot, from a local EVM run, is shown
// for scale and labelled as such.
const snapshot = JSON.parse(readFileSync(join(ROOT, "contracts/snapshots/Letterlock.json"), "utf8")) as Record<string, string>;
const forgeSnapshot = Object.fromEntries(
  ["publish_firstKey_tx", "publish_rotate_tx", "drop_toAddress_1KiB_tx", "drop_toAddress_16KiB_tx"].map((k) => [k, Number(snapshot[k])]),
);

const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return undefined; } };
const cpus = os.cpus();
const results = {
  schema: 1,
  generatedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  command: `pnpm bench${opts.n !== "200" ? ` --n ${N}` : ""}${opts.warmup !== "5" ? ` --warmup ${WARMUP}` : ""}${opts.rpc ? ` --rpc ${rpcShown}` : ""}`,
  context: {
    machine: {
      cpu: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      model: process.platform === "darwin" ? sh("sysctl", ["-n", "hw.model"]) : undefined,
      os: process.platform === "darwin" ? `macOS ${sh("sw_vers", ["-productVersion"])} (${os.arch()})` : `${os.type()} ${os.release()} (${os.arch()})`,
    },
    /** os.loadavg() (1, 5 and 15 minutes) before the first and after the last round: seal is CPU-bound. */
    loadAverage: { start: loadAtStart, end: loadAtEnd },
    node: process.version,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sdk: { version: VERSION, runtimePaths: SDK_RUNTIME_PATHS, git: gitContext() },
    chain: { name: "Monad mainnet", chainId: 143, directory: record.address, rpc: rpcShown, blocks: [Number(firstBlock), Number(lastBlock)] },
    recipient: { address: recipient, kid: expected.kid, epoch: expected.epoch, label: "the deploy smoke test's DEMO KEY (deployments/143.json)" },
    n: N,
    warmupRounds: WARMUP,
    plaintextBytes: plaintext.length,
    envelopeBytes,
    percentiles: "nearest-rank: the sample at rank ceil(p/100 * n), 1-based; every value is a measured sample",
  },
  latencyMs: {
    resolve: summarize(samples.resolve),
    seal: summarize(samples.seal),
    resolveAndSeal: summarize(samples.resolveAndSeal),
    rpcRoundTrip: summarize(samples.rpcRoundTrip),
    coldFirstResolve: round3(cold.ms),
  },
  checks: {
    resolvesChecked,
    envelopesChecked,
    mismatches,
    failures,
    warmupFailures,
  },
  gas: { source: `eth_getTransactionReceipt and eth_getTransactionByHash on ${rpcShown} for the hashes in deployments/143.json`, receipts: gas, forgeSnapshot },
  samplesMs: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.map(round3)])),
};

const L = results.latencyMs;
const row = (name: string, what: string, s: ReturnType<typeof summarize>) =>
  `| ${name} | ${what} | ${s.n} | **${s.p50}** | ${s.p95} | ${s.p99} | ${s.min} | ${s.max} | ${s.mean} |`;
const ctx = results.context;
const g = ctx.sdk.git;
const md = `# Benchmark: resolve + seal on Monad mainnet

Measured ${results.generatedAt.slice(0, 16).replace("T", " ")} UTC with \`${results.command}\` (scripts/bench.ts). Every number below is
copied from [results.json](results.json), which also holds all ${Object.values(samples).reduce((n, v) => n + v.length, 0)} raw samples.

**resolve + seal: p50 ${L.resolveAndSeal.p50} ms · p95 ${L.resolveAndSeal.p95} ms · p99 ${L.resolveAndSeal.p99} ms** over N = ${L.resolveAndSeal.n}, against the
public RPC ${rpcShown}. Sealing alone takes p50 ${L.seal.p50} ms on this machine; the rest is one \`keyOf\` read over the network.

## Latency (milliseconds)

| Operation | What is timed | n | p50 | p95 | p99 | min | max | mean |
|---|---|---|---|---|---|---|---|---|
${row("resolve", "`ll.resolve(address)`: one `keyOf` eth_call", L.resolve)}
${row("seal", "`seal()`: HPKE to the resolved key, no network", L.seal)}
${row("resolve + seal", "`ll.sealTo(address, note)`, as one call", L.resolveAndSeal)}
${row("rpc round trip", "`eth_blockNumber` on the same RPC (context)", L.rpcRoundTrip)}

The first resolve of a new client also runs its one-time checks (\`eth_chainId\`, \`eth_getCode\` and \`NO_AGENT()\`, in
parallel with the \`keyOf\` read): it took ${L.coldFirstResolve} ms here, once, and is not in the table.

## What was checked while timing

- Recipient: \`${recipient}\`, the mainnet directory's deployer. Its key is the deploy smoke test's **DEMO KEY**
  (kid \`${expected.kid}\`, epoch ${expected.epoch}; deployments/143.json), not a passkey's.
- Every resolve (${resolvesChecked}, the cold one included) was checked against the recorded key and epoch, and every
  envelope (${envelopesChecked}) for chain 143, the directory \`${record.address}\`, the recipient and kid \`${expected.kid}\`:
  ${mismatches.length ? `**${mismatches.length} mismatch(es)**, listed in results.json.` : "no mismatch."}
- Failed calls: ${failures.length - warmupFailures} in the measured rounds, ${warmupFailures} in the warm-up.${failures.length ? " Each is listed in results.json; none was retried into the samples." : ""}
- The note is ${ctx.plaintextBytes} bytes; its envelope's wire form (what \`drop\` sends) is ${ctx.envelopeBytes} bytes.

## Gas, from mainnet receipts

${results.gas.source}. Cost is the receipt's gas used times its effective gas price.${gas.every((x) => x.gasUsed === x.gasLimit) ? " In every receipt the gas used equals the transaction's gas limit." : ""}

| Transaction | Gas used | Gas limit | Price (gwei) | Cost (MON) | Recorded | Tx |
|---|---|---|---|---|---|---|
${gas.map((x) => `| ${x.what} | ${x.gasUsed.toLocaleString("en-US")} | ${x.gasLimit.toLocaleString("en-US")} | ${x.effectiveGasPriceGwei} | ${x.costMON} | ${x.matchesRecord ? "matches" : `**differs** (${x.recordedGasUsed})`} | [${x.tx.slice(0, 10)}…](${x.explorer}) |`).join("\n")}

No mainnet rotation has happened yet, so there is no receipt for one. For scale only, forge's gas snapshot
(contracts/snapshots/Letterlock.json, a local EVM run of each call as its own transaction; not a receipt): first publish
${forgeSnapshot.publish_firstKey_tx!.toLocaleString("en-US")}, rotation ${forgeSnapshot.publish_rotate_tx!.toLocaleString("en-US")}, drop of a 1 KiB envelope ${forgeSnapshot.drop_toAddress_1KiB_tx!.toLocaleString("en-US")}, of a 16 KiB one ${forgeSnapshot.drop_toAddress_16KiB_tx!.toLocaleString("en-US")}.

## Context

| | |
|---|---|
| Date | ${results.generatedAt} to ${results.finishedAt} |
| Machine | ${ctx.machine.model ? `${ctx.machine.model}, ` : ""}${ctx.machine.cpu}, ${ctx.machine.cores} cores, ${ctx.machine.memoryGiB} GiB, ${ctx.machine.os} |
| Load average (1, 5, 15 min) | ${ctx.loadAverage.start.join(" / ")} at the start, ${ctx.loadAverage.end.join(" / ")} at the end (${ctx.machine.cores} cores) |
| Node.js | ${ctx.node} |
| Time zone of the machine | ${ctx.timeZone} |
| SDK | letterlock ${VERSION}${g ? `, runtime code at \`${g.sdkCommit.slice(0, 7)}\` (${g.sdkCommitDate})${g.sdkDirty ? ", **with uncommitted changes**" : ""}; checkout \`${g.head.slice(0, 7)}\`` : ""} |
| RPC | ${rpcShown} (Monad's public endpoint), mainnet blocks ${ctx.chain.blocks[0]} to ${ctx.chain.blocks[1]} |
| N | ${N} rounds after ${WARMUP} warm-up rounds; each round times resolve, seal, resolve + seal and an rpc round trip, in that order in even rounds and reversed in odd ones |
| Percentiles | nearest-rank (every value is a measured sample) |

The network dominates \`resolve\`: it tracks the plain \`eth_blockNumber\` round trip from this machine to the RPC, so
another location or endpoint moves it by that difference. \`seal\` is local CPU (HPKE in JavaScript: an X25519 key
generation and agreement, HKDF and ChaCha20-Poly1305) and does not depend on the chain; it varies with what else the
machine runs, hence the load average above. Nothing in the run is random except HPKE's ephemeral key, which the
protocol requires to be fresh for every seal: the note, the recipient and the order of operations are fixed.

## Reproduce

\`\`\`sh
pnpm install
pnpm bench            # N = 200; rewrites bench/results.json and bench/RESULTS.md
\`\`\`
`;

if (!opts["no-write"]) {
  mkdirSync(join(ROOT, "bench"), { recursive: true });
  writeFileSync(join(ROOT, "bench/results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(ROOT, "bench/RESULTS.md"), md);
}
const line = (name: string, s: ReturnType<typeof summarize>) =>
  `  ${name.padEnd(16)} n=${String(s.n).padEnd(4)} p50 ${String(s.p50).padStart(9)}  p95 ${String(s.p95).padStart(9)}  p99 ${String(s.p99).padStart(9)} ms`;
console.log([
  line("resolve", L.resolve),
  line("seal", L.seal),
  line("resolve+seal", L.resolveAndSeal),
  line("rpc round trip", L.rpcRoundTrip),
  `  cold first resolve ${L.coldFirstResolve} ms · envelope ${envelopeBytes} bytes · failures ${failures.length} · mismatches ${mismatches.length}`,
  ...gas.map((x) => `  gas ${x.name.padEnd(16)} ${String(x.gasUsed).padStart(9)}  ${x.costMON} MON  ${x.matchesRecord ? "matches deployments/143.json" : "DIFFERS from deployments/143.json"}`),
  opts["no-write"] ? "  (--no-write: nothing written)" : "  wrote bench/results.json and bench/RESULTS.md",
].join("\n"));
process.exitCode = mismatches.length || gas.some((x) => !x.matchesRecord || x.status !== "success") ? 1 : 0;
