// Writes fixtures/envelopes.json: envelope fixtures with the outcome the SDK gives each one.
//
//   pnpm fixtures            print the file to standard output
//   pnpm fixtures --write    rewrite fixtures/envelopes.json
//
// "offline": envelopes sealed to SOFTWARE keys (scripts/lib/plan.ts: a SHA-256 of a public label stands in for a
// passkey's PRF output, and deriveKeyPair / deriveAgentKeyPair turn it into a key exactly as from a passkey). Anyone
// can open them; they are never published to a directory. `pnpm verify` replays each one with no network
// (scripts/verify_offline.ts) and checks the outcome is still the one recorded here, so a change to the envelope
// format, the HPKE binding or the error codes shows up as a failed replay.
// "seed": what scripts/seed.ts sends to persona addresses. Each envelope is sealed to the key the persona published (from
// a passkey on the persona's own device, as intended: the script cannot check where a key came from), so only the holder
// of that key opens it; they are described here, not replayed.
//
// Every outcome below was produced by the SDK while writing the file, and the script refuses to write a case whose
// outcome is not the one it was built to show. Sealing is randomized (a fresh HPKE ephemeral key per envelope), so a
// rewrite changes enc and ct; everything else is deterministic.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DEPLOYMENTS,
  decodeEnvelope,
  fingerprint,
  fromB64url,
  isLetterlockError,
  open,
  seal,
  toB64url,
  toHex,
  type EncryptionKeyPair,
  type Envelope,
} from "letterlock";
import { ROOT } from "./lib/git.ts";
import {
  FIXTURE_AGENT,
  FIXTURE_PERSONAS,
  SEED_NOTES,
  SEED_OLD_EPOCH,
  SEED_TAMPER,
  fixtureAddress,
  fixtureAgentKeys,
  fixtureKeys,
} from "./lib/plan.ts";

export const FIXTURE_FILE = join(ROOT, "fixtures/envelopes.json");

/**
 * Every offline case fixtures/envelopes.json holds, in this order, with the outcome it is built to show. main() refuses
 * to write a file that differs, and scripts/verify_offline.ts refuses to replay one that differs: a case, a negative one
 * above all, cannot quietly drop out of `pnpm verify`.
 */
export const FIXTURE_CASES = [
  { id: "opens", want: "OPENS" },
  { id: "tampered-ct", want: "TAMPERED" },
  { id: "tampered-enc", want: "TAMPERED" },
  { id: "readdressed", want: "TAMPERED" },
  { id: "other-chain", want: "TAMPERED" },
  { id: "other-directory", want: "TAMPERED" },
  { id: "wrong-key", want: "WRONG_KEY" },
  { id: "kid-edited", want: "OPENS" },
  { id: "old-epoch-current-key", want: "EPOCH_MISMATCH" },
  { id: "old-epoch-rederived", want: "OPENS" },
  { id: "agent-opens", want: "OPENS" },
  { id: "agent-owner-key", want: "WRONG_KEY" },
  { id: "non-canonical-base64url", want: "TAMPERED" },
  { id: "kid-not-wire-form", want: "INPUT_INVALID" },
] as const;

/** The outcomes the replay must show at least once each. */
export const REQUIRED_OUTCOMES = [...new Set(FIXTURE_CASES.map((c) => c.want))];

/** The chain and directory every fixture envelope is bound to: the live Monad mainnet directory. */
export const FIXTURE_CHAIN = { chainId: DEPLOYMENTS.monad.chainId, directory: DEPLOYMENTS.monad.directory } as const;

/** "maya@1" → maya's epoch-1 key; "agent:7@1" → agent 7's epoch-1 key (derived from its owner's PRF stand-in). */
export const keyFor = (ref: string): EncryptionKeyPair & { recipient: string } => {
  const m = /^(agent:(\d+)|[a-z]+)@(\d+)$/.exec(ref);
  if (!m) throw new Error(`not a fixture key reference: ${ref}`);
  const epoch = Number(m[3]);
  if (m[2] !== undefined) {
    const agentId = BigInt(m[2]);
    if (agentId !== FIXTURE_AGENT.id) throw new Error(`no fixture agent ${m[2]}`);
    return { ...fixtureAgentKeys(FIXTURE_AGENT.owner, agentId, epoch), recipient: `agent:${agentId}` };
  }
  return { ...fixtureKeys(m[1]!, epoch), recipient: fixtureAddress(m[1]!) };
};

export type Outcome = { outcome: string; plaintext?: string };

/** What the SDK does with an envelope as it arrives on the wire (decodeEnvelope, as inbox() reads a drop) and a key. */
export const replay = async (envelope: unknown, keys: EncryptionKeyPair): Promise<Outcome> => {
  try {
    const decoded = decodeEnvelope(JSON.stringify(envelope));
    const pt = await open(decoded, keys);
    return { outcome: "OPENS", plaintext: new TextDecoder("utf-8", { fatal: true }).decode(pt) };
  } catch (e) {
    if (isLetterlockError(e)) return { outcome: e.code };
    throw e;
  }
};

