// What the public docs say about the SDK must stay true. LIVE=1 (test/live.test.ts) checks the names they point at.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { letterlock } from "../src/index.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("public docs", () => {
  it("the README tells readers to install the CLI from npm, where the owner published it", () => {
    // letterlock@0.1.0 is on npm, published by the owner (live.test.ts checks the registry names this repository).
    const readme = read("packages/letterlock/README.md");
    expect(readme).toContain("npm i letterlock");
    expect(readme).not.toContain("not published to npm yet");
  });

  it("no doc says the SDK has no drop helper: drop() and inbox() exist", () => {
    for (const f of ["contracts/README.md", "contracts/script/DeployMainnet.md", "docs/SPEC.md", "packages/letterlock/README.md"])
      expect(read(f), f).not.toMatch(/SDK has no drop helper|no drop helper yet/i);
    const ll = letterlock({ chain: "monad" });
    expect([typeof ll.drop, typeof ll.inbox]).toEqual(["function", "function"]);
  });
});
