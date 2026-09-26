// Prints the EXAMPLE values the demo pages show before they are wired to the chain (lib/examples.ts).
//
// Nothing here is a passkey, a published key or a transaction. Each example address is the first 20 bytes of
// SHA-256 over a labelled string (no one holds a private key for it). Each example encryption key is the SDK's own
// deriveKeyPair() over SHA-256 of another labelled string, standing in for a passkey PRF output. The example
// envelopes are real SDK seal() output to those keys, bound to the testnet directory the app points at (the address
// in deployments/10143.json, read below, so a redeploy only needs this script run again), and were never dropped.
// The failures are what the SDK's open() really throws for the listed inputs.
// test/examples.test.ts re-derives every key, opens every envelope and re-checks every failure, so the example
// data on the pages stays honest.
//
//   node scripts/example-values.ts > lib/examples.json     (from apps/demo; Node 22.18+ runs TypeScript directly)
import { createHash } from "node:crypto";
import { deriveKeyPair, fingerprint, isLetterlockError, open, seal, toHex, type Envelope } from "letterlock";
import testnet from "../../../deployments/10143.json" with { type: "json" };

export const sha256 = (s: string): Uint8Array => new Uint8Array(createHash("sha256").update(s).digest());
export const exampleAddress = (label: string): `0x${string}` =>
  `0x${toHex(sha256(`letterlock example address: ${label}`).slice(0, 20))}`;
export const exampleKeys = (label: string, epoch: number) => deriveKeyPair(sha256(`letterlock example prf: ${label}`), epoch);

export const TESTNET = { chainId: testnet.chainId, directory: testnet.address as `0x${string}` } as const;

/** Every key an example persona has posted, oldest first; the last one is current. */
const PERSONAS = [
  { name: "Maya", epochs: [1] },
  { name: "Nadia", epochs: [1] },
  { name: "Kai", epochs: [1, 2] },
] as const;

/** An example ERC-8004 agent recipient (`agent:<id>`); the id is illustrative. */
const AGENTS = [{ id: 4412, epochs: [1] }] as const;

const LETTERS = [
  { id: "maya-dentist", to: "Maya", epoch: 1, text: "Maya, the dentist moved to Thursday at 10:40. I will remind you on Wednesday evening." },
  { id: "maya-flight", to: "Maya", epoch: 1, text: "Your flight changed to the evening departure, so I moved the car pickup to match." },
  { id: "kai-lease", to: "Kai", epoch: 1, text: "Kai, the landlord accepted the new lease terms. Sign before the 30th." },
] as const;

type Failure = { code: string; letter: string; key: { name: string; epoch: number }; values: Record<string, string | number> };

const main = async () => {
  const personas = PERSONAS.map(({ name, epochs }) => ({
    name,
    address: exampleAddress(name.toLowerCase()),
    keys: epochs.map((epoch) => {
      const k = exampleKeys(name.toLowerCase(), epoch);
      return { epoch, publicKey: `0x${toHex(k.publicKey)}`, fingerprint: fingerprint(k.publicKey) };
    }),
  }));
  const agents = AGENTS.map(({ id, epochs }) => ({
    recipient: `agent:${id}`,
    keys: epochs.map((epoch) => {
      const k = exampleKeys(`agent ${id}`, epoch);
      return { epoch, publicKey: `0x${toHex(k.publicKey)}`, fingerprint: fingerprint(k.publicKey) };
    }),
  }));

  const keysOf = (name: string, epoch: number) => exampleKeys(name.toLowerCase(), epoch);
  const letters: { id: string; to: string; recipient: string; epoch: number; text: string; bytes: number; envelope: Envelope }[] = [];
  for (const l of LETTERS) {
    const p = personas.find((x) => x.name === l.to)!;
    const envelope = await seal({
      ...TESTNET,
      to: { recipient: p.address, publicKey: keysOf(l.to, l.epoch).publicKey, epoch: l.epoch },
      plaintext: new TextEncoder().encode(l.text),
    });
    letters.push({ id: l.id, to: l.to, recipient: p.address, epoch: l.epoch, text: l.text, bytes: new TextEncoder().encode(JSON.stringify(envelope)).length, envelope });
  }

  // one copy of the first letter with one ciphertext byte changed in transit
  const original = letters[0]!.envelope;
  const ct = Buffer.from(original.ct, "base64url");
  const index = 12;
  ct[index] = ct[index]! ^ 0x01;
  const tampered = { from: letters[0]!.id, ctByte: index, envelope: { ...original, ct: ct.toString("base64url") } };

  const failures: Failure[] = [];
  const expectFailure = async (code: string, env: Envelope, letter: string, key: { name: string; epoch: number }, values: Failure["values"]) => {
    try {
      await open(env, keysOf(key.name, key.epoch));
    } catch (e) {
      if (isLetterlockError(e) && e.code === code) return failures.push({ code, letter, key, values });
      throw e;
    }
    throw new Error(`${letter} opened with ${key.name}'s epoch-${key.epoch} key; expected ${code}`);
  };
  await expectFailure("TAMPERED", tampered.envelope, "tampered", { name: "Maya", epoch: 1 }, {});
  await expectFailure("WRONG_KEY", original, letters[0]!.id, { name: "Nadia", epoch: 1 }, {
    sealedTo: original.kid,
    derived: fingerprint(keysOf("Nadia", 1).publicKey),
  });
  const lease = letters.find((l) => l.id === "kai-lease")!;
  await expectFailure("EPOCH_MISMATCH", lease.envelope, lease.id, { name: "Kai", epoch: 2 }, { envelopeEpoch: 1, keyEpoch: 2 });

  console.log(JSON.stringify({ directory: TESTNET, personas, agents, letters, tampered, failures }, null, 2));
};

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].split("/").pop()!)) await main();
