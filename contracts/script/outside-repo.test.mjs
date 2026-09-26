// smoke.mjs writes a PRF stand-in, which opens anything sealed to its key, to --out, and refuses an --out inside the
// repository (outside-repo.mjs). Every way into the tree must be refused, and a real outside path allowed. Nothing
// here writes inside the repository unless the check is broken, and then the test removes it again.
//
//   node --test contracts/script/outside-repo.test.mjs     (the smoke.mjs test also needs the SDK's dependencies)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { isOutside } from "./outside-repo.mjs";

const repo = join(import.meta.dirname, "..", "..");
const work = mkdtempSync(join(tmpdir(), "letterlock-outside-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

test("the repository and every path under it are inside, however the path is spelled", () => {
  for (const p of [
    repo,
    join(repo, "keys"),
    join(repo, "..keys"), // a folder whose name starts with "..": inside
    join(repo, "...", "deeper"),
    join(repo, "contracts", "new", "deeper"),
    `${repo}/contracts/../..keys`,
    relative(process.cwd(), join(repo, "..keys")), // `--out ./..keys` from the repository root
  ])
    assert.equal(isOutside(repo, p), false, p);
});

test("a symlink into the repository leads inside, whether or not the path under it exists yet", () => {
  const link = join(work, "link-into-repo");
  symlinkSync(join(repo, "contracts"), link);
  for (const p of [link, join(link, "keys"), join(link, "new", "deeper")]) assert.equal(isOutside(repo, p), false, p);
});

test("a symlink that does not resolve is refused: it could still lead into the tree", () => {
  const dangling = join(work, "dangling");
  symlinkSync(join(repo, "not-there-yet"), dangling);
  assert.throws(() => isOutside(repo, join(dangling, "keys")), /does not resolve/);
});

const upper = join(dirname(repo), basename(repo).toUpperCase());
const ignoresCase = upper !== repo && existsSync(upper) && statSync(upper).ino === statSync(repo).ino;
test("the repository's path in another letter case is inside, on a file system that ignores case",
  { skip: ignoresCase ? false : "this file system tells letter cases apart" }, () => {
    assert.equal(isOutside(repo, join(upper, "keys")), false);
    assert.equal(isOutside(repo, join(upper, "..keys")), false);
  });

// macOS: /System/Volumes/Data is a second name for /Users, /private, /opt and the other firmlink roots, and
// realpath keeps that spelling, so only the folders' identity shows it is the same tree.
const firmlinked = join("/System/Volumes/Data", repo);
const sameFolder = (a, b) => {
  const x = statSync(a, { bigint: true });
  const y = statSync(b, { bigint: true });
  return x.dev === y.dev && x.ino === y.ino;
};
const hasFirmlink = existsSync(firmlinked) && sameFolder(firmlinked, repo);
test("the repository under /System/Volumes/Data is inside, where that second name exists",
  { skip: hasFirmlink ? false : "no /System/Volumes/Data name for the repository here" }, () => {
    for (const p of [firmlinked, join(firmlinked, "keys"), join(firmlinked, "..keys"), join(firmlinked, "a", "b")])
      assert.equal(isOutside(repo, p), false, p);
    assert.equal(isOutside(firmlinked, join(repo, "keys")), false);
  });

test("paths outside the repository are allowed, existing or not", () => {
  for (const p of [work, join(work, "new", "deeper"), dirname(repo), join(dirname(repo), "sibling-not-there"), tmpdir()])
    assert.equal(isOutside(repo, p), true, p);
});

const sdkInstalled = existsSync(join(repo, "packages", "letterlock", "node_modules", "@hpke", "core"));
const skipSmoke = { skip: sdkInstalled ? false : "the SDK's dependencies are not installed (pnpm install)" };
const prepare = (out) => {
  const directory = JSON.parse(readFileSync(join(repo, "deployments", "10143.json"), "utf8")).address;
  return spawnSync(process.execPath, [
    "contracts/script/smoke.mjs", "prepare", "--chain-id", "10143", "--directory", directory,
    "--recipient", "0x000000000000000000000000000000000000dead", "--out", out,
  ], { cwd: repo, encoding: "utf8" });
};

test("smoke.mjs prepare refuses --out ./..keys and writes nothing there; an outside --out gets key.json, mode 600",
  skipSmoke, () => {

    const name = `..keys-test-${process.pid}`;
    try {
      const refused = prepare(`./${name}`);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /--out must be outside the repository/);
      assert.equal(existsSync(join(repo, name)), false);
    } finally {
      rmSync(join(repo, name), { recursive: true, force: true }); // only there if the check let it through
    }

    const out = join(work, "smoke-out");
    const done = prepare(out);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(done.stdout).selfCheck, "opened");
    assert.equal(statSync(join(out, "key.json")).mode & 0o777, 0o600);
  });

test("smoke.mjs prepare never replaces an earlier key.json: a second run into the same --out fails and changes nothing",
  skipSmoke, () => {
    const out = join(work, "smoke-twice");
    assert.equal(prepare(out).status, 0);
    const key = readFileSync(join(out, "key.json"));
    const envelope = readFileSync(join(out, "envelope.json"));
    const again = prepare(out);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.deepEqual(readFileSync(join(out, "key.json")), key);
    assert.deepEqual(readFileSync(join(out, "envelope.json")), envelope);
  });

test("smoke.mjs prepare refuses a key.json symlink in --out and writes nothing through it", skipSmoke, () => {
  const out = join(work, "smoke-link");
  const target = join(work, "link-target.json"); // outside the tree, so a broken check leaks nothing into it
  mkdirSync(out);
  symlinkSync(target, join(out, "key.json"));
  const done = prepare(out);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /already exists/);
  assert.equal(existsSync(target), false);
  assert.equal(lstatSync(join(out, "key.json")).isSymbolicLink(), true);
  assert.equal(existsSync(join(out, "envelope.json")), false);
});
