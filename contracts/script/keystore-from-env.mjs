#!/usr/bin/env node
// Imports a private key held in an environment variable into a Foundry keystore, for a deploy run with no terminal
// (`cast wallet import --interactive` needs one). Only the variable's NAME is given on the command line, so the key
// never appears in the process list or in shell history; it is never printed, and never written unencrypted.
//
//   set -a; source ~/.config/monad/mainnet-deployer.env; set +a
//   node script/keystore-from-env.mjs --key-env MONAD_MAINNET_PRIVATE_KEY --name letterlock-mainnet \
//     --password-file ~/.config/monad/letterlock-mainnet.password --expect-address "$MONAD_MAINNET_ADDRESS"
//   [--keystore-dir DIR]   (default ~/.foundry/keystores, where `--account <name>` looks)
//
// The keystore is the Web3 Secret Storage v3 file that `cast wallet import` writes (scrypt n=8192 r=8 p=1,
// aes-128-ctr, keccak-256 MAC), written with mode 600; the MAC is computed by `cast keccak` reading stdin. Foundry
// then derives the address from the new file with the same password file (`cast wallet address --keystore`), and the
// file is deleted again unless that works and the address equals --expect-address. An existing keystore of the same
// name is never overwritten. The password file must not be readable by group or others; Foundry ignores trailing
// whitespace in it (a final newline is fine), and so does this script.
import { spawnSync } from "node:child_process";
import { createCipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SCRYPT = { N: 8192, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const fail = (message) => {
  console.error(`keystore-from-env: ${message}`);
  process.exit(1);
};

const keyEnv = opt("key-env");
const name = opt("name");
const passwordFile = opt("password-file");
const expectAddress = opt("expect-address");
const dir = resolve(opt("keystore-dir") ?? join(homedir(), ".foundry", "keystores"));
if (!keyEnv || !name || !passwordFile) {
  fail("usage: --key-env VAR --name NAME --password-file FILE [--expect-address 0x...] [--keystore-dir DIR]");
}
if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) fail("--name: letters, digits, '.', '-' and '_' only");
if (expectAddress !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(expectAddress)) fail("--expect-address: not an address");

// The key: 32 bytes of hex, optionally 0x-prefixed, in [1, n - 1]. Error messages name the variable, never its value.
const raw = process.env[keyEnv];
if (raw === undefined || raw.trim() === "") fail(`environment variable ${keyEnv} is not set`);
const hex = raw.trim().replace(/^0x/i, "");
if (!/^[0-9a-fA-F]{64}$/.test(hex)) fail(`${keyEnv} does not hold a 32-byte hex private key`);
const scalar = BigInt(`0x${hex}`);
if (scalar === 0n || scalar >= SECP256K1_N) fail(`${keyEnv} is not a valid secp256k1 private key`);

let password;
try {
  if (statSync(passwordFile).mode & 0o077) fail(`${passwordFile} is readable by group or others: chmod 600 it`);
  password = readFileSync(passwordFile, "utf8").trimEnd();
} catch (e) {
  fail(`cannot read the password file ${passwordFile}: ${e.code ?? e.message}`);
}
if (password === "") fail(`${passwordFile} is empty`);

const cast = (args, input) => {
  const r = spawnSync("cast", args, { input, encoding: "utf8" });
  if (r.error) fail(`cannot run cast (Foundry): ${r.error.message}`);
  return r;
};

const key = Buffer.from(hex, "hex");
const salt = randomBytes(32);
const iv = randomBytes(16);
const derived = scryptSync(Buffer.from(password, "utf8"), salt, 32, SCRYPT);
const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
key.fill(0);
const macInput = Buffer.concat([derived.subarray(16, 32), ciphertext]);
derived.fill(0);
const hashed = cast(["keccak"], `0x${macInput.toString("hex")}`);
macInput.fill(0);
const mac = hashed.stdout.trim();
if (hashed.status !== 0 || !/^0x[0-9a-f]{64}$/.test(mac)) fail("cast keccak failed");

const keystore = {
  crypto: {
    cipher: "aes-128-ctr",
    cipherparams: { iv: iv.toString("hex") },
    ciphertext: ciphertext.toString("hex"),
    kdf: "scrypt",
    kdfparams: { dklen: 32, n: SCRYPT.N, p: SCRYPT.p, r: SCRYPT.r, salt: salt.toString("hex") },
    mac: mac.slice(2),
  },
  id: randomUUID(),
  version: 3,
};

const path = join(dir, name);
mkdirSync(dir, { recursive: true, mode: 0o700 });
try {
  writeFileSync(path, JSON.stringify(keystore), { mode: 0o600, flag: "wx" });
} catch (e) {
  fail(e.code === "EEXIST" ? `${path} already exists; it is never overwritten` : `cannot write ${path}: ${e.code ?? e.message}`);
}

// Foundry itself must open the new keystore with the password file and derive the expected address.
const derivedAddress = cast(["wallet", "address", "--keystore", path, "--password-file", passwordFile]);
const address = derivedAddress.stdout.trim();
if (derivedAddress.status !== 0 || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  rmSync(path, { force: true });
  fail(`Foundry could not open the new keystore, so it was deleted: ${derivedAddress.stderr.trim()}`);
}
if (expectAddress !== undefined && address.toLowerCase() !== expectAddress.toLowerCase()) {
  rmSync(path, { force: true });
  fail(`the key in ${keyEnv} is for ${address}, not ${expectAddress}; the keystore was deleted`);
}
console.log(`keystore ${path}`);
console.log(`address  ${address}`);
