// This repository becomes public. The project's private planning notes never enter it, and neither do their file
// names: the pre-publication leak scan flags any reference to one. The names are read at test time from the
// planning folder that sits next to this repository, so this file never spells them out. In a clone without that
// folder (anyone else's), the tests are skipped. The second test extends the check from HEAD to the whole history
// (`git log --all -S<name>`), and the third to every commit message, because the repository goes public with its
// history.
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

// Commits (abbreviated hashes) allowed to add or remove a planning-file name: none. Four early commits named two of
// them in code comments; the history was rewritten on 2026-09-27, before the repository went public, with those
// comments reworded, so every commit hash from the third commit on changed. Keep this set empty.
const KNOWN_IN_HISTORY = new Set<string>();

test("no commit in history adds or removes a planning-file name",
  { skip: names.length === 0 ? "no planning folder next to this repository" : false }, () => {
    const hits: string[] = [];
    for (const n of names) {
      const commits = execFileSync("git", ["log", "--all", "--format=%h", "--abbrev=7", `-S${n}`], { cwd: root }).toString().split("\n").filter(Boolean);
      for (const c of commits) if (!KNOWN_IN_HISTORY.has(c)) hits.push(`${c} adds or removes ${n}`);
    }
    assert.deepEqual(hits, []);
  });

// A commit message goes public with the history too, and -S reads only the patches.
test("no commit message names a planning file", { skip: names.length === 0 ? "no planning folder next to this repository" : false }, () => {
  const log = execFileSync("git", ["log", "--all", "--format=%h%x00%B%x1e", "--abbrev=7"], { cwd: root, maxBuffer: 64 << 20 }).toString();
  const hits: string[] = [];
  for (const record of log.split("\x1e")) {
    const [hash, message] = record.replace(/^\n/, "").split("\0");
    if (!hash || message === undefined) continue;
    for (const name of new Set(patterns.filter((p) => message.split("\n").some((line) => p.re.test(line))).map((p) => p.name))) {
      hits.push(`${hash}'s message names ${name}`);
    }
  }
  assert.deepEqual(hits, []);
});
