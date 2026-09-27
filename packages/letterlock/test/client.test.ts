// The chain layer against the real directory bytecode on a local anvil chain (test/anvil/global-setup.ts).
import { parseEventLogs, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LETTERLOCK_RP_ID,
  deriveKeyPair,
  fingerprint,
  isLetterlockError,
  letterlockAbi,
  open,
  seal,
  toHex,
  type ChainErrorCode,
  type LetterlockErrorCode,
} from "../src/index.ts";
import { Fault, anvil, client, ctx, faultyAbi, fundedAccount, newAgentId, noChain, publicClient, registryAbi, sendAs } from "./anvil/context.ts";
import { rpcProxy } from "./anvil/proxy.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const prf = (n: number) => new Uint8Array(32).fill(n);
const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(() => "no error", (e: unknown) => (isLetterlockError(e) ? e.code : `not a LetterlockError: ${String(e)}`));
const rejects = async (p: Promise<unknown>, code: LetterlockErrorCode | ChainErrorCode) => expect(await codeOf(p)).toBe(code);
const nonce = (address: Address) => publicClient().getTransactionCount({ address });

describe.skipIf(noChain)("resolve", () => {
  it("an address with no key → NO_KEY_PUBLISHED, and seal never happens", async () => {
    const nobody = privateKeyToAccount(generatePrivateKey()).address;
    await rejects(client().resolve(nobody), "NO_KEY_PUBLISHED");
    await rejects(client().sealTo(nobody, utf8("hello")), "NO_KEY_PUBLISHED");
  });

  it("returns key, epoch and updatedAt from ONE keyOf read, as published", async () => {
    const account = await fundedAccount();
    const keys = deriveKeyPair(prf(1), 1);
    const r = await client().publish({ account, keys });
    const key = await client().resolve(account.address);
    expect(key.recipient).toBe(account.address.toLowerCase());
    expect(toHex(key.publicKey)).toBe(toHex(keys.publicKey));
    expect(key.epoch).toBe(1);
    expect(key.kid).toBe(fingerprint(keys.publicKey));
    const block = await publicClient().getBlock({ blockNumber: r.blockNumber });
    expect(key.updatedAt).toBe(Number(block.timestamp));
    expect(key.chainId).toBe(143);
    expect(key.directory).toBe(ctx.ok && ctx.directory);
    // the same read, done by hand
    const raw = await publicClient().readContract({ address: key.directory, abi: letterlockAbi, functionName: "keyOf", args: [account.address] });
    expect(raw).toEqual([`0x${toHex(keys.publicKey)}`, 1, BigInt(key.updatedAt)]);
  });

  it("accepts a checksummed or lower-case address and rejects anything else as INPUT_INVALID", async () => {
    const account = await fundedAccount();
    await client().publish({ account, keys: deriveKeyPair(prf(2), 1) });
    expect((await client().resolve(account.address.toLowerCase())).epoch).toBe(1);
    for (const bad of ["maya.eth", "0x1234", "agent:01", `agent:${2n ** 256n}`, ""]) await rejects(client().resolve(bad), "INPUT_INVALID");
  });

  it("an RPC on another chain → INPUT_INVALID: a key read there must never be sealed under this chain's id", async () => {
    await rejects(client({ chain: "monad-testnet" }).resolve(privateKeyToAccount(generatePrivateKey()).address), "INPUT_INVALID");
  });

  it("an RPC that does not answer → CHAIN_UNAVAILABLE, never NO_KEY_PUBLISHED", async () => {
    await rejects(client({ rpcUrl: "http://127.0.0.1:9" }).resolve(zeroAddress.replace(/0$/, "1")), "CHAIN_UNAVAILABLE");
  });

  it("no directory at the address → INPUT_INVALID", async () => {
    await rejects(client({ directory: "0x000000000000000000000000000000000000dEaD" }).resolve(zeroAddress.replace(/0$/, "1")), "INPUT_INVALID");
  });
});

