// Sends the seed envelopes to persona addresses: the agent side of the demo, and only that side.
//
//   pnpm seed --to 0xMAYA --old-epoch-to 0xKAI                             Monad testnet (the default)
//   pnpm seed --to 0xMAYA --old-epoch-to 0xKAI --dry-run                   resolve, seal and simulate; send nothing
//   pnpm seed --mainnet --confirm-mainnet --to 0xMAYA --old-epoch-to 0xKAI Monad mainnet: real transactions, real MON
//
// A persona's key comes from a passkey a person created on a real device, and was published from it. This script
// never creates, derives or holds a persona key: it reads each persona's key from the directory and seals to it, so
// only that persona's passkey opens what it sends. The plan is fixed (scripts/lib/plan.ts, described in
// fixtures/envelopes.json), and so is its order:
//   --to            the 4 notes, then a copy of the first with one ciphertext byte changed, which opens as TAMPERED
//   --old-epoch-to  1 note sealed to the persona's PREVIOUS epoch key, which the passkey still opens after a rotation.
//                   The persona must have rotated at least once; the key is read from the directory's KeyPublished
//                   log for that epoch, and the log of the current epoch must match keyOf, or nothing is sent.
// Sealing is randomized (a fresh HPKE ephemeral key per envelope), so the envelopes differ between runs; the notes,
// the tampered byte, the recipients and the order do not.
//
// Everything is resolved, sealed, simulated and estimated before the first transaction, and the sender must hold twice
// the estimated cost, so a refusal sends nothing. After the last drop the recipients' inboxes are read back and every
// envelope sent must be there, byte for byte. The run is recorded in fixtures/seeded/<chainId>.json after every drop
// (so a run that stops halfway says what landed); a second run to the same persona and directory is refused unless
// --again.
//
// The sending key is read from an environment variable named by --private-key-env (never from the command line):
// by default MONAD_TESTNET_PRIVATE_KEY on testnet and LETTERLOCK_AGENT_PRIVATE_KEY on mainnet. Its value is never
// printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  DEPLOYMENTS,
  NO_AGENT,
  encodeEnvelope,
  fingerprint,
  fromB64url,
  isLetterlockError,
  letterlock,
  letterlockAbi,
  seal,
  toB64url,
  type Envelope,
  type LetterlockChain,
} from "letterlock";
import { bytesToHex, createPublicClient, formatEther, formatGwei, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { ROOT } from "./lib/git.ts";
import { keyPublishedLogs } from "./lib/key-history.ts";
import { SEED_NOTES, SEED_OLD_EPOCH, SEED_TAMPER } from "./lib/plan.ts";

const USAGE = `usage: pnpm seed --to <address> [--old-epoch-to <address>] [options]

  --to <address>              persona that receives the ${SEED_NOTES.length} notes and the tampered copy (needs a published key)
  --old-epoch-to <address>    persona that has rotated: receives one note sealed to its previous epoch's key
  --mainnet                   Monad mainnet (default: Monad testnet)
  --confirm-mainnet           required with --mainnet to send: every drop is a transaction that spends MON
  --dry-run                   resolve, seal, simulate and estimate; send nothing, record nothing
  --private-key-env <NAME>    environment variable holding the sender's key
                              (default: MONAD_TESTNET_PRIVATE_KEY on testnet, LETTERLOCK_AGENT_PRIVATE_KEY on mainnet)
  --rpc <url>                 JSON-RPC endpoint (default: the chain's public RPC)
  --directory <address>       another Letterlock directory (a local test deploy); needs --from-block
  --from-block <n>            first block of KeyPublished history to search (default: the directory's deploy block)
  --record <file>             where to record the run (default: fixtures/seeded/<chainId>.json)
  --again                     send even though the record has a run to this persona and directory
`;

/** Nothing was sent: a bad command line (printed with the usage), or a check that failed before the first drop. */
class Refusal extends Error {
  readonly usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.usage = usage;
  }
}
const refuse = (message: string): never => { throw new Refusal(message); };
const usage = (message: string): never => { throw new Refusal(message, true); };

