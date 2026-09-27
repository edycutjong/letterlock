// The app answers on the SDK's pinned rpId host, and the host SDK 0.1.0 pinned sends every request there
// (next.config.ts), so no page is served, and no passkey made, under the old rpId. The live answers are checked by
// scripts/smoke.mjs on the production host and by the SDK's LIVE=1 checks.
import assert from "node:assert/strict";
import { test } from "node:test";

const { LETTERLOCK_RP_ID } = await import("letterlock");
const { default: config, APP_HOST, RETIRED_HOST } = await import("../next.config.ts");

test("the app's host is the SDK's pinned rpId, and the retired host is the rpId 0.1.0 pinned", () => {
  assert.equal(APP_HOST, LETTERLOCK_RP_ID);
  assert.equal(RETIRED_HOST, "letterlock-app.vercel.app");
  assert.notEqual(RETIRED_HOST, APP_HOST);
});

test("every path on the retired host is a 308 to the same path on the app's host, before any other redirect", async () => {
  const rules = await config.redirects!();
  assert.deepEqual(rules[0], {
    source: "/:path*",
    has: [{ type: "host", value: "letterlock-app\\.vercel\\.app" }],
    destination: "https://app.letterlock.edycu.dev/:path*",
    permanent: true, // 308: the method and the body are kept, so a POST to /api/drip arrives as a POST
  });
  // Next.js anchors a `has` value and reads it as a regular expression: it matches the retired host and nothing else
  const host = new RegExp(`^${(rules[0]!.has![0] as { value: string }).value}$`);
  assert.ok(host.test(RETIRED_HOST));
  for (const other of [APP_HOST, "letterlock-appXvercelXapp", "x.letterlock-app.vercel.app", "letterlock-app.vercel.app.evil.dev", "localhost", "127.0.0.1"])
    assert.ok(!host.test(other), other);
  // no other rule sends the app's own host anywhere
  assert.ok(rules.slice(1).every((r) => !r.destination.startsWith("http")), "only the retired host leaves the app");
});
