// The chain layer against the real directory bytecode on a local anvil chain (test/anvil/global-setup.ts).
import type { WebAuthnClient } from "@category-labs/mera";
import { parseEventLogs, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import * as sdk from "../src/index.ts";
import {
  DEPLOYMENTS,
  LETTERLOCK_RP_ID,
  createEncryptionAddress,
  deriveFromPasskey,
  fingerprint,
  isLetterlockError,
  letterlock,
  letterlockAbi,
  meraAccount,
  open,
  seal,
  toHex,
  type ChainErrorCode,
  type LetterlockErrorCode,
} from "../src/index.ts";
import { Fault, agentStandIn, anvil, client, ctx, faultyAbi, fund, fundedAccount, newAgentId, noChain, privateChain, publicClient, registryAbi, sendAs, standIn, testClient } from "./anvil/context.ts";
import { pendingIsLatest, rpcError, rpcProxy } from "./anvil/proxy.ts";
import { softAuthenticator, zeroedDuring, type SoftAuthenticator } from "./soft-authenticator.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
// looked up at call time, so this file still loads (and the test fails, not the file) against a build without it
const deriveForAgent = (o: Parameters<typeof sdk.deriveForAgent>[0]) => sdk.deriveForAgent(o);
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
    const keys = standIn(1, 1);
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
    await client().publish({ account, keys: standIn(2, 1) });
    expect((await client().resolve(account.address.toLowerCase())).epoch).toBe(1);
    for (const bad of ["maya.eth", "0x1234", "agent:01", `agent:${2n ** 256n}`, ""]) await rejects(client().resolve(bad), "INPUT_INVALID");
  });

  it("an RPC on another chain → INPUT_INVALID: a key read there must never be sealed under this chain's id", async () => {
    await rejects(client({ chain: "monad-testnet" }).resolve(privateKeyToAccount(generatePrivateKey()).address), "INPUT_INVALID");
  });

  it("an RPC on another chain is named as such, even when the directory read fails first (no directory there)", async () => {
    // the built-in testnet directory has no code on this chain-143 RPC; eth_chainId is answered last
    const proxy = await rpcProxy(anvil().rpcUrl, {
      intercept: async (req, upstream) => (req.method === "eth_chainId" ? new Promise((r) => setTimeout(() => r(upstream()), 300)) : undefined),
    });
    try {
      const e = await client({ chain: "monad-testnet", directory: undefined, rpcUrl: proxy.url }).resolve(zeroAddress.replace(/0$/, "1")).then(() => null, (x: unknown) => x);
      expect(isLetterlockError(e, "INPUT_INVALID")).toBe(true);
      expect((e as Error).message).toContain("the RPC serves chain 143, not Monad testnet (10143)");
    } finally { await proxy.close(); }
  });

  it("an RPC that does not answer → CHAIN_UNAVAILABLE, never NO_KEY_PUBLISHED", async () => {
    await rejects(client({ rpcUrl: "http://127.0.0.1:9" }).resolve(zeroAddress.replace(/0$/, "1")), "CHAIN_UNAVAILABLE");
  });

  it("no directory at the address → INPUT_INVALID", async () => {
    await rejects(client({ directory: "0x000000000000000000000000000000000000dEaD" }).resolve(zeroAddress.replace(/0$/, "1")), "INPUT_INVALID");
  });
});