const main = async () => {
  const { values } = parseArgs({ options: { write: { type: "boolean", default: false } } });
  const enc = new TextEncoder();
  const sealTo = (ref: string, text: string) => {
    const k = keyFor(ref);
    return seal({ ...FIXTURE_CHAIN, to: { recipient: k.recipient, publicKey: k.publicKey, epoch: k.epoch }, plaintext: enc.encode(text) });
  };
  /** One byte of a base64url field XORed, re-spelled canonically: a valid envelope that no longer authenticates. */
  const flip = (field: string, index: number, xor: number) => {
    const b = fromB64url(field);
    b[index] = b[index]! ^ xor;
    return toB64url(b);
  };
  /** The same bytes spelled with the last character's unused bits set: not the one canonical spelling. */
  const nonCanonical = (field: string) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    if (fromB64url(field).length % 3 === 0) throw new Error("a field of whole 3-byte groups has no unused bits");
    return field.slice(0, -1) + alphabet[alphabet.indexOf(field.at(-1)!) | 1];
  };

  const keys = [
    ...FIXTURE_PERSONAS.flatMap(({ name, epochs }) => epochs.map((epoch) => `${name}@${epoch}`)),
    ...FIXTURE_AGENT.epochs.map((epoch) => `agent:${FIXTURE_AGENT.id}@${epoch}`),
  ].map((ref) => {
    const k = keyFor(ref);
    return {
      ref,
      // the fields resolve() returns for this key, as a cache of it: scripts/verify_offline.ts seals to these
      recipient: k.recipient,
      chainId: FIXTURE_CHAIN.chainId,
      directory: FIXTURE_CHAIN.directory,
      epoch: k.epoch,
      publicKey: `0x${toHex(k.publicKey)}`,
      kid: fingerprint(k.publicKey),
      prf: ref.startsWith("agent:")
        ? `deriveAgentKeyPair(SHA-256("letterlock fixture prf: ${FIXTURE_AGENT.owner}"), ${FIXTURE_AGENT.id}n, ${k.epoch})`
        : `deriveKeyPair(SHA-256("letterlock fixture prf: ${ref.split("@")[0]}"), ${k.epoch})`,
    };
  });

  const note = SEED_NOTES[0].text;
  const maya: Envelope = await sealTo("maya@1", note);
  const kai: Envelope = await sealTo("kai@1", SEED_OLD_EPOCH.text);
  const agentNote = `Task for agent ${FIXTURE_AGENT.id}: summarize this week's calendar changes and seal the summary to your owner.`;
  const agent: Envelope = await sealTo(`agent:${FIXTURE_AGENT.id}@1`, agentNote);
  const nadia = keyFor("nadia@1");

  type Case = { id: string; about: string; envelope: Record<string, unknown>; open: string; expect: Outcome };
  const planned: (Omit<Case, "expect"> & { want: string; text?: string })[] = [
    { id: "opens", about: "A note sealed to maya's epoch-1 key opens with that key.", envelope: maya, open: "maya@1", want: "OPENS", text: note },
    {
      id: "tampered-ct",
      about: `One ciphertext byte changed in transit (byte ${SEED_TAMPER.ctByte}, xor 0x0${SEED_TAMPER.xor}): authentication fails and the kid still names the key, so TAMPERED.`,
      envelope: { ...maya, ct: flip(maya.ct, SEED_TAMPER.ctByte, SEED_TAMPER.xor) }, open: "maya@1", want: "TAMPERED",
    },
    {
      id: "tampered-enc", about: "One byte of the encapsulated key changed: the shared secret changes, TAMPERED.",
      envelope: { ...maya, enc: flip(maya.enc, 0, 0x01) }, open: "maya@1", want: "TAMPERED",
    },
    {
      id: "readdressed", about: "The header's recipient changed to nadia's address: the HPKE info binds the recipient, TAMPERED with maya's key.",
      envelope: { ...maya, recipient: nadia.recipient }, open: "maya@1", want: "TAMPERED",
    },
    {
      id: "other-chain", about: "The header's chainId changed from 143 to 10143: the info binds the chain, TAMPERED.",
      envelope: { ...maya, chainId: DEPLOYMENTS["monad-testnet"].chainId }, open: "maya@1", want: "TAMPERED",
    },
    {
      id: "other-directory", about: "The header's directory changed to the testnet directory: the info binds the directory, TAMPERED.",
      envelope: { ...maya, directory: DEPLOYMENTS["monad-testnet"].directory.toLowerCase() }, open: "maya@1", want: "TAMPERED",
    },
    {
      id: "wrong-key", about: "Maya's note tried with nadia's key: decryption fails and the kid names another key, so WRONG_KEY (the wrong passkey was chosen).",
      envelope: maya, open: "nadia@1", want: "WRONG_KEY",
    },
    {
      id: "kid-edited", about: "The kid (a routing hint, not authenticated) changed to nadia's: maya's key still opens it. Editing the kid can never make the right key fail.",
      envelope: { ...maya, kid: fingerprint(nadia.publicKey) }, open: "maya@1", want: "OPENS", text: note,
    },
    {
      id: "old-epoch-current-key", about: "A note sealed to kai's epoch-1 key, tried after kai rotated with his epoch-2 key: EPOCH_MISMATCH, before any decryption.",
      envelope: kai, open: "kai@2", want: "EPOCH_MISMATCH",
    },
    {
      id: "old-epoch-rederived", about: "The same note with kai's epoch-1 key, re-derived from the same PRF stand-in: rotation leaves old notes openable.",
      envelope: kai, open: "kai@1", want: "OPENS", text: SEED_OLD_EPOCH.text,
    },
    {
      id: "agent-opens", about: `A note sealed to agent:${FIXTURE_AGENT.id} opens with the agent's key, derived from its owner's PRF stand-in with the agent id.`,
      envelope: agent, open: `agent:${FIXTURE_AGENT.id}@1`, want: "OPENS", text: agentNote,
    },
    {
      id: "agent-owner-key", about: `The agent's note tried with its owner's own key (${FIXTURE_AGENT.owner}@1): an agent's key is a different key, WRONG_KEY.`,
      envelope: agent, open: `${FIXTURE_AGENT.owner}@1`, want: "WRONG_KEY",
    },
    {
      id: "non-canonical-base64url", about: "enc spelled with the last character's unused bits set (the same bytes): refused on decode as TAMPERED, before any key is used.",
      envelope: { ...maya, enc: nonCanonical(maya.enc) }, open: "maya@1", want: "TAMPERED",
    },
    {
      id: "kid-not-wire-form", about: "The kid in upper case: the wire form takes only 16 lower-case hex digits, INPUT_INVALID on decode.",
      envelope: { ...maya, kid: maya.kid.toUpperCase() }, open: "maya@1", want: "INPUT_INVALID",
    },
  ];

  const shape = (cases: readonly { id: string; want: string }[]) => JSON.stringify(cases.map(({ id, want }) => ({ id, want })));
  if (shape(planned) !== shape(FIXTURE_CASES)) throw new Error("the cases built here differ from FIXTURE_CASES: change both together");
  const offline: Case[] = [];
  for (const { want, text, ...c } of planned) {
    const got = await replay(c.envelope, keyFor(c.open));
    if (got.outcome !== want || got.plaintext !== text)
      throw new Error(`fixture ${c.id}: built to show ${want}${text ? ` "${text}"` : ""}, the SDK gives ${JSON.stringify(got)}`);
    offline.push({ ...c, expect: got });
  }

  const file = {
    about: [
      "Envelope fixtures, each with the outcome the SDK gives it. Written by scripts/fixtures.ts (pnpm fixtures --write).",
      "offline: sealed to SOFTWARE keys (a SHA-256 of a public label stands in for a passkey's PRF output). Anyone can open them, and they are never published to a directory. pnpm verify replays every case with the network switched off (scripts/verify_offline.ts).",
      "seed: what scripts/seed.ts sends to persona addresses. Each is sealed to the key the persona published (from a passkey on the persona's own device, as intended: the script cannot check where a key came from), so only the holder of that key opens it: they are described here, not replayed. A run records its transactions in fixtures/seeded/<chainId>.json.",
    ],
    chain: { chainId: FIXTURE_CHAIN.chainId, directory: FIXTURE_CHAIN.directory, network: DEPLOYMENTS.monad.network },
    keys,
    offline,
    seed: {
      notes: SEED_NOTES.map((n) => ({ ...n, expect: "OPENS with the persona's passkey" })),
      tampered: { ...SEED_TAMPER, expect: "TAMPERED: a copy of the first note with one ciphertext byte changed" },
      oldEpoch: {
        ...SEED_OLD_EPOCH,
        expect: "OPENS with the persona's passkey (the envelope's own, previous epoch is re-derived); EPOCH_MISMATCH with the current epoch's key",
      },
    },
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  if (values.write) {
    writeFileSync(FIXTURE_FILE, text);
    console.error(`wrote fixtures/envelopes.json: ${keys.length} software keys, ${offline.length} offline cases (${offline.map((c) => c.expect.outcome).join(", ")})`);
  } else process.stdout.write(text);
};

if (import.meta.main) await main();