describe.skipIf(noChain)("publish", () => {
  it("publishes from the account (msg.sender) and emits KeyPublished", async () => {
    const account = await fundedAccount();
    const keys = deriveKeyPair(prf(3), 1);
    const r = await client().publish({ account, keys });
    expect(r).toMatchObject({ recipient: account.address.toLowerCase(), epoch: 1, publicKey: `0x${toHex(keys.publicKey)}`, kid: fingerprint(keys.publicKey) });
    const receipt = await publicClient().getTransactionReceipt({ hash: r.transactionHash });
    expect(receipt.gasUsed).toBe(r.gasUsed);
    const [log] = parseEventLogs({ abi: letterlockAbi, logs: receipt.logs, eventName: "KeyPublished" });
    expect(log?.args.who).toBe(account.address);
    expect(log?.args.pub).toBe(`0x${toHex(keys.publicKey)}`);
  });

  it("a wrong epoch → EPOCH_MISMATCH before any transaction (the simulation refuses it)", async () => {
    const account = await fundedAccount();
    await rejects(client().publish({ account, keys: deriveKeyPair(prf(4), 2) }), "EPOCH_MISMATCH");
    await client().publish({ account, keys: deriveKeyPair(prf(4), 1) });
    const before = await nonce(account.address);
    await rejects(client().publish({ account, keys: deriveKeyPair(prf(4), 1) }), "EPOCH_MISMATCH");
    await rejects(client().publish({ account, keys: deriveKeyPair(prf(4), 3) }), "EPOCH_MISMATCH");
    expect(await nonce(account.address)).toBe(before);
    await client().publish({ account, keys: deriveKeyPair(prf(5), 2) });
    expect((await client().resolve(account.address)).epoch).toBe(2);
  });

  it.each([
    ["zero key", new Uint8Array(32)],
    ["small-order key u = 1", Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0))],
    ["non-canonical key (bit 255 set)", (() => { const k = deriveKeyPair(prf(6), 1).publicKey.slice(); k[31]! |= 0x80; return k; })()],
  ])("the directory refuses a %s → INPUT_INVALID, and no gas is spent", async (_, publicKey) => {
    const account = await fundedAccount();
    const before = await publicClient().getBalance({ address: account.address });
    await rejects(client().publish({ account, keys: { publicKey, epoch: 1 } }), "INPUT_INVALID");
    expect(await publicClient().getBalance({ address: account.address })).toBe(before);
  });

  it("malformed keys and accounts → INPUT_INVALID without touching the chain", async () => {
    const account = await fundedAccount();
    await rejects(client().publish({ account, keys: { publicKey: new Uint8Array(31), epoch: 1 } }), "INPUT_INVALID");
    await rejects(client().publish({ account, keys: { publicKey: deriveKeyPair(prf(7), 1).publicKey, epoch: 0 } }), "INPUT_INVALID");
    await rejects(client().publish({ account: "not an account" as never, keys: deriveKeyPair(prf(7), 1) }), "INPUT_INVALID");
  });

  it("an account without MON → INSUFFICIENT_FUNDS", async () => {
    const broke = privateKeyToAccount(generatePrivateKey());
    await rejects(client().publish({ account: broke, keys: deriveKeyPair(prf(8), 1) }), "INSUFFICIENT_FUNDS");
  });
});

describe.skipIf(noChain)("rpId pinning", () => {
  const other = { rpId: "localhost" } as const;

  it(`publish, rotate and publishForAgent refuse an rpId other than ${LETTERLOCK_RP_ID}, before any chain call`, async () => {
    const account = await fundedAccount();
    const keys = deriveKeyPair(prf(9), 1);
    await rejects(client(other).publish({ account, keys }), "INPUT_INVALID");
    await rejects(client(other).rotate({ account }), "INPUT_INVALID");
    await rejects(client(other).publishForAgent({ account, agentId: 1n, keys }), "INPUT_INVALID");
    const offline = { ...other, rpcUrl: "http://127.0.0.1:9" };
    await rejects(client(offline).publish({ account, keys }), "INPUT_INVALID"); // refused before the dead RPC is reached
    expect(await nonce(account.address)).toBe(0);
  });

  it("reads are not pinned: any rpId can resolve and seal", async () => {
    const account = await fundedAccount();
    await client().publish({ account, keys: deriveKeyPair(prf(10), 1) });
    expect((await client(other).resolve(account.address)).epoch).toBe(1);
    expect((await client(other).sealTo(account.address, utf8("hi"))).epoch).toBe(1);
  });

  it("unsafeAllowAnyRpId lifts the pin (tests only)", async () => {
    const account = await fundedAccount();
    const r = await client({ ...other, unsafeAllowAnyRpId: true }).publish({ account, keys: deriveKeyPair(prf(11), 1) });
    expect(r.epoch).toBe(1);
  });

  it("a key derived under another rpId is refused even by a production client", async () => {
    const account = await fundedAccount();
    await rejects(client().publish({ account, keys: { ...deriveKeyPair(prf(12), 1), rpId: "localhost" } }), "INPUT_INVALID");
    await client().publish({ account, keys: { ...deriveKeyPair(prf(12), 1), rpId: LETTERLOCK_RP_ID } });
  });
});

