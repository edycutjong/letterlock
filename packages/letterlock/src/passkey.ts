import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from "@category-labs/mera";
import { deriveKeyPair, prfSaltFor, type EncryptionKeyPair } from "./derive.ts";
import { open, parseEnvelope, type Envelope } from "./envelope.ts";
import { LetterlockError } from "./errors.ts";

/** Every failure leaves the SDK as a LetterlockError with a documented code (docs/SPEC.md §5). */
const wrap = (cause: unknown): never => {
  if (cause instanceof LetterlockError) throw cause;
  if (isMeraError(cause)) {
    if (cause.code === "PRF_UNAVAILABLE")
      throw new LetterlockError("PRF_UNSUPPORTED", "this authenticator does not return a PRF output (e.g. Dashlane, some Chrome profiles)", { cause });
    if (cause.code === "INPUT_INVALID") throw new LetterlockError("INPUT_INVALID", cause.message, { cause });
  }
  throw new LetterlockError("PASSKEY_FAILED", "the passkey ceremony was cancelled, timed out, or found no passkey for this site", { cause });
};

export type CreateAddressOptions = {
  readonly rp: { id: string; name: string };
  readonly user: { name: string; displayName: string };
  readonly webAuthnClient?: WebAuthnClient;
};

/** One passkey creation ceremony → the epoch-1 encryption key pair (mera falls back to a 2nd prompt if needed). */
export const createEncryptionAddress = async (
  o: CreateAddressOptions,
): Promise<{ credential: PasskeyCredentialMetadata; keys: EncryptionKeyPair }> => {
  try {
    const r = await createPasskeyWithPrfOutput({ ...o, prfSalt: prfSaltFor(1) });
    return { credential: { credentialId: r.credentialId, transports: r.transports }, keys: deriveKeyPair(r.prfOutput, 1) };
  } catch (e) { return wrap(e); }
};

export type DeriveOptions = {
  readonly rpId: string;
  readonly epoch: number;
  readonly credential?: PasskeyCredentialMetadata;
  readonly webAuthnClient?: WebAuthnClient;
};

/** One assertion ceremony → the key pair for `epoch`. Same passkey on any synced device → same keys. */
export const deriveFromPasskey = async (o: DeriveOptions): Promise<EncryptionKeyPair & { credentialId: string }> => {
  try {
    const r = await getPasskeyPrfOutput({
      rpId: o.rpId,
      prfSalt: prfSaltFor(o.epoch),
      ...(o.credential ? { credential: o.credential } : {}),
      ...(o.webAuthnClient ? { webAuthnClient: o.webAuthnClient } : {}),
    });
    return { ...deriveKeyPair(r.prfOutput, o.epoch), credentialId: r.credentialId };
  } catch (e) { return wrap(e); }
};

export type OpenWithPasskeyOptions = Omit<DeriveOptions, "epoch">;

/**
 * One passkey prompt → plaintext. Derives the key for the envelope's own epoch (old notes keep opening after
 * a rotation), opens, then zeroes its copy of the secret key (best effort: library-internal copies and the
 * PRF output held by mera are outside our reach, and JS cannot guarantee erasure).
 */
export const openWithPasskey = async (env: Envelope, o: OpenWithPasskeyOptions): Promise<Uint8Array> => {
  parseEnvelope(env); // a malformed envelope must not cost the user a passkey prompt
  const keys = await deriveFromPasskey({ ...o, epoch: env.epoch });
  try { return await open(env, keys); }
  finally { keys.secretKey.fill(0); }
};
