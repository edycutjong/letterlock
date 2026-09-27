// Drives the REAL mera functions (createPasskeyWithPrfOutput / getPasskeyPrfOutput) through a software
// authenticator: proves Letterlock's salt reaches the PRF, the create-time fallback path works, and a second
// "device" with the synced passkey re-derives the identical key — the cross-device claim of the demo.
import { describe, expect, it } from "vitest";
import { toHex, utf8 } from "../src/bytes.ts";
import { open, seal } from "../src/envelope.ts";
import { isLetterlockError } from "../src/errors.ts";
import { createEncryptionAddress, deriveForAgent, deriveFromPasskey, openWithPasskey } from "../src/passkey.ts";
import { softAuthenticator } from "./soft-authenticator.ts";

const rp = { id: "letterlock.test", name: "Letterlock" };
const user = { name: "maya", displayName: "Maya" };

describe("passkey → encryption address (via mera)", () => {
  it("one creation ceremony yields the epoch-1 key when PRF is evaluated at create time", async () => {
    const mac = softAuthenticator();
    const { keys, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: mac });
    expect(keys.epoch).toBe(1);
    expect(keys.publicKey).toHaveLength(32);
    expect(credential.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mac.calls).toEqual({ create: 1, get: 0 });
  });

  it("falls back to one assertion when the authenticator does not evaluate PRF at create (Safari/iCloud path)", async () => {
    const mac = softAuthenticator({ prfAtCreate: false });
    const { keys } = await createEncryptionAddress({ rp, user, webAuthnClient: mac });
    expect(mac.calls).toEqual({ create: 1, get: 1 });
    const again = await deriveFromPasskey({ rpId: rp.id, epoch: 1, webAuthnClient: mac });
    expect(toHex(again.publicKey)).toBe(toHex(keys.publicKey));
  });

  it("the SAME passkey on a second synced device re-derives the identical key and opens the note", async () => {
    const mac = softAuthenticator();
    const { keys, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: mac });
    const env = await seal({
      chainId: 143, directory: "0x00000000000000000000000000000000000000aa",
      to: { recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: keys.publicKey, epoch: 1 },
      plaintext: utf8("the dentist moved to Thursday 10:40"),
    });
    const ipad = mac.syncedTo();
    const k = await deriveFromPasskey({ rpId: rp.id, epoch: 1, credential, webAuthnClient: ipad });
    expect(toHex(k.publicKey)).toBe(toHex(keys.publicKey));
    expect(new TextDecoder().decode(await open(env, k))).toBe("the dentist moved to Thursday 10:40");
    expect(ipad.calls.get).toBe(1);
  });

  it("a different passkey (another person) derives a different key", async () => {
    const a = await createEncryptionAddress({ rp, user, webAuthnClient: softAuthenticator() });
    const b = await createEncryptionAddress({ rp, user, webAuthnClient: softAuthenticator() });
    expect(toHex(a.keys.publicKey)).not.toBe(toHex(b.keys.publicKey));
  });

  it("rotation: epoch 2 is a new key, and epoch 1 stays re-derivable for old notes", async () => {
    const dev = softAuthenticator();
    const { keys: k1, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const k2 = await deriveFromPasskey({ rpId: rp.id, epoch: 2, credential, webAuthnClient: dev });
    const k1again = await deriveFromPasskey({ rpId: rp.id, epoch: 1, credential, webAuthnClient: dev });
    expect(toHex(k2.publicKey)).not.toBe(toHex(k1.publicKey));
    expect(toHex(k1again.publicKey)).toBe(toHex(k1.publicKey));
  });

  it("an authenticator without PRF (e.g. Dashlane) surfaces PRF_UNSUPPORTED, not a silent downgrade", async () => {
    const e = await createEncryptionAddress({ rp, user, webAuthnClient: softAuthenticator({ supportsPrf: false }) })
      .then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "PRF_UNSUPPORTED")).toBe(true);
  });

  it("a passkey from another relying party is not found (rpId isolation) → PASSKEY_FAILED", async () => {
    const dev = softAuthenticator();
    await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const e = await deriveFromPasskey({ rpId: "evil.test", epoch: 1, webAuthnClient: dev }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "PASSKEY_FAILED")).toBe(true);
  });

  it("a malformed credential id → INPUT_INVALID (mera's own validation, wrapped)", async () => {
    const e = await deriveFromPasskey({ rpId: rp.id, epoch: 1, credential: { credentialId: "not/base64url=" }, webAuthnClient: softAuthenticator() })
      .then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID")).toBe(true);
  });

  it("create-time fallback stays pinned to the NEW passkey even when an older one exists for the site", async () => {
    const dev = softAuthenticator({ prfAtCreate: false });
    await createEncryptionAddress({ rp, user, webAuthnClient: dev });              // older passkey, listed first
    const { keys, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const pinned = await deriveFromPasskey({ rpId: rp.id, epoch: 1, credential, webAuthnClient: dev });
    expect(toHex(keys.publicKey)).toBe(toHex(pinned.publicKey));
  });

  it("choosing the wrong passkey at the prompt → WRONG_KEY, not TAMPERED", async () => {
    const dev = softAuthenticator();
    const first = await createEncryptionAddress({ rp, user, webAuthnClient: dev });   // e.g. an old passkey
    const second = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const env = await seal({ chainId: 143, directory: "0x00000000000000000000000000000000000000aa",
      to: { recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: second.keys.publicKey, epoch: 1 }, plaintext: utf8("hi") });
    const e = await openWithPasskey(env, { rpId: rp.id, credential: first.credential, webAuthnClient: dev }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "WRONG_KEY")).toBe(true);
    expect(await openWithPasskey(env, { rpId: rp.id, credential: second.credential, webAuthnClient: dev })).toEqual(utf8("hi"));
  });

  it("a malformed envelope is rejected before any passkey prompt", async () => {
    const dev = softAuthenticator();
    const { keys, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const env = await seal({ chainId: 143, directory: "0x00000000000000000000000000000000000000aa",
      to: { recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: keys.publicKey, epoch: 1 }, plaintext: utf8("hi") });
    const before = dev.calls.get;
    for (const bad of [{ ...env, ct: "not base64!" }, { ...env, chainId: 0 }]) {
      const e = await openWithPasskey(bad, { rpId: rp.id, credential, webAuthnClient: dev }).then(() => null, (x: unknown) => x);
      expect(isLetterlockError(e)).toBe(true);
    }
    expect(dev.calls.get).toBe(before);
  });

  it("deriveForAgent: the owner's passkey derives each agent a key of its own, the same on every synced device", async () => {
    const mac = softAuthenticator();
    const { keys: own, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: mac });
    const a = await deriveForAgent({ rpId: rp.id, agentId: 10260n, epoch: 1, credential, webAuthnClient: mac });
    const again = await deriveForAgent({ rpId: rp.id, agentId: "agent:10260", epoch: 1, credential, webAuthnClient: mac.syncedTo() });
    const other = await deriveForAgent({ rpId: rp.id, agentId: 10261, epoch: 1, credential, webAuthnClient: mac });
    expect(toHex(again.publicKey)).toBe(toHex(a.publicKey));
    expect(toHex(a.publicKey)).not.toBe(toHex(own.publicKey));
    expect(toHex(other.publicKey)).not.toBe(toHex(a.publicKey));
    expect([a.agentId, a.epoch, a.rpId]).toEqual([10260n, 1, rp.id]);
    // what the agent's server holds does not open the owner's own notes
    const ownNote = await seal({ chainId: 143, directory: "0x00000000000000000000000000000000000000aa",
      to: { recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: own.publicKey, epoch: 1 }, plaintext: utf8("mine") });
    const e = await open(ownNote, a).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "WRONG_KEY")).toBe(true);
  });

  it("openWithPasskey derives the agent's key for an agent:<id> envelope, and the address key otherwise", async () => {
    const dev = softAuthenticator();
    const { keys: own, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const agent = await deriveForAgent({ rpId: rp.id, agentId: 7, epoch: 1, credential, webAuthnClient: dev });
    const dir = "0x00000000000000000000000000000000000000aa" as const;
    const toAgent = await seal({ chainId: 143, directory: dir, to: { recipient: "agent:7", publicKey: agent.publicKey, epoch: 1 }, plaintext: utf8("task") });
    const toOwner = await seal({ chainId: 143, directory: dir, to: { recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: own.publicKey, epoch: 1 }, plaintext: utf8("note") });
    expect(await openWithPasskey(toAgent, { rpId: rp.id, credential, webAuthnClient: dev })).toEqual(utf8("task"));
    expect(await openWithPasskey(toOwner, { rpId: rp.id, credential, webAuthnClient: dev })).toEqual(utf8("note"));
    const e = await deriveForAgent({ rpId: rp.id, agentId: -1, epoch: 1, webAuthnClient: dev }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID")).toBe(true);
  });

  it("openWithPasskey derives the envelope's own epoch, so notes sealed before a rotation still open", async () => {
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const k2 = await deriveFromPasskey({ rpId: rp.id, epoch: 2, credential, webAuthnClient: dev });
    const k1 = await deriveFromPasskey({ rpId: rp.id, epoch: 1, credential, webAuthnClient: dev });
    const mk = (k: typeof k1, t: string) => seal({ chainId: 143, directory: "0x00000000000000000000000000000000000000aa",
      to: { recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: k.publicKey, epoch: k.epoch }, plaintext: utf8(t) });
    const [old, cur] = await Promise.all([mk(k1, "before rotation"), mk(k2, "after rotation")]);
    expect(new TextDecoder().decode(await openWithPasskey(old, { rpId: rp.id, credential, webAuthnClient: dev }))).toBe("before rotation");
    expect(new TextDecoder().decode(await openWithPasskey(cur, { rpId: rp.id, credential, webAuthnClient: dev }))).toBe("after rotation");
  });
});