describe.skipIf(noChain)("sealTo", () => {
  it("seals to the resolved key: the recipient's key opens it, bound to this chain and directory", async () => {
    const account = await fundedAccount();
    const keys = deriveKeyPair(prf(13), 1);
    await client().publish({ account, keys });
    const env = await client().sealTo(account.address, utf8("the courier comes at noon"));
    expect(env).toMatchObject({ v: 1, chainId: 143, directory: ctx.ok && ctx.directory.toLowerCase(), recipient: account.address.toLowerCase(), epoch: 1, kid: fingerprint(keys.publicKey) });
    expect(new TextDecoder().decode(await open(env, keys))).toBe("the courier comes at noon");
  });

  it("refuses a non-byte plaintext before any chain read", async () => {
    await rejects(client({ rpcUrl: "http://127.0.0.1:9" }).sealTo(zeroAddress, "text" as never), "INPUT_INVALID");
  });

  it("after a rotation it seals to the new epoch only", async () => {
    const account = await fundedAccount();
    await client().publish({ account, keys: deriveKeyPair(prf(14), 1) });
    const old = await client().sealTo(account.address, utf8("before"));
    await client().publish({ account, keys: deriveKeyPair(prf(15), 2) });
    const cur = await client().sealTo(account.address, utf8("after"));
    expect([old.epoch, cur.epoch]).toEqual([1, 2]);
    expect(new TextDecoder().decode(await open(old, deriveKeyPair(prf(14), 1)))).toBe("before");
    expect(new TextDecoder().decode(await open(cur, deriveKeyPair(prf(15), 2)))).toBe("after");
  });
});

describe.skipIf(noChain)("agents (ERC-8004 path, test-double registry at the mainnet registry address)", () => {
  let owner: Awaited<ReturnType<typeof fundedAccount>>;
  let agentId: bigint;
  beforeAll(async () => {
    if (!ctx.ok) return;
    owner = await fundedAccount();
    agentId = newAgentId();
    await sendAs(ctx.registry, registryAbi, "mint", [owner.address, agentId]);
  });

  it("the owner publishes; agent:<id> resolves to that key", async () => {
    const keys = deriveKeyPair(prf(16), 1);
    const r = await client().publishForAgent({ account: owner, agentId, keys });
    expect(r.recipient).toBe(`agent:${agentId}`);
    const key = await client().resolve(`agent:${agentId}`);
    expect([toHex(key.publicKey), key.epoch, key.recipient]).toEqual([toHex(keys.publicKey), 1, `agent:${agentId}`]);
    const env = await client().sealTo(`agent:${agentId}`, utf8("task for the agent"));
    expect(new TextDecoder().decode(await open(env, keys))).toBe("task for the agent");
  });

  it("agent ids are accepted as bigint, number, 'agent:<id>' or '<id>'", async () => {
    const other = newAgentId();
    const acct = await fundedAccount();
    await sendAs(ctx.ok ? ctx.registry : zeroAddress, registryAbi, "mint", [acct.address, other]);
    await client().publishForAgent({ account: acct, agentId: `agent:${other}`, keys: deriveKeyPair(prf(17), 1) });
    await client().publishForAgent({ account: acct, agentId: String(other), keys: deriveKeyPair(prf(18), 2) });
    await client().publishForAgent({ account: acct, agentId: Number(other), keys: deriveKeyPair(prf(19), 3) });
    expect((await client().resolve(`agent:${other}`)).epoch).toBe(3);
    await rejects(client().publishForAgent({ account: acct, agentId: -1, keys: deriveKeyPair(prf(19), 4) }), "INPUT_INVALID");
    await rejects(client().publishForAgent({ account: acct, agentId: (1n << 256n) - 1n, keys: deriveKeyPair(prf(19), 4) }), "INPUT_INVALID");
  });

  it("a non-owner → NOT_AGENT_OWNER; an agent nobody owns → NOT_AGENT_OWNER", async () => {
    const stranger = await fundedAccount();
    await rejects(client().publishForAgent({ account: stranger, agentId, keys: deriveKeyPair(prf(20), 2) }), "NOT_AGENT_OWNER");
    await rejects(client().publishForAgent({ account: stranger, agentId: newAgentId(), keys: deriveKeyPair(prf(20), 1) }), "NOT_AGENT_OWNER");
  });

  it("the key follows the NFT: after a transfer the old key no longer resolves, and the new owner continues the epochs", async () => {
    const id = newAgentId();
    const [seller, buyer] = [await fundedAccount(), await fundedAccount()];
    await sendAs(ctx.ok ? ctx.registry : zeroAddress, registryAbi, "mint", [seller.address, id]);
    await client().publishForAgent({ account: seller, agentId: id, keys: deriveKeyPair(prf(21), 1) });
    await sendAs(ctx.ok ? ctx.registry : zeroAddress, registryAbi, "transfer", [id, buyer.address]);
    await rejects(client().resolve(`agent:${id}`), "NO_KEY_PUBLISHED");
    await rejects(client().sealTo(`agent:${id}`, utf8("to the old owner?")), "NO_KEY_PUBLISHED");
    await rejects(client().publishForAgent({ account: buyer, agentId: id, keys: deriveKeyPair(prf(22), 1) }), "EPOCH_MISMATCH");
    await client().publishForAgent({ account: buyer, agentId: id, keys: deriveKeyPair(prf(22), 2) });
    expect((await client().resolve(`agent:${id}`)).epoch).toBe(2);
  });

  it("a directory without a registry (as on testnet) → INPUT_INVALID for every agent call", async () => {
    if (!ctx.ok) return;
    const ll = client({ directory: ctx.directoryNoAgents });
    const acct = await fundedAccount();
    await rejects(ll.resolve("agent:1"), "INPUT_INVALID");
    await rejects(ll.publishForAgent({ account: acct, agentId: 1n, keys: deriveKeyPair(prf(23), 1) }), "INPUT_INVALID");
    const env = await seal({ chainId: 143, directory: ctx.directoryNoAgents, to: { recipient: "agent:1", publicKey: deriveKeyPair(prf(23), 1).publicKey, epoch: 1 }, plaintext: utf8("x") });
    await rejects(ll.drop({ account: acct, envelope: env }), "INPUT_INVALID");
  });

  it("the built-in testnet directory refuses agent recipients without a chain call", async () => {
    await rejects(client({ chain: "monad-testnet", directory: undefined, rpcUrl: "http://127.0.0.1:9" }).resolve("agent:10260"), "INPUT_INVALID");
  });
});

