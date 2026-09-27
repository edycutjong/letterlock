// The colour law, checked in the source: sealing-wax red appears only as wax, that is in the wax seal and in the
// wordmark's "lock". No stylesheet or component may use the wax tokens or their hex values anywhere else. (scripts/
// qa.mjs checks the same law in the rendered pages, on every computed colour.)
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const ALLOWED = new Set(["app/tokens.css", "components/WaxSeal.tsx", "components/WaxSeal.module.css", "components/Wordmark.tsx", "components/Wordmark.module.css", "app/icon.svg"]);
const WAX = /var\(--(after|accent|sealed|wax-deep|wax-sheen|color-error|accent-glow|color-error-glow|gradient-wax|gradient-hero|shadow-glow)\)|#a3261e|#7a1b15|#c4483c/i;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (["node_modules", ".next", ".next-e2e", "qa", "test", "e2e-results"].includes(f)) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(css|tsx?|svg)$/.test(f) ? [p] : [];
  });

test("wax colours appear only in the seal, the wordmark and the token sheet", () => {
  const hits: string[] = [];
  for (const f of files(root)) {
    const rel = relative(root, f);
    if (ALLOWED.has(rel)) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      // a wax value printed as text (the kit's swatch label) is allowed when the line above says so
      if (WAX.test(line) && !/colour-law: label/.test(lines[i - 1] ?? "")) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the token sheet carries the brand values unchanged", () => {
  const css = readFileSync(join(root, "app/tokens.css"), "utf8");
  for (const [token, hex] of [
    ["--bg", "#F3EEE3"],
    ["--ink", "#1E1B16"],
    ["--muted", "#6E6556"],
    ["--before", "#2F5D9E"],
    ["--after", "#A3261E"],
    ["--rule", "#CFC4AF"],
  ])
    assert.match(css, new RegExp(`${token}:\\s+${hex};`), token);
});

test("no button is red: the button styles use no wax token", () => {
  const css = readFileSync(join(root, "components/Button.module.css"), "utf8");
  assert.doesNotMatch(css, WAX);
  assert.doesNotMatch(css, /--color-error|--accent/);
});
