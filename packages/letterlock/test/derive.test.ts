import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { toHex } from "../src/bytes.ts";
import { deriveKeyPair, fingerprint, prfSaltFor } from "../src/derive.ts";
import { isLetterlockError } from "../src/errors.ts";

const prf = Uint8Array.from({ length: 32 }, (_, i) => i);

describe("derivation", () => {
  it("is deterministic: same PRF output + epoch → same key pair", () => {
    const a = deriveKeyPair(prf, 1), b = deriveKeyPair(prf.slice(), 1);
    expect(toHex(a.secretKey)).toBe(toHex(b.secretKey));
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey));
  });

  it("public key is X25519(sk)", () => {
    const k = deriveKeyPair(prf, 1);
    expect(toHex(k.publicKey)).toBe(toHex(x25519.getPublicKey(k.secretKey)));
    expect(k.publicKey).toHaveLength(32);
  });

  it("each epoch uses its own PRF salt and its own HKDF info", () => {
    expect(toHex(prfSaltFor(1))).not.toBe(toHex(prfSaltFor(2)));
    expect(prfSaltFor(1)).toHaveLength(32);
    // even with an identical PRF output, epoch separation still holds via HKDF info
    expect(toHex(deriveKeyPair(prf, 1).publicKey)).not.toBe(toHex(deriveKeyPair(prf, 2).publicKey));
  });

  it("the Letterlock salt namespace differs from mera's default account salt", async () => {
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const meraDefault = toHex(sha256(new TextEncoder().encode("mera.prf.salt.v1")));
    for (const e of [1, 2, 3]) expect(toHex(prfSaltFor(e))).not.toBe(meraDefault);
  });

  it("pins the derivation so a silent change breaks the build (golden value)", () => {
    expect(toHex(prfSaltFor(1))).toMatchInlineSnapshot(`"cfaeb6c52fb44ecb20e696cec98b904c35e1d92443e22b4dc1e9341d54033573"`);
    expect(toHex(deriveKeyPair(prf, 1).publicKey)).toMatchInlineSnapshot(`"7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b"`);
    expect(fingerprint(deriveKeyPair(prf, 1).publicKey)).toMatchInlineSnapshot(`"48fd7d26d39587bf"`);
  });

  it.each([0, -1, 1.5, 2 ** 32, Number.NaN])("rejects epoch %s", (e) => {
    expect(() => prfSaltFor(e)).toThrow();
    try { deriveKeyPair(prf, e); } catch (err) { expect(isLetterlockError(err, "INPUT_INVALID")).toBe(true); }
  });

  it("rejects a PRF output that is not 32 bytes as PRF_UNSUPPORTED", () => {
    expect(() => deriveKeyPair(new Uint8Array(31), 1)).toThrow(/PRF_UNSUPPORTED/);
  });
});
