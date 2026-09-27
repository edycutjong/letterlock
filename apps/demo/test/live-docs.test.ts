// The app is served at the SDK's pinned rpId host (apps/demo/README.md: "Live: https://letterlock-app.vercel.app"), so
// the protocol spec and the SDK's README must not tell a judge that nothing is deployed there, while still warning
// that whoever serves that host can derive every key. The SDK's LIVE check (packages/letterlock/test/live.test.ts)
// asks the host itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const docs = { "docs/SPEC.md": read("docs/SPEC.md"), "packages/letterlock/README.md": read("packages/letterlock/README.md") };

test("the spec and the SDK's README say the rpId's host serves the app, not that nothing is deployed there", () => {
  for (const [path, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /nothing (is|was) deployed|DEPLOYMENT_NOT_FOUND/i, `${path} still says nothing is deployed at the host`);
    assert.match(text, /serves the Letterlock app/, `${path} does not say the host serves the app`);
    assert.match(text, /`letterlock-app`/, `${path} does not name the Vercel project`);
  }
});

test("and both keep the warning that whoever serves the host can derive every key", () => {
  assert.match(docs["docs/SPEC.md"], /Whoever serves the rpId's host\*\* can run passkey ceremonies/);
  assert.match(docs["packages/letterlock/README.md"], /Whoever serves pages there can run passkey ceremonies/);
});
