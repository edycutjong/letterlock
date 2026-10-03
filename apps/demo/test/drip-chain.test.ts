// The drip route's chain side (lib/drip-server.ts): what readChainState reads and how it maps the answers, the past
// blocks it looks back to (and caches for a minute), the second RPC it asks when the first no longer holds a block, and
// the transfer broadcastDrip signs. The RPCs are a stand-in (test/rpc-stub.ts) and the drip key is a throwaway one, so
// nothing here reaches a chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { encodeFunctionResult, keccak256, parseTransaction, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { block, hex, stubRpc, type RpcHandler } from "./rpc-stub.ts";

// lib/chain.ts reaches the deployment records: a .json file loads as the module Next.js makes of it
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});

const DRIP_KEY = generatePrivateKey();
process.env.LETTERLOCK_DRIP_PRIVATE_KEY = DRIP_KEY;
const { readChainState, broadcastDrip, waitForDrip } = await import("../lib/drip-server.ts");
const { DEPLOYMENT, SCAN_RPC } = await import("../lib/chain.ts");
const { letterlockAbi } = await import("letterlock");
const { TRANSFER_GAS, walletBid } = await import("../lib/drip.ts");

const MAIN = DEPLOYMENT.rpcUrl;
const WALLET = privateKeyToAccount(DRIP_KEY).address;
const ACCOUNT = privateKeyToAccount(generatePrivateKey()).address;
const request = { address: ACCOUNT, chainId: DEPLOYMENT.chainId, minute: 0, signature: "0x" as Hex };

// a chain at block 1,000,000 that makes 2.5 blocks a second: a day back is block 784,000, an hour back 991,000, and the
// drip looks 600 blocks further back still (lib/past-blocks.ts, MARGIN_BLOCKS)
const HEAD = 1_000_000n;
const NOW = 1_800_000_000n;
const timeOf = (n: bigint) => NOW - ((HEAD - n) * 2n) / 5n;
const DAY_BLOCK = 784_000n - 600n;
const HOUR_BLOCK = 991_000n - 600n;

let stub: ReturnType<typeof stubRpc> | undefined;
afterEach(() => stub?.restore());

const lower = (a: unknown) => String(a).toLowerCase();

/** The chain as both RPCs see it; `mainHolds` says which past blocks the main RPC still answers for. */
const chain = (o: { pub: Hex; epoch: number; mainHolds: (n: bigint) => boolean; scanHolds?: (n: bigint) => boolean }) => {
  const at = (tag: unknown) => (typeof tag === "string" && tag.startsWith("0x") ? BigInt(tag) : undefined);
  const holds = (n: bigint | undefined, url: string) =>
    n === undefined || n >= HEAD - 4n || (url === MAIN ? o.mainHolds(n) : (o.scanHolds ?? (() => true))(n));
  const balanceOf = (who: string, n: bigint | undefined) =>
    who === lower(WALLET) ? (n === undefined ? 50n * 10n ** 18n : n === DAY_BLOCK ? 51n * 10n ** 18n : 50n * 10n ** 18n + 3n) : 7n;
  const nonceOf = (who: string, tag: unknown, n: bigint | undefined) =>
    who === lower(WALLET) ? (tag === "pending" ? 42 : n === undefined ? 41 : n === DAY_BLOCK ? 30 : n === HOUR_BLOCK ? 39 : 40) : 0;
  const handlers: Record<string, RpcHandler> = {
    eth_getBlockByNumber: ([tag]) => {
      const n = tag === "latest" ? HEAD : BigInt(tag as string);
      return block(n, timeOf(n));
    },
    eth_blockNumber: () => hex(HEAD),
    eth_chainId: () => hex(DEPLOYMENT.chainId),
    eth_gasPrice: () => hex(102n),
    eth_maxPriorityFeePerGas: () => hex(2n),
    eth_fillTransaction: () => ({ tx: { maxFeePerGas: hex(500n) } }),
    eth_call: () =>
      encodeFunctionResult({ abi: letterlockAbi, functionName: "keyOf", result: [o.pub, o.epoch, o.epoch ? 1_700_000_000n : 0n] }),
    eth_getBalance: ([who, tag], url) => (holds(at(tag), url) ? hex(balanceOf(lower(who), at(tag))) : undefined),
    eth_getTransactionCount: ([who, tag], url) => (holds(at(tag), url) ? hex(nonceOf(lower(who), tag, at(tag))) : undefined),
  };
  return handlers;
};

test("readChainState maps the account's key, the fees and the drip wallet's state now, 4 blocks back, an hour and a day back", async () => {
  stub = stubRpc(chain({ pub: `0x${"ab".repeat(32)}`, epoch: 1, mainHolds: () => true }));
  const s = await readChainState(request, WALLET);
  assert.deepEqual(s.account, { hasKey: true, balance: 7n, nonce: 0 });
  assert.equal(s.gasPrice, 102n);
  assert.equal(s.bidFeePerGas, walletBid(500n), "the bid is the wallet's: eth_fillTransaction's fee cap, as viem raises it");
  assert.equal(typeof s.maxFeePerGas, "bigint");
  assert.deepEqual(s.wallet, {
    balance: 50n * 10n ** 18n,
    nonce: 41,
    pendingNonce: 42,
    recentNonce: 40,
    dayAgo: { balance: 51n * 10n ** 18n, nonce: 30 },
    hourAgo: { balance: 50n * 10n ** 18n + 3n, nonce: 39 },
  });
  const recent = stub.calls.find((c) => c.method === "eth_getTransactionCount" && c.params[1] === hex(HEAD - 4n));
  assert.ok(recent, "the recent nonce is read 4 blocks under the head");
  assert.ok(stub.calls.every((c) => c.url === MAIN), "the main RPC held every block: the second one was never asked");
});

