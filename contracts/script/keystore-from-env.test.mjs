// Tests for keystore-from-env.mjs with random TEST keys (never a real one), in a temporary keystore directory.
// Foundry is the judge: it must decrypt what the script writes back to the same key.
//
//   node --test contracts/script/keystore-from-env.test.mjs     (needs Foundry's `cast` on PATH)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const HELPER = join(import.meta.dirname, "keystore-from-env.mjs");
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const work = mkdtempSync(join(tmpdir(), "letterlock-keystore-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

function testKey() {
  for (;;) {
    const hex = randomBytes(32).toString("hex");
    const k = BigInt(`0x${hex}`);
    if (k > 0n && k < SECP256K1_N) return hex;
  }
}

let n = 0;
function passwordFile(mode = 0o600) {
  const password = `test-${randomBytes(16).toString("hex")}`;
  const file = join(work, `password-${++n}`);
  writeFileSync(file, `${password}\n`); // a final newline, as `openssl rand -hex 32 > file` leaves
  chmodSync(file, mode);
  return { password, file };
}

function run(args, keyValue) {
  const env = { ...process.env };
  delete env.LETTERLOCK_TEST_KEY;
  if (keyValue !== undefined) env.LETTERLOCK_TEST_KEY = keyValue;
  const r = spawnSync(process.execPath, [HELPER, "--key-env", "LETTERLOCK_TEST_KEY", ...args], { env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const cast = (args, env = process.env) => spawnSync("cast", args, { env, encoding: "utf8" });

test("imports the key from the environment; Foundry decrypts the keystore to the same key and address", () => {
  const key = testKey();
  const pw = passwordFile();
  const dir = join(work, "ks-roundtrip");
  const r = run(["--name", "roundtrip", "--password-file", pw.file, "--keystore-dir", dir], `0x${key}`);
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.out.toLowerCase().includes(key), "the key must never be printed");

  const file = join(dir, "roundtrip");
  assert.equal(statSync(file).mode & 0o777, 0o600, "keystore file mode");
  const decrypted = cast(["wallet", "decrypt-keystore", "roundtrip", "--keystore-dir", dir], {
    ...process.env,
    CAST_UNSAFE_PASSWORD: pw.password,
  });
  assert.equal(decrypted.status, 0, decrypted.stderr);
  assert.ok(decrypted.stdout.toLowerCase().includes(`0x${key}`), "Foundry decrypts the keystore back to the same key");

  const address = cast(["wallet", "address", "--keystore", file, "--password-file", pw.file]);
  assert.equal(address.status, 0, address.stderr);
  assert.match(r.out, new RegExp(`address\\s+${address.stdout.trim()}`));
});

test("--expect-address: a mismatch deletes the keystore and fails; a match keeps it", () => {
  const key = testKey();
  const pw = passwordFile();
  const dir = join(work, "ks-expect");
  const first = run(["--name", "probe", "--password-file", pw.file, "--keystore-dir", dir], key);
  assert.equal(first.status, 0, first.out);
  const address = first.out.match(/address\s+(0x[0-9a-fA-F]{40})/)[1];

  const wrong = run(["--name", "wrong", "--password-file", pw.file, "--keystore-dir", dir,
    "--expect-address", "0x000000000000000000000000000000000000dEaD"], key);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.out, /not 0x000000000000000000000000000000000000dEaD/);
  assert.ok(!existsSync(join(dir, "wrong")), "a keystore for another address is deleted");

  const right = run(["--name", "right", "--password-file", pw.file, "--keystore-dir", dir,
    "--expect-address", address.toLowerCase()], key);
  assert.equal(right.status, 0, right.out);
  assert.ok(existsSync(join(dir, "right")));
});

test("never overwrites an existing keystore", () => {
  const pw = passwordFile();
  const dir = join(work, "ks-overwrite");
  assert.equal(run(["--name", "same", "--password-file", pw.file, "--keystore-dir", dir], testKey()).status, 0);
  const before = readFileSync(join(dir, "same"), "utf8");
  const again = run(["--name", "same", "--password-file", pw.file, "--keystore-dir", dir], testKey());
  assert.notEqual(again.status, 0);
  assert.match(again.out, /already exists/);
  assert.equal(readFileSync(join(dir, "same"), "utf8"), before);
});

test("rejects a missing, malformed or out-of-range key without printing it", () => {
  const pw = passwordFile();
  const dir = join(work, "ks-reject");
  const args = ["--name", "bad", "--password-file", pw.file, "--keystore-dir", dir];
  const short = testKey().slice(1);
  const cases = [
    [undefined, /is not set/],
    [short, /does not hold a 32-byte hex private key/],
    ["0".repeat(64), /not a valid secp256k1 private key/],
    [SECP256K1_N.toString(16), /not a valid secp256k1 private key/],
  ];
  for (const [value, message] of cases) {
    const r = run(args, value);
    assert.notEqual(r.status, 0, `accepted ${value === undefined ? "a missing key" : "a bad key"}`);
    assert.match(r.out, message);
    if (value) assert.ok(!r.out.includes(value), "the rejected value must not be printed");
  }
  assert.ok(!existsSync(join(dir, "bad")));
});

test("refuses a password file that group or others can read", () => {
  const pw = passwordFile(0o644);
  const dir = join(work, "ks-mode");
  const r = run(["--name", "open", "--password-file", pw.file, "--keystore-dir", dir], testKey());
  assert.notEqual(r.status, 0);
  assert.match(r.out, /chmod 600/);
  assert.ok(!existsSync(join(dir, "open")));
});
