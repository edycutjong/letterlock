import { describe, expect, it } from "vitest";
import { fromB64url, toB64url, utf8 } from "../src/bytes.ts";
import { deriveKeyPair, fingerprint } from "../src/derive.ts";
import { infoFor, open, seal, suite, type Envelope, type RecipientKey } from "../src/envelope.ts";
import { isLetterlockError, type LetterlockErrorCode } from "../src/errors.ts";

const maya = deriveKeyPair(new Uint8Array(32).fill(7), 1);
const nadia = deriveKeyPair(new Uint8Array(32).fill(9), 1);
const MAYA = "0x4D2c0F6aA3b91E7cA4E8B1c0dD8Ff2a1b3C4d5E6"; // test fixture address, not onchain
const DIR = "0x00000000000000000000000000000000000000Aa";
const note = utf8("the dentist moved to Thursday 10:40");
const mayaKey: RecipientKey = { recipient: MAYA, publicKey: maya.publicKey, epoch: 1 };
const base = { chainId: 143, directory: DIR, to: mayaKey, plaintext: note } as const;

const rejects = async (p: Promise<unknown>, code: LetterlockErrorCode) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(isLetterlockError(e, code), `expected ${code}, got ${String(e)}`).toBe(true);
};
const flip = (b64: string, i = 0) => { const b = fromB64url(b64); b[i % b.length]! ^= 1; return toB64url(b); };

describe("seal → open", () => {
  it("round-trips with the recipient's re-derived key", async () => {
    const env = await seal(base);
    expect(new TextDecoder().decode(await open(env, deriveKeyPair(new Uint8Array(32).fill(7), 1)))).toBe(
      "the dentist moved to Thursday 10:40",
    );
  });

  it("is randomized: two seals of the same note differ (fresh ephemeral key)", async () => {
    const [a, b] = await Promise.all([seal(base), seal(base)]);
    expect(a.enc).not.toBe(b.enc);
    expect(a.ct).not.toBe(b.ct);
  });

  it("envelope is plain JSON with a fixed field set and survives a database round-trip", async () => {
    const env = JSON.parse(JSON.stringify(await seal(base))) as Envelope;
    expect(Object.keys(env).sort()).toEqual(["chainId", "ct", "directory", "enc", "epoch", "kid", "recipient", "v"]);
    expect(env.recipient).toBe(MAYA.toLowerCase());
    expect(env.kid).toBe(fingerprint(maya.publicKey));
    expect(await open(env, maya)).toEqual(note);
  });

  it("binds a checksummed and a lower-case recipient to the same info", async () => {
    const env = await seal({ ...base, to: { ...mayaKey, recipient: MAYA.toUpperCase().replace("0X", "0x") } });
    expect(await open(env, maya)).toEqual(note);
  });

  it("works for an ERC-8004 agent recipient", async () => {
    const env = await seal({ ...base, to: { ...mayaKey, recipient: "agent:42" } });
    expect(env.recipient).toBe("agent:42");
    expect(await open(env, maya)).toEqual(note);
  });

  it("handles empty and 1 MiB payloads", async () => {
    expect(await open(await seal({ ...base, plaintext: new Uint8Array(0) }), maya)).toEqual(new Uint8Array(0));
    const big = new Uint8Array(1 << 20).map((_, i) => i & 0xff);
    expect(await open(await seal({ ...base, plaintext: big }), maya)).toEqual(big);
  });

  it("accepts subarray views over a shared buffer (byteOffset ≠ 0)", async () => {
    const pool = new Uint8Array(96); pool.set(maya.publicKey, 17);
    const env = await seal({ ...base, to: { ...mayaKey, publicKey: pool.subarray(17, 49) } });
    expect(await open(env, maya)).toEqual(note);
  });
});

