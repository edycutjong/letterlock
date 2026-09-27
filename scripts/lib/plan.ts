// The seed plan (scripts/seed.ts) and the software keys of the offline envelope fixtures (scripts/fixtures.ts,
// fixtures/envelopes.json, replayed by scripts/verify_offline.ts). Kept in one module so the fixture file, the seed
// script and `pnpm verify` cannot disagree about a note, a tampered byte or a key.
import { createHash } from "node:crypto";
import { deriveAgentKeyPair, deriveKeyPair, toHex, type AgentKeyPair, type EncryptionKeyPair } from "letterlock";

/**
 * The notes the seed script sends to one persona, in this order. Their texts are the demo's example letters
 * (apps/demo/lib/examples.json) plus one, so the inbox a persona opens on a real device reads like the pages.
 */
export const SEED_NOTES = [
  { id: "dentist", text: "Maya, the dentist moved to Thursday at 10:40. I will remind you on Wednesday evening." },
  { id: "flight", text: "Your flight changed to the evening departure, so I moved the car pickup to match." },
  { id: "courier", text: "The courier comes at noon." },
  { id: "dinner", text: "Nadia's birthday dinner is on Saturday at 19:30. I booked a table for four and will remind you on Friday." },
] as const;

/**
 * A copy of one sent note with one ciphertext byte changed, as if altered in transit: the passkey's key still names
 * it (the kid is unchanged), and it fails authentication, so it opens as TAMPERED. The same byte the demo's example
 * uses (apps/demo/lib/examples.json, "tampered").
 */
export const SEED_TAMPER = { from: "dentist", ctByte: 12, xor: 0x01 } as const;

/**
 * The note sealed to a persona's PREVIOUS epoch key, after it rotated: it opens with the passkey (the SDK re-derives
 * the envelope's own epoch), and the current epoch's key reports EPOCH_MISMATCH.
 */
export const SEED_OLD_EPOCH = { id: "lease", text: "Kai, the landlord accepted the new lease terms. Sign before the 30th." } as const;

// Software keys: public stand-ins for a passkey's PRF output, for fixtures that must open without a passkey.
// Anything sealed to these keys can be opened by anyone who reads this file. They are never published to a directory.

const sha256 = (s: string): Uint8Array => new Uint8Array(createHash("sha256").update(s).digest());

/** The PRF stand-in of a software persona: SHA-256("letterlock fixture prf: " + name). */
export const fixturePrf = (name: string): Uint8Array => sha256(`letterlock fixture prf: ${name}`);

/** A software persona's address: the first 20 bytes of SHA-256("letterlock fixture address: " + name). No one holds its key. */
export const fixtureAddress = (name: string): `0x${string}` => `0x${toHex(sha256(`letterlock fixture address: ${name}`).slice(0, 20))}`;

/** The persona's key pair at `epoch`, derived exactly as from a passkey (deriveKeyPair over the PRF stand-in). */
export const fixtureKeys = (name: string, epoch: number): EncryptionKeyPair => deriveKeyPair(fixturePrf(name), epoch);

/** An ERC-8004 agent's key pair, derived from its owner's PRF stand-in with the agent id (deriveAgentKeyPair). */
export const fixtureAgentKeys = (owner: string, agentId: bigint, epoch: number): AgentKeyPair =>
  deriveAgentKeyPair(fixturePrf(owner), agentId, epoch);

/** The software personas and agent the fixtures use: Kai has rotated once, so his epoch-1 key is an old one. */
export const FIXTURE_PERSONAS = [
  { name: "maya", epochs: [1] },
  { name: "nadia", epochs: [1] },
  { name: "kai", epochs: [1, 2] },
] as const;
export const FIXTURE_AGENT = { id: 7n, owner: "nadia", epochs: [1] } as const;
