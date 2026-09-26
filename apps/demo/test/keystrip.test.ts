// The register strip must carry the whole fingerprint: equal strips mean equal keys, and a changed digit changes
// the strip. Checked exhaustively for every hex digit and on the SDK's real fingerprints.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BARS, STRIP, STRIP_BARS, STRIP_WIDTH, barExtent, groupFingerprint, readStrip, stripBars, stripPath } from "../lib/keystrip.ts";

const FPS = ["0000000000000000", "ffffffffffffffff", "6b5286d1ad2708a1", "22c8044f76d4e8e5", "0123456789abcdef"];

test("a strip is 32 bars and reads back to the same 16 digits", () => {
  for (const fp of FPS) {
    const bars = stripBars(fp);
    assert.equal(bars.length, STRIP_BARS);
    assert.equal(readStrip(bars), fp);
  }
});

test("every hex digit has its own pair of bars (two bits per bar)", () => {
  const pairs = new Set<string>();
  for (let d = 0; d < 16; d++) {
    const digit = d.toString(16);
    const [hi, lo] = stripBars(digit.repeat(16));
    pairs.add(`${hi}/${lo}`);
    assert.equal(BARS.indexOf(hi!), d >> 2);
    assert.equal(BARS.indexOf(lo!), d & 3);
  }
  assert.equal(pairs.size, 16);
});

test("one changed digit changes the strip", () => {
  const a = stripPath("6b5286d1ad2708a1");
  for (let i = 0; i < 16; i++) {
    const digits = [..."6b5286d1ad2708a1"];
    digits[i] = digits[i] === "0" ? "1" : "0";
    assert.notEqual(stripPath(digits.join("")), a, `digit ${i}`);
  }
});

test("the four bar states: tracker in the middle, ascender up, descender down, full both ways", () => {
  assert.deepEqual(barExtent("tracker"), { y: -STRIP.tracker, height: 2 * STRIP.tracker });
  assert.deepEqual(barExtent("ascender"), { y: -STRIP.reach, height: STRIP.reach + STRIP.tracker });
  assert.deepEqual(barExtent("descender"), { y: -STRIP.tracker, height: STRIP.reach + STRIP.tracker });
  assert.deepEqual(barExtent("full"), { y: -STRIP.reach, height: 2 * STRIP.reach });
  assert.equal(STRIP_WIDTH, 31 * STRIP.pitch + STRIP.width);
});

test("rejects anything that is not a 16-digit lower-case fingerprint", () => {
  for (const bad of ["", "6B5286D1AD2708A1", "6b5286d1ad2708a", "6b5286d1ad2708a1f", "zz5286d1ad2708a1"]) {
    assert.throws(() => stripBars(bad), TypeError, bad);
  }
});

test("fingerprints are grouped in fours", () => {
  assert.equal(groupFingerprint("6b5286d1ad2708a1"), "6b52 86d1 ad27 08a1");
});
