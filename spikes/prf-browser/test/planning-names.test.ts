// This repository becomes public. The project's private planning notes never enter it, and neither do their file
// names: the pre-publication leak scan flags any reference to one. The names are read at test time from the
// planning folder that sits next to this repository, so this file never spells them out. In a clone without that
// folder (anyone else's), the test is skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname }).toString().trim();
const planning = join(root, "..", "specs");
const names = existsSync(planning) ? readdirSync(planning).filter((f) => f.endsWith(".md") && f !== "README.md") : [];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// the full file name, and the bare stem when it is distinctive (hyphenated): "x-y.md" and "x-y" both count
const patterns = names.flatMap((n) => {
  const stem = n.slice(0, -3);
  return [n, ...(stem.includes("-") ? [stem] : [])].map((s) => ({ name: n, re: new RegExp(`(^|[^A-Za-z0-9_-])${escape(s)}(?![A-Za-z0-9_-])`) }));
});

test("no tracked file mentions a private planning file", { skip: names.length === 0 ? "no planning folder next to this repository" : false }, () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
  const hits: string[] = [];
  for (const f of files) {
    const path = join(root, f);
    if (!existsSync(path) || !statSync(path).isFile()) continue; // submodules, deletions not yet staged
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue; // binary
    bytes.toString("utf8").split("\n").forEach((line, i) => {
      for (const name of new Set(patterns.filter((p) => p.re.test(line)).map((p) => p.name))) hits.push(`${f}:${i + 1} names ${name}`);
    });
  }
  assert.ok(names.length >= 5, `expected the planning folder to hold several notes, found ${names.length}`);
  assert.deepEqual(hits, []);
});
