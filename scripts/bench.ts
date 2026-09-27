// Resolve + seal latency against the live Monad mainnet directory, and the gas its real transactions paid.
//
//   pnpm bench                                  5 runs of 200 rounds against https://rpc.monad.xyz; writes
//                                               bench/results.json and bench/RESULTS.md
//   pnpm bench --runs 1 --n 20 --no-write       a quick look; nothing is written
//   pnpm bench --rpc <url>                      another endpoint (only its origin is recorded: a path may carry an API key)
//
// Read-only: no key, no transaction. The recipient is the mainnet directory's deployer, whose published key is the
// deploy smoke test's DEMO KEY (deployments/143.json); every resolve must return exactly that key and epoch.
//
// A run starts a new SDK client and a new RPC client, times the client's first resolve (its one-time chain and
// directory checks, the cold first resolve), then 5 warm-up rounds, then N measured rounds. Runs follow one another,
// so how much the numbers move from run to run is reported next to them; the headline percentiles pool every run.
// Timed with performance.now(), one operation at a time (nothing overlaps); every round runs these four, in this order
// in even rounds and in the reverse order in odd ones:
//   resolve         ll.resolve(deployer): one keyOf eth_call over HTTPS
//   seal            seal() of a fixed note to the key that resolve returned: HPKE on this machine, no network
//   resolve+seal    ll.sealTo(deployer, note): the SDK's own resolve-then-seal, timed as one call
//   rpc round trip  eth_blockNumber on the same endpoint: the network's share of a resolve, for context
// Percentiles are nearest-rank (scripts/lib/stats.ts). A call counts as a sample only when it made exactly the HTTP
// requests it should (scripts/lib/timing.ts): viem retries a failed request inside the call, so a retried call is a
// failure, reported with the others and never timed into the samples. Any failed call in a measured round, or any
// mismatch, exits 1. The gas figures are read from the receipts of the transactions deployments/143.json records.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEPLOYMENTS, VERSION, encodeEnvelope, letterlock, seal, toHex, type Envelope, type ResolvedKey } from "letterlock";
import { createPublicClient, formatEther, formatGwei, http, type Hex } from "viem";
import { monad } from "viem/chains";
import { BENCH_PATHS, ROOT, SDK_RUNTIME_PATHS, gitContext } from "./lib/git.ts";
import { SEED_NOTES } from "./lib/plan.ts";
import { round3, summarize, type Summary } from "./lib/stats.ts";
import { countRequests, timeCall } from "./lib/timing.ts";

const { values: opts } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
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
const RUNS = count("runs", opts.runs!, 1);
const N = count("n", opts.n!, 1);
const WARMUP = count("warmup", opts.warmup!, 0);
const rpcUrl = opts.rpc ?? DEPLOYMENTS.monad.rpcUrl;
const rpcShown = new URL(rpcUrl).origin; // a path or query may hold an API key: never recorded
const publicRpc = rpcShown === new URL(DEPLOYMENTS.monad.rpcUrl).origin;
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
  agentId?: number;
  /** Every key agent `agentId` has had, oldest first; epochs after the first carry their own transaction and gas. */
  agent?: { keys?: { epoch: number; publishForAgentTx?: Hex; gasUsed?: number }[] };
};
const record = JSON.parse(readFileSync(join(ROOT, "deployments/143.json"), "utf8")) as Record143;
if (record.chainId !== 143 || record.address !== DEPLOYMENTS.monad.directory)
  throw new Error("deployments/143.json and the SDK's DEPLOYMENTS.monad name different directories");

const recipient = record.deployer;
const expected = { publicKey: record.smokeTest.publishedKey.toLowerCase(), epoch: record.smokeTest.epoch, kid: record.smokeTest.kid };
const note = SEED_NOTES[0].text;
const plaintext = new TextEncoder().encode(note);

// HTTP requests each timed call makes: the cold resolve reads eth_chainId, eth_getCode, NO_AGENT() and keyOf; a warm
// resolve or sealTo one keyOf; eth_blockNumber one; seal none.
const REQUESTS = { cold: 4, resolve: 1, seal: 0, resolveAndSeal: 1, rpcRoundTrip: 1 } as const;
const requests = countRequests();

