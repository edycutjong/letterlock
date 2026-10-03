// The page's postage reads (lib/gas.ts): what a transaction needs in the passkey account, the gas a drop() is estimated
// at (to a person and to an agent), the wait for the drip's MON as consensus sees it (three blocks back), and the drip
// request's answers that are not the drip's own (no answer at all; the drip busy). The RPC is a stand-in
// (test/rpc-stub.ts): nothing here reaches a chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { decodeFunctionData, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hex, stubRpc } from "./rpc-stub.ts";

// lib/gas.ts reaches the deployment records through lib/chain.ts: a .json file loads as the module Next.js makes of it
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});
const { postageFor, publishPostage, dropGas, waitForFunds, requestDrip } = await import("../lib/gas.ts");
const { DripRefused } = await import("../lib/failure.ts");
const { PUBLISH_GAS, walletBid } = await import("../lib/drip.ts");
const { DEPLOYMENT } = await import("../lib/chain.ts");
const { NO_AGENT, letterlockAbi, isLetterlockError } = await import("letterlock");

const account = privateKeyToAccount(generatePrivateKey());
let stub: ReturnType<typeof stubRpc> | undefined;
afterEach(() => stub?.restore());

const envelope = (recipient: string) => ({
  v: 1 as const,
  chainId: DEPLOYMENT.chainId,
  directory: DEPLOYMENT.directory,
  recipient: recipient as `0x${string}`,
  epoch: 1,
  kid: "0123456789abcdef",
  enc: "AAAA",
  ct: "AAAA",
});

test("postage is the gas at the fee cap the wallet will bid, beside the account's balance", async () => {
  stub = stubRpc({ eth_getBalance: () => hex(5_000n), eth_fillTransaction: () => ({ tx: { maxFeePerGas: hex(100n) } }) });
  assert.deepEqual(await postageFor(account.address, 21_000n), { balance: 5_000n, needed: 21_000n * walletBid(100n) });
  assert.deepEqual(await publishPostage(account.address), { balance: 5_000n, needed: PUBLISH_GAS * walletBid(100n) });
});

test("a failed postage read is the SDK's chain error, named for what was being read", async () => {
  stub = stubRpc({ eth_fillTransaction: () => ({ tx: { maxFeePerGas: hex(100n) } }) }); // no eth_getBalance
  await assert.rejects(postageFor(account.address, 21_000n), (e) => isLetterlockError(e) && /balance and the fee cap/.test(String(e)));
});

test("a drop's gas is estimated with the envelope's bytes, to an address and to an agent", async () => {
  const sent: Hex[] = [];
  stub = stubRpc({
    eth_estimateGas: ([tx]) => {
      sent.push((tx as { data: Hex }).data);
      return hex(84_000n);
    },
  });
  const to = privateKeyToAccount(generatePrivateKey()).address;
  assert.equal(await dropGas(account.address, envelope(to.toLowerCase())), 84_000n);
  assert.equal(await dropGas(account.address, envelope("agent:10260")), 84_000n);
  const [person, agent] = sent.map((data) => decodeFunctionData({ abi: letterlockAbi, data }));
  assert.equal(person!.functionName, "drop");
  assert.deepEqual([String(person!.args![0]).toLowerCase(), person!.args![1]], [to.toLowerCase(), NO_AGENT]);
  assert.deepEqual([agent!.args![0], agent!.args![1]], [zeroAddress, 10260n]);
  assert.ok(stub.calls.every((c) => (c.params[0] as { to: string }).to.toLowerCase() === DEPLOYMENT.directory.toLowerCase()));
});

test("a failed estimate is the SDK's chain error", async () => {
  stub = stubRpc({});
  await assert.rejects(dropGas(account.address, envelope("agent:10260")), (e) => isLetterlockError(e) && /estimating the drop's gas/.test(String(e)));
});

test("the wait reads the balance three blocks back, and asks again after a failed read or a short balance", async () => {
  let reads = 0;
  stub = stubRpc({
    eth_blockNumber: () => hex(1_000n),
    eth_getBalance: () => (++reads === 1 ? undefined : hex(reads === 2 ? 10n : 500n)),
  });
  assert.equal(await waitForFunds(account.address, 500n, 10_000), 500n);
  assert.equal(reads, 3, "a failed read, then a balance short of what is needed, then enough");
  assert.ok(stub.calls.filter((c) => c.method === "eth_getBalance").every((c) => c.params[1] === hex(997n)));
});

test("the wait gives up as NOT_ARRIVED when the MON does not arrive in time", async () => {
  stub = stubRpc({ eth_blockNumber: () => hex(2n), eth_getBalance: () => hex(0n) });
  await assert.rejects(waitForFunds(account.address, 1n, -1), (e) => e instanceof DripRefused && e.code === "NOT_ARRIVED");
  assert.equal(stub.calls.find((c) => c.method === "eth_getBalance")?.params[1], hex(2n), "a chain under 4 blocks reads at the head");
});

test("a drip that cannot be reached is UNREACHABLE; a busy drip is asked again", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(requestDrip(account), (e) => e instanceof DripRefused && e.code === "UNREACHABLE");

    const answers = [
      { status: 503, body: { error: "DRIP_BUSY", message: "busy" } },
      { status: 200, body: { dripped: false } },
    ];
    let asked = 0;
    globalThis.fetch = (async () => {
      const a = answers[asked++]!;
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch;
    assert.equal(await requestDrip(account), undefined);
    assert.equal(asked, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
