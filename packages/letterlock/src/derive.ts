import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, utf8 } from "./bytes.ts";
import { LetterlockError } from "./errors.ts";

/**
 * Derivation (docs/SPEC.md §2, normative):
 *   prfSalt(epoch) = SHA-256("letterlock/hpke/v1/" ‖ epoch)          — Letterlock's own PRF namespace,
 *                                                                     disjoint from mera's account salt
 *   sk = HKDF-SHA256(ikm = PRF output, salt = "letterlock/v1",
 *                    info = "letterlock/v1/x25519/" ‖ epoch, L = 32)   — clamped by X25519
 *   pk = X25519(sk, 9)
 * Rotation = epoch + 1 → a new salt → an unrelated PRF output; every old epoch stays re-derivable.
 */
export const MAX_EPOCH = 0xffff_ffff;

const checkEpoch = (epoch: number) => {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > MAX_EPOCH)
    throw new LetterlockError("INPUT_INVALID", `epoch must be an integer in 1..${MAX_EPOCH}, got ${epoch}`);
};

export const prfSaltFor = (epoch: number): Uint8Array<ArrayBuffer> => {
  checkEpoch(epoch);
  return new Uint8Array(sha256(utf8(`letterlock/hpke/v1/${epoch}`)));
};

export type EncryptionKeyPair = {
  readonly epoch: number;
  /** X25519 private key. Never stored, never sent — re-derived on each open(). */
  readonly secretKey: Uint8Array;
  /** X25519 public key — the value published onchain as bytes32. */
  readonly publicKey: Uint8Array;
};

export const deriveKeyPair = (prfOutput: Uint8Array, epoch: number): EncryptionKeyPair => {
  checkEpoch(epoch);
  if (prfOutput.length !== 32)
    throw new LetterlockError("PRF_UNSUPPORTED", `PRF output must be 32 bytes, got ${prfOutput.length}`);
  const secretKey = hkdf(sha256, prfOutput, utf8("letterlock/v1"), utf8(`letterlock/v1/x25519/${epoch}`), 32);
  return { epoch, secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

/** Short human-comparable fingerprint of a public key (first 8 bytes of SHA-256, hex). */
export const fingerprint = (publicKey: Uint8Array): string => toHex(sha256(publicKey).slice(0, 8));
