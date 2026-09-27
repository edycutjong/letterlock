// Every SDK error a person can meet has a slip, and no slip names a problem without saying what to do.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SLIP_CODES, SLIP_COPY } from "../lib/error-copy.ts";

/** the members of one error-code union in the SDK's errors.ts */
const sdkCodes = (union: "LetterlockErrorCode" | "ChainErrorCode") => {
  const src = readFileSync(new URL("../../../packages/letterlock/src/errors.ts", import.meta.url), "utf8");
  const body = src.match(new RegExp(`export type ${union} =([^;]+);`))?.[1] ?? "";
  return [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
};

test("every SDK protocol error code except INPUT_INVALID (a form error) has a slip", () => {
  const codes = sdkCodes("LetterlockErrorCode");
  assert.ok(codes.length >= 7, `read ${codes.length} codes from the SDK`);
  assert.deepEqual([...SLIP_CODES].sort(), codes.filter((c) => c !== "INPUT_INVALID").sort());
});

// The chain client's codes (publish, resolve, drop, inbox) are their own union in the SDK. No page calls the chain
// client yet, so no slip shows them; this fails when the SDK adds one, or when a page starts calling the chain
// client, whatever the import form, which is when its failures need slips.
const CHAIN_CLIENT = /\b(letterlock|meraAccount|toLetterlockError)\b/;
/** the ways a source can reach the chain client at run time; `import type` is erased and reaches nothing */
const callsChainClient = (src: string): boolean => {
  const from = `\\s*from\\s*["']letterlock(?:/[^"']*)?["']`;
  // a namespace import (`import * as sdk from "letterlock"`) hands the whole client to whatever uses `sdk`
  if (new RegExp(`import\\s*\\*\\s*as\\s+\\w+${from}`).test(src)) return true;
  // a dynamic import, the way a client-only chain client is lazy-loaded in a page
  if (/\bimport\s*\(\s*["'`]letterlock(?:\/[^"'`]*)?["'`]\s*\)/.test(src)) return true;
  // a value import or re-export naming the client (a default import, a brace list, or both)
  for (const m of src.matchAll(new RegExp(`\\b(import|export)(\\s+type)?\\s*([^;]*?)${from}`, "g")))
    if (!m[2] && CHAIN_CLIENT.test(m[3]!.replace(/\btype\s+\w+(\s+as\s+\w+)?/g, ""))) return true;
  // a call, however the client was reached
  return /\bletterlock\s*\(/.test(src);
};

test("the chain-client guard recognises every import form", () => {
  for (const src of [
    'import { letterlock } from "letterlock";',
    "import { letterlock } from 'letterlock';",
    'import { type Envelope, meraAccount } from "letterlock";',
    'import * as sdk from "letterlock"; sdk.publish();',
    'const { letterlock: client } = await import("letterlock");',
    "const m = await import('letterlock');",
    'export { toLetterlockError } from "letterlock";',
    "const c = letterlock({ chainId: 143 });",
  ])
    assert.equal(callsChainClient(src), true, src);
  for (const src of [
    'import type { LetterlockErrorCode } from "letterlock";',
    'import type { Envelope } from "letterlock";',
    'import { type Envelope } from "letterlock";',
    'import { EXAMPLE_TAMPERED, letter } from "@/lib/examples.ts";',
  ])
    assert.equal(callsChainClient(src), false, src);
});

test("the chain client's codes are not slips yet, and no page calls the chain client", () => {
  assert.deepEqual(sdkCodes("ChainErrorCode").sort(), ["CHAIN_UNAVAILABLE", "INSUFFICIENT_FUNDS", "NOT_AGENT_OWNER"]);
  const sources = ["app", "components", "lib"].flatMap((dir) =>
    readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => ({ f: `${dir}/${f}`, src: readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8") })),
  );
  const callers = sources.filter(({ src }) => callsChainClient(src)).map(({ f }) => f);
  assert.deepEqual(callers, [], "a page calls the chain client: give its failures (CHAIN_UNAVAILABLE, INSUFFICIENT_FUNDS, NOT_AGENT_OWNER) slips");
});

test("every slip has a reason, a box line, a meaning and a recovery, with and without quoted values", () => {
  for (const code of SLIP_CODES) {
    const c = SLIP_COPY[code];
    assert.ok(c.reason.length > 0 && c.box.length > 0, code);
    for (const v of [{}, { envelopeEpoch: 1, keyEpoch: 2, sealedTo: "6b5286d1ad2708a1", derived: "593013e05c26c52f" }]) {
      assert.ok(c.meaning(v).length > 20, `${code} meaning`);
      assert.ok(c.recovery(v).length > 20, `${code} recovery`);
      assert.doesNotMatch(c.meaning(v) + c.recovery(v), /undefined|NaN/, code);
    }
  }
});

test("slips quote real values when they have them", () => {
  assert.match(SLIP_COPY.EPOCH_MISMATCH.meaning({ envelopeEpoch: 1, keyEpoch: 2 }), /epoch 1.*epoch 2/);
  assert.match(SLIP_COPY.WRONG_KEY.meaning({ sealedTo: "6b5286d1ad2708a1", derived: "593013e05c26c52f" }), /6b52 86d1 ad27 08a1.*5930 13e0 5c26 c52f/);
});

test("the tick-box lines are distinct, so the ticked one is unambiguous", () => {
  const boxes = SLIP_CODES.map((c) => SLIP_COPY[c].box);
  assert.equal(new Set(boxes).size, boxes.length);
});

test("no slip sends the reader to the sender: an envelope cannot say who sealed it, and the inbox never names one", () => {
  for (const code of SLIP_CODES)
    for (const v of [{}, { envelopeEpoch: 1, keyEpoch: 2, sealedTo: "6b5286d1ad2708a1", derived: "593013e05c26c52f" }]) {
      const text = `${SLIP_COPY[code].meaning(v)} ${SLIP_COPY[code].recovery(v)}`;
      assert.doesNotMatch(text, /\bthe sender\b/i, `${code} relies on a sender the app cannot know`);
    }
});