describe.skipIf(noChain)("an RPC that refuses JSON-RPC batches (rpc-mainnet.monadinfra.com: HTTP 403 for any batch)", () => {
  it("resolve, sealTo, publish, drop and inbox each send one request per HTTP request, and work", async () => {
    const proxy = await rpcProxy(anvil().rpcUrl, { refuseBatches: true });
    try {
      const ll = client({ rpcUrl: proxy.url });
      const account = await fundedAccount();
      const keys = deriveKeyPair(prf(40), 1);
      const published = await ll.publish({ account, keys });
      expect((await ll.resolve(account.address)).epoch).toBe(1);
      const dropped = await ll.drop({ account, envelope: await ll.sealTo(account.address, utf8("through a strict RPC")) });
      const box = await ll.inbox(account.address, { fromBlock: published.blockNumber, toBlock: dropped.blockNumber });
      expect(box.envelopes.map((e) => e.transactionHash)).toEqual([dropped.transactionHash]);
      expect(proxy.stats.batches).toBe(0);
    } finally { await proxy.close(); }
  });
});

describe.skipIf(noChain)("a registry that cannot answer (RegistryCallFailed): unknown, never 'no key'", () => {
  it.each([["EmptyRevert", Fault.EmptyRevert], ["OutOfGas", Fault.OutOfGas], ["ErrorString", Fault.ErrorString], ["Panic", Fault.Panic]])(
    "ownerOf fails with %s → resolve, sealTo, drop and publishForAgent throw CHAIN_UNAVAILABLE", async (_, fault) => {
      if (!ctx.ok) return;
      const ll = client({ directory: ctx.directoryFaulty });
      const acct = await fundedAccount();
      const id = newAgentId();
      await sendAs(ctx.faultyRegistry, faultyAbi, "mint", [acct.address, id]);
      const keys = deriveKeyPair(prf(24), 1);
      await ll.publishForAgent({ account: acct, agentId: id, keys });
      const env = await ll.sealTo(`agent:${id}`, utf8("x"));
      await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [fault]);
      try {
        await rejects(ll.resolve(`agent:${id}`), "CHAIN_UNAVAILABLE");
        await rejects(ll.sealTo(`agent:${id}`, utf8("x")), "CHAIN_UNAVAILABLE");
        await rejects(ll.drop({ account: acct, envelope: env }), "CHAIN_UNAVAILABLE");
        await rejects(ll.publishForAgent({ account: acct, agentId: id, keys: deriveKeyPair(prf(25), 2) }), "CHAIN_UNAVAILABLE");
      } finally {
        await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [Fault.None]);
      }
    });
});
