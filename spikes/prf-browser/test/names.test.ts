import assert from "node:assert/strict";
import { test } from "node:test";
import { passkeyName } from "../names.ts";

const at = new Date(2026, 8, 26, 20, 48, 5);

test("two passkeys made in the same second get different names (the tester must tell them apart)", () => {
  const a = passkeyName(at, () => Uint8Array.of(0, 1, 2));
  const b = passkeyName(at, () => Uint8Array.of(3, 4, 5));
  assert.equal(a, "maya 20:48 · abc");
  assert.equal(b, "maya 20:48 · def");
  assert.notEqual(a, b);
});

test("the default random suffix differs across 200 names made at one instant", () => {
  const names = new Set(Array.from({ length: 200 }, () => passkeyName(at)));
  // 31^3 = 29,791 suffixes: 200 draws collide with p ≈ 0.49 by the birthday bound, so allow a few repeats, never
  // the old behaviour (every name equal)
  assert.ok(names.size >= 190, `only ${names.size} distinct names`);
  for (const n of names) assert.match(n, /^maya 20:48 · [a-hj-km-np-z2-9]{3}$/);
});

test("the suffix never uses characters that are easy to misread (0 o 1 i l)", () => {
  const all = Array.from({ length: 256 }, (_, b) => passkeyName(at, () => Uint8Array.of(b, b, b)).slice(-3));
  assert.equal(all.join("").match(/[0o1il]/g), null);
});