const { values: o } = parseArgs({
  options: {
    to: { type: "string" },
    "old-epoch-to": { type: "string" },
    mainnet: { type: "boolean", default: false },
    "confirm-mainnet": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "private-key-env": { type: "string" },
    rpc: { type: "string" },
    directory: { type: "string" },
    "from-block": { type: "string" },
    record: { type: "string" },
    again: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

type Planned = { id: string; recipient: Address; envelope: Envelope; wire: Uint8Array; expect: string };
type Sent = Planned & { tx: Hex; block: bigint; gasUsed: bigint };

const main = async (): Promise<number> => {
  if (o.help) { process.stdout.write(USAGE); return 0; }
  if (!o.to) usage("--to <address> is required: the persona that receives the notes");
  const address = (flag: string, v: string): Address => {
    if (!isAddress(v)) usage(`${flag} must be a 0x address with a valid EIP-55 checksum (or all lower-case)`);
    return getAddress(v);
  };
  const to = address("--to", o.to!);
  const oldTo = o["old-epoch-to"] === undefined ? undefined : address("--old-epoch-to", o["old-epoch-to"]);
  if (o.mainnet && !o["confirm-mainnet"] && !o["dry-run"])
    usage("--mainnet sends real transactions that spend MON: add --confirm-mainnet to send, or --dry-run to only simulate");
  if (o.directory !== undefined && o["from-block"] === undefined)
    usage("--directory needs --from-block: the script knows the deploy block of the built-in directories only");

  const chain: LetterlockChain = o.mainnet ? "monad" : "monad-testnet";
  const deployment = DEPLOYMENTS[chain];
  const keyEnv = o["private-key-env"] ?? (o.mainnet ? "LETTERLOCK_AGENT_PRIVATE_KEY" : "MONAD_TESTNET_PRIVATE_KEY");
  const raw = process.env[keyEnv]?.trim();
  if (!raw) usage(`environment variable ${keyEnv} is not set (--private-key-env names the variable that holds the sender's key)`);
  const hexKey = (raw!.startsWith("0x") ? raw! : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hexKey)) usage(`environment variable ${keyEnv} does not hold a 32-byte hex private key`);
  const account = privateKeyToAccount(hexKey);

  const directory = o.directory === undefined ? getAddress(deployment.directory) : address("--directory", o.directory);
  if (o["from-block"] !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(o["from-block"])) usage("--from-block must be a block number");
  const fromBlock = o["from-block"] === undefined ? deployment.deployBlock : BigInt(o["from-block"]);
  const rpcUrl = o.rpc ?? deployment.rpcUrl;
  const explorer = o.directory === undefined && o.rpc === undefined ? deployment.explorer : undefined;
  const ll = letterlock({ chain, rpcUrl, directory, deployBlock: fromBlock, pollingInterval: 250 });
  const rpc = createPublicClient({ chain: o.mainnet ? monad : monadTestnet, transport: http(rpcUrl) });
  const recordFile = o.record ?? join(ROOT, `fixtures/seeded/${deployment.chainId}.json`);
  const shown = (f: string) => relative(process.cwd(), f) || f;

  console.log(`seed: ${deployment.network} (${deployment.chainId}), directory ${directory}, from ${account.address} (key from $${keyEnv})${o["dry-run"] ? ", DRY RUN" : ""}`);

  type Drop = { id: string; recipient: string; epoch: number; kid: string; bytes: number; tx: Hex; block: number; gasUsed: number; explorer?: string; expect: string; envelope: Envelope };
  type Run = { at: string; chainId: number; network: string; directory: string; sender: string; status: string; drops: Drop[] };
  const record: { about: string; runs: Run[] } = existsSync(recordFile)
    ? JSON.parse(readFileSync(recordFile, "utf8"))
    : { about: `Envelopes scripts/seed.ts dropped on ${deployment.network}. Each is sealed to a persona's key from a real passkey, so only that passkey opens it; "expect" is what it shows then.`, runs: [] };
  const already = record.runs.find((r) => r.chainId === deployment.chainId && r.directory.toLowerCase() === directory.toLowerCase() &&
    r.drops.some((d) => d.recipient.toLowerCase() === to.toLowerCase()));
  if (already && !o.again && !o["dry-run"])
    refuse(`${shown(recordFile)} already has a run to ${to} on this directory (${already.at}); pass --again to send the notes a second time`);

  // 1. Keys: one keyOf read for --to; for --old-epoch-to its current key and the KeyPublished log of the one before.
  const key = await ll.resolve(to);
  console.log(`  ${to}  epoch ${key.epoch}  kid ${key.kid}  (keyOf)`);
  const plaintext = (s: string) => new TextEncoder().encode(s);
  const planned: Planned[] = [];
  const add = (id: string, envelope: Envelope, expect: string) =>
    planned.push({ id, recipient: getAddress(envelope.recipient), envelope, wire: encodeEnvelope(envelope), expect });
  for (const n of SEED_NOTES)
    add(n.id, await seal({ chainId: ll.chainId, directory: ll.directory, to: key, plaintext: plaintext(n.text) }), "OPENS with the persona's passkey");
  const source = planned.find((p) => p.id === SEED_TAMPER.from)!.envelope;
  const ct = fromB64url(source.ct);
  ct[SEED_TAMPER.ctByte] = ct[SEED_TAMPER.ctByte]! ^ SEED_TAMPER.xor;
  add(`${SEED_TAMPER.from}-tampered`, { ...source, ct: toB64url(ct) }, `TAMPERED: a copy of "${SEED_TAMPER.from}" with ciphertext byte ${SEED_TAMPER.ctByte} changed`);

  if (oldTo) {
    const current = await ll.resolve(oldTo);
    if (current.epoch < 2) refuse(`${oldTo} is at epoch ${current.epoch}: it has not rotated, so it has no previous key. Rotate from its passkey first`);
    const want = current.epoch - 1;
    const logs = await keyPublishedLogs(rpc, directory, oldTo, [current.epoch, want], fromBlock,
      { onProgress: (p) => console.log(`  searching KeyPublished logs of ${oldTo}: down to block ${p.block} (${p.requests} requests)`) });
    const now = logs.get(current.epoch);
    const previous = logs.get(want);
    if (!now || bytesToHex(now.publicKey) !== bytesToHex(current.publicKey))
      refuse(`the KeyPublished log of ${oldTo}'s epoch ${current.epoch} ${now ? "does not carry the key keyOf returns" : `is not between block ${fromBlock} and the head`}`);
    if (!previous) return refuse(`no KeyPublished log of ${oldTo}'s epoch ${want} between block ${fromBlock} and the head`);
    const kid = fingerprint(previous.publicKey);
    console.log(`  ${oldTo}  epoch ${current.epoch}  kid ${current.kid}  (keyOf); epoch ${want}  kid ${kid}  (KeyPublished in block ${previous.block})`);
    add(SEED_OLD_EPOCH.id, await seal({ chainId: ll.chainId, directory: ll.directory, to: { recipient: oldTo, publicKey: previous.publicKey, epoch: want }, plaintext: plaintext(SEED_OLD_EPOCH.text) }),
      `OPENS with the persona's passkey at epoch ${want}; EPOCH_MISMATCH with its epoch-${current.epoch} key`);
  } else {
    console.log("  (no --old-epoch-to: the old-epoch note is skipped)");
  }

  // 2. Simulate and estimate every drop, and check the balance, before anything is sent.
  const gasPrice = await rpc.getGasPrice();
  let totalGas = 0n;
  for (const p of planned) {
    const call = { account, address: directory, abi: letterlockAbi, functionName: "drop", args: [p.recipient, NO_AGENT, bytesToHex(p.wire)] } as const;
    try {
      await rpc.simulateContract(call);
      totalGas += await rpc.estimateContractGas(call);
    } catch (e) {
      refuse(`the directory refuses the drop "${p.id}" to ${p.recipient}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const balance = await rpc.getBalance({ address: account.address });
  const cost = totalGas * gasPrice;
  console.log(`  ${planned.length} drops, about ${totalGas.toLocaleString("en-US")} gas, about ${formatEther(cost)} MON at ${formatGwei(gasPrice)} gwei; sender balance ${formatEther(balance)} MON`);
  // twice the estimate: a wallet may offer up to about twice the current price, and a drop that runs out of funds halfway
  // leaves a half-seeded inbox
  if (balance < 2n * cost) refuse(`the sender holds ${formatEther(balance)} MON; the drops need about ${formatEther(cost)} MON, and the script asks for twice that`);
  for (const p of planned) console.log(`    ${p.id.padEnd(18)} → ${p.recipient}  epoch ${p.envelope.epoch}  kid ${p.envelope.kid}  ${p.wire.length} B  expect ${p.expect.split(":")[0]}`);
  if (o["dry-run"]) { console.log("dry run: nothing sent, nothing recorded"); return 0; }

  // 3. Send, in the plan's order. The record is written after every drop, so a run that stops halfway says what landed
  // (and a second run to the same persona is refused without --again).
  const run: Run = { at: new Date().toISOString(), chainId: deployment.chainId, network: deployment.network, directory, sender: account.address, status: "sending", drops: [] };
  record.runs.push(run);
  const save = () => {
    mkdirSync(dirname(recordFile), { recursive: true });
    writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  };
  const sent: Sent[] = [];
  for (const p of planned) {
    let r;
    try {
      r = await ll.drop({ account, envelope: p.envelope });
    } catch (e) {
      run.status = `stopped at "${p.id}": ${isLetterlockError(e) ? e.message : (e as Error).message.split("\n")[0]}`;
      if (sent.length) save();
      throw e;
    }
    sent.push({ ...p, tx: r.transactionHash, block: r.blockNumber, gasUsed: r.gasUsed });
    run.drops.push({
      id: p.id,
      recipient: p.recipient,
      epoch: p.envelope.epoch,
      kid: p.envelope.kid,
      bytes: p.wire.length,
      tx: r.transactionHash,
      block: Number(r.blockNumber),
      gasUsed: Number(r.gasUsed),
      ...(explorer ? { explorer: `${explorer}/tx/${r.transactionHash}` } : {}),
      expect: p.expect,
      envelope: p.envelope,
    });
    save();
    console.log(`    sent ${p.id.padEnd(18)} tx ${r.transactionHash}  block ${r.blockNumber}  gas ${r.gasUsed}${explorer ? `  ${explorer}/tx/${r.transactionHash}` : ""}`);
  }

  // 4. Read the inboxes back: every envelope sent is there, in its transaction, byte for byte.
  const first = sent.reduce((m, s) => (s.block < m ? s.block : m), sent[0]!.block);
  for (const recipient of [...new Set(sent.map((s) => s.recipient))]) {
    const mine = sent.filter((s) => s.recipient === recipient);
    let missing = mine;
    for (let attempt = 0; attempt < 10 && missing.length; attempt++) {
      if (attempt) await new Promise((res) => setTimeout(res, 1000)); // a load-balanced RPC may answer from a node a block behind
      const box = await ll.inbox(recipient, { fromBlock: first, toBlock: "latest" });
      missing = mine.filter((s) => !box.envelopes.some((e) => e.transactionHash === s.tx && bytesToHex(encodeEnvelope(e.envelope)) === bytesToHex(s.wire)));
    }
    if (missing.length) {
      run.status = `sent; read back ${recipient}: ${missing.map((m) => m.id).join(", ")} not found in its inbox`;
      save();
      throw new Error(run.status);
    }
    console.log(`  read back ${recipient}: ${mine.length} of ${mine.length} envelopes in its inbox, byte for byte`);
  }
  run.status = `sent and read back: all ${sent.length} envelopes in their recipients' inboxes, byte for byte`;
  save();
  console.log(`recorded in ${shown(recordFile)}: ${sent.length} drops, ${sent.reduce((g, s) => g + s.gasUsed, 0n).toLocaleString("en-US")} gas`);
  return 0;
};

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof Refusal) {
    process.stderr.write(`seed: ${e.message}\n${e.usage ? `\n${USAGE}` : "nothing was sent\n"}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`seed: ${isLetterlockError(e) ? e.message : e instanceof Error ? e.message.split("\n")[0] : String(e)}\n`);
    process.exitCode = 1;
  }
}