test("the past blocks are found once a minute, not on every request", async () => {
  stub = stubRpc(chain({ pub: `0x${"ab".repeat(32)}`, epoch: 1, mainHolds: () => true }));
  await readChainState(request, WALLET);
  const sampled = stub.calls.filter((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest").length;
  assert.equal(sampled, 0, "the minute-old answer from the test before is used");
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await readChainState(request, WALLET);
  } finally {
    Date.now = realNow;
  }
  assert.ok(stub.calls.filter((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest").length >= 3, "a minute later they are found again");
});

test("a key never published reads as none; a block the main RPC dropped is read from the second RPC, and one neither holds is left out", async () => {
  assert.notEqual(SCAN_RPC, MAIN, "mainnet has a second RPC for history");
  stub = stubRpc(
    chain({ pub: `0x${"00".repeat(32)}`, epoch: 0, mainHolds: (n) => n > DAY_BLOCK, scanHolds: (n) => n !== HOUR_BLOCK && n !== DAY_BLOCK }),
  );
  const none = await readChainState(request, WALLET);
  assert.equal(none.account.hasKey, false);
  assert.equal(none.wallet.dayAgo, undefined, "neither RPC holds the day-old block: the daily cap cannot be checked (CAP_UNVERIFIABLE)");
  assert.deepEqual(none.wallet.hourAgo, { balance: 50n * 10n ** 18n + 3n, nonce: 39 });

  stub.restore();
  stub = stubRpc(chain({ pub: `0x${"00".repeat(32)}`, epoch: 0, mainHolds: (n) => n > DAY_BLOCK }));
  const viaScan = await readChainState(request, WALLET);
  assert.deepEqual(viaScan.wallet.dayAgo, { balance: 51n * 10n ** 18n, nonce: 30 });
  assert.ok(
    stub.calls.some((c) => c.url === SCAN_RPC && c.method === "eth_getBalance" && c.params[1] === hex(DAY_BLOCK)),
    "the day-old balance came from the second RPC",
  );
});

test("readChainState throws when the RPC cannot answer: the route reports CHAIN_UNAVAILABLE", async () => {
  const handlers = chain({ pub: `0x${"ab".repeat(32)}`, epoch: 1, mainHolds: () => true });
  delete handlers.eth_gasPrice;
  stub = stubRpc(handlers);
  await assert.rejects(readChainState(request, WALLET));
});

test("broadcastDrip signs the transfer with the nonce it read, and never bids under the RPC's own fee estimate", async () => {
  const sent: Hex[] = [];
  const handlers = chain({ pub: `0x${"ab".repeat(32)}`, epoch: 1, mainHolds: () => true });
  handlers.eth_sendRawTransaction = ([raw]) => {
    sent.push(raw as Hex);
    return keccak256(raw as Hex);
  };
  stub = stubRpc(handlers);
  const to: Address = ACCOUNT;
  // the RPC's estimate, as viem makes it, is base fee 100 x 1.2 + priority 2 = 122: a lower cap is raised to it, a higher one is kept
  const low = await broadcastDrip(to, 1234n, 41, 1n);
  const high = await broadcastDrip(to, 1234n, 41, 10_000n);
  assert.equal(low, keccak256(sent[0]!));
  const [a, b] = sent.map((raw) => parseTransaction(raw));
  assert.deepEqual([a!.to?.toLowerCase(), a!.value, a!.nonce, a!.gas, a!.chainId], [to.toLowerCase(), 1234n, 41, TRANSFER_GAS, DEPLOYMENT.chainId]);
  assert.equal(a!.maxFeePerGas, 122n);
  assert.equal(b!.maxFeePerGas, 10_000n);
  assert.equal(a!.maxPriorityFeePerGas, 2n);
  assert.ok(high.startsWith("0x"));
});

test("broadcastDrip refuses without a drip key, before anything is sent", async () => {
  stub = stubRpc({});
  const key = process.env.LETTERLOCK_DRIP_PRIVATE_KEY;
  process.env.LETTERLOCK_DRIP_PRIVATE_KEY = "not a key";
  try {
    await assert.rejects(broadcastDrip(ACCOUNT, 1n, 0, 1n), /no drip key configured/);
  } finally {
    process.env.LETTERLOCK_DRIP_PRIVATE_KEY = key;
  }
  assert.equal(stub.calls.length, 0);
});

test("waitForDrip answers with the receipt's status and block", async () => {
  const hash = `0x${"cd".repeat(32)}` as Hex;
  const receipt = (status: "0x1" | "0x0") => ({
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash: `0x${"ef".repeat(32)}`,
    blockNumber: hex(HEAD),
    from: WALLET,
    to: ACCOUNT,
    cumulativeGasUsed: hex(21_000n),
    gasUsed: hex(21_000n),
    effectiveGasPrice: hex(122n),
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    type: "0x2",
  });
  stub = stubRpc({ eth_blockNumber: () => hex(HEAD), eth_getTransactionReceipt: () => receipt("0x1") });
  assert.deepEqual(await waitForDrip(hash), { status: "success", blockNumber: HEAD });
  stub.restore();
  stub = stubRpc({ eth_blockNumber: () => hex(HEAD), eth_getTransactionReceipt: () => receipt("0x0") });
  assert.deepEqual(await waitForDrip(hash), { status: "reverted", blockNumber: HEAD });
});
