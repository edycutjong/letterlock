// Drives the REAL mera functions (createPasskeyWithPrfOutput / getPasskeyPrfOutput) through a software
// authenticator: proves Letterlock's salt reaches the PRF, the create-time fallback path works, and a second
// "device" with the synced passkey re-derives the identical key — the cross-device claim of the demo.
import { describe, expect, it } from "vitest";
import { toHex, utf8 } from "../src/bytes.ts";
import { open, seal } from "../src/envelope.ts";
import { isLetterlockError } from "../src/errors.ts";
import { createEncryptionAddress, deriveFromPasskey } from "../src/passkey.ts";
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
      recipient: "0x4d2c0f6aa3b91e7ca4e8b1c0dd8ff2a1b3c4d5e6", publicKey: keys.publicKey, epoch: 1,
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

  it("a passkey from another relying party is not found (rpId isolation)", async () => {
    const dev = softAuthenticator();
    await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    await expect(deriveFromPasskey({ rpId: "evil.test", epoch: 1, webAuthnClient: dev })).rejects.toThrow();
  });
});
