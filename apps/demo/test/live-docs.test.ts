// The app is served at the SDK's pinned rpId host (apps/demo/README.md: "Live: https://app.letterlock.edycu.dev"), so
// the protocol spec, the SDK's README and the doc comment on LETTERLOCK_RP_ID itself (what an editor shows a developer
// who hovers the constant) must not say that nothing is deployed there, while the first two still warn that whoever
// serves that host can derive every key. The SDK's LIVE check (packages/letterlock/test/live.test.ts) asks the host
// itself, and the host 0.1.0 pinned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const docs = {
  "docs/SPEC.md": read("docs/SPEC.md"),
  "packages/letterlock/README.md": read("packages/letterlock/README.md"),
  "packages/letterlock/src/deployments.ts": read("packages/letterlock/src/deployments.ts").replace(/ \* /g, " "),
};

test("the spec, the SDK's README and LETTERLOCK_RP_ID's doc comment say the rpId's host serves the app, not that nothing is deployed there", () => {
  for (const [path, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /nothing (is|was) deployed|DEPLOYMENT_NOT_FOUND/i, `${path} still says nothing is deployed at the host`);
    assert.match(text, /serves the Letterlock app/, `${path} does not say the host serves the app`);
    assert.match(text, /`letterlock-app`/, `${path} does not name the Vercel project`);
    assert.match(text, /app\.letterlock\.edycu\.dev/, `${path} does not name the rpId`);
    assert.match(text, /owner's own domain|a domain the owner registered/, `${path} does not say whose domain the host is on`);
  }
});

test("and each names letterlock-app.vercel.app only as the rpId 0.1.0 pinned, never as the current one", () => {
  for (const [path, text] of Object.entries(docs)) {
    const old = [...text.matchAll(/letterlock-app\.vercel\.app/g)];
    assert.ok(old.length > 0, `${path} does not say which rpId 0.1.0 pinned`);
    for (const m of old) assert.match(text.slice(Math.max(0, m.index - 30), m.index), /0\.1\.0 pinned `$/, `${path}: ${text.slice(m.index - 60, m.index + 40)}`);
  }
});

test("and both keep the warning that whoever serves the host can derive every key", () => {
  assert.match(docs["docs/SPEC.md"], /Whoever serves the rpId's host\*\* can run passkey ceremonies/);
  assert.match(docs["packages/letterlock/README.md"], /Whoever serves pages on the host, or on a subdomain of it, can run passkey ceremonies/);
  assert.match(docs["docs/SPEC.md"], /A page on a subdomain of the host may name it as its rpId too/);
});