type Failure = { run: number; round: number; op: string; code: string; message: string };
const failures: Failure[] = [];
const mismatches: string[] = [];
let resolvesChecked = 0;
let envelopesChecked = 0;

/** Runs one timed operation; a failure is recorded and returns undefined. Round -1 is the cold resolve, -2 warm-up. */
const timed = async <T>(run: number, round: number, op: string, expectedRequests: number, f: () => Promise<T>) => {
  const r = await timeCall(requests, expectedRequests, f);
  if (r.ok) return r;
  failures.push({ run, round, op, code: r.code, message: hide(r.message) });
  return undefined;
};

const checkKey = (where: string, k: ResolvedKey) => {
  resolvesChecked++;
  const got = { publicKey: `0x${toHex(k.publicKey)}`, epoch: k.epoch, kid: k.kid };
  if (got.publicKey !== expected.publicKey || got.epoch !== expected.epoch || got.kid !== expected.kid)
    mismatches.push(`${where}: resolve returned ${JSON.stringify(got)}, deployments/143.json records ${JSON.stringify(expected)}`);
};
const checkEnvelope = (where: string, e: Envelope) => {
  envelopesChecked++;
  if (e.kid !== expected.kid || e.epoch !== expected.epoch || e.chainId !== 143 || e.directory !== record.address.toLowerCase() || e.recipient !== recipient.toLowerCase())
    mismatches.push(`${where}: envelope header ${JSON.stringify({ chainId: e.chainId, directory: e.directory, recipient: e.recipient, epoch: e.epoch, kid: e.kid })}`);
};

const loadAverage = () => os.loadavg().map((x) => Math.round(x * 100) / 100);
const startedAt = new Date();
const loadAtStart = loadAverage();
console.log(`bench: ${RUNS} run(s) of N=${N} (+${WARMUP} warm-up rounds each) against ${rpcShown}, recipient ${recipient} (${record.smokeTest.kid}), a ${plaintext.length}-byte note`);

const OPS = ["resolve", "seal", "resolveAndSeal", "rpcRoundTrip"] as const;
type Op = (typeof OPS)[number];
type Samples = Record<Op, number[]>;
type Run = { run: number; startedAt: string; finishedAt: string; blocks: [number, number]; coldFirstResolve: number | null; samples: Samples; failures: number };
const runs: Run[] = [];
let envelopeBytes = 0;
let warmupFailures = 0;