describe.skipIf(noChain)("a directory address that holds no Letterlock directory → INPUT_INVALID, and no transaction", () => {
  const state = async (address: Address) => [await nonce(address), await publicClient().getBalance({ address })];
  const notADirectory = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID"), String(e)).toBe(true);
    expect((e as Error).message).toMatch(/is not a Letterlock directory on Monad mainnet/);
  };

  // runtime code that answers any call with the word 1: PUSH1 1, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN
  const catchAll = async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    await testClient().setCode({ address, bytecode: "0x600160005260206000f3" });
    return address;
  };

  it.each([
    ["an address with no code (a typo, or the other network's directory)", async () => privateKeyToAccount(generatePrivateKey()).address, "the address has no code"],
    ["a contract that is not a directory (the registry)", async () => anvil().registry, "its code does not answer NO_AGENT()"],
    ["a contract that answers every call (a fallback)", catchAll, "NO_AGENT() returned 1, not 2^256 - 1"],
  ])("%s: publish, rotate, drop, inbox and resolve refuse it; the account's nonce and balance are unchanged", async (_, where, why) => {
    const directory = await where();
    const ll = client({ directory });
    const account = await fundedAccount();
    const before = await state(account.address);
    const e = await ll.publish({ account, keys: standIn(41, 1) }).then(() => null, (x: unknown) => x);
    expect((e as Error).message).toContain(why);
    const env = await seal({ chainId: 143, directory, to: { recipient: account.address, publicKey: standIn(41, 1).publicKey, epoch: 1 }, plaintext: utf8("x") });
    await notADirectory(ll.drop({ account, envelope: env }));
    await notADirectory(ll.inbox(account.address, { fromBlock: 0n }));
    await notADirectory(ll.resolve(account.address));
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp: { id: LETTERLOCK_RP_ID, name: "Letterlock" }, user: { name: "a", displayName: "A" }, webAuthnClient: dev });
    await notADirectory(ll.rotate({ account, credential, webAuthnClient: dev }));
    expect(dev.calls.get).toBe(0); // refused before the passkey prompt
    expect(await state(account.address)).toEqual(before);
  });

  it("the check is made once per client, and a failed RPC is CHAIN_UNAVAILABLE, not 'no directory'", async () => {
    const proxy = await rpcProxy(anvil().rpcUrl);
    try {
      const ll = client({ rpcUrl: proxy.url });
      const account = await fundedAccount();
      await ll.publish({ account, keys: standIn(42, 1) });
      await ll.resolve(account.address);
      await ll.inbox(account.address, { fromBlock: 0n, toBlock: 1n });
      expect(proxy.stats.methods.eth_getCode).toBe(1);
    } finally { await proxy.close(); }
    await rejects(client({ rpcUrl: "http://127.0.0.1:9" }).publish({ account: await fundedAccount(), keys: standIn(42, 1) }), "CHAIN_UNAVAILABLE");
  });

  it.each(["eth_chainId", "eth_getCode"])("%s failing past viem's retries → CHAIN_UNAVAILABLE, and the same client asks again once the RPC answers", async (method) => {
    const account = await fundedAccount();
    await client().publish({ account, keys: standIn(49, 1) });
    let down = true;
    const proxy = await rpcProxy(anvil().rpcUrl, { intercept: (req) => (down && req.method === method ? rpcError(req, -32603, "internal error") : undefined) });
    try {
      const ll = client({ rpcUrl: proxy.url });
      await rejects(ll.resolve(account.address), "CHAIN_UNAVAILABLE");
      const asked = proxy.stats.methods[method] ?? 0;
      expect(asked).toBeGreaterThan(1); // viem retried it before giving up
      down = false;
      expect((await ll.resolve(account.address)).epoch).toBe(1); // a failed check is not kept
      expect(proxy.stats.methods[method]).toBe(asked + 1);
    } finally { await proxy.close(); }
  });

  it("the built-in directory is checked too: on a chain-143 RPC where its address holds no code, publish sends nothing", async () => {
    const ll = client({ directory: undefined }); // Monad mainnet's directory address, which holds no code on this anvil
    expect(ll.directory).toBe(DEPLOYMENTS.monad.directory);
    const account = await fundedAccount();
    const e = await ll.publish({ account, keys: standIn(50, 1) }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID"), String(e)).toBe(true);
    expect((e as Error).message).toContain(`${DEPLOYMENTS.monad.directory} is not a Letterlock directory on Monad mainnet: the address has no code`);
    expect(await nonce(account.address)).toBe(0);
  });
});

describe("client.open", () => {
  it("derives under the client's rpId: a client for another rpId opens a note sealed to that rpId's passkey", async () => {
    const dev = softAuthenticator();
    const { keys, credential } = await createEncryptionAddress({ rp: { id: "localhost", name: "Letterlock" }, user: { name: "l", displayName: "L" }, webAuthnClient: dev });
    const env = await seal({ chainId: 143, directory: DEPLOYMENTS.monad.directory, to: { recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: keys.publicKey, epoch: 1 }, plaintext: utf8("opened on localhost") });
    const ll = letterlock({ chain: "monad", rpId: "localhost" }); // opening is not pinned (docs/SPEC.md §6), and reads no chain
    expect(new TextDecoder().decode(await ll.open(env, { credential, webAuthnClient: dev }))).toBe("opened on localhost");
    expect(dev.calls.get).toBe(1);
  });
});

