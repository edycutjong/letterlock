// Colours come from the token sheet (app/tokens.css) and nowhere else. No stylesheet or component writes a raw hex
// colour or a named colour; the few places that must hand a colour over as text (the kit's swatch labels, the
// browser's theme colour) read it from the token sheet, so they cannot drift from it. The brand icon (app/icon.svg)
// is the brand's own file, copied with its token fallbacks, and is left as it is.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { tokenValue } from "../lib/tokens.ts";

const root = join(import.meta.dirname, "..");
const EXEMPT = new Set(["app/tokens.css", "app/icon.svg"]);
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/i;
const NAMED = /(?<![\w-])(black|white|red|blue|green|gr[ae]y|silver|navy|maroon)(?![\w-])/i;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (["node_modules", ".next", "qa", "test", "public"].includes(f)) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(css|tsx?|svg)$/.test(f) ? [p] : [];
  });

test("no raw hex colour outside the token sheet", () => {
  const hits: string[] = [];
  for (const f of files(join(root, "app")).concat(files(join(root, "components")), files(join(root, "lib")))) {
    const rel = relative(root, f);
    if (EXEMPT.has(rel)) continue;
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => HEX.test(line) && hits.push(`${rel}:${i + 1}: ${line.trim()}`));
  }
  assert.deepEqual(hits, []);
});

test("no named colour in a stylesheet: colours are tokens or mixes of tokens", () => {
  const hits: string[] = [];
  for (const f of files(join(root, "app")).concat(files(join(root, "components")))) {
    const rel = relative(root, f);
    if (EXEMPT.has(rel) || !rel.endsWith(".css")) continue;
    // comments may name colours ("airmail blue"); blank them out, keeping the line numbers
    readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
      .split("\n")
      .forEach((line, i) => NAMED.test(line) && hits.push(`${rel}:${i + 1}: ${line.trim()}`));
  }
  assert.deepEqual(hits, []);
});

test("tokenValue reads the token sheet", () => {
  const css = readFileSync(join(root, "app/tokens.css"), "utf8");
  for (const token of ["--bg", "--bg-elevated", "--bg-sunk", "--ink", "--muted", "--rule", "--before", "--after"] as const) {
    const line = css.split("\n").find((l) => l.trimStart().startsWith(`${token}:`));
    assert.ok(line, token);
    assert.ok(line.includes(tokenValue(token)), `${token} → ${tokenValue(token)}`);
  }
  assert.equal(tokenValue("--bg"), "#F3EEE3");
  assert.throws(() => tokenValue("--no-such-token"), /no-such-token/);
});
