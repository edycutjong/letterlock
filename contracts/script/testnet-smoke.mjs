#!/usr/bin/env node
// Testnet smoke run for the deployed directory, using the SDK's own derive/seal/open (packages/letterlock).
// The key is a TEST KEY: deriveKeyPair() over 32 random bytes that stand in for a passkey PRF output. No passkey
// is involved, and the stand-in is written only to --out, which must be outside this repository.
//
//   node contracts/script/testnet-smoke.mjs prepare --directory 0x.. --recipient 0x.. --chain-id 10143 --out DIR
//       -> DIR/test-key.json (stand-in + public key), prints the public key and the sealed envelope (hex)
//   (publish the key and drop the envelope with `cast send`, see contracts/README.md)
//   node contracts/script/testnet-smoke.mjs verify --rpc URL --directory 0x.. --recipient 0x.. --drop-tx 0x.. --key DIR/test-key.json
//       -> keyOf(recipient) must equal the test key; the Dropped envelope is read back from the receipt and opened
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveKeyPair, fingerprint, fromHex, open, seal, toHex,
} from "../../packages/letterlock/src/index.ts";

const contracts = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(contracts, "..");
const NO_AGENT = (1n << 256n) - 1n;

const args = Object.fromEntries(
  process.argv.slice(3).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const need = (k) => {
  if (!args[k]) throw new Error(`missing --${k}`);
  return args[k];
};
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

async function prepare() {
  const directory = need("directory");
  const recipient = need("recipient");
  const chainId = Number(need("chain-id"));
  const out = resolve(need("out"));
  const rel = relative(repo, out);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error(`--out must be outside the repository (${repo})`);
  if (!isAddress(directory) || !isAddress(recipient)) throw new Error("bad address");

  const prfStandIn = new Uint8Array(randomBytes(32)); // TEST KEY: random bytes in place of a passkey PRF output
  const keys = deriveKeyPair(prfStandIn, 1);
  const note = `Letterlock testnet smoke note, ${new Date().toISOString()}. TEST KEY: derived by deriveKeyPair() from 32 random bytes standing in for a passkey PRF output; no passkey was used.`;
  const envelope = await seal({
    chainId, directory, to: { recipient, publicKey: keys.publicKey, epoch: 1 },
    plaintext: new TextEncoder().encode(note),
  });
  // self-check before anything goes onchain
  const back = new TextDecoder().decode(await open(envelope, keys));
  if (back !== note) throw new Error("self-check failed: envelope did not open");

  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "test-key.json"), JSON.stringify({
    label: "TEST KEY - random 32-byte PRF stand-in, not a passkey",
    prfStandIn: `0x${toHex(prfStandIn)}`, epoch: 1, publicKey: `0x${toHex(keys.publicKey)}`, kid: fingerprint(keys.publicKey),
  }, null, 2));
  writeFileSync(join(out, "envelope.json"), JSON.stringify(envelope, null, 2));
  console.log(JSON.stringify({
    publicKey: `0x${toHex(keys.publicKey)}`, epoch: 1, kid: fingerprint(keys.publicKey),
    envelopeBytes: envelopeBytes.length, envelopeHex: `0x${toHex(envelopeBytes)}`, selfCheck: "opened",
  }, null, 2));
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** abi.decode(data, (bytes)) for a single dynamic `bytes` argument. */
const decodeBytes = (hex) => {
  const b = fromHex(hex);
  const offset = Number(BigInt(`0x${toHex(b.slice(0, 32))}`));
  const len = Number(BigInt(`0x${toHex(b.slice(offset, offset + 32))}`));
  return b.slice(offset + 32, offset + 32 + len);
};

async function verify() {
  const url = need("rpc");
  const directory = need("directory").toLowerCase();
  const recipient = need("recipient").toLowerCase();
  const dropTx = need("drop-tx");
  const saved = JSON.parse(readFileSync(need("key"), "utf8"));

  // 1. keyOf(recipient), selector taken from the forge artifact
  const artifact = JSON.parse(readFileSync(join(contracts, "out", "Letterlock.sol", "Letterlock.json"), "utf8"));
  const selector = artifact.methodIdentifiers["keyOf(address)"];
  const ret = fromHex(await rpc(url, "eth_call", [{ to: directory, data: `0x${selector}${recipient.slice(2).padStart(64, "0")}` }, "latest"]));
  const onchainPub = `0x${toHex(ret.slice(0, 32))}`;
  const onchainEpoch = Number(BigInt(`0x${toHex(ret.slice(32, 64))}`));
  const updatedAt = Number(BigInt(`0x${toHex(ret.slice(64, 96))}`));
  if (onchainPub !== saved.publicKey.toLowerCase() || onchainEpoch !== saved.epoch)
    throw new Error(`keyOf mismatch: ${onchainPub} epoch ${onchainEpoch}`);

  // 2. the Dropped log of the drop tx: emitted by the directory, topic1 = recipient, topic2 = NO_AGENT
  const receipt = await rpc(url, "eth_getTransactionReceipt", [dropTx]);
  if (receipt.status !== "0x1") throw new Error("drop tx failed");
  const log = receipt.logs.find((l) => l.address.toLowerCase() === directory
    && BigInt(l.topics[1]) === BigInt(recipient) && BigInt(l.topics[2]) === NO_AGENT);
  if (!log) throw new Error("no Dropped(recipient, NO_AGENT) log in the drop tx");
  const envelope = JSON.parse(new TextDecoder().decode(decodeBytes(log.data)));

  // 3. open it with the re-derived test key
  const keys = deriveKeyPair(fromHex(saved.prfStandIn), saved.epoch);
  if (`0x${toHex(keys.publicKey)}` !== saved.publicKey.toLowerCase()) throw new Error("stand-in does not derive the saved key");
  const plaintext = new TextDecoder().decode(await open(envelope, keys));
  console.log(JSON.stringify({
    keyOf: { pub: onchainPub, epoch: onchainEpoch, updatedAt },
    dropped: { block: Number(BigInt(receipt.blockNumber)), envelopeBytes: decodeBytes(log.data).length, kid: envelope.kid },
    opened: plaintext,
  }, null, 2));
}

const cmd = process.argv[2];
if (cmd === "prepare") await prepare();
else if (cmd === "verify") await verify();
else {
  console.error("usage: testnet-smoke.mjs prepare|verify ... (see header)");
  process.exit(2);
}