describe.skipIf(noChain)("publish", () => {
  it("publishes from the account (msg.sender) and emits KeyPublished", async () => {
    const account = await fundedAccount();
    const keys = standIn(3, 1);
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
    await rejects(client().publish({ account, keys: standIn(4, 2) }), "EPOCH_MISMATCH");
    await client().publish({ account, keys: standIn(4, 1) });
    const before = await nonce(account.address);
    await rejects(client().publish({ account, keys: standIn(4, 1) }), "EPOCH_MISMATCH");
    await rejects(client().publish({ account, keys: standIn(4, 3) }), "EPOCH_MISMATCH");
    expect(await nonce(account.address)).toBe(before);
    await client().publish({ account, keys: standIn(5, 2) });
    expect((await client().resolve(account.address)).epoch).toBe(2);
  });

  it.each([
    ["zero key", new Uint8Array(32), "ZeroKey"],
    ["small-order key u = 1", Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0)), "LowOrderKey"],
    ["non-canonical key (bit 255 set)", (() => { const k = standIn(6, 1).publicKey.slice(); k[31]! |= 0x80; return k; })(), "NonCanonicalKey"],
  ])("the directory refuses a %s → INPUT_INVALID, and no gas is spent", async (_, publicKey, reason) => {
    const account = await fundedAccount();
    const before = await publicClient().getBalance({ address: account.address });
    const e = await client().publish({ account, keys: { publicKey, epoch: 1, rpId: LETTERLOCK_RP_ID } }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID"), String(e)).toBe(true);
    expect((e as Error).message).toContain(`(${reason})`);
    expect(await publicClient().getBalance({ address: account.address })).toBe(before);
  });

  it("malformed keys and accounts → INPUT_INVALID without touching the chain", async () => {
    const account = await fundedAccount();
    await rejects(client().publish({ account, keys: { publicKey: new Uint8Array(31), epoch: 1, rpId: LETTERLOCK_RP_ID } }), "INPUT_INVALID");
    await rejects(client().publish({ account, keys: { publicKey: standIn(7, 1).publicKey, epoch: 0, rpId: LETTERLOCK_RP_ID } }), "INPUT_INVALID");
    await rejects(client().publish({ account: "not an account" as never, keys: standIn(7, 1) }), "INPUT_INVALID");
  });

  it("an address the node signs for: a refused publish sends nothing either (the node signs whatever it is sent)", async () => {
    // viem estimates gas before it signs for a local account, which a refused call also fails; for an address it sends
    // eth_sendTransaction as is, so only the simulation keeps the reverting transaction (and its gas) off the chain
    const signer = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"; // anvil's default account 9, unlocked
    const before = await nonce(signer);
    await rejects(client().publish({ account: signer, keys: standIn(48, 2) }), "EPOCH_MISMATCH");
    expect(await nonce(signer)).toBe(before);
  });

  it("an account without MON → INSUFFICIENT_FUNDS", async () => {
    const broke = privateKeyToAccount(generatePrivateKey());
    await rejects(client().publish({ account: broke, keys: standIn(8, 1) }), "INSUFFICIENT_FUNDS");
  });

  it.each([
    ["Signer had insufficient balance"], // Monad testnet, a publish from an empty account (2026-09-27)
    ["reserve balance violation"], // Monad's eth_call when a transaction exceeds the sender's reserve balance
  ])("a node that says '%s' → INSUFFICIENT_FUNDS (viem does not name that wording), and nothing is sent", async (wording) => {
    const account = await fundedAccount();
    const proxy = await rpcProxy(anvil().rpcUrl, {
      intercept: (req) => {
        if (req.method !== "eth_call" && req.method !== "eth_estimateGas") return undefined;
        const from = (req.params[0] as { from?: string }).from?.toLowerCase();
        return from === account.address.toLowerCase() ? rpcError(req, -32000, wording) : undefined;
      },
    });
    try {
      await rejects(client({ rpcUrl: proxy.url }).publish({ account, keys: standIn(44, 1) }), "INSUFFICIENT_FUNDS");
      expect(await nonce(account.address)).toBe(0);
    } finally { await proxy.close(); }
  });
});

describe.skipIf(noChain)("drop", () => {
  it("refuses an envelope sealed for another directory before sending: the directory itself takes any bytes", async () => {
    if (!ctx.ok) return;
    const account = await fundedAccount();
    const keys = standIn(47, 1);
    await client().publish({ account, keys });
    const elsewhere = await seal({ chainId: 143, directory: ctx.directoryNoAgents, to: { recipient: account.address, publicKey: keys.publicKey, epoch: 1 }, plaintext: utf8("x") });
    const before = await nonce(account.address);
    const e = await client().drop({ account, envelope: elsewhere }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID"), String(e)).toBe(true);
    expect((e as Error).message).toContain(`sealed for directory ${ctx.directoryNoAgents.toLowerCase()}`);
    expect(await nonce(account.address)).toBe(before);
  });
});

describe.skipIf(noChain)("rotate", () => {
  it("derives the next epoch's key from the passkey, publishes it, and zeroes its copy of the secret key", async () => {
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp: { id: LETTERLOCK_RP_ID, name: "Letterlock" }, user: { name: "r", displayName: "R" }, webAuthnClient: dev });
    const account = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential, webAuthnClient: dev });
    await fund(account.address, "1");
    const next = await deriveFromPasskey({ rpId: LETTERLOCK_RP_ID, epoch: 1, credential, webAuthnClient: dev }); // no key yet: epoch 1
    let r: Awaited<ReturnType<ReturnType<typeof client>["rotate"]>> | undefined;
    const zeroed = await zeroedDuring(async () => { r = await client().rotate({ account, credential, webAuthnClient: dev }); });
    expect([r?.epoch, r?.publicKey]).toEqual([1, `0x${toHex(next.publicKey)}`]);
    expect(zeroed).toContain(toHex(next.secretKey));
    account.end();
  });
});

