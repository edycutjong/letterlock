// The build stamp in a throwaway repo shaped like this one: the page, the SDK it bundles, the lockfile, and an
// unrelated folder (contracts) that other commits touch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { buildStamp } from "../build-stamp.ts";

const root = mkdtempSync(join(tmpdir(), "ll-stamp-"));
after(() => rmSync(root, { recursive: true, force: true }));
const spike = join(root, "spikes/prf-browser");
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=stamp-test", "-c", "user.email=stamp@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root }).toString().trim();
const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const commit = (msg: string) => { git("add", "-A"); git("commit", "-q", "-m", msg); return git("log", "-1", "--format=%h"); };
const edit = (path: string) => appendFileSync(join(root, path), "\n// edited\n");
const reset = () => { git("reset", "-q", "--hard"); git("clean", "-q", "-fd"); };

git("init", "-q");
put("spikes/prf-browser/main.ts", "export {};\n");
put("spikes/prf-browser/README.md", "# page\n");
put("spikes/prf-browser/check-page.mjs", "// test script\n");
put("spikes/prf-browser/test/verdict.test.ts", "export {};\n");
put("packages/letterlock/src/envelope.ts", "export {};\n");
put("packages/letterlock/README.md", "# sdk\n");
put("packages/letterlock/test/envelope.test.ts", "export {};\n");
put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
put("contracts/src/Letterlock.sol", "// contract\n");
const first = commit("initial");

test("a clean checkout is stamped with the last commit that touched the page's inputs", () => {
  assert.equal(buildStamp(spike), first);
});

test("an uncommitted edit to the bundled SDK marks the page dirty", () => {
  edit("packages/letterlock/src/envelope.ts");
  try { assert.equal(buildStamp(spike), `${first}+dirty`); } finally { reset(); }
});

test("an uncommitted lockfile change, or a new untracked page module, marks the page dirty", () => {
  edit("pnpm-lock.yaml");
  try { assert.equal(buildStamp(spike), `${first}+dirty`); } finally { reset(); }
  put("spikes/prf-browser/extra.ts", "export {};\n");
  try { assert.equal(buildStamp(spike), `${first}+dirty`); } finally { reset(); }
});

test("Markdown edits never mark it dirty, in the page folder or in the SDK", () => {
  edit("spikes/prf-browser/README.md");
  edit("packages/letterlock/README.md");
  try { assert.equal(buildStamp(spike), first); } finally { reset(); }
});

test("tests never enter the bundle: editing them leaves the stamp clean", () => {
  edit("spikes/prf-browser/check-page.mjs");
  edit("spikes/prf-browser/test/verdict.test.ts");
  edit("packages/letterlock/test/envelope.test.ts");
  try { assert.equal(buildStamp(spike), first); } finally { reset(); }
});

test("a commit outside the page's inputs (contracts, tests) leaves the stamp unchanged; a commit to the SDK moves it", () => {
  edit("contracts/src/Letterlock.sol");
  const contracts = commit("contracts only");
  assert.notEqual(contracts, first);
  assert.equal(buildStamp(spike), first);
  edit("spikes/prf-browser/test/verdict.test.ts");
  commit("tests only");
  assert.equal(buildStamp(spike), first);
  edit("packages/letterlock/src/envelope.ts");
  const sdk = commit("sdk change");
  assert.equal(buildStamp(spike), sdk);
});

test("outside a git repository the stamp says so", () => {
  const bare = mkdtempSync(join(tmpdir(), "ll-nogit-"));
  try { assert.equal(buildStamp(bare), "nogit"); } finally { rmSync(bare, { recursive: true, force: true }); }
});
