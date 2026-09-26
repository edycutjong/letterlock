import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_NOTE_BYTES, noteBudget } from "../note.ts";

test("the limit is counted in UTF-8 bytes, so 70 CJK characters (210 bytes) are over it", () => {
  const b = noteBudget("字".repeat(70));
  assert.deepEqual([b.bytes, b.ok], [210, false]);
  assert.match(b.text, /^210 \/ 200 bytes: too long/);
  assert.match(b.text, /3–4 bytes each/);
});

test("200 Latin characters are exactly at the limit, 201 are over", () => {
  assert.equal(MAX_NOTE_BYTES, 200);
  assert.deepEqual([noteBudget("a".repeat(200)).ok, noteBudget("a".repeat(201)).ok], [true, false]);
  assert.equal(noteBudget("a".repeat(200)).text, "200 / 200 bytes");
});

test("emoji count 4 bytes each; an empty field says the sample note is used", () => {
  assert.equal(noteBudget("📬".repeat(50)).bytes, 200);
  assert.equal(noteBudget("📬".repeat(51)).ok, false);
  assert.match(noteBudget("").text, /empty, so the sample note is sealed/);
});