// mera adds a passkey on every creation (a fresh user handle), and a creation that fails after the ceremony leaves its
// passkey behind: a device can hold several passkeys for the site. A prompt that is not pinned lets any of them answer.
describe.skipIf(noChain)("the key and the account come from one passkey (docs/SPEC.md §7)", () => {
  /** Two passkeys for the site on one device: an older one, which answers a prompt that pins none, and the account's own. */
  const twoPasskeys = async () => {
    const dev = softAuthenticator();
    const rp = { id: LETTERLOCK_RP_ID, name: "Letterlock" };
    const older = await createEncryptionAddress({ rp, user: { name: "old", displayName: "Old" }, webAuthnClient: dev });
    const mine = await createEncryptionAddress({ rp, user: { name: "me", displayName: "Me" }, webAuthnClient: dev });
    const account = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential: mine.credential, webAuthnClient: dev });
    await fund(account.address, "1");
    return { dev, older, mine, account };
  };
  /** A WebAuthn client that drops the credential a request pins (a buggy or hostile one): the first passkey answers. */
  const ignoresPin = (dev: SoftAuthenticator): WebAuthnClient => ({
    createCredential: (req) => dev.createCredential(req),
    getCredential: ({ allowCredential: _, ...req }) => dev.getCredential(req),
  });
  const epoch2 = (credential: { credentialId: string }, dev: SoftAuthenticator) =>
    deriveFromPasskey({ rpId: LETTERLOCK_RP_ID, epoch: 2, credential, webAuthnClient: dev });

  it("rotate({ account }) derives from the account's own passkey, not from whichever passkey for the site answers first", async () => {
    const { dev, older, mine, account } = await twoPasskeys();
    await client().publish({ account, keys: mine.keys });
    // no credential: on a synced device the app may hold only the account
    const r = await client().rotate({ account, webAuthnClient: dev });
    const [own, other] = [await epoch2(mine.credential, dev), await epoch2(older.credential, dev)];
    expect(r.publicKey).toBe(`0x${toHex(own.publicKey)}`);
    expect(r.publicKey).not.toBe(`0x${toHex(other.publicKey)}`);
    // so a note sealed to the account now opens with the account's own passkey
    const env = await client().sealTo(account.address, utf8("after the rotation"));
    expect(new TextDecoder().decode(await client().open(env, { credential: mine.credential, webAuthnClient: dev }))).toBe("after the rotation");
    account.end();
  });

  it("a credential that is not the account's passkey → INPUT_INVALID before the prompt, and nothing is sent", async () => {
    const { dev, older, mine, account } = await twoPasskeys();
    await client().publish({ account, keys: mine.keys });
    const before = [await nonce(account.address), dev.calls.get];
    await rejects(client().rotate({ account, credential: older.credential, webAuthnClient: dev }), "INPUT_INVALID");
    expect([await nonce(account.address), dev.calls.get]).toEqual(before);
    expect((await client().resolve(account.address)).epoch).toBe(1);
    account.end();
  });

  it("a WebAuthn client that ignores the pin: the passkey that answered is checked, and its key is never published", async () => {
    const { dev, older, mine, account } = await twoPasskeys();
    await client().publish({ account, keys: mine.keys });
    const stray = await epoch2(older.credential, dev); // what the older passkey answers for epoch 2
    const before = await nonce(account.address);
    let code = "";
    const zeroed = await zeroedDuring(async () => { code = await codeOf(client().rotate({ account, webAuthnClient: ignoresPin(dev) })); });
    expect(code).toBe("INPUT_INVALID");
    expect(zeroed).toContain(toHex(stray.secretKey)); // its secret key is wiped all the same
    expect(await nonce(account.address)).toBe(before);
    expect((await client().resolve(account.address)).epoch).toBe(1);
    // any other account is held to the credential it is given in the same way
    const server = await fundedAccount();
    await rejects(client().rotate({ account: server, credential: mine.credential, webAuthnClient: ignoresPin(dev) }), "INPUT_INVALID");
    expect(await nonce(server.address)).toBe(0);
    account.end();
  });

  it("any account not from meraAccount() needs the credential: refused before the prompt, never an unpinned one", async () => {
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp: { id: LETTERLOCK_RP_ID, name: "Letterlock" }, user: { name: "s", displayName: "S" }, webAuthnClient: dev });
    const account = await fundedAccount();
    await rejects(client().rotate({ account, webAuthnClient: dev }), "INPUT_INVALID");
    expect([dev.calls.get, await nonce(account.address)]).toEqual([0, 0]);
    const r = await client().rotate({ account, credential, webAuthnClient: dev });
    const own = await deriveFromPasskey({ rpId: LETTERLOCK_RP_ID, epoch: 1, credential, webAuthnClient: dev });
    expect([r.epoch, r.publicKey]).toEqual([1, `0x${toHex(own.publicKey)}`]);
  });

  it("deriveForAgent and meraAccount name the passkey that ANSWERED, not the one asked for: a pin-ignoring client cannot slip another passkey's key or account in", async () => {
    if (!ctx.ok) return;
    const { dev, older, mine, account } = await twoPasskeys();
    const agentId = newAgentId();
    await sendAs(ctx.registry, registryAbi, "mint", [account.address, agentId]);
    // asked for `mine`, answered by `older`: the agent key says so, and publishForAgent refuses it
    const stray = await deriveForAgent({ rpId: LETTERLOCK_RP_ID, agentId, epoch: 1, credential: mine.credential, webAuthnClient: ignoresPin(dev) });
    expect(stray.credentialId).toBe(older.credential.credentialId);
    await rejects(client().publishForAgent({ account, agentId, keys: stray }), "INPUT_INVALID");
    expect(await nonce(account.address)).toBe(0);
    // the same for the account: asked for `mine`, it is `older`'s account and says so
    const olderAccount = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential: older.credential, webAuthnClient: dev });
    const strayAccount = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential: mine.credential, webAuthnClient: ignoresPin(dev) });
    expect([strayAccount.address, strayAccount.credentialId]).toEqual([olderAccount.address, older.credential.credentialId]);
    await fund(strayAccount.address, "1"); // so that only the passkey check can refuse
    await rejects(client().publish({ account: strayAccount, keys: mine.keys }), "INPUT_INVALID");
    expect(await nonce(strayAccount.address)).toBe(0);
    for (const a of [account, olderAccount, strayAccount]) a.end();
  });

  it("publish and publishForAgent take from a meraAccount() only a key that names its own passkey; nothing else is sent", async () => {
    if (!ctx.ok) return;
    const { dev, older, mine, account } = await twoPasskeys();
    const refused = async (p: Promise<unknown>, why: string) => {
      const e = await p.then(() => null, (x: unknown) => x);
      expect(isLetterlockError(e, "INPUT_INVALID"), String(e)).toBe(true);
      expect((e as Error).message).toContain(why);
    };
    const another = `the key was derived from passkey ${older.credential.credentialId}, and the account comes from passkey ${mine.credential.credentialId}`;
    const unnamed = "the key does not name the passkey it was derived from";
    // createEncryptionAddress's key names its passkey, as deriveFromPasskey's and deriveForAgent's do
    expect([mine.keys.credentialId, older.keys.credentialId]).toEqual([mine.credential.credentialId, older.credential.credentialId]);
    await refused(client().publish({ account, keys: older.keys }), another);
    // nor a key rebuilt from its fields, which could come from any passkey (a plain account still takes one)
    const { publicKey, epoch, rpId } = mine.keys;
    await refused(client().publish({ account, keys: { publicKey, epoch, rpId } }), unnamed);
    const agentId = newAgentId();
    await sendAs(ctx.registry, registryAbi, "mint", [account.address, agentId]);
    const forAgent = (credential: { credentialId: string }) => deriveForAgent({ rpId: LETTERLOCK_RP_ID, agentId, epoch: 1, credential, webAuthnClient: dev });
    await refused(client().publishForAgent({ account, agentId, keys: await forAgent(older.credential) }), another);
    const { credentialId: _, ...rebuilt } = await forAgent(mine.credential);
    await refused(client().publishForAgent({ account, agentId, keys: rebuilt }), unnamed);
    expect(await nonce(account.address)).toBe(0);
    await client().publish({ account, keys: mine.keys });
    await client().publishForAgent({ account, agentId, keys: await forAgent(mine.credential) });
    expect([(await client().resolve(account.address)).epoch, (await client().resolve(`agent:${agentId}`)).epoch]).toEqual([1, 1]);
    account.end();
  });
});