for (let run = 1; run <= RUNS; run++) {
  // a new client each run: its one-time checks make the first resolve cold again
  const ll = letterlock({ chain: "monad", rpcUrl });
  const rpc = createPublicClient({ chain: monad, transport: http(rpcUrl, { retryCount: 0 }) });
  const runStarted = new Date();
  const failuresBefore = failures.length;
  const cold = await timed(run, -1, "cold resolve", REQUESTS.cold, () => ll.resolve(recipient));
  if (cold) checkKey(`run ${run}, cold`, cold.value);
  if (mismatches.length) throw new Error(`the directory no longer returns the recorded DEMO KEY: ${mismatches[0]}`);

  const warmStart = failures.length;
  for (let w = 0; w < WARMUP; w++) {
    await timed(run, -2, "warm-up resolve", REQUESTS.resolve, () => ll.resolve(recipient));
    await timed(run, -2, "warm-up resolve+seal", REQUESTS.resolveAndSeal, () => ll.sealTo(recipient, plaintext));
    await timed(run, -2, "warm-up rpc round trip", REQUESTS.rpcRoundTrip, () => rpc.getBlockNumber({ cacheTime: 0 }));
  }
  warmupFailures += failures.length - warmStart;

  const samples: Samples = { resolve: [], seal: [], resolveAndSeal: [], rpcRoundTrip: [] };
  const firstBlock = await rpc.getBlockNumber({ cacheTime: 0 });
  // One round: resolve then seal its result, the SDK's sealTo, and a plain round trip. The order is reversed every
  // other round, so no operation always runs right after another one.
  const resolveThenSeal = async (i: number) => {
    const r = await timed(run, i, "resolve", REQUESTS.resolve, () => ll.resolve(recipient));
    if (!r) return;
    samples.resolve.push(r.ms);
    checkKey(`run ${run}, round ${i}`, r.value);
    const s = await timed(run, i, "seal", REQUESTS.seal, () => seal({ chainId: ll.chainId, directory: ll.directory, to: r.value, plaintext }));
    if (!s) return;
    samples.seal.push(s.ms);
    checkEnvelope(`run ${run}, round ${i}`, s.value);
    envelopeBytes = encodeEnvelope(s.value).length;
  };
  const sealTo = async (i: number) => {
    const c = await timed(run, i, "resolve+seal", REQUESTS.resolveAndSeal, () => ll.sealTo(recipient, plaintext));
    if (c) { samples.resolveAndSeal.push(c.ms); checkEnvelope(`run ${run}, round ${i}`, c.value); }
  };
  const roundTrip = async (i: number) => {
    const b = await timed(run, i, "rpc round trip", REQUESTS.rpcRoundTrip, () => rpc.getBlockNumber({ cacheTime: 0 }));
    if (b) samples.rpcRoundTrip.push(b.ms);
  };
  for (let i = 0; i < N; i++) {
    for (const op of i % 2 === 0 ? [resolveThenSeal, sealTo, roundTrip] : [roundTrip, sealTo, resolveThenSeal]) await op(i);
  }
  const lastBlock = await rpc.getBlockNumber({ cacheTime: 0 });
  runs.push({
    run, startedAt: runStarted.toISOString(), finishedAt: new Date().toISOString(), blocks: [Number(firstBlock), Number(lastBlock)],
    coldFirstResolve: cold ? round3(cold.ms) : null, samples, failures: failures.length - failuresBefore,
  });
  const p50 = samples.resolveAndSeal.length ? summarize(samples.resolveAndSeal).p50 : "-";
  console.log(`  run ${run}/${RUNS}: resolve+seal p50 ${p50} ms, cold first resolve ${cold ? round3(cold.ms) : "failed"} ms, ${failures.length - failuresBefore} failed calls`);
}
const finishedAt = new Date();
const loadAtEnd = loadAverage();
const measuredFailures = failures.filter((f) => f.round !== -2); // the measured rounds and the cold resolves, not the warm-up

// Gas: the receipts of the directory's own mainnet transactions, next to what deployments/143.json recorded. Every
// transaction deployments/143.json records, with the gas it records for it: the deploy smoke test's five, then each
// later key of the agent (a rotation: publishForAgent at the next epoch). Read with viem's default retries: not timed.
const reader = createPublicClient({ chain: monad, transport: http(rpcUrl) });
const agentId = record.agentId ?? 10260;
const TXS: { name: string; hash: Hex; what: string; recorded: number | undefined }[] = [
  { name: "deploy", hash: record.deployTx, what: "Letterlock deploy (creation code + registry argument)", recorded: record.gasUsed.deploy },
  { name: "agentRegister", hash: record.agentRegisterTx, what: `ERC-8004 register() of agent ${agentId} (the registry's gas, not Letterlock's)`, recorded: record.gasUsed.agentRegister },
  { name: "publish", hash: record.publishTx, what: "publish(pub, 1): an address's first key", recorded: record.gasUsed.publish },
  { name: "publishForAgent", hash: record.publishForAgentTx, what: `publishForAgent(${agentId}, pub, 1): an agent's first key (reads the live registry)`, recorded: record.gasUsed.publishForAgent },
  { name: "drop", hash: record.dropTx, what: `drop() of a ${record.smokeTest.envelopeBytes}-byte envelope`, recorded: record.gasUsed.drop },
  ...(record.agent?.keys ?? [])
    .filter((k) => k.epoch > 1 && k.publishForAgentTx !== undefined && k.publishForAgentTx !== record.publishForAgentTx)
    .map((k) => ({
      name: `publishForAgent epoch ${k.epoch}`,
      hash: k.publishForAgentTx!,
      what: `publishForAgent(${agentId}, pub, ${k.epoch}): the agent's key rotated to epoch ${k.epoch}`,
      recorded: k.gasUsed,
    })),
];
type GasRow = {
  name: string; what: string; tx: Hex; block: number; status: string; gasUsed: number; gasLimit: number;
  effectiveGasPriceGwei: string; costMON: string; recordedGasUsed: number | null; matchesRecord: boolean; explorer: string;
};
const gas: GasRow[] = [];
for (const t of TXS) {
  const [receipt, tx] = await Promise.all([reader.getTransactionReceipt({ hash: t.hash }), reader.getTransaction({ hash: t.hash })]);
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
    recordedGasUsed: t.recorded ?? null,
    matchesRecord: t.recorded === Number(receipt.gasUsed),
    explorer: `${DEPLOYMENTS.monad.explorer}/tx/${t.hash}`,
  });
}
// No mainnet receipt exists yet for an address's rotation (a second publish): forge's gas snapshot, from a local EVM
// run, is shown for scale and labelled as such.
const snapshot = JSON.parse(readFileSync(join(ROOT, "contracts/snapshots/Letterlock.json"), "utf8")) as Record<string, string>;
const forgeSnapshot = Object.fromEntries(
  ["publish_firstKey_tx", "publish_rotate_tx", "drop_toAddress_1KiB_tx", "drop_toAddress_16KiB_tx"].map((k) => [k, Number(snapshot[k])]),
);

