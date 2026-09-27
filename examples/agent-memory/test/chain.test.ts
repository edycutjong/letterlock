// The agent against the real directory bytecode on a local anvil (chain id 143), with the SDK's test-double ERC-8004
// registry at the mainnet registry address: the same path as mainnet, end to end. As on mainnet, the agent's epoch-1
// key is a stand-in it does not hold, and its epoch-2 key comes from its seed.
//   an owner mints the agent, publishes epoch 1 (a stand-in), then epoch 2 from the agent's seed
//   POST /remember → the drop is in Maya's inbox and opens with her key
//   a second agent seals a task to agent:<id> through keyOfAgent → POST /task → the answer is in ITS inbox and opens
//   the daily cap counts the wallet's transactions onchain
import { createHash, randomBytes } from "node:crypto";
import { open, seal, toHex, type Envelope, type Recipient } from "letterlock";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  agentStandIn,
  anvil,
  client,
  fund,
  fundedAccount,
  newAgentId,
  noChain,
  publicClient,
  registryAbi,
  sendAs,
  standIn,
} from "../../../packages/letterlock/test/anvil/context.ts";
import { agentPublicKey } from "../src/agent-key.ts";
import { createApp, type App } from "../src/app.ts";
import { agentChain, firstBlockAtOrAfter } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { encodeTask, newNonce, parseReply } from "../src/task.ts";