describe.skipIf(noChain)("a transaction that reverts when it is mined (a chain of the test's own, with mining paused)", () => {
  it("a publish whose simulation passed but whose transaction reverted in its block is an error, never a result", async () => {
    const chain = await privateChain();
    // estimates and simulations see only mined state, as on Monad ("pending" behaves as "latest")
    const proxy = await rpcProxy(chain.rpcUrl, { rewrite: pendingIsLatest });
    try {
      const ll = chain.client({ rpcUrl: proxy.url });
      const account = await chain.fundedAccount();
      const pending = () => chain.publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      const until = async (n: number) => { for (let i = 0; i < 200 && (await pending()) < n; i++) await new Promise((r) => setTimeout(r, 25)); };
      await chain.testClient.setAutomine(false);
      const first = ll.publish({ account, keys: standIn(45, 1) }).then((x) => x, (e: unknown) => e);
      await until(1);
      // simulated against the head, where epoch 1 is still free: its transaction is sent, then reverts EpochNotNext(1, 1)
      const second = codeOf(ll.publish({ account, keys: standIn(46, 1) }));
      await until(2);
      await chain.testClient.mine({ blocks: 1 });
      expect(await first).toMatchObject({ epoch: 1 });
      expect(await second).toBe("EPOCH_MISMATCH");
      const block = await chain.publicClient.getBlock({ blockTag: "latest", includeTransactions: true });
      const statuses = await Promise.all(block.transactions.map(async (t) => (await chain.publicClient.getTransactionReceipt({ hash: t.hash })).status));
      expect(statuses).toEqual(["success", "reverted"]);
    } finally { await proxy.close(); chain.close(); }
  });
});