const pooled = (op: Op) => runs.flatMap((r) => r.samples[op]);
const colds = runs.map((r) => r.coldFirstResolve).filter((x): x is number => x !== null);
const perRun = (r: Run) => Object.fromEntries(OPS.filter((op) => r.samples[op].length).map((op) => [op, summarize(r.samples[op])])) as Partial<Record<Op, Summary>>;
const across = (vals: number[]) => {
  const sorted = [...vals].sort((a, b) => a - b);
  return { min: sorted[0]!, median: sorted[Math.ceil(sorted.length / 2) - 1]!, max: sorted[sorted.length - 1]! };
};

const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return undefined; } };
const cpus = os.cpus();
const results = {
  schema: 2,
  generatedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  command: `pnpm bench${opts.runs !== "5" ? ` --runs ${RUNS}` : ""}${opts.n !== "200" ? ` --n ${N}` : ""}${opts.warmup !== "5" ? ` --warmup ${WARMUP}` : ""}${opts.rpc ? ` --rpc ${rpcShown}` : ""}`,
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
    sdk: { version: VERSION, runtimePaths: SDK_RUNTIME_PATHS, benchPaths: BENCH_PATHS, git: gitContext() },
    chain: { name: "Monad mainnet", chainId: 143, directory: record.address, rpc: rpcShown, publicRpc, blocks: [runs[0]!.blocks[0], runs.at(-1)!.blocks[1]] },
    recipient: { address: recipient, kid: expected.kid, epoch: expected.epoch, label: "the deploy smoke test's DEMO KEY (deployments/143.json)" },
    runs: RUNS,
    /** Measured rounds per run. */
    n: N,
    warmupRounds: WARMUP,
    plaintextBytes: plaintext.length,
    envelopeBytes,
    requestsPerCall: REQUESTS,
    retries: "viem's HTTP transport retries a failed request inside a call; a call that made more HTTP requests than requestsPerCall is a failure, never a sample",
    percentiles: "nearest-rank: the sample at rank ceil(p/100 * n), 1-based; every value is a measured sample",
  },
  /** Every run's samples pooled; coldFirstResolve holds one sample per run. */
  latencyMs: {
    ...(Object.fromEntries(OPS.map((op) => [op, summarize(pooled(op))])) as Record<Op, Summary>),
    coldFirstResolve: colds.length ? summarize(colds) : null,
  },
  /** Each run on its own, in order. */
  runs: runs.map((r) => ({ run: r.run, startedAt: r.startedAt, finishedAt: r.finishedAt, blocks: r.blocks, failures: r.failures,
    latencyMs: { ...perRun(r), coldFirstResolve: r.coldFirstResolve } })),
  /** How each statistic moved across the runs: the lowest, the median and the highest run. */
  spread: Object.fromEntries(OPS.map((op) => [op, Object.fromEntries((["p50", "p95", "p99"] as const).map((k) =>
    [k, across(runs.filter((r) => r.samples[op].length).map((r) => summarize(r.samples[op])[k]))]))])),
  checks: {
    resolvesChecked,
    envelopesChecked,
    mismatches,
    failures: measuredFailures,
    warmupFailures,
    coldFailures: failures.filter((f) => f.round === -1).length,
  },
  gas: { source: `eth_getTransactionReceipt and eth_getTransactionByHash on ${rpcShown} for the hashes in deployments/143.json`, receipts: gas, forgeSnapshot },
  samplesMs: { ...Object.fromEntries(OPS.map((op) => [op, runs.map((r) => r.samples[op].map(round3))])), coldFirstResolve: colds },
};

