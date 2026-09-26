import assert from "node:assert/strict";
import { test } from "node:test";
import { HYBRID_HINT, deriveVerdict, type Outcome } from "../verdict.ts";

const base: Outcome = { hasNote: true, opened: false, wrongKey: false, hybrid: false, creator: false, sameCredential: true, who: "maya 20:48 · k3f", other: "Mac" };
const v = (o: Partial<Outcome>) => deriveVerdict({ ...base, ...o });

test("a note opened on the synced copy is the only cross-device PASS", () => {
  assert.deepEqual(v({ opened: true }), { level: "pass", text: "Same key — the note opened on this device." });
});

test("a note opened over hybrid is RETRY, never PASS: the synced copy was not used", () => {
  const r = v({ opened: true, hybrid: true });
  assert.equal(r.level, "retry");
  assert.match(r.text, /through ANOTHER device \(hybrid \/ QR\).*does not test the sync/);
});

test("on the device that made the passkey, an opened note is a self-check PASS that points at the other device", () => {
  const r = v({ opened: true, creator: true, other: "iPad" });
  assert.equal(r.level, "pass");
  assert.match(r.text, /^Self-check passed: signing in gives the same key as creating the passkey did/);
  assert.match(r.text, /Now open the link on the iPad\.$/);
});

test("a creation-vs-sign-in mismatch on the creating device is not blamed on the sync", () => {
  const r = v({ wrongKey: true, creator: true, other: "iPad" });
  assert.equal(r.level, "fail");
  assert.match(r.text, /on the device that made it.*another PRF output than creating the passkey did.*not a sync problem/);
  assert.doesNotMatch(r.text, /across devices/);
});

test("the cross-device FAIL names the OS-generation confounder and asks for both OS versions", () => {
  const r = v({ wrongKey: true, sameCredential: true });
  assert.equal(r.level, "fail");
  assert.match(r.text, /did not match across devices/);
  assert.match(r.text, /different OS generations .* known Apple issue rather than a Letterlock defect/);
  assert.match(r.text, /with both OS versions/);
});

test("another passkey chosen → RETRY naming the link's passkey, or the other device when the link has no name", () => {
  assert.deepEqual(v({ wrongKey: true, sameCredential: false }), { level: "retry", text: "A different passkey was chosen. Tap 2 again and choose “maya 20:48 · k3f”." });
  assert.match(v({ wrongKey: true, sameCredential: false, who: undefined, other: "iPad" }).text, /choose the passkey the iPad made\.$/);
});

test("hybrid without an open → the hybrid hint; no note → info; unknown credential → FAIL; other errors keep their code", () => {
  assert.deepEqual(v({ hybrid: true, wrongKey: true }), { level: "retry", text: HYBRID_HINT });
  assert.equal(v({ hasNote: false }).level, "info");
  assert.match(v({ wrongKey: true, sameCredential: null }).text, /^Different key: either another passkey/);
  assert.deepEqual(v({ openError: { code: "TAMPERED", help: "Open the link again." } }), { level: "fail", text: "The note did not open (TAMPERED). Open the link again." });
});
