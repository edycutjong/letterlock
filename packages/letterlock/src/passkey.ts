import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from "@category-labs/mera";
import { agentPrfSaltFor, deriveAgentKeyPair, deriveKeyPair, prfSaltFor, type AgentKeyPair, type EncryptionKeyPair } from "./derive.ts";
import { canonicalRecipient, open, parseEnvelope, toAgentId, type Envelope } from "./envelope.ts";
import { LetterlockError } from "./errors.ts";

/** Every failure leaves the SDK as a LetterlockError with a documented code (docs/SPEC.md §5). */
export const toPasskeyError = (cause: unknown): never => {
  if (cause instanceof LetterlockError) throw cause;
  if (isMeraError(cause)) {
    if (cause.code === "PRF_UNAVAILABLE")
      throw new LetterlockError("PRF_UNSUPPORTED", "this authenticator does not return a PRF output (e.g. Dashlane, some Chrome profiles)", { cause });
    if (cause.code === "INPUT_INVALID") throw new LetterlockError("INPUT_INVALID", cause.message, { cause });
  }
  throw new LetterlockError("PASSKEY_FAILED", "the passkey ceremony was cancelled, timed out, or found no passkey for this site", { cause });
};

/** A key pair derived from a passkey, with the rpId it was derived under: publish() refuses a key from another rpId. */
export type PasskeyKeyPair = EncryptionKeyPair & { readonly rpId: string };

export type CreateAddressOptions = {
  readonly rp: { id: string; name: string };
  readonly user: { name: string; displayName: string };
  readonly webAuthnClient?: WebAuthnClient;
};

/** One passkey creation ceremony → the epoch-1 encryption key pair (mera falls back to a 2nd prompt if needed). */
export const createEncryptionAddress = async (
  o: CreateAddressOptions,
): Promise<{ credential: PasskeyCredentialMetadata; keys: PasskeyKeyPair }> => {
  try {
    const r = await createPasskeyWithPrfOutput({ ...o, prfSalt: prfSaltFor(1) });
    return { credential: { credentialId: r.credentialId, transports: r.transports }, keys: { ...deriveKeyPair(r.prfOutput, 1), rpId: o.rp.id } };
  } catch (e) { return toPasskeyError(e); }
};

export type DeriveOptions = {
  readonly rpId: string;
  readonly epoch: number;
  readonly credential?: PasskeyCredentialMetadata;
  readonly webAuthnClient?: WebAuthnClient;
};

const prfOutputFor = (o: Omit<DeriveOptions, "epoch">, prfSalt: Uint8Array<ArrayBuffer>) =>
  getPasskeyPrfOutput({
    rpId: o.rpId,
    prfSalt,
    ...(o.credential ? { credential: o.credential } : {}),
    ...(o.webAuthnClient ? { webAuthnClient: o.webAuthnClient } : {}),
  });

/**
 * One assertion ceremony → the key pair of the passkey's own encryption address for `epoch`. Same passkey on any
 * synced device → same keys. Never an ERC-8004 agent's key: that is deriveForAgent().
 */
export const deriveFromPasskey = async (o: DeriveOptions): Promise<PasskeyKeyPair & { credentialId: string }> => {
  try {
    const r = await prfOutputFor(o, prfSaltFor(o.epoch));
    return { ...deriveKeyPair(r.prfOutput, o.epoch), credentialId: r.credentialId, rpId: o.rpId };
  } catch (e) { return toPasskeyError(e); }
};

/** An agent's key pair derived from its owner's passkey, with the rpId it was derived under. */
export type AgentPasskeyKeyPair = AgentKeyPair & { readonly rpId: string };

export type DeriveForAgentOptions = DeriveOptions & {
  /** The ERC-8004 agent: `agent:<id>`, `<id>`, a number or a bigint. */
  readonly agentId: bigint | number | string;
};

/**
 * One assertion ceremony → the key pair of ERC-8004 agent `agentId` at `epoch`, from its owner's passkey with the
 * agent's own PRF salt (docs/SPEC.md §2). It is unrelated to the owner's own key and to the owner's other agents'
 * keys, so the agent's server can hold its secret without being able to open the owner's notes, and the owner's
 * passkey can always derive it again. publishForAgent() publishes only such a key, and only for this agent.
 */
export const deriveForAgent = async (o: DeriveForAgentOptions): Promise<AgentPasskeyKeyPair & { credentialId: string }> => {
  try {
    const agentId = toAgentId(o.agentId);
    const r = await prfOutputFor(o, agentPrfSaltFor(agentId, o.epoch));
    return { ...deriveAgentKeyPair(r.prfOutput, agentId, o.epoch), credentialId: r.credentialId, rpId: o.rpId };
  } catch (e) { return toPasskeyError(e); }
};

export type OpenWithPasskeyOptions = Omit<DeriveOptions, "epoch">;

/**
 * One passkey prompt → plaintext. Derives the key for the envelope's own recipient (the passkey's own key, or an
 * agent's key for `agent:<id>`: both are bound into the envelope, so an edited recipient fails to open) and its own
 * epoch (old notes keep opening after a rotation), opens, then zeroes its copy of the secret key (best effort:
 * library-internal copies and the PRF output held by mera are outside our reach, and JS cannot guarantee erasure).
 */
export const openWithPasskey = async (env: Envelope, o: OpenWithPasskeyOptions): Promise<Uint8Array> => {
  parseEnvelope(env); // a malformed envelope must not cost the user a passkey prompt
  const recipient = canonicalRecipient(env.recipient);
  const keys = recipient.startsWith("agent:")
    ? await deriveForAgent({ ...o, agentId: recipient, epoch: env.epoch })
    : await deriveFromPasskey({ ...o, epoch: env.epoch });
  try { return await open(env, keys); }
  finally { keys.secretKey.fill(0); }
};