const L = results.latencyMs;
const S = results.spread;
const row = (name: string, what: string, s: Summary) =>
  `| ${name} | ${what} | ${s.n} | **${s.p50}** | ${s.p95} | ${s.p99} | ${s.min} | ${s.max} | ${s.mean} |`;
const ctx = results.context;
const g = ctx.sdk.git;
const sampleCount = Object.values(results.samplesMs).reduce((n, v) => n + v.flat().length, 0);
const md = `# Benchmark: resolve + seal on Monad mainnet

Measured ${results.generatedAt.slice(0, 16).replace("T", " ")} UTC with \`${results.command}\` (scripts/bench.ts). Every number below is
copied from [results.json](results.json), which also holds all ${sampleCount.toLocaleString("en-US")} raw samples.

**resolve + seal: p50 ${L.resolveAndSeal.p50} ms · p95 ${L.resolveAndSeal.p95} ms · p99 ${L.resolveAndSeal.p99} ms** over N = ${L.resolveAndSeal.n.toLocaleString("en-US")}
(${RUNS} run${RUNS === 1 ? "" : "s"} of ${N}), against ${publicRpc ? "the public RPC" : "the RPC"} ${rpcShown}. Sealing alone takes p50 ${L.seal.p50} ms on this machine; the rest is one
\`keyOf\` read over the network.${RUNS > 1 ? ` From run to run, the resolve + seal p50 ranged ${S.resolveAndSeal!.p50!.min}–${S.resolveAndSeal!.p50!.max} ms,
and the p99 ${S.resolveAndSeal!.p99!.min}–${S.resolveAndSeal!.p99!.max} ms.` : ""}

## Latency (milliseconds, every run pooled)

| Operation | What is timed | n | p50 | p95 | p99 | min | max | mean |
|---|---|---|---|---|---|---|---|---|
${row("resolve", "`ll.resolve(address)`: one `keyOf` eth_call", L.resolve)}
${row("seal", "`seal()`: HPKE to the resolved key, no network", L.seal)}
${row("resolve + seal", "`ll.sealTo(address, note)`, as one call", L.resolveAndSeal)}
${row("rpc round trip", "`eth_blockNumber` on the same RPC (context)", L.rpcRoundTrip)}

The first resolve of a new client also runs its one-time checks (\`eth_chainId\`, \`eth_getCode\` and \`NO_AGENT()\`, in
parallel with the \`keyOf\` read). Each run starts a new client, so the cold first resolve was timed once per run (the
column below): ${L.coldFirstResolve ? `p50 ${L.coldFirstResolve.p50} ms over ${L.coldFirstResolve.n} runs, min ${L.coldFirstResolve.min} ms, max ${L.coldFirstResolve.max} ms` : "every one failed"}. It is not in the table.

## Run to run

| Run | Mainnet blocks | resolve + seal p50 | p95 | p99 | resolve p50 | seal p50 | rpc round trip p50 | cold first resolve | failed calls |
|---|---|---|---|---|---|---|---|---|---|
${results.runs.map((r) => {
  const l = r.latencyMs;
  return `| ${r.run} | ${r.blocks[0]} to ${r.blocks[1]} | ${l.resolveAndSeal?.p50 ?? "-"} | ${l.resolveAndSeal?.p95 ?? "-"} | ${l.resolveAndSeal?.p99 ?? "-"} | ${l.resolve?.p50 ?? "-"} | ${l.seal?.p50 ?? "-"} | ${l.rpcRoundTrip?.p50 ?? "-"} | ${l.coldFirstResolve ?? "failed"} | ${r.failures} |`;
}).join("\n")}

The runs follow one another on one machine and one endpoint, so this spread is what the network and the machine did
in those minutes; another hour, place or endpoint moves it further.

## What was checked while timing

- Recipient: \`${recipient}\`, the mainnet directory's deployer. Its key is the deploy smoke test's **DEMO KEY**
  (kid \`${expected.kid}\`, epoch ${expected.epoch}; deployments/143.json), not a passkey's.
- Every resolve (${resolvesChecked.toLocaleString("en-US")}, the cold ones included) was checked against the recorded key and epoch, and every
  envelope (${envelopesChecked.toLocaleString("en-US")}) for chain 143, the directory \`${record.address}\`, the recipient and kid \`${expected.kid}\`:
  ${mismatches.length ? `**${mismatches.length} mismatch(es)**, listed in results.json.` : "no mismatch."}
- Every timed call had to make exactly the HTTP requests it needs (one \`keyOf\` read for a resolve or a resolve + seal,
  one \`eth_blockNumber\`, none for a seal): viem retries a failed request inside a call, and a retried call is counted as
  failed, not timed. Failed calls: ${measuredFailures.length} in the measured rounds, ${warmupFailures} in the warm-up, ${results.checks.coldFailures} cold.${failures.length ? " Each is listed in results.json." : ""}
- The note is ${ctx.plaintextBytes} bytes; its envelope's wire form (what \`drop\` sends) is ${ctx.envelopeBytes} bytes.

## Gas, from mainnet receipts

${results.gas.source}. Cost is the receipt's gas used times its effective gas price. Monad charges a transaction for its
gas limit, not for the gas its execution uses ([Monad docs: differences from Ethereum](https://docs.monad.xyz/developer-essentials/differences)),
${gas.every((x) => x.gasUsed === x.gasLimit) ? "and in every receipt below the gas used equals the transaction's gas limit: these are the gas charged, not the gas executed." : "so a receipt's gas used is what was charged."}

| Transaction | Gas used | Gas limit | Price (gwei) | Cost (MON) | Recorded | Tx |
|---|---|---|---|---|---|---|
${gas.map((x) => `| ${x.what} | ${x.gasUsed.toLocaleString("en-US")} | ${x.gasLimit.toLocaleString("en-US")} | ${x.effectiveGasPriceGwei} | ${x.costMON} | ${x.matchesRecord ? "matches" : `**differs** (${x.recordedGasUsed})`} | [${x.tx.slice(0, 10)}…](${x.explorer}) |`).join("\n")}

${gas.some((x) => x.name.startsWith("publishForAgent epoch")) ? "An agent key has been rotated on mainnet (above); no address key has been yet, so there is no receipt for an address's rotation" : "No mainnet rotation has happened yet, so there is no receipt for one"}. For scale only, forge's gas snapshot
(contracts/snapshots/Letterlock.json, a local EVM run of each call as its own transaction: gas executed, not a Monad
charge, and not a receipt): first publish ${forgeSnapshot.publish_firstKey_tx!.toLocaleString("en-US")}, rotation ${forgeSnapshot.publish_rotate_tx!.toLocaleString("en-US")}, drop of a 1 KiB envelope
${forgeSnapshot.drop_toAddress_1KiB_tx!.toLocaleString("en-US")}, of a 16 KiB one ${forgeSnapshot.drop_toAddress_16KiB_tx!.toLocaleString("en-US")}.

## Context

| | |
|---|---|
| Date | ${results.generatedAt} to ${results.finishedAt} |
| Machine | ${ctx.machine.model ? `${ctx.machine.model}, ` : ""}${ctx.machine.cpu}, ${ctx.machine.cores} cores, ${ctx.machine.memoryGiB} GiB, ${ctx.machine.os} |
| Load average (1, 5, 15 min) | ${ctx.loadAverage.start.join(" / ")} at the start, ${ctx.loadAverage.end.join(" / ")} at the end (${ctx.machine.cores} cores) |
| Node.js | ${ctx.node} |
| Time zone of the machine | ${ctx.timeZone} |
| SDK | letterlock ${VERSION}${g ? `, runtime code at \`${g.sdkCommit.slice(0, 7)}\` (${g.sdkCommitDate})${g.sdkDirty ? ", **with uncommitted changes**" : ""}` : ""} |
| Benchmark code | ${g ? `scripts/bench.ts and scripts/lib as of \`${g.benchCommit.slice(0, 7)}\`${g.benchDirty ? ", **with uncommitted changes**" : ", no uncommitted changes"}; checkout \`${g.head.slice(0, 7)}\`` : "not a git checkout"} |
| RPC | ${rpcShown} (${publicRpc ? "Monad's public endpoint" : "set with --rpc"}), mainnet blocks ${ctx.chain.blocks[0]} to ${ctx.chain.blocks[1]} |
| N | ${RUNS} run${RUNS === 1 ? "" : "s"} of ${N} rounds, each after ${WARMUP} warm-up rounds; each round times resolve, seal, resolve + seal and an rpc round trip, in that order in even rounds and reversed in odd ones |
| Percentiles | nearest-rank (every value is a measured sample) |