describe.skipIf(noChain)("rpId pinning", () => {
  const other = { rpId: "localhost" } as const;

  it(`publish, rotate and publishForAgent refuse an rpId other than ${LETTERLOCK_RP_ID}, before any chain call`, async () => {
    const account = await fundedAccount();
    const keys = standIn(9, 1);
    // a passkey of that rpId, so that the pin is the only reason rotate has to refuse
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp: { id: other.rpId, name: "Letterlock" }, user: { name: "p", displayName: "P" }, webAuthnClient: dev });
    await rejects(client(other).publish({ account, keys }), "INPUT_INVALID");
    await rejects(client(other).rotate({ account, credential, webAuthnClient: dev }), "INPUT_INVALID");
    await rejects(client(other).publishForAgent({ account, agentId: 1n, keys }), "INPUT_INVALID");
    const offline = { ...other, rpcUrl: "http://127.0.0.1:9" };
    await rejects(client(offline).publish({ account, keys }), "INPUT_INVALID"); // refused before the dead RPC is reached
    await rejects(client(offline).rotate({ account, credential, webAuthnClient: dev }), "INPUT_INVALID");
    expect([dev.calls.get, await nonce(account.address)]).toEqual([0, 0]); // no prompt, and nothing sent
  });

  it("reads are not pinned: any rpId can resolve and seal", async () => {
    const account = await fundedAccount();
    await client().publish({ account, keys: standIn(10, 1) });
    expect((await client(other).resolve(account.address)).epoch).toBe(1);
    expect((await client(other).sealTo(account.address, utf8("hi"))).epoch).toBe(1);
  });

  it("unsafeAllowAnyRpId lifts the pin (tests only), but never takes a key from an rpId other than the client's", async () => {
    const account = await fundedAccount();
    const unsafe = client({ ...other, unsafeAllowAnyRpId: true });
    await rejects(unsafe.publish({ account, keys: standIn(11, 1) }), "INPUT_INVALID"); // derived under LETTERLOCK_RP_ID
    const r = await unsafe.publish({ account, keys: { ...standIn(11, 1), rpId: "localhost" } }); // as a localhost passkey labels it
    expect(r.epoch).toBe(1);
  });

  it("a key that carries no rpId (rebuilt as { publicKey, epoch }) is refused too, unless unsafeAllowAnyRpId", async () => {
    const dev = softAuthenticator();
    const { keys } = await createEncryptionAddress({ rp: { id: "localhost", name: "Letterlock" }, user: { name: "a", displayName: "A" }, webAuthnClient: dev });
    const bare = { publicKey: keys.publicKey, epoch: keys.epoch }; // e.g. after holding the key in app state
    const account = await fundedAccount();
    await rejects(client().publish({ account, keys }), "INPUT_INVALID");
    await rejects(client().publish({ account, keys: bare }), "INPUT_INVALID");
    await rejects(client().publishForAgent({ account, agentId: 1n, keys: bare }), "INPUT_INVALID");
    expect(await nonce(account.address)).toBe(0);
    expect((await client({ unsafeAllowAnyRpId: true }).publish({ account, keys: bare })).epoch).toBe(1);
  });

  it("a key derived under another rpId is refused even by a production client", async () => {
    const account = await fundedAccount();
    await rejects(client().publish({ account, keys: { ...standIn(12, 1), rpId: "localhost" } }), "INPUT_INVALID");
    await client().publish({ account, keys: { ...standIn(12, 1), rpId: LETTERLOCK_RP_ID } });
  });
});

