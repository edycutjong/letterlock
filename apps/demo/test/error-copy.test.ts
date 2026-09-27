// Every SDK error a person can meet has a slip, and no slip names a problem without saying what to do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SLIP_CODES, SLIP_COPY } from "../lib/error-copy.ts";

const sdkCodes = () => {
  const src = readFileSync(new URL("../../../packages/letterlock/src/errors.ts", import.meta.url), "utf8");
  return [...src.matchAll(/\|\s*"([A-Z_]+)"/g)].map((m) => m[1]!);
};

test("every SDK error code except INPUT_INVALID (a form error) has a slip", () => {
  const codes = sdkCodes();
  assert.ok(codes.length >= 7, `read ${codes.length} codes from the SDK`);
  assert.deepEqual([...SLIP_CODES].sort(), codes.filter((c) => c !== "INPUT_INVALID").sort());
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
