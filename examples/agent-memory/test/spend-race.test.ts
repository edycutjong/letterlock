// What the wallet spends, on the directory bytecode (a private anvil, chain id 143): the checks that bound it are made
// on each transaction as it is signed (src/spend.ts), inside each instance's send queue, so concurrent requests, and
// two server instances, cannot spend past the reserve or the day's allowance.
//
// The private chain's base fee is set to 0, and blocks this small never raise it: every drop's fee cap is then the
// priority fee (1 gwei on anvil) and it is charged exactly that, so the test can size a balance to a number of drops.
import { NO_AGENT, encodeEnvelope, letterlockAbi, seal } from "letterlock";
import { bytesToHex, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noChain, privateChain, standIn } from "../../../packages/letterlock/test/anvil/context.ts";
import { createApp, type App } from "../src/app.ts";
import { agentChain } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const RESERVE = parseEther("0.1");

describe.skipIf(noChain)("the wallet signs only what the reserve and the day allow, checked on each drop as it is signed (anvil)", () => {
  let chain: Awaited<ReturnType<typeof privateChain>>;
  let maya: Address;
  const mayaKeys = standIn(0x6d);

  beforeAll(async () => {
    chain = await privateChain();
    await chain.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
    await chain.testClient.mine({ blocks: 1 });
    const account = await chain.fundedAccount("1");
    maya = account.address;
    await chain.client().publish({ account, keys: mayaKeys });
  });
  afterAll(() => chain?.close());

  /** A funded wallet and `instances` apps on it, each with its own chain client and send queue, as Vercel runs them. */
  const agent = async (balance: bigint, env: Record<string, string> = {}, instances = 1) => {
    const walletKey = generatePrivateKey();
    const wallet = privateKeyToAccount(walletKey).address;
    await chain.testClient.setBalance({ address: wallet, value: balance });
    const config = loadConfig({
      AGENT_ENABLED: "true",
      LETTERLOCK_AGENT_PRIVATE_KEY: walletKey,
      LETTERLOCK_DIRECTORY: chain.directory,
      MONAD_RPC_URL: chain.rpcUrl,
      AGENT_MIN_BALANCE_MON: "0.1",
      ...env,
    });
    const apps: App[] = Array.from({ length: instances }, () => createApp({ config, chain: agentChain({ ...config, pollingInterval: 50 }), log: () => undefined }));
    const remember = async (app: App, text: string, ip: string) => {
      const res = await app(new Request("https://agent.test/remember", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: maya, text }) }), ip);
      return { status: res.status, body: (await res.json()) as Json };
    };
    const sent = () => chain.publicClient.getTransactionCount({ address: wallet });
    const balanceOf = () => chain.publicClient.getBalance({ address: wallet });
    return { wallet, apps, remember, sent, balanceOf };
  };

  /** What a drop of `text` to Maya costs here: its gas (eth_estimateGas from `from`) at the fee cap the wallet will sign. */
  const costOf = async (text: string, from: Address) => {
    const envelope = await seal({ chainId: 143, directory: chain.directory, to: { recipient: maya.toLowerCase() as `0x${string}`, publicKey: mayaKeys.publicKey, epoch: 1 }, plaintext: new TextEncoder().encode(text) });
    const gas = await chain.publicClient.estimateContractGas({ account: from, address: chain.directory, abi: letterlockAbi, functionName: "drop", args: [maya, NO_AGENT, bytesToHex(encodeEnvelope(envelope))] });
    const { maxFeePerGas } = await chain.publicClient.estimateFeesPerGas();
    return { gas, fee: maxFeePerGas, cost: gas * maxFeePerGas };
  };

  it("the fee here is what the test assumes: the fee cap is the priority fee, and a drop is charged exactly that", async () => {
    const { fee } = await costOf("x", maya);
    expect(fee).toBe(1_000_000_000n);
    const a = await agent(RESERVE + parseEther("1"), { AGENT_DAILY_SPEND_PERCENT: "100" });
    const before = await a.balanceOf();
    const r = await a.remember(a.apps[0]!, "burst 0", "203.0.113.1");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(before - (await a.balanceOf())).toBe(BigInt(r.body.gasUsed) * fee);
  });

  it("8 concurrent notes, from 8 IPs, with the reserve and three and a half drops in the wallet: 3 are sent, 5 refused, the reserve kept", async () => {
    const probe = await agent(0n);
    const { cost } = await costOf("burst 0", probe.wallet); // "burst 0" to "burst 7": envelopes of one size, one gas
    const a = await agent(RESERVE + 3n * cost + cost / 2n, { AGENT_DAILY_SPEND_PERCENT: "100" });
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => a.remember(a.apps[0]!, `burst ${i}`, `203.0.113.${20 + i}`)));
    expect(all.filter((r) => r.status === 200), JSON.stringify(all.map((r) => r.body.error?.code ?? r.status))).toHaveLength(3);
    expect(all.filter((r) => r.status !== 200).map((r) => r.body.error.code)).toEqual(Array(5).fill("GAS_RESERVE"));
    expect(await a.sent()).toBe(3);
    expect((await a.balanceOf()) >= RESERVE).toBe(true);
  });

  it("the same across two server instances: still 3 sent, and the reserve kept", async () => {
    const probe = await agent(0n);
    const { cost } = await costOf("burst 0", probe.wallet);
    const a = await agent(RESERVE + 3n * cost + cost / 2n, { AGENT_DAILY_SPEND_PERCENT: "100" }, 2);
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => a.remember(a.apps[i % 2]!, `burst ${i}`, `203.0.113.${30 + i}`)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(3);
    // the rest: the reserve, or (while the instances race for one of the first nonces) a send that lost the race three times
    for (const r of all.filter((x) => x.status !== 200)) expect(["GAS_RESERVE", "CHAIN_UNAVAILABLE"], JSON.stringify(r.body)).toContain(r.body.error.code);
    expect(await a.sent()).toBe(3);
    expect((await a.balanceOf()) >= RESERVE).toBe(true);
  });

  it("the reserve counts the drop's own cost: a wallet 1 wei above it sends nothing", async () => {
    const a = await agent(RESERVE + 1n, { AGENT_DAILY_SPEND_PERCENT: "100" });
    const r = await a.remember(a.apps[0]!, "one note", "203.0.113.40");
    expect([r.status, r.body.error?.code]).toEqual([503, "GAS_RESERVE"]);
    expect(await a.sent()).toBe(0);
  });

  it("two instances, 10 concurrent notes, a cap of 3 a day: exactly 3 are sent, counted by the nonce each drop is signed with", async () => {
    const a = await agent(parseEther("10"), { AGENT_DAILY_DROP_CAP: "3" }, 2);
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => a.remember(a.apps[i % 2]!, `capped ${i}`, `203.0.113.${50 + i}`)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(3);
    // the rest: the day's cap, or (while two instances race for one of the first 3 nonces) a send that lost the race three times
    for (const r of all.filter((x) => x.status !== 200)) expect(["DAILY_CAP", "CHAIN_UNAVAILABLE"], JSON.stringify(r.body)).toContain(r.body.error.code);
    expect(all.filter((r) => r.body.error?.code === "DAILY_CAP").length).toBeGreaterThanOrEqual(5);
    expect(await a.sent()).toBe(3);
  });

  it("the day's allowance follows the wallet: 25% of it at the most a drop can cost", async () => {
    // 250,000 gas at a 1 gwei fee cap: a drop costs at most 0.00025 MON, and 25% of 0.1011 MON pays for 101 of them
    const a = await agent(parseEther("0.1011"), { AGENT_MIN_BALANCE_MON: "0.0001" });
    const health = (await (await a.apps[0]!(new Request("https://agent.test/health"), "203.0.113.70")).json()) as Json;
    expect(health.limits.dailyDrops).toMatchObject({ cap: 150, spendPercent: 25, allowedToday: 101, used: 0 });
  });

  it("no drop above the gas cap is signed: a 1,000-emoji note with AGENT_MAX_DROP_GAS 100,000 is refused, a short one is sent", async () => {
    const a = await agent(parseEther("1"), { AGENT_MAX_DROP_GAS: "100000" });
    const big = await a.remember(a.apps[0]!, "🔒".repeat(1000), "203.0.113.80");
    expect([big.status, big.body.error.code]).toEqual([422, "DROP_TOO_COSTLY"]);
    expect(await a.sent()).toBe(0);
    const small = await a.remember(a.apps[0]!, "a short note", "203.0.113.80");
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    expect(BigInt(small.body.gasUsed) <= 100_000n).toBe(true);
    expect(await a.sent()).toBe(1);
  });
});
