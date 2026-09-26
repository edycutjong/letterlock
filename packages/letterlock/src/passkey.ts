import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from "@category-labs/mera";
import { deriveKeyPair, prfSaltFor, type EncryptionKeyPair } from "./derive.ts";
import { LetterlockError } from "./errors.ts";

const wrap = (cause: unknown): never => {
  if (isMeraError(cause) && cause.code === "PRF_UNAVAILABLE")
    throw new LetterlockError("PRF_UNSUPPORTED", "this authenticator does not return a PRF output (e.g. Dashlane, some Chrome profiles)", { cause });
  throw cause;
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
