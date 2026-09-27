// The agent's key is docs/SPEC.md §2's agent key, with a seed standing in for the owner's passkey. These tests
// recompute it with Node's own crypto (OpenSSL: HMAC, HKDF, X25519), not the libraries the code uses.
import { createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import { deriveAgentKeyPair, deriveKeyPair, fingerprint, open, seal, toHex } from "letterlock";
import { describe, expect, it } from "vitest";
import { agentKeyFromSeed, agentPublicKey, seedPrf } from "../src/agent-key.ts";

const seed = new Uint8Array(32).map((_, i) => i + 1);

/** The whole derivation, spelled out from SPEC §2 and WebAuthn L3 §10.1.4, on OpenSSL. */
const independent = (s: Uint8Array, agentId: bigint, epoch: number) => {
  const salt = createHash("sha256").update(`letterlock/hpke/v1/agent:${agentId}/${epoch}`).digest();
  const evalSalt = createHash("sha256").update(Buffer.concat([Buffer.from("WebAuthn PRF"), Buffer.from([0]), salt])).digest();
  const prf = createHmac("sha256", s).update(evalSalt).digest();
  const sk = Buffer.from(hkdfSync("sha256", prf, "letterlock/v1", `letterlock/v1/x25519/agent:${agentId}/${epoch}`, 32));
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), sk]);
  const pk = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(-32);
  return { prf: new Uint8Array(prf), secretKey: new Uint8Array(sk), publicKey: new Uint8Array(pk) };
};

describe("agentKeyFromSeed", () => {
  it("is SPEC §2's agent key over a WebAuthn PRF whose credential secret is the seed (checked on OpenSSL)", () => {
    for (const [agentId, epoch] of [[10260n, 2], [10260n, 3], [0n, 1], [2n ** 200n, 4_000_000_000]] as const) {
      const ours = agentKeyFromSeed(seed, agentId, epoch);
      const theirs = independent(seed, agentId, epoch);
      expect(toHex(ours.secretKey)).toBe(toHex(theirs.secretKey));
      expect(toHex(ours.publicKey)).toBe(toHex(theirs.publicKey));
      expect(ours.agentId).toBe(agentId);
      expect(ours.epoch).toBe(epoch);
    }
    expect(toHex(seedPrf(seed, new Uint8Array(createHash("sha256").update("letterlock/hpke/v1/agent:10260/2").digest()))))
      .toBe(toHex(independent(seed, 10260n, 2).prf));
  });

  it("is the SDK's deriveAgentKeyPair over that PRF output, never the address formula", () => {
    const prf = independent(seed, 10260n, 2).prf;
    expect(toHex(agentKeyFromSeed(seed, 10260n, 2).publicKey)).toBe(toHex(deriveAgentKeyPair(prf, 10260n, 2).publicKey));
    expect(toHex(agentKeyFromSeed(seed, 10260n, 2).publicKey)).not.toBe(toHex(deriveKeyPair(prf, 2).publicKey));
  });

  it("gives an unrelated key for every epoch, every agent and every seed, and the same key every time", () => {
    const keys = [
      agentKeyFromSeed(seed, 10260n, 2),
      agentKeyFromSeed(seed, 10260n, 3),
      agentKeyFromSeed(seed, 10261n, 2),
      agentKeyFromSeed(seed.map((b) => b ^ 1), 10260n, 2),
    ].map((k) => toHex(k.publicKey));
    expect(new Set(keys).size).toBe(4);
    expect(toHex(agentKeyFromSeed(seed, 10260n, 2).publicKey)).toBe(keys[0]);
  });

  it("opens what is sealed to its public half, and agentPublicKey reports that half with its kid", async () => {
    const pub = agentPublicKey(seed, 10260n, 2);
    const envelope = await seal({
      chainId: 143,
      directory: "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e",
      to: { recipient: "agent:10260", publicKey: pub.publicKey, epoch: 2 },
      plaintext: new TextEncoder().encode("for the agent"),
    });
    expect(envelope.kid).toBe(pub.kid);
    expect(pub.kid).toBe(fingerprint(pub.publicKey));
    const keys = agentKeyFromSeed(seed, 10260n, 2);
    expect(new TextDecoder().decode(await open(envelope, keys))).toBe("for the agent");
  });

  it("refuses a seed that is not 32 bytes", () => {
    expect(() => agentKeyFromSeed(new Uint8Array(31), 10260n, 2)).toThrow(/32 bytes/);
    expect(() => agentKeyFromSeed(new Uint8Array(33), 10260n, 2)).toThrow(/32 bytes/);
  });
});