describe.skipIf(noChain)("sealTo", () => {
  it("seals to the resolved key: the recipient's key opens it, bound to this chain and directory", async () => {
    const account = await fundedAccount();
    const keys = standIn(13, 1);
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
    await client().publish({ account, keys: standIn(14, 1) });
    const old = await client().sealTo(account.address, utf8("before"));
    await client().publish({ account, keys: standIn(15, 2) });
    const cur = await client().sealTo(account.address, utf8("after"));
    expect([old.epoch, cur.epoch]).toEqual([1, 2]);
    expect(new TextDecoder().decode(await open(old, standIn(14, 1)))).toBe("before");
    expect(new TextDecoder().decode(await open(cur, standIn(15, 2)))).toBe("after");
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
    const keys = agentStandIn(16, agentId, 1);
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
    await client().publishForAgent({ account: acct, agentId: `agent:${other}`, keys: agentStandIn(17, other, 1) });
    await client().publishForAgent({ account: acct, agentId: String(other), keys: agentStandIn(18, other, 2) });
    await client().publishForAgent({ account: acct, agentId: Number(other), keys: agentStandIn(19, other, 3) });
    expect((await client().resolve(`agent:${other}`)).epoch).toBe(3);
    await rejects(client().publishForAgent({ account: acct, agentId: -1, keys: agentStandIn(19, other, 4) }), "INPUT_INVALID");
    await rejects(client().publishForAgent({ account: acct, agentId: (1n << 256n) - 1n, keys: agentStandIn(19, other, 4) }), "INPUT_INVALID");
  });

  it("a non-owner → NOT_AGENT_OWNER; an agent nobody owns → NOT_AGENT_OWNER", async () => {
    const stranger = await fundedAccount();
    await rejects(client().publishForAgent({ account: stranger, agentId, keys: agentStandIn(20, agentId, 2) }), "NOT_AGENT_OWNER");
    const unowned = newAgentId();
    await rejects(client().publishForAgent({ account: stranger, agentId: unowned, keys: agentStandIn(20, unowned, 1) }), "NOT_AGENT_OWNER");
  });

  it("the key follows the NFT: after a transfer the old key no longer resolves, and the new owner continues the epochs", async () => {
    const id = newAgentId();
    const [seller, buyer] = [await fundedAccount(), await fundedAccount()];
    await sendAs(ctx.ok ? ctx.registry : zeroAddress, registryAbi, "mint", [seller.address, id]);
    await client().publishForAgent({ account: seller, agentId: id, keys: agentStandIn(21, id, 1) });
    await sendAs(ctx.ok ? ctx.registry : zeroAddress, registryAbi, "transfer", [id, buyer.address]);
    await rejects(client().resolve(`agent:${id}`), "NO_KEY_PUBLISHED");
    await rejects(client().sealTo(`agent:${id}`, utf8("to the old owner?")), "NO_KEY_PUBLISHED");
    await rejects(client().publishForAgent({ account: buyer, agentId: id, keys: agentStandIn(22, id, 1) }), "EPOCH_MISMATCH");
    await client().publishForAgent({ account: buyer, agentId: id, keys: agentStandIn(22, id, 2) });
    expect((await client().resolve(`agent:${id}`)).epoch).toBe(2);
  });

  it("a directory without a registry (as on testnet) → INPUT_INVALID for every agent call", async () => {
    if (!ctx.ok) return;
    const ll = client({ directory: ctx.directoryNoAgents });
    const acct = await fundedAccount();
    await rejects(ll.resolve("agent:1"), "INPUT_INVALID");
    await rejects(ll.publishForAgent({ account: acct, agentId: 1n, keys: agentStandIn(23, 1n, 1) }), "INPUT_INVALID");
    const env = await seal({ chainId: 143, directory: ctx.directoryNoAgents, to: { recipient: "agent:1", publicKey: standIn(23, 1).publicKey, epoch: 1 }, plaintext: utf8("x") });
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
      const keys = standIn(40, 1);
      const published = await ll.publish({ account, keys });
      expect((await ll.resolve(account.address)).epoch).toBe(1);
      const dropped = await ll.drop({ account, envelope: await ll.sealTo(account.address, utf8("through a strict RPC")) });
      const box = await ll.inbox(account.address, { fromBlock: published.blockNumber, toBlock: dropped.blockNumber });
      expect(box.envelopes.map((e) => e.transactionHash)).toEqual([dropped.transactionHash]);
      expect(proxy.stats.batches).toBe(0);
    } finally { await proxy.close(); }
  });
});

