// EXAMPLE content for the pages before they are wired to the chain. Every value comes from
// scripts/example-values.ts (SDK derivation and seal over labelled strings; no passkey, nothing published, no
// transaction), and test/examples.test.ts re-derives each key, opens each envelope and re-checks each failure.
// Anything shown from here carries an "Example" badge on the page, and nothing from here is ever linked to an
// explorer: none of it is on chain.
import data from "./examples.json";
import type { Envelope } from "letterlock";
import type { SlipCode, SlipValues } from "./error-copy.ts";

export type ExampleKey = { epoch: number; publicKey: `0x${string}`; fingerprint: string };

export type ExamplePersona = {
  name: string;
  address: `0x${string}`;
  /** every key this persona has posted, oldest first; the last one is current */
  keys: ExampleKey[];
};

export type ExampleAgent = { recipient: `agent:${string}`; keys: ExampleKey[] };

export type ExampleLetter = {
  id: string;
  to: string;
  recipient: `0x${string}`;
  epoch: number;
  /** the plaintext the example envelope really decrypts to */
  text: string;
  /** UTF-8 size of the envelope JSON */
  bytes: number;
  envelope: Envelope;
};

export type ExampleFailure = { code: SlipCode; letter: string; key: { name: string; epoch: number }; values: SlipValues };

export const EXAMPLE_DIRECTORY = data.directory;
export const EXAMPLE_PERSONAS = data.personas as ExamplePersona[];
export const EXAMPLE_AGENTS = data.agents as ExampleAgent[];
export const EXAMPLE_LETTERS = data.letters as ExampleLetter[];
export const EXAMPLE_TAMPERED = data.tampered as { from: string; ctByte: number; envelope: Envelope };
export const EXAMPLE_FAILURES = data.failures as ExampleFailure[];

export const persona = (name: string): ExamplePersona => {
  const p = EXAMPLE_PERSONAS.find((x) => x.name === name);
  if (!p) throw new Error(`no example persona ${name}`);
  return p;
};

export const currentKey = (p: { keys: ExampleKey[] }): ExampleKey => p.keys[p.keys.length - 1]!;

export const letter = (id: string): ExampleLetter => {
  const l = EXAMPLE_LETTERS.find((x) => x.id === id);
  if (!l) throw new Error(`no example letter ${id}`);
  return l;
};

export const failureValues = (code: SlipCode): SlipValues => EXAMPLE_FAILURES.find((f) => f.code === code)?.values ?? {};
