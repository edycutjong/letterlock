// The app answers on the SDK's pinned rpId host, and the host SDK 0.1.0 pinned sends every request there, so no page
// is served, and no passkey made, under the old rpId. On Vercel the 308 is vercel.json's, which Vercel's router answers
// before any file or function; next.config.ts has the same rule for any other server, but Next.js leaves /_next/ out of
// every redirect it is given, so on its own it served the build's files, and its 404 page, on the old host. The live
// answers are checked by scripts/smoke.mjs on the production host and by the SDK's LIVE=1 checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { LETTERLOCK_RP_ID } = await import("letterlock");
const { default: config, APP_HOST, RETIRED_HOST } = await import("../next.config.ts");
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

test("the app's host is the SDK's pinned rpId, and the retired host is the rpId 0.1.0 pinned", () => {
  assert.equal(APP_HOST, LETTERLOCK_RP_ID);
  assert.equal(RETIRED_HOST, "letterlock-app.vercel.app");
  assert.notEqual(RETIRED_HOST, APP_HOST);
});

test("every request to the retired host, the build's /_next/ files included, is a 308 to the same path on the app's host", async () => {
  // on Vercel: vercel.json, answered by Vercel's router before any file or function
  assert.deepEqual(vercel.redirects?.[0], {
    source: "/(.*)",
    has: [{ type: "host", value: "letterlock-app\\.vercel\\.app" }],
    destination: "https://app.letterlock.edycu.dev/$1",
    permanent: true, // 308: the method and the body are kept, so a POST to /api/drip arrives as a POST
  });
  assert.equal(vercel.redirects.length, 1, "vercel.json sends nothing else anywhere");
  // Vercel reads `source` as a regular expression over the whole path, and $1 carries all of it
  const source = new RegExp(`^${vercel.redirects[0].source}$`);
  for (const path of ["/", "/judge", "/api/drip", "/_next/static/chunks/main-app.js", "/_next/static/media/a.woff2", "/_next/data/x.json", "/_next/image", "/.well-known/webauthn"])
    assert.equal(source.exec(path)?.[1], path.slice(1), path);
  // on any other server: the same rule in next.config.ts, before any other redirect (Next.js leaves /_next/ out of it)
  const rules = await config.redirects!();
  assert.deepEqual(rules[0], {
    source: "/:path*",
    has: [{ type: "host", value: "letterlock-app\\.vercel\\.app" }],
    destination: "https://app.letterlock.edycu.dev/:path*",
    permanent: true,
  });
  // a `has` value is an anchored regular expression, in both: it matches the retired host and nothing else
  for (const value of [vercel.redirects[0].has[0].value, (rules[0]!.has![0] as { value: string }).value]) {
    const host = new RegExp(`^${value}$`);
    assert.ok(host.test(RETIRED_HOST));
    for (const other of [APP_HOST, "letterlock-appXvercelXapp", "x.letterlock-app.vercel.app", "letterlock-app.vercel.app.evil.dev", "localhost", "127.0.0.1"])
      assert.ok(!host.test(other), other);
  }
  // no other rule sends the app's own host anywhere
  assert.ok(rules.slice(1).every((r) => !r.destination.startsWith("http")), "only the retired host leaves the app");
});
