import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { concat, fromB64url, fromHex, lp, toB64url, uintBE, utf8 } from "./bytes.ts";
import { NO_AGENT } from "./deployments.ts";
import { fingerprint, type EncryptionKeyPair } from "./derive.ts";
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
  /**
   * Fingerprint of the recipient key sealed to (docs/SPEC.md §3). NOT authenticated — a routing hint that lets
   * open() say WRONG_KEY instead of TAMPERED. Tampering with it can only cause an error, never a decryption.
   */
  readonly kid: string;
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
  // a 64-hex-digit value pasted as a recipient may be a private key: never echo one into an error message
  const shown = typeof r === "string" ? JSON.stringify(r.replace(/[0-9a-fA-F]{64}/g, "[64 hex digits]")) : typeof r;
  throw new LetterlockError("INPUT_INVALID", `recipient must be 0x<40 hex> or agent:<id>, got ${shown}`);
};

/** `agent:<id>`, `<id>`, a number or a bigint → the agent id, below the NO_AGENT marker. */
export const toAgentId = (agent: bigint | number | string): bigint => {
  const text = typeof agent === "string" ? (agent.startsWith("agent:") ? agent : `agent:${agent}`) : undefined;
  let id: bigint;
  if (text !== undefined) id = BigInt(canonicalRecipient(text).slice("agent:".length));
  else if (typeof agent === "bigint" || (typeof agent === "number" && Number.isSafeInteger(agent))) id = BigInt(agent);
  else throw new LetterlockError("INPUT_INVALID", `agent id must be a non-negative integer, got ${String(agent)}`);
  if (id < 0n || id >= NO_AGENT) throw new LetterlockError("INPUT_INVALID", `agent id must be in 0..2^256 - 2, got ${id}`);
  return id;
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

/** A recipient's published key exactly as ONE keyOf() read returned it — key and epoch travel together. */
export type RecipientKey = {
  readonly recipient: string;
  readonly publicKey: Uint8Array;
  readonly epoch: number;
};

export type SealParams = {
  readonly chainId: number;
  readonly directory: `0x${string}`;
  /** Pass the keyOf() result as one value; never assemble publicKey and epoch from separate reads. */
  readonly to: RecipientKey;
  readonly plaintext: Uint8Array;
};

/** Seal bytes to a published key. Needs no passkey and no secret: anyone may seal. */
export const seal = async (p: SealParams): Promise<Envelope> => {
  const { to } = p;
  if (!(to.publicKey instanceof Uint8Array) || to.publicKey.length !== 32)
    throw new LetterlockError("INPUT_INVALID", "X25519 public key must be 32 bytes");
  const header: EnvelopeHeader = {
    v: 1,
    chainId: p.chainId,
    directory: p.directory.toLowerCase() as `0x${string}`,
    recipient: canonicalRecipient(to.recipient),
    epoch: to.epoch,
  };
  checkHeader(header);
  // a JS caller passing a string would otherwise seal ZERO bytes without any error
  if (!(p.plaintext instanceof Uint8Array))
    throw new LetterlockError("INPUT_INVALID", "plaintext must be a Uint8Array (encode text with TextEncoder)");
  const recipientPublicKey = await suite.kem.importKey("raw", to.publicKey.slice().buffer, true);
  let sealed: { enc: ArrayBuffer; ct: ArrayBuffer };
  try {
    sealed = await suite.seal({ recipientPublicKey, info: infoFor(header) }, p.plaintext);
  } catch (cause) {
    // encapsulation fails exactly when the DH output is all-zero: a low-order X25519 key (RFC 9180 §7.1.4)
    throw new LetterlockError("INPUT_INVALID", "recipient public key is not a usable X25519 key", { cause });
  }
  return { ...header, kid: fingerprint(to.publicKey), enc: toB64url(new Uint8Array(sealed.enc)), ct: toB64url(new Uint8Array(sealed.ct)) };
};

/** Validates and decodes an envelope without any crypto — call before spending a passkey prompt. */
export const parseEnvelope = (env: Envelope): { enc: Uint8Array; ct: Uint8Array } => {
  checkHeader(env);
  try { return { enc: fromB64url(env.enc), ct: fromB64url(env.ct) }; }
  catch (cause) { throw new LetterlockError("TAMPERED", "envelope fields are not canonical base64url", { cause }); }
};

const KID = /^[0-9a-f]{16}$/;

/**
 * The envelope as UTF-8 JSON, fields in the docs/SPEC.md §3 order: the bytes drop() sends and inbox() reads back.
 * Validates first, so malformed envelopes never leave the SDK.
 */
export const encodeEnvelope = (env: Envelope): Uint8Array => {
  parseEnvelope(env);
  const { v, chainId, directory, recipient, epoch, kid, enc, ct } = env;
  return utf8(JSON.stringify({ v, chainId, directory, recipient, epoch, kid, enc, ct }));
};

/**
 * Parses envelope JSON (a string, or UTF-8 bytes such as a Dropped log's) and validates it as parseEnvelope does.
 * Only the §3 fields are kept. Nothing is decrypted: a valid envelope can still fail to open.
 *   INPUT_INVALID — not UTF-8, not JSON, a missing or mistyped field, or a bad header
 *   TAMPERED      — enc or ct is not canonical base64url
 */
export const decodeEnvelope = (input: string | Uint8Array): Envelope => {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); }
    catch (cause) { throw new LetterlockError("INPUT_INVALID", "envelope is not UTF-8", { cause }); }
  }
  let o: unknown;
  try { o = JSON.parse(text); }
  catch (cause) { throw new LetterlockError("INPUT_INVALID", "envelope is not JSON", { cause }); }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new LetterlockError("INPUT_INVALID", "envelope is not a JSON object");
  const f = o as Record<string, unknown>;
  const field = <T>(name: string, type: "number" | "string"): T => {
    if (typeof f[name] !== type) throw new LetterlockError("INPUT_INVALID", `envelope field "${name}" must be a ${type}`);
    return f[name] as T;
  };
  const env: Envelope = {
    v: field<1>("v", "number"),
    chainId: field<number>("chainId", "number"),
    directory: field<`0x${string}`>("directory", "string"),
    recipient: field<Recipient>("recipient", "string"),
    epoch: field<number>("epoch", "number"),
    kid: field<string>("kid", "string"),
    enc: field<string>("enc", "string"),
    ct: field<string>("ct", "string"),
  };
  if (!KID.test(env.kid)) throw new LetterlockError("INPUT_INVALID", "envelope kid must be 16 lower-case hex digits");
  parseEnvelope(env);
  return env;
};

