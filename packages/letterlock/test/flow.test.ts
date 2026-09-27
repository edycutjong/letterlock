// The whole Letterlock flow on the real directory bytecode (local anvil, chain id 143), with the passkey played by
// the software authenticator driving the REAL mera ceremonies:
//   Maya's Mac creates a passkey → derives her epoch-1 key and her passkey account → the account publishes the key
//   an unrelated agent (its own client, no passkey) resolves Maya → seals a note → drops it
//   Maya's iPad (the same passkey, synced) reads the inbox → opens the note with ONE prompt
//   Maya rotates → new notes use epoch 2, the old note still opens
// On anvil the account is funded with anvil_setBalance; on Monad it needs MON for gas.
import { parseEventLogs } from "viem";
import { describe, expect, it } from "vitest";
import { LETTERLOCK_RP_ID, createEncryptionAddress, fingerprint, letterlockAbi, meraAccount, open, toHex } from "../src/index.ts";
import { client, fund, fundedAccount, noChain, publicClient, testClient } from "./anvil/context.ts";
import { softAuthenticator } from "./soft-authenticator.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe.skipIf(noChain)("publish → resolve → seal → drop → inbox → open", () => {
  it("one passkey derives the key AND signs its publish; a stranger seals; a synced device opens", async () => {
    // Maya's Mac: one passkey, two derivations (Letterlock's salt for the key, mera's for the account)
    const mac = softAuthenticator();
    const { keys, credential } = await createEncryptionAddress({ rp: { id: LETTERLOCK_RP_ID, name: "Letterlock" }, user: { name: "maya", displayName: "Maya" }, webAuthnClient: mac });
    const account = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential, webAuthnClient: mac });
    expect(mac.calls).toEqual({ create: 1, get: 1 });
    await fund(account.address, "1");

    const maya = client(); // the production rpId: no unsafe flag anywhere in this flow
    const published = await maya.publish({ account, keys });
    const receipt = await publicClient().getTransactionReceipt({ hash: published.transactionHash });
    expect(receipt.from).toBe(account.address.toLowerCase()); // signed by the passkey account
    const [log] = parseEventLogs({ abi: letterlockAbi, logs: receipt.logs, eventName: "KeyPublished" });
    expect(log?.args).toMatchObject({ who: account.address, pub: `0x${toHex(keys.publicKey)}`, epoch: 1 });
    account.end();
    keys.secretKey.fill(0); // nothing secret is kept: the iPad re-derives

    // an unrelated agent: its own client and its own funded key, no passkey
    const agent = client();
    const sender = await fundedAccount("1");
    const key = await agent.resolve(account.address);
    expect(key.kid).toBe(fingerprint(keys.publicKey));
    const envelope = await agent.sealTo(account.address, utf8("the dentist moved to Thursday 10:40"));
    const dropped = await agent.drop({ account: sender, envelope });
    expect(dropped.recipient).toBe(account.address.toLowerCase());

    // Maya's iPad: the same passkey, synced; nothing stored on it. inbox() reads up to the finalized block, and on
    // Monad a block is finalized two blocks after it is proposed
    await testClient().mine({ blocks: 2 });
    const ipad = mac.syncedTo();
    const inbox = await client().inbox(account.address, { fromBlock: published.blockNumber });
    expect(inbox.rejected).toEqual([]);
    expect(inbox.envelopes.map((e) => e.transactionHash)).toEqual([dropped.transactionHash]);
    expect(inbox.envelopes[0]!.envelope).toEqual(envelope);
    expect(inbox.envelopes[0]!.bytes).toBe(dropped.bytes);
    const opened = await client().open(inbox.envelopes[0]!.envelope, { credential, webAuthnClient: ipad });
    expect(text(opened)).toBe("the dentist moved to Thursday 10:40");
    expect(ipad.calls.get).toBe(1);

    // rotation from the iPad: a fresh account session signs, the passkey derives epoch 2
    const ipadAccount = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential, webAuthnClient: ipad });
    expect(ipadAccount.address).toBe(account.address);
    const rotated = await client().rotate({ account: ipadAccount, credential, webAuthnClient: ipad });
    expect(rotated.epoch).toBe(2);
    expect(ipad.calls.get).toBe(3); // one open, one account, one epoch-2 key
    const newer = await agent.sealTo(account.address, utf8("after rotation"));
    expect(newer.epoch).toBe(2);
    await agent.drop({ account: sender, envelope: newer });
    ipadAccount.end();
    await testClient().mine({ blocks: 2 });

    const all = await client().inbox(account.address, { fromBlock: published.blockNumber });
    expect(all.envelopes.map((e) => e.envelope.epoch)).toEqual([1, 2]);
    for (const [i, want] of ["the dentist moved to Thursday 10:40", "after rotation"].entries())
      expect(text(await client().open(all.envelopes[i]!.envelope, { credential, webAuthnClient: ipad }))).toBe(want);
  });

  it("an agent on the ERC-8004 path: the owner's passkey account publishes for it, and it receives sealed tasks", async () => {
    const { ctx, registryAbi, sendAs, newAgentId } = await import("./anvil/context.ts");
    if (!ctx.ok) return;
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp: { id: LETTERLOCK_RP_ID, name: "Letterlock" }, user: { name: "ops", displayName: "Agent operator" }, webAuthnClient: dev });
    const owner = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential, webAuthnClient: dev });
    await fund(owner.address, "1");
    const agentId = newAgentId();
    await sendAs(ctx.registry, registryAbi, "mint", [owner.address, agentId]);
    // the agent's key comes from the owner's passkey with the agent id in the derivation: its server can hold the
    // secret (open(envelope, agentKeys)) without it opening anything sealed to the owner
    const { deriveForAgent } = await import("../src/index.ts");
    const agentKeys = await deriveForAgent({ rpId: LETTERLOCK_RP_ID, agentId, epoch: 1, credential, webAuthnClient: dev });
    const r = await client().publishForAgent({ account: owner, agentId, keys: agentKeys });
    const sender = await fundedAccount("1");
    const env = await client().sealTo(`agent:${agentId}`, utf8("summarise the 10:40 call"));
    await client().drop({ account: sender, envelope: env });
    await testClient().mine({ blocks: 2 }); // finalized
    const inbox = await client().inbox(`agent:${agentId}`, { fromBlock: r.blockNumber });
    expect(inbox.envelopes).toHaveLength(1);
    expect(text(await open(inbox.envelopes[0]!.envelope, agentKeys))).toBe("summarise the 10:40 call"); // the agent's server
    agentKeys.secretKey.fill(0);
    // and the owner's passkey, on any device: open() derives the agent's key for an agent:<id> envelope
    expect(text(await client().open(inbox.envelopes[0]!.envelope, { credential, webAuthnClient: dev.syncedTo() }))).toBe("summarise the 10:40 call");
    owner.end();
  });
});