describe.skipIf(noChain)("an agent's key is its own, never its owner's (the agent id is in the derivation)", () => {
  it("a key derived for the owner's address is refused for the agent; deriveForAgent's key cannot open the owner's notes", async () => {
    if (!ctx.ok) return;
    const dev = softAuthenticator();
    const { keys: ownerKeys, credential } = await createEncryptionAddress({ rp: { id: LETTERLOCK_RP_ID, name: "Letterlock" }, user: { name: "ops", displayName: "Operator" }, webAuthnClient: dev });
    const owner = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential, webAuthnClient: dev });
    await fund(owner.address, "1");
    await client().publish({ account: owner, keys: ownerKeys });
    const agentId = newAgentId();
    await sendAs(ctx.registry, registryAbi, "mint", [owner.address, agentId]);

    // the owner's own epoch-1 key, as deriveFromPasskey gives it: never an agent's key
    const own = await deriveFromPasskey({ rpId: LETTERLOCK_RP_ID, epoch: 1, credential, webAuthnClient: dev });
    expect(toHex(own.publicKey)).toBe(toHex(ownerKeys.publicKey));
    await rejects(client().publishForAgent({ account: owner, agentId, keys: own }), "INPUT_INVALID");
    // nor the owner's key labelled as the agent's by hand: the directory holds it as the owner's
    await rejects(client().publishForAgent({ account: owner, agentId, keys: { ...own, agentId } }), "INPUT_INVALID");

    const agentKeys = await deriveForAgent({ rpId: LETTERLOCK_RP_ID, agentId, epoch: 1, credential, webAuthnClient: dev });
    await rejects(client().publishForAgent({ account: owner, agentId: agentId + 1n, keys: agentKeys }), "INPUT_INVALID"); // another agent's
    await rejects(client().publish({ account: owner, keys: agentKeys }), "INPUT_INVALID"); // an agent's key is not an address key
    await client().publishForAgent({ account: owner, agentId, keys: agentKeys });
    const [a, b] = [await client().resolve(owner.address), await client().resolve(`agent:${agentId}`)];
    expect(toHex(b.publicKey)).toBe(toHex(agentKeys.publicKey));
    expect(toHex(b.publicKey)).not.toBe(toHex(a.publicKey));

    // the agent's server holds agentKeys: the owner's own notes stay closed to it
    const note = await client().sealTo(owner.address, utf8("the owner's private note"));
    await rejects(open(note, agentKeys), "WRONG_KEY");
    expect(new TextDecoder().decode(await open(await client().sealTo(`agent:${agentId}`, utf8("a task")), agentKeys))).toBe("a task");

    // an earlier key of the owner is no longer in the directory, and is refused all the same: it opens the owner's
    // earlier notes (the owner rotates to epoch 3; its epoch-2 key is the agent's next epoch, which the directory takes)
    await client().rotate({ account: owner, credential, webAuthnClient: dev });
    await client().rotate({ account: owner, credential, webAuthnClient: dev });
    const earlier = await deriveFromPasskey({ rpId: LETTERLOCK_RP_ID, epoch: 2, credential, webAuthnClient: dev });
    await rejects(client().publishForAgent({ account: owner, agentId, keys: earlier }), "INPUT_INVALID");
    owner.end();
  });
});

describe.skipIf(noChain)("a registry that cannot answer (RegistryCallFailed): unknown, never 'no key'", () => {
  // Every test that sets the shared faulty registry's fault lives in this file: vitest runs files in parallel, and a
  // fault set by one file while another file's test runs made that test fail (CI on main, 2026-10-03).
  it("RegistryCallFailed on a read → CHAIN_UNAVAILABLE (unknown, not 'no key')", async () => {
    if (!ctx.ok) return;
    const owner = await fundedAccount();
    const id = newAgentId();
    await sendAs(ctx.faultyRegistry, faultyAbi, "mint", [owner.address, id]);
    await client({ directory: ctx.directoryFaulty }).publishForAgent({ account: owner, agentId: id, keys: agentStandIn(43, id, 1) });
    await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [Fault.OtherCustomError]);
    try {
      const e = await publicClient()
        .readContract({ address: ctx.directoryFaulty, abi: sdk.letterlockAbi, functionName: "keyOfAgent", args: [id] })
        .then(() => undefined, (x: unknown) => sdk.toLetterlockError(x, "call"));
      expect(e?.code).toBe("CHAIN_UNAVAILABLE");
      expect(e?.message).toContain("(RegistryCallFailed)");
    } finally {
      await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [Fault.None]);
    }
  });

  it.each([["EmptyRevert", Fault.EmptyRevert], ["OutOfGas", Fault.OutOfGas], ["ErrorString", Fault.ErrorString], ["Panic", Fault.Panic]])(
    "ownerOf fails with %s → resolve, sealTo, drop and publishForAgent throw CHAIN_UNAVAILABLE", async (_, fault) => {
      if (!ctx.ok) return;
      const ll = client({ directory: ctx.directoryFaulty });
      const acct = await fundedAccount();
      const id = newAgentId();
      await sendAs(ctx.faultyRegistry, faultyAbi, "mint", [acct.address, id]);
      const keys = agentStandIn(24, id, 1);
      await ll.publishForAgent({ account: acct, agentId: id, keys });
      const env = await ll.sealTo(`agent:${id}`, utf8("x"));
      await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [fault]);
      try {
        await rejects(ll.resolve(`agent:${id}`), "CHAIN_UNAVAILABLE");
        await rejects(ll.sealTo(`agent:${id}`, utf8("x")), "CHAIN_UNAVAILABLE");
        await rejects(ll.drop({ account: acct, envelope: env }), "CHAIN_UNAVAILABLE");
        await rejects(ll.publishForAgent({ account: acct, agentId: id, keys: agentStandIn(25, id, 2) }), "CHAIN_UNAVAILABLE");
      } finally {
        await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [Fault.None]);
      }
    });
});
