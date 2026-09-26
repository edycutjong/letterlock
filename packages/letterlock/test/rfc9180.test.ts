// RFC 9180 Appendix A.2.1 — DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, base mode.
// Proves the exact suite Letterlock ships reproduces the published vectors on both sides.
import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "../src/bytes.ts";
import { suite } from "../src/envelope.ts";

const V = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  ikmE: "909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b",
  ikmR: "1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df",
  pkRm: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
  skRm: "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb",
  enc: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
  pt: "4265617574792069732074727574682c20747275746820626561757479",
  aad0: "436f756e742d30",
  ct0: "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28",
};
const buf = (h: string) => fromHex(h).slice().buffer;

describe("RFC 9180 A.2.1 vectors", () => {
  it("DeriveKeyPair(ikmR) reproduces skRm/pkRm", async () => {
    const kp = await suite.kem.deriveKeyPair(fromHex(V.ikmR));
    expect(toHex(new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)))).toBe(V.pkRm);
    expect(toHex(new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey)))).toBe(V.skRm);
  });

  it("seal with ikmE reproduces enc and sequence-0 ciphertext", async () => {
    const recipientPublicKey = await suite.kem.importKey("raw", buf(V.pkRm), true);
    const sender = await suite.createSenderContext({ recipientPublicKey, info: fromHex(V.info), ekm: fromHex(V.ikmE) });
    expect(toHex(new Uint8Array(sender.enc))).toBe(V.enc);
    expect(toHex(new Uint8Array(await sender.seal(fromHex(V.pt), fromHex(V.aad0))))).toBe(V.ct0);
  });

  it("open with raw-imported skRm recovers the plaintext (the import path open() uses)", async () => {
    const recipientKey = {
      privateKey: await suite.kem.importKey("raw", buf(V.skRm), false),
      publicKey: await suite.kem.importKey("raw", buf(V.pkRm), true),
    };
    const pt = await suite.open({ recipientKey, enc: buf(V.enc), info: fromHex(V.info) }, fromHex(V.ct0), fromHex(V.aad0));
    expect(toHex(new Uint8Array(pt))).toBe(V.pt);
  });
});
