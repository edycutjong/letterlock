// P256-binding spike (an optional ownership proof). Question: can the SAME passkey mera uses also prove, onchain via
// Monad's P256 precompile 0x0100 (EIP-7951), that it vouches for a given Letterlock X25519 key?
//  1. a capturing WebAuthnClient runs mera's creation ceremony and records the credential's P256 public key
//     (mera never returns it — a limit of mera 0.2.0)
//  2. a second assertion signs
//       challenge = SHA-256("letterlock/bind/v1" ‖ u64 chainId ‖ directory[20] ‖ owner[20] ‖ x25519pk[32] ‖ u32 epoch)
//     (owner + chainId + directory stop a public signature being replayed for another address, chain or
//      directory; u32 epoch stops epoch+256 aliasing — audit round 1, findings 1–2)
//  3. the WebAuthn message hash h = SHA-256(authData ‖ SHA-256(clientDataJSON)) + (r, s, qx, qy) = the 160-byte
//     precompile input; the runner eth_calls it on Monad testnet and mainnet.
import type { WebAuthnClient } from "@category-labs/mera";
import { createEncryptionAddress, fromHex, toB64url, toHex } from "letterlock";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const u8 = (b: ArrayBuffer | ArrayBufferView) => new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const sha256 = async (b: Uint8Array) => u8(await crypto.subtle.digest("SHA-256", b.slice()));
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const be32 = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 0xffn));
const big = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** Strict DER ECDSA-Sig-Value → (r, s) in [1, n-1], low-s normalized (EIP-7951 accepts both; normalizing is harmless). */
const derToRS = (der: Uint8Array): [bigint, bigint] => {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("bad DER: SEQUENCE header");
  let i = 2;
  const read = () => {
    if (der[i++] !== 0x02) throw new Error("bad DER: INTEGER tag");
    const len = der[i++]!; if (len < 1 || len > 33 || i + len > der.length) throw new Error("bad DER: INTEGER length");
    const v = big(der.slice(i, i + len)); i += len; return v;
  };
  const r = read(); let s = read();
  if (i !== der.length) throw new Error("bad DER: trailing bytes");
  if (r < 1n || r >= N || s < 1n || s >= N) throw new Error("bad DER: r/s out of range");
  if (s > N / 2n) s = N - s; return [r, s];
};

type Captured = { credentialId?: Uint8Array; alg?: number; spki?: Uint8Array };

/** mera-compatible browser client that also captures the P256 public key at creation. */
const capturingClient = (cap: Captured): WebAuthnClient => ({
  async createCredential(req) {
    const cred = (await navigator.credentials.create({ publicKey: {
      rp: req.rp, user: req.user, challenge: req.challenge,
      pubKeyCredParams: req.algorithms.map((alg) => ({ type: "public-key" as const, alg })),
      authenticatorSelection: { residentKey: req.residentKey, requireResidentKey: true, userVerification: req.userVerification },
      attestation: req.attestation, timeout: req.timeout,
      extensions: { prf: { eval: { first: req.prfSalt } } } as AuthenticationExtensionsClientInputs,
    } })) as PublicKeyCredential;
    const resp = cred.response as AuthenticatorAttestationResponse;
    cap.credentialId = u8(cred.rawId); cap.alg = resp.getPublicKeyAlgorithm();
    const spki = resp.getPublicKey(); if (spki) cap.spki = u8(spki);
    const prf = (cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: BufferSource } } }).prf;
    return {
      credentialId: u8(cred.rawId), transports: resp.getTransports?.() as never, prfEnabled: prf?.enabled ?? !!prf?.results,
      ...(prf?.results?.first ? { prfOutput: u8(prf.results.first as ArrayBuffer) } : {}),
    };
  },
  async getCredential(req) {
    const cred = (await navigator.credentials.get({ publicKey: {
      rpId: req.rpId, challenge: req.challenge, userVerification: req.userVerification, timeout: req.timeout,
      allowCredentials: req.allowCredential ? [{ type: "public-key", id: req.allowCredential.credentialId }] : [],
      extensions: { prf: { eval: { first: req.prfSalt } } } as AuthenticationExtensionsClientInputs,
    } })) as PublicKeyCredential;
    const prf = (cred.getClientExtensionResults() as { prf?: { results?: { first?: BufferSource } } }).prf;
    return { credentialId: u8(cred.rawId), ...(prf?.results?.first ? { prfOutput: u8(prf.results.first as ArrayBuffer) } : {}) };
  },
});

