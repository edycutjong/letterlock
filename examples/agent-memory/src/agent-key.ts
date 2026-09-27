// The agent's own Letterlock key, with no passkey behind it.
//
// docs/SPEC.md §2 derives an ERC-8004 agent's key from its owner's passkey: the PRF is evaluated at the agent's salt,
// then HKDF gives the X25519 key. This agent runs on a server, so a 32-byte secret seed (LETTERLOCK_AGENT_KEY_SEED)
// plays the passkey's credential secret, through the computation a WebAuthn PRF performs over CTAP2 hmac-secret
// (WebAuthn Level 3 §10.1.4):
//
//   prf = HMAC-SHA256(seed, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ agentSalt(agentId, epoch)))
//   key = deriveAgentKeyPair(prf, agentId, epoch)        — the SDK's §2 agent derivation, unchanged
//
// So the key is an agent key in the §2 sense (the agent id is in its salt and its HKDF info; it is never an address
// key), each epoch gives an unrelated key, and every epoch stays re-derivable from the seed. Whoever holds the seed
// opens everything sealed to this agent: it lives only in the host's environment and in the operator's keychain.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { agentPrfSaltFor, deriveAgentKeyPair, fingerprint, type AgentKeyPair } from "letterlock";

const PRF_LABEL = new TextEncoder().encode("WebAuthn PRF");

/** The WebAuthn PRF output a credential whose secret is `seed` returns for `salt`. */
export const seedPrf = (seed: Uint8Array, salt: Uint8Array): Uint8Array => {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new TypeError("the agent key seed must be 32 bytes");
  const input = new Uint8Array(PRF_LABEL.length + 1 + salt.length);
  input.set(PRF_LABEL, 0);
  input.set(salt, PRF_LABEL.length + 1); // the 0x00 separator is already there
  return hmac(sha256, seed, sha256(input));
};

/** Agent `agentId`'s key pair at `epoch`, from the seed. The caller wipes `secretKey` when done. */
export const agentKeyFromSeed = (seed: Uint8Array, agentId: bigint, epoch: number): AgentKeyPair => {
  const prf = seedPrf(seed, agentPrfSaltFor(agentId, epoch));
  try {
    return deriveAgentKeyPair(prf, agentId, epoch);
  } finally {
    prf.fill(0);
  }
};

/** The public half and its fingerprint (the envelope kid), with the secret wiped before returning. */
export const agentPublicKey = (seed: Uint8Array, agentId: bigint, epoch: number): { publicKey: Uint8Array; kid: string; epoch: number } => {
  const keys = agentKeyFromSeed(seed, agentId, epoch);
  keys.secretKey.fill(0);
  return { publicKey: keys.publicKey, kid: fingerprint(keys.publicKey), epoch };
};