/**
 * Open an envelope with the recipient's re-derived key pair.
 *   EPOCH_MISMATCH — (pre-check) the key is for another epoch than the envelope names → derive envelope.epoch
 *   TAMPERED       — authentication failed: altered in transit
 *   WRONG_KEY      — authentication failed AND the kid hint names a different key: the wrong passkey was chosen
 * Decryption is always attempted before the unauthenticated kid is consulted, so an edited kid can never make
 * the right key fail.
 */
export const open = async (env: Envelope, keys: EncryptionKeyPair): Promise<Uint8Array> => {
  const { enc, ct } = parseEnvelope(env);
  if (env.epoch !== keys.epoch)
    throw new LetterlockError("EPOCH_MISMATCH", `envelope is sealed to epoch ${env.epoch}, key is epoch ${keys.epoch}`);
  try {
    const recipientKey = {
      privateKey: await suite.kem.importKey("raw", keys.secretKey.slice().buffer, false),
      publicKey: await suite.kem.importKey("raw", keys.publicKey.slice().buffer, true),
    };
    const pt = await suite.open({ recipientKey, enc: enc.slice().buffer, info: infoFor(env) }, ct);
    return new Uint8Array(pt);
  } catch (cause) {
    if (typeof env.kid === "string" && env.kid !== fingerprint(keys.publicKey))
      throw new LetterlockError("WRONG_KEY", `envelope is sealed to key ${env.kid}, this passkey derives ${fingerprint(keys.publicKey)}`, { cause });
    throw new LetterlockError("TAMPERED", "envelope failed authentication (altered in transit)", { cause });
  }
};