describe("tamper and misuse surface as named errors", () => {
  it("a different person's key (same epoch) → WRONG_KEY before any crypto", async () =>
    rejects(open(await seal(base), nadia), "WRONG_KEY"));

  it("an edited kid can never make the RIGHT key fail (decrypt first, kid only explains failures)", async () => {
    const env = await seal(base);
    expect(await open({ ...env, kid: "0000000000000000" }, maya)).toEqual(note);
  });

  it.each([["a string", "hello, this is a secret note"], ["undefined", undefined], ["an object", { a: 1 }]])(
    "seal refuses %s as plaintext instead of sealing zero bytes", async (_, pt) =>
      rejects(seal({ ...base, plaintext: pt as never }), "INPUT_INVALID"));

  it("wrong key with the kid hint stripped → TAMPERED (authentication still holds)", async () => {
    const { kid: _kid, ...noKid } = await seal(base);
    await rejects(open(noKid as Envelope, nadia), "TAMPERED");
  });

  it("1 byte flipped in ct → TAMPERED (the demo's 'returned to sender')", async () => {
    const env = await seal(base);
    await rejects(open({ ...env, ct: flip(env.ct, 5) }, maya), "TAMPERED");
  });

  it("1 byte flipped in enc → TAMPERED", async () => {
    const env = await seal(base);
    await rejects(open({ ...env, enc: flip(env.enc, 3) }, maya), "TAMPERED");
  });

  it.each([
    ["chainId", { chainId: 10143 }],
    ["directory", { directory: "0x00000000000000000000000000000000000000bb" }],
    ["recipient", { recipient: "0x1111111111111111111111111111111111111111" }],
  ] as const)("re-addressed %s → TAMPERED (no cross-chain / cross-directory / re-address replay)", async (_, patch) => {
    const env = await seal(base);
    await rejects(open({ ...env, ...patch } as Envelope, maya), "TAMPERED");
  });

  it("epoch mismatch → EPOCH_MISMATCH before any crypto", async () => {
    const env = await seal(base);
    await rejects(open(env, deriveKeyPair(new Uint8Array(32).fill(7), 2)), "EPOCH_MISMATCH");
  });

  it("non-canonical base64url (unused trailing bits set) → TAMPERED, so one envelope has one spelling", async () => {
    const env = await seal(base);
    expect(env.enc).toHaveLength(43); // 32 bytes → 43 chars → the last char carries 2 unused bits
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alias = env.enc.slice(0, -1) + A[A.indexOf(env.enc.at(-1)!) ^ 1];
    expect(Buffer.from(alias, "base64url").equals(Buffer.from(env.enc, "base64url"))).toBe(true); // same bytes, lenient
    await rejects(open({ ...env, enc: alias }, maya), "TAMPERED");
    await rejects(open({ ...env, ct: "not base64!" }, maya), "TAMPERED");
  });

  it.each([
    ["recipient", { to: { ...mayaKey, recipient: "maya.eth" } }],
    ["recipient agent id", { to: { ...mayaKey, recipient: "agent:01" } }],
    ["directory", { directory: "0x1234" }],
    ["publicKey length", { to: { ...mayaKey, publicKey: new Uint8Array(31) } }],
    ["chainId", { chainId: 0 }],
    ["epoch", { to: { ...mayaKey, epoch: 0 } }],
  ] as const)("seal rejects bad %s as INPUT_INVALID", async (_, patch) =>
    rejects(seal({ ...base, ...patch } as never), "INPUT_INVALID"));

  it.each([
    ["all-zero key", new Uint8Array(32)],
    ["identity point u=1", Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0))],
    ["order-8 point", Uint8Array.from(Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex"))],
  ])("seal refuses a low-order recipient key (%s) as INPUT_INVALID", async (_, pk) =>
    rejects(seal({ ...base, to: { ...mayaKey, publicKey: pk } }), "INPUT_INVALID"));
});

describe("info encoding", () => {
  it("binds the epoch: same key, header epoch changed → HPKE open fails (isolates I3 from the key check)", async () => {
    const env = await seal(base);
    const recipientKey = {
      privateKey: await suite.kem.importKey("raw", maya.secretKey.slice().buffer, false),
      publicKey: await suite.kem.importKey("raw", maya.publicKey.slice().buffer, true),
    };
    const openWith = (epoch: number) =>
      suite.open({ recipientKey, enc: fromB64url(env.enc).slice().buffer, info: infoFor({ ...env, epoch }) }, fromB64url(env.ct));
    await expect(openWith(1)).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(openWith(2)).rejects.toThrow();
  });

  it("pins the exact info wire format (docs/SPEC.md §3) — a format change breaks every sealed envelope", () => {
    const hex = Buffer.from(infoFor({ v: 1, chainId: 143, directory: DIR, recipient: "agent:42", epoch: 7 })).toString("hex");
    expect(hex).toBe(
      "000d" + Buffer.from("letterlock/v1").toString("hex") + // lp("letterlock/v1")
      "000000000000008f" +                                     // u64 chainId 143
      "0014" + "00000000000000000000000000000000000000aa" +    // lp(directory[20])
      "0008" + Buffer.from("agent:42").toString("hex") +       // lp(utf8(recipient))
      "00000007",                                              // u32 epoch
    );
  });

  it("every header field changes the info bytes", () => {
    const h = { v: 1, chainId: 143, directory: DIR, recipient: MAYA, epoch: 1 } as const;
    const ref = Buffer.from(infoFor(h));
    for (const patch of [{ chainId: 10143 }, { directory: "0x00000000000000000000000000000000000000bb" }, { recipient: "agent:1" }, { epoch: 2 }])
      expect(Buffer.from(infoFor({ ...h, ...patch } as never)).equals(ref)).toBe(false);
  });

  it("is injective across field boundaries (length-prefixed)", () => {
    const h = { v: 1, chainId: 143, directory: DIR, epoch: 1 } as const;
    expect(Buffer.from(infoFor({ ...h, recipient: "agent:12" })).equals(Buffer.from(infoFor({ ...h, recipient: "agent:1" })))).toBe(false);
  });
});
