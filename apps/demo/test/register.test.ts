// The register's chain reads (lib/register.ts): KeyPublished logs as lines (to an address and to an agent), the range
// narrowed when an RPC refuses one too wide, the binary searches for a timestamp's block and for an address's first key,
// and the publish of one key found again. The RPCs are a stand-in (test/rpc-stub.ts): nothing here reaches a chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { block, hex, stubRpc, type RpcHandler } from "./rpc-stub.ts";

// lib/register.ts reaches the deployment records through lib/chain.ts: a .json file loads as the module Next.js makes of it
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});
const { readKeyLines, firstBlockAt, scanHead, findPublish, firstKeyBlock } = await import("../lib/register.ts");
const { DEPLOYMENT, SCAN_RPC } = await import("../lib/chain.ts");
const { NO_AGENT, letterlockAbi, fingerprint, fromHex, isLetterlockError } = await import("letterlock");

let stub: ReturnType<typeof stubRpc> | undefined;
afterEach(() => stub?.restore());

const DEPLOY = BigInt(DEPLOYMENT.deployBlock);
const who = privateKeyToAccount(generatePrivateKey()).address;
const pub = (b: number): Hex => `0x${b.toString(16).padStart(2, "0").repeat(32)}`;

/** A KeyPublished log as eth_getLogs answers it. */
const keyLog = (o: { who: Address; agentId?: bigint; pub: Hex; epoch: number; block: bigint; logIndex: number; tx: number; at?: bigint }) => ({
  address: DEPLOYMENT.directory,
  topics: encodeEventTopics({ abi: letterlockAbi, eventName: "KeyPublished", args: { who: o.who, agentId: o.agentId ?? NO_AGENT } }),
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], [o.pub, o.epoch]),
  blockNumber: hex(o.block),
  blockHash: `0x${"11".repeat(32)}`,
  transactionHash: `0x${o.tx.toString(16).padStart(64, "0")}`,
  transactionIndex: "0x0",
  logIndex: hex(o.logIndex),
  removed: false,
  ...(o.at === undefined ? {} : { blockTimestamp: hex(o.at) }),
});

test("KeyPublished logs become the register's lines, oldest first, to an address and to an agent", async () => {
  stub = stubRpc({
    eth_getLogs: () => [
      keyLog({ who, agentId: 10260n, pub: pub(2), epoch: 3, block: DEPLOY + 9n, logIndex: 1, tx: 2 }),
      keyLog({ who, pub: pub(1), epoch: 1, block: DEPLOY + 5n, logIndex: 0, tx: 1, at: 1_790_000_000n }),
    ],
  });
  const progress: [bigint, bigint][] = [];
  const lines = await readKeyLines({ fromBlock: DEPLOY, toBlock: DEPLOY + 9n, onProgress: (d, t) => progress.push([d, t]) });
  assert.deepEqual(lines, [
    {
      id: `0x${"1".padStart(64, "0")}:0`,
      recipient: who.toLowerCase(),
      publisher: who,
      publicKey: pub(1),
      fingerprint: fingerprint(fromHex(pub(1))),
      epoch: 1,
      block: Number(DEPLOY + 5n),
      txHash: `0x${"1".padStart(64, "0")}`,
      logIndex: 0,
      at: 1_790_000_000,
    },
    {
      id: `0x${"2".padStart(64, "0")}:1`,
      recipient: "agent:10260",
      publisher: who,
      publicKey: pub(2),
      fingerprint: fingerprint(fromHex(pub(2))),
      epoch: 3,
      block: Number(DEPLOY + 9n),
      txHash: `0x${"2".padStart(64, "0")}`,
      logIndex: 1,
    },
  ]);
  assert.deepEqual(progress, [[10n, 10n]]);
  assert.ok(stub.calls.every((c) => c.url === SCAN_RPC), "the register reads over the scan RPC");
});

