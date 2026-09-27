// What the public docs say about the SDK must stay true. LIVE=1 (test/live.test.ts) checks the names they point at.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LETTERLOCK_RP_ID, VERSION, letterlock } from "../src/index.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("public docs", () => {
  it("the README tells readers to install the CLI from npm, where the owner published it", () => {
    // letterlock is on npm, published by the owner (live.test.ts checks the registry names this repository).
    const readme = read("packages/letterlock/README.md");
    expect(readme).toContain("npm i letterlock");
    expect(readme).not.toContain("not published to npm yet");
  });

  it("CHANGELOG.md opens with this version, and says which rpId it pins and which one it left", () => {
    const log = read("packages/letterlock/CHANGELOG.md");
    const top = /^## (\S+) \(\d{4}-\d{2}-\d{2}\)$/m.exec(log);
    expect(top?.[1], "the newest CHANGELOG entry is not this package's version").toBe(VERSION);
    const entry = log.slice(top!.index, log.indexOf("\n## ", top!.index + 1));
    expect(entry).toContain(`\`LETTERLOCK_RP_ID\` is now \`${LETTERLOCK_RP_ID}\``);
    expect(entry).toContain("`letterlock-app.vercel.app`");
    expect(entry).toMatch(/cannot be re-derived under the new rpId/);
  });

  it("the README names the pinned rpId, and not the one 0.1.0 pinned as if it were current", () => {
    const readme = read("packages/letterlock/README.md").replace(/\s+/g, " ");
    expect(readme).toContain(`\`LETTERLOCK_RP_ID\` (\`${LETTERLOCK_RP_ID}\`)`);
    const old = [...readme.matchAll(/letterlock-app\.vercel\.app/g)];
    expect(old.length).toBeGreaterThan(0);
    for (const m of old) expect(readme.slice(Math.max(0, m.index - 40), m.index), "the old host is named only as what 0.1.0 pinned").toMatch(/0\.1\.0 pinned `$/);
  });

  it("no doc says the SDK has no drop helper: drop() and inbox() exist", () => {
    for (const f of ["contracts/README.md", "contracts/script/DeployMainnet.md", "docs/SPEC.md", "packages/letterlock/README.md"])
      expect(read(f), f).not.toMatch(/SDK has no drop helper|no drop helper yet/i);
    const ll = letterlock({ chain: "monad" });
    expect([typeof ll.drop, typeof ll.inbox]).toEqual(["function", "function"]);
  });
});