const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u64 = (n: number) => cat(u32(Math.floor(n / 2 ** 32)), u32(n >>> 0));

export type BindContext = { chainId: number; directory: `0x${string}`; owner: `0x${string}` };

export const bindChallenge = (c: BindContext, x25519pk: Uint8Array, epoch: number) =>
  sha256(cat(new TextEncoder().encode("letterlock/bind/v1"), u64(c.chainId), fromHex(c.directory), fromHex(c.owner), x25519pk, u32(epoch)));

export const p256BindingCheck = async (rp: { id: string; name: string }, ctx: BindContext) => {
  const cap: Captured = {};
  const { keys } = await createEncryptionAddress({ rp, user: { name: "maya-bind", displayName: "Maya" }, webAuthnClient: capturingClient(cap) });
  if (cap.alg !== -7 || !cap.spki) return { verdict: "CUT", reason: `authenticator chose alg ${cap.alg} (need ES256 -7) or hid the key` };
  const pub = await crypto.subtle.importKey("spki", cap.spki.slice(), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const raw = u8(await crypto.subtle.exportKey("raw", pub));          // 0x04 ‖ x ‖ y
  const qx = raw.slice(1, 33), qy = raw.slice(33, 65);

  const challenge = await bindChallenge(ctx, keys.publicKey, keys.epoch);
  const a = (await navigator.credentials.get({ publicKey: {
    rpId: rp.id, challenge: challenge.slice(), userVerification: "required",
    allowCredentials: [{ type: "public-key", id: cap.credentialId!.slice() }],
  } })) as PublicKeyCredential;
  const r = a.response as AuthenticatorAssertionResponse;
  const authData = u8(r.authenticatorData), cdj = u8(r.clientDataJSON), sig = u8(r.signature);
  const client = JSON.parse(new TextDecoder().decode(cdj)) as { type: string; challenge: string; origin: string };
  const signed = cat(authData, await sha256(cdj));
  const h = await sha256(signed);
  const [rr, ss] = derToRS(sig);
  const webcryptoOk = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, cat(be32(rr), be32(ss)).slice(), signed.slice());
  return {
    verdict: "PENDING_ONCHAIN",
    x25519pk: toHex(keys.publicKey), epoch: keys.epoch,
    clientDataOk: client.type === "webauthn.get" && client.challenge === toB64url(challenge) && client.origin === location.origin,
    rpIdHashOk: toHex(authData.slice(0, 32)) === toHex(await sha256(new TextEncoder().encode(rp.id))),
    upFlag: ((authData[32] ?? 0) & 0x01) !== 0,
    uvFlag: ((authData[32] ?? 0) & 0x04) !== 0,
    // What 0x0100 alone proves: this P256 key signed this h. It does NOT prove the P256 key belongs to `owner`
    // — the contract must anchor Q to msg.sender (the mera account) and recompute h from authData +
    // clientDataJSON itself (see docs/SPEC.md §7).
    webcryptoOk,
    precompileInput: "0x" + toHex(cat(h, be32(rr), be32(ss), qx, qy)),
    tamperedInput: "0x" + toHex(cat(h.map((b, i) => (i === 0 ? b ^ 1 : b)), be32(rr), be32(ss), qx, qy)),
    authDataLen: authData.length, clientDataJSON: new TextDecoder().decode(cdj),
  };
};
