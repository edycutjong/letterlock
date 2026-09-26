// This repository becomes public. The project's private planning notes never enter it, and neither do their file
// names: the pre-publication leak scan flags any reference to one. The names are read at test time from the
// planning folder that sits next to this repository, so this file never spells them out. In a clone without that
// folder (anyone else's), the tests are skipped. The second test extends the check from HEAD to the whole history
// (`git log --all -S<name>`), because the repository goes public with its history.
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

// Commits (full hashes) already known to add or remove a planning-file name. Rewriting them, or accepting them, is
// the owner's decision before the repository goes public; this list only keeps a NEW one from slipping in unseen.
// After a history rewrite these hashes no longer exist and the list should be emptied.
const KNOWN_IN_HISTORY = new Set([
  "d17c130", "fa0c62c", // one name, added then removed
  "dc6e2d9", "02c7a6e", // a second name, added then removed
]);

test("no commit in history adds or removes a planning-file name, other than the known ones awaiting the pre-publication decision",
  { skip: names.length === 0 ? "no planning folder next to this repository" : false }, () => {
    const hits: string[] = [];
    for (const n of names) {
      const commits = execFileSync("git", ["log", "--all", "--format=%h", "--abbrev=7", `-S${n}`], { cwd: root }).toString().split("\n").filter(Boolean);
      for (const c of commits) if (!KNOWN_IN_HISTORY.has(c)) hits.push(`${c} adds or removes ${n}`);
    }
    assert.deepEqual(hits, []);
  });