test("a range the RPC refuses is split to the size it names, or to a tenth when it names none, and every block is still read", async () => {
  const asked: [bigint, bigint][] = [];
  const refuse = (limit: number | undefined): RpcHandler => ([q]) => {
    const { fromBlock, toBlock } = q as { fromBlock: Hex; toBlock: Hex };
    const [lo, hi] = [BigInt(fromBlock), BigInt(toBlock)];
    asked.push([lo, hi]);
    return hi - lo + 1n > BigInt(limit ?? 100) ? undefined : [];
  };
  // the stub answers a refusal with "missing trie node": swap in the RPC's wording
  const wording = (message: string) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await real(input, init);
      const text = (await res.text()).replace("missing trie node", message);
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return () => void (globalThis.fetch = real);
  };

  stub = stubRpc({ eth_getLogs: refuse(250) });
  let undo = wording("eth_getLogs is limited to a 250 range");
  await readKeyLines({ fromBlock: 0n, toBlock: 1_999n });
  undo();
  assert.deepEqual(asked[0], [0n, 1_999n], "the whole range first");
  assert.ok(asked.slice(1).every(([lo, hi]) => hi - lo + 1n <= 250n), "then pages of the size the RPC named");
  const covered = new Set(asked.slice(1).flatMap(([lo, hi]) => Array.from({ length: Number(hi - lo + 1n) }, (_, i) => Number(lo) + i)));
  assert.equal(covered.size, 2_000);

  stub.restore();
  asked.length = 0;
  stub = stubRpc({ eth_getLogs: refuse(100) });
  undo = wording("query exceeds max results");
  await readKeyLines({ fromBlock: 0n, toBlock: 999n });
  undo();
  assert.deepEqual(asked[1], [0n, 99n], "no size named: a tenth of the range");
});

test("any other refusal is the SDK's chain error, naming the blocks", async () => {
  stub = stubRpc({ eth_getLogs: () => undefined });
  await assert.rejects(readKeyLines({ fromBlock: 5n, toBlock: 5n }), (e) => isLetterlockError(e) && /blocks 5 to 5/.test(String(e)));
  stub.restore();
  stub = stubRpc({});
  await assert.rejects(scanHead(), (e) => isLetterlockError(e) && /head block/.test(String(e)));
});

test("firstBlockAt finds the first block at or after a timestamp", async () => {
  const head = DEPLOY + 1_000n;
  const at = (n: bigint) => 1_790_000_000n + (n - DEPLOY) * 2n; // a block every 2 s from the deploy
  stub = stubRpc({ eth_blockNumber: () => hex(head), eth_getBlockByNumber: ([tag]) => block(BigInt(tag as string), at(BigInt(tag as string))) });
  assert.equal(await firstBlockAt(1_790_000_301), DEPLOY + 151n);
  assert.equal(await firstBlockAt(1_790_000_300), DEPLOY + 150n);
  assert.ok(stub.calls.filter((c) => c.method === "eth_getBlockByNumber").length <= 2 * 11, "a binary search: about log2(1,000) reads each");
  stub.restore();
  stub = stubRpc({});
  await assert.rejects(firstBlockAt(1), (e) => isLetterlockError(e) && /block of a key's publish/.test(String(e)));
});

test("findPublish scans the whole register on mainnet and returns the last publish of that address at that epoch", async () => {
  const other = privateKeyToAccount(generatePrivateKey()).address;
  stub = stubRpc({
    eth_blockNumber: () => hex(DEPLOY + 50n),
    eth_getLogs: () => [
      keyLog({ who, pub: pub(1), epoch: 1, block: DEPLOY + 1n, logIndex: 0, tx: 1 }),
      keyLog({ who, pub: pub(2), epoch: 2, block: DEPLOY + 2n, logIndex: 0, tx: 2 }),
      keyLog({ who: other, pub: pub(3), epoch: 2, block: DEPLOY + 3n, logIndex: 0, tx: 3 }),
    ],
  });
  const line = await findPublish(who, 2, 0);
  assert.equal(line?.publicKey, pub(2));
  assert.equal(await findPublish(who, 9, 0), undefined);
  const logs = stub.calls.find((c) => c.method === "eth_getLogs")!.params[0] as { fromBlock: Hex; toBlock: Hex };
  assert.deepEqual([BigInt(logs.fromBlock), BigInt(logs.toBlock)], [DEPLOY, DEPLOY + 50n]);
});

test("firstKeyBlock finds the block an address first had a key, and is undefined when the RPC no longer holds that state", async () => {
  const head = DEPLOY + 1_000n;
  const published = DEPLOY + 377n;
  const keyOf: RpcHandler = ([, tag]) =>
    encodeFunctionResult({ abi: letterlockAbi, functionName: "keyOf", result: BigInt(tag as string) >= published ? [pub(1), 1, 1n] : [pub(0), 0, 0n] });
  stub = stubRpc({ eth_blockNumber: () => hex(head), eth_call: keyOf });
  assert.equal(await firstKeyBlock(who), published);

  stub.restore();
  stub = stubRpc({ eth_blockNumber: () => hex(head) });
  assert.equal(await firstKeyBlock(who), undefined);

  stub.restore();
  stub = stubRpc({});
  await assert.rejects(firstKeyBlock(who), (e) => isLetterlockError(e) && /head block/.test(String(e)));
});
