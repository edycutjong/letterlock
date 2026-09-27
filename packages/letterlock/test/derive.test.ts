import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { toHex } from "../src/bytes.ts";
import { agentPrfSaltFor, deriveAgentKeyPair, deriveKeyPair, fingerprint, prfSaltFor } from "../src/derive.ts";
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

  it.each([0, -1, 1.5, 2 ** 32, Number.NaN])("rejects epoch %s as INPUT_INVALID", (e) => {
    const code = (f: () => unknown) => { try { f(); return "no error"; } catch (err) { return isLetterlockError(err) ? err.code : String(err); } };
    expect(code(() => prfSaltFor(e))).toBe("INPUT_INVALID");
    expect(code(() => deriveKeyPair(prf, e))).toBe("INPUT_INVALID");
  });

  it("rejects a PRF output that is not 32 bytes as PRF_UNSUPPORTED", () => {
    expect(() => deriveKeyPair(new Uint8Array(31), 1)).toThrow(/PRF_UNSUPPORTED/);
  });
});

describe("an ERC-8004 agent's key (the agent id in the salt and in the HKDF info)", () => {
  it("pins the agent derivation (golden values, computed from the formula with @noble directly)", () => {
    expect(toHex(agentPrfSaltFor(10260n, 1))).toBe("99ee899df83f5ad5c2848f5dacee4fd00c9908b7dc62785506c59fc75b000d59");
    const k = deriveAgentKeyPair(prf, 10260n, 1);
    expect(toHex(k.publicKey)).toBe("ad53f0bc457b503d1cf29d27924a0c3d9286429779e4fd1fc8c795804d86aa5d");
    expect(fingerprint(k.publicKey)).toBe("3698ae3b767dec51");
    expect([k.agentId, k.epoch]).toEqual([10260n, 1]);
  });

  it("is never the owner's own key: another salt, and another key even from the same PRF output", () => {
    for (const e of [1, 2]) {
      expect(toHex(agentPrfSaltFor(10260n, e))).not.toBe(toHex(prfSaltFor(e)));
      expect(toHex(deriveAgentKeyPair(prf, 10260n, e).publicKey)).not.toBe(toHex(deriveKeyPair(prf, e).publicKey));
    }
    expect(toHex(deriveAgentKeyPair(prf, 1n, 1).publicKey)).not.toBe(toHex(deriveAgentKeyPair(prf, 2n, 1).publicKey)); // nor another agent's
    expect(toHex(agentPrfSaltFor(1n, 23))).not.toBe(toHex(agentPrfSaltFor(12n, 3))); // "agent:1/23" vs "agent:12/3"
  });

  it.each([-1n, (1n << 256n) - 1n, 5 as never, "5" as never])("rejects agent id %s as INPUT_INVALID", (id) => {
    expect(() => agentPrfSaltFor(id, 1)).toThrow(/INPUT_INVALID/);
    expect(() => deriveAgentKeyPair(prf, id, 1)).toThrow(/INPUT_INVALID/);
  });
});