const IP = "203.0.113.7";
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(noChain)("the agent on the directory bytecode (anvil, chain id 143, ERC-8004 test double)", () => {
  const agentId = newAgentId();
  const callerId = newAgentId();
  const seedHex = toHex(randomBytes(32));
  const walletKey = generatePrivateKey();
  const wallet = privateKeyToAccount(walletKey).address;
  const env = () => ({
    AGENT_ENABLED: "true",
    LETTERLOCK_AGENT_PRIVATE_KEY: walletKey,
    LETTERLOCK_AGENT_KEY_SEED: seedHex,
    LETTERLOCK_AGENT_ID: agentId.toString(),
    LETTERLOCK_DIRECTORY: anvil().directory,
    LETTERLOCK_DEPLOY_BLOCK: anvil().deployBlock,
    MONAD_RPC_URL: anvil().rpcUrl,
  });
  const maya = standIn(0x6d); // Maya's key, as her passkey would derive it
  const caller = agentStandIn(0x63, callerId, 1); // the calling agent's key, derived for that agent
  let mayaAddress: `0x${string}`;
  let app: App;
  const post = async (a: App, path: string, body: unknown) => {
    const res = await a(new Request(`https://agent.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), IP);
    return { status: res.status, body: (await res.json()) as Json };
  };
  const appFor = (over: Record<string, string> = {}) => {
    const config = loadConfig({ ...env(), ...over });
    return createApp({ config, chain: agentChain({ ...config, pollingInterval: 50 }), log: () => undefined });
  };

  beforeAll(async () => {
    const owner = await fundedAccount("1");
    const callerOwner = await fundedAccount("1");
    await sendAs(anvil().registry, registryAbi, "mint", [owner.address, agentId]);
    await sendAs(anvil().registry, registryAbi, "mint", [callerOwner.address, callerId]);
    // epoch 1: a key the agent does not hold (on mainnet, the deploy smoke test's demo key)
    await client().publishForAgent({ account: owner, agentId, keys: agentStandIn(0x41, agentId, 1) });
    // epoch 2: from the agent's seed. It has no passkey and so no rpId: unsafeAllowAnyRpId takes such a key (the
    // agent-id and owner-key checks still run), as scripts/publish-agent-key.ts does on mainnet
    const seeded = agentPublicKey(Buffer.from(seedHex, "hex"), agentId, 2);
    await client({ unsafeAllowAnyRpId: true }).publishForAgent({ account: owner, agentId, keys: { publicKey: seeded.publicKey, epoch: 2, agentId } });
    await client().publishForAgent({ account: callerOwner, agentId: callerId, keys: caller });
    const mayaAccount = await fundedAccount("1");
    mayaAddress = mayaAccount.address;
    await client().publish({ account: mayaAccount, keys: maya });
    await fund(wallet, "1");
    app = appFor();
  });

  it("/health: the key published for the agent is the one its seed derives, at epoch 2", async () => {
    const res = await app(new Request("https://agent.test/health"), IP);
    const body = (await res.json()) as Json;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      agent: { recipient: `agent:${agentId}` },
      chain: { chainId: 143, directory: anvil().directory },
      wallet: { address: wallet, balance: "1 MON", nonce: 0 },
      key: { published: { epoch: 2 }, held: { epoch: 2 }, matches: true },
      limits: { dailyDrops: { used: 0, counted: "chain" } },
    });
  });

  it("/remember: the drop comes from the agent's wallet, lands in Maya's inbox, and opens with her key", async () => {
    const r = await post(app, "/remember", { to: mayaAddress, text: "the dentist moved to Thursday 10:40" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const receipt = await publicClient().getTransactionReceipt({ hash: r.body.dropTx });
    expect(receipt.from).toBe(wallet.toLowerCase());
    const box = await client().inbox(mayaAddress, { fromBlock: BigInt(r.body.blockNumber), toBlock: BigInt(r.body.blockNumber) });
    expect(box.envelopes.map((e) => e.transactionHash)).toEqual([r.body.dropTx]);
    expect(box.envelopes[0]!.envelope).toEqual(r.body.envelope);
    expect(new TextDecoder().decode(await open(box.envelopes[0]!.envelope, maya))).toBe("the dentist moved to Thursday 10:40");
  });

  it("/task: another agent seals to agent:<id> through keyOfAgent; the answer is dropped to that agent and opens with its key", async () => {
    const task = { replyTo: `agent:${callerId}` as Recipient, nonce: newNonce(), issuedAt: Math.floor(Date.now() / 1000), text: "what did I ask you to remember?" };
    const envelope = await client().sealTo(`agent:${agentId}`, encodeTask(task)); // resolve → keyOfAgent → epoch 2
    expect(envelope.epoch).toBe(2);
    const r = await post(app, "/task", { from: `agent:${callerId}`, envelope });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.task).toEqual({ recipient: `agent:${agentId}`, epoch: 2, kid: envelope.kid });
    const box = await client().inbox(`agent:${callerId}`, { fromBlock: BigInt(r.body.blockNumber), toBlock: BigInt(r.body.blockNumber) });
    expect(box.envelopes.map((e) => e.transactionHash)).toEqual([r.body.dropTx]);
    const reply = parseReply(await open(box.envelopes[0]!.envelope, caller));
    expect(reply).toMatchObject({ from: `agent:${agentId}`, inReplyTo: task.nonce, task: { sealedTo: { epoch: 2, kid: envelope.kid } } });
    expect(reply.text).toContain(`“${task.text}”`);
  });

  it("/task of 1,000 control characters is answered with a drop under 100,000 gas: the answer quotes 80 characters and names the whole text by its SHA-256", async () => {
    // quoted in full, as before, this answer was an 8,981-byte envelope: 384,237 gas on Monad mainnet (eth_estimateGas)
    const text = "\u0001".repeat(1000);
    const task = { replyTo: `agent:${callerId}` as Recipient, nonce: newNonce(), issuedAt: Math.floor(Date.now() / 1000), text };
    const r = await post(app, "/task", { from: `agent:${callerId}`, envelope: await client().sealTo(`agent:${agentId}`, encodeTask(task)) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.bytes).toBeLessThan(1700);
    expect(BigInt(r.body.gasUsed) < 100_000n, String(r.body.gasUsed)).toBe(true);
    const box = await client().inbox(`agent:${callerId}`, { fromBlock: BigInt(r.body.blockNumber), toBlock: BigInt(r.body.blockNumber) });
    const reply = parseReply(await open(box.envelopes.find((e) => e.transactionHash === r.body.dropTx)!.envelope, caller));
    expect(reply.task).toMatchObject({ chars: 1000, sha256: createHash("sha256").update(text).digest("hex") });
  });

  it("/task sealed to the epoch-1 key (which the agent does not hold) is refused, and nothing is sent", async () => {
    const before = await publicClient().getTransactionCount({ address: wallet });
    const envelope: Envelope = await seal({
      chainId: 143,
      directory: anvil().directory,
      to: { recipient: `agent:${agentId}`, publicKey: agentStandIn(0x41, agentId, 1).publicKey, epoch: 1 },
      plaintext: encodeTask({ replyTo: mayaAddress, nonce: newNonce(), issuedAt: Math.floor(Date.now() / 1000), text: "old key" }),
    });
    const r = await post(app, "/task", { from: mayaAddress, envelope });
    expect([r.status, r.body.error.code]).toEqual([422, "EPOCH_NOT_HELD"]);
    const nobody = await post(app, "/remember", { to: privateKeyToAccount(generatePrivateKey()).address, text: "no key" });
    expect([nobody.status, nobody.body.error.code]).toEqual([422, "NO_KEY_PUBLISHED"]);
    expect(await publicClient().getTransactionCount({ address: wallet })).toBe(before);
  });

  it("the daily cap counts the wallet's transactions onchain, so every instance sees the same count", async () => {
    const sent = await publicClient().getTransactionCount({ address: wallet });
    expect(sent).toBeGreaterThanOrEqual(2);
    const fresh = appFor({ AGENT_DAILY_DROP_CAP: String(sent) }); // a new instance: no memory of the drops above
    const health = (await (await fresh(new Request("https://agent.test/health"), IP)).json()) as Json;
    expect(health.limits.dailyDrops).toMatchObject({ used: sent, cap: sent, counted: "chain" });
    const r = await post(fresh, "/remember", { to: mayaAddress, text: "one too many" });
    expect([r.status, r.body.error.code]).toEqual([429, "DAILY_CAP"]);
    expect(await publicClient().getTransactionCount({ address: wallet })).toBe(sent);
  });

  it("firstBlockAtOrAfter finds the first block at or after a timestamp", async () => {
    const pub = publicClient();
    const head = await pub.getBlock({ blockTag: "latest" });
    for (const n of [1n, head.number / 2n, head.number]) {
      const ts = (await pub.getBlock({ blockNumber: n })).timestamp;
      const first = await firstBlockAtOrAfter(pub, ts);
      expect((await pub.getBlock({ blockNumber: first })).timestamp).toBeGreaterThanOrEqual(ts);
      if (first > 0n) expect((await pub.getBlock({ blockNumber: first - 1n })).timestamp).toBeLessThan(ts);
    }
    expect(await firstBlockAtOrAfter(pub, head.timestamp + 3600n)).toBe(head.number + 1n);
    expect(await firstBlockAtOrAfter(pub, 0n)).toBe(0n);
  });
});