The network dominates \`resolve\`: it tracks the plain \`eth_blockNumber\` round trip from this machine to the RPC, so
another location or endpoint moves it by that difference. \`seal\` is local CPU (HPKE in JavaScript: an X25519 key
generation and agreement, HKDF and ChaCha20-Poly1305) and does not depend on the chain; it varies with what else the
machine runs, hence the load average above. Nothing in the run is random except HPKE's ephemeral key, which the
protocol requires to be fresh for every seal: the note, the recipient and the order of operations are fixed.

## Reproduce

\`\`\`sh
pnpm install
pnpm bench            # 5 runs of N = 200; rewrites bench/results.json and bench/RESULTS.md
\`\`\`
`;

if (!opts["no-write"]) {
  mkdirSync(join(ROOT, "bench"), { recursive: true });
  writeFileSync(join(ROOT, "bench/results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(ROOT, "bench/RESULTS.md"), md);
}
const line = (name: string, s: Summary) =>
  `  ${name.padEnd(16)} n=${String(s.n).padEnd(5)} p50 ${String(s.p50).padStart(9)}  p95 ${String(s.p95).padStart(9)}  p99 ${String(s.p99).padStart(9)} ms`;
console.log([
  line("resolve", L.resolve),
  line("seal", L.seal),
  line("resolve+seal", L.resolveAndSeal),
  line("rpc round trip", L.rpcRoundTrip),
  `  cold first resolve p50 ${L.coldFirstResolve?.p50 ?? "-"} ms (n=${L.coldFirstResolve?.n ?? 0}) · envelope ${envelopeBytes} bytes · failed calls ${measuredFailures.length} measured, ${warmupFailures} warm-up · mismatches ${mismatches.length}`,
  ...(RUNS > 1 ? [`  resolve+seal p50 across runs: ${S.resolveAndSeal!.p50!.min} to ${S.resolveAndSeal!.p50!.max} ms (median ${S.resolveAndSeal!.p50!.median} ms)`] : []),
  ...gas.map((x) => `  gas ${x.name.padEnd(26)} ${String(x.gasUsed).padStart(9)}  ${x.costMON} MON  ${x.matchesRecord ? "matches deployments/143.json" : "DIFFERS from deployments/143.json"}`),
  ...measuredFailures.slice(0, 5).map((f) => `  FAILED run ${f.run} round ${f.round} ${f.op}: ${f.code}: ${f.message}`),
  opts["no-write"] ? "  (--no-write: nothing written)" : "  wrote bench/results.json and bench/RESULTS.md",
].join("\n"));
process.exitCode = measuredFailures.length || mismatches.length || gas.some((x) => !x.matchesRecord || x.status !== "success") ? 1 : 0;
