import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { concat, fromB64url, fromHex, lp, toB64url, uintBE, utf8 } from "./bytes.ts";
import type { EncryptionKeyPair } from "./derive.ts";
import { LetterlockError } from "./errors.ts";

/** RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256) · HKDF-SHA256 · ChaCha20-Poly1305 (suite 0x0020/0x0001/0x0003). */
export const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

/** An EVM address (`0x` + 40 hex) or an ERC-8004 agent (`agent:<decimal id>`). */
export type Recipient = `0x${string}` | `agent:${string}`;

export type EnvelopeHeader = {
  readonly v: 1;
  readonly chainId: number;
  /** Letterlock directory contract address. */
  readonly directory: `0x${string}`;
  readonly recipient: Recipient;
  readonly epoch: number;
};

export type Envelope = EnvelopeHeader & {
  /** HPKE encapsulated key, base64url. */
  readonly enc: string;
  /** HPKE ciphertext, base64url. */
  readonly ct: string;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AGENT = /^agent:(0|[1-9][0-9]{0,77})$/;

/** Lower-cases addresses so a checksummed and a plain spelling bind to the same info. */
export const canonicalRecipient = (r: string): Recipient => {
  if (ADDRESS.test(r)) return r.toLowerCase() as Recipient;
  if (AGENT.test(r)) return r as Recipient;
  throw new LetterlockError("INPUT_INVALID", `recipient must be 0x<40 hex> or agent:<id>, got ${JSON.stringify(r)}`);
};

const checkHeader = (h: EnvelopeHeader): void => {
  if (h.v !== 1) throw new LetterlockError("INPUT_INVALID", `unsupported envelope version ${String(h.v)}`);
  if (!Number.isSafeInteger(h.chainId) || h.chainId <= 0) throw new LetterlockError("INPUT_INVALID", "bad chainId");
  if (!ADDRESS.test(h.directory)) throw new LetterlockError("INPUT_INVALID", "bad directory address");
  if (!Number.isInteger(h.epoch) || h.epoch < 1 || h.epoch > 0xffff_ffff) throw new LetterlockError("INPUT_INVALID", "bad epoch");
  canonicalRecipient(h.recipient);
};

/**
 * HPKE `info` binds the envelope to one chain, one directory, one recipient and one epoch (invariant I3):
 *   lp("letterlock/v1") ‖ u64(chainId) ‖ lp(directory[20]) ‖ lp(utf8(recipient)) ‖ u32(epoch)
 * Every variable-length field is length-prefixed, so no two headers encode to the same bytes.
 */
export const infoFor = (h: EnvelopeHeader): Uint8Array =>
  concat(
    lp(utf8("letterlock/v1")),
    uintBE(h.chainId, 8),
    lp(fromHex(h.directory)),
    lp(utf8(canonicalRecipient(h.recipient))),
    uintBE(h.epoch, 4),
  );

export type SealParams = {
  readonly chainId: number;
  readonly directory: `0x${string}`;
  readonly recipient: string;
  /** The recipient's published key and its epoch, as returned by keyOf(). */
  readonly publicKey: Uint8Array;
  readonly epoch: number;
  readonly plaintext: Uint8Array;
};

/** Seal bytes to a published key. Needs no passkey and no secret: anyone may seal. */
export const seal = async (p: SealParams): Promise<Envelope> => {
  if (p.publicKey.length !== 32) throw new LetterlockError("INPUT_INVALID", "X25519 public key must be 32 bytes");
  const header: EnvelopeHeader = {
    v: 1,
    chainId: p.chainId,
    directory: p.directory.toLowerCase() as `0x${string}`,
    recipient: canonicalRecipient(p.recipient),
    epoch: p.epoch,
  };
  checkHeader(header);
  const recipientPublicKey = await suite.kem.importKey("raw", p.publicKey.slice().buffer, true);
  const { enc, ct } = await suite.seal({ recipientPublicKey, info: infoFor(header) }, p.plaintext);
  return { ...header, enc: toB64url(new Uint8Array(enc)), ct: toB64url(new Uint8Array(ct)) };
};

/**
 * Open an envelope with the recipient's re-derived key pair. Any change to a header field, `enc` or `ct`
 * fails authentication and surfaces as TAMPERED; a key from another epoch surfaces as EPOCH_MISMATCH.
 */
export const open = async (env: Envelope, keys: EncryptionKeyPair): Promise<Uint8Array> => {
  checkHeader(env);
  if (env.epoch !== keys.epoch)
    throw new LetterlockError("EPOCH_MISMATCH", `envelope is sealed to epoch ${env.epoch}, key is epoch ${keys.epoch}`);
  let enc: Uint8Array, ct: Uint8Array;
  try { enc = fromB64url(env.enc); ct = fromB64url(env.ct); }
  catch (cause) { throw new LetterlockError("TAMPERED", "envelope fields are not base64url", { cause }); }
  const recipientKey = {
    privateKey: await suite.kem.importKey("raw", keys.secretKey.slice().buffer, false),
    publicKey: await suite.kem.importKey("raw", keys.publicKey.slice().buffer, true),
  };
  try {
    const pt = await suite.open({ recipientKey, enc: enc.slice().buffer, info: infoFor(env) }, ct);
    return new Uint8Array(pt);
  } catch (cause) {
    throw new LetterlockError("TAMPERED", "envelope failed authentication (altered, or sealed to a different key)", { cause });
  }
};
