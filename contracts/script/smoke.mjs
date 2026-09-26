#!/usr/bin/env node
// Smoke run for a deployed directory, using the SDK's own derive/seal/open (packages/letterlock).
// The key is nobody's: deriveKeyPair() over 32 random bytes that stand in for a passkey PRF output. It is labelled
// TEST KEY (the default) or, with --label "DEMO KEY", a demo key on mainnet. No passkey is involved, and the stand-in
// is written only to --out, which must be outside this repository.
//
//   node contracts/script/smoke.mjs prepare --chain-id 143 --directory 0x.. --recipient 0x..|agent:<id> --out DIR
//       [--label "DEMO KEY"]
//       -> DIR/key.json (stand-in + public key) and DIR/envelope.json (a note sealed to that key with seal(), opened
//          once as a self-check); prints the public key and the envelope as hex
//   (publish the key with `cast send` publish or publishForAgent, and drop the envelope with `cast send` drop)
//   node contracts/script/smoke.mjs verify --rpc URL --directory 0x.. --recipient 0x..|agent:<id> --key DIR/key.json
//       [--drop-tx 0x..]
//       -> keyOf(address) or keyOfAgent(id) must return the saved key and epoch; with --drop-tx, the Dropped envelope
//          is read back from that receipt, must name this chain, directory and recipient, and is opened
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalRecipient, deriveKeyPair, fingerprint, fromHex, open, seal, toHex,
} from "../../packages/letterlock/src/index.ts";

const contracts = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(contracts, "..");
const NO_AGENT = (1n << 256n) - 1n;
/** keccak256("Dropped(address,uint256,bytes)") */
const DROPPED_TOPIC = "0x8a4d903a6ff8418ccd1925799f931057bf8cb32bb34d51e9982c0a9cc679ce6a";
const NETWORKS = { 143: "Monad mainnet", 10143: "Monad testnet" };

const args = Object.fromEntries(
  process.argv.slice(3).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const need = (k) => {
  if (!args[k]) throw new Error(`missing --${k}`);
  return args[k];
};
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** "0x.." -> the lower-cased address; "agent:<id>" -> the agent id. Anything else throws INPUT_INVALID (SDK rule). */
const parseRecipient = (r) => {
  const canonical = canonicalRecipient(r);
  return canonical.startsWith("agent:")
    ? { canonical, agentId: BigInt(canonical.slice("agent:".length)) }
    : { canonical, address: canonical };
};

async function prepare() {
  const directory = need("directory");
  const recipient = parseRecipient(need("recipient"));
  const chainId = Number(need("chain-id"));
  const label = args.label ?? "TEST KEY";
  const out = resolve(need("out"));
  const rel = relative(repo, out);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error(`--out must be outside the repository (${repo})`);
  if (!isAddress(directory)) throw new Error("bad directory address");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("bad --chain-id");
  const network = NETWORKS[chainId] ?? `chain ${chainId}`;

  const prfStandIn = new Uint8Array(randomBytes(32)); // random bytes in place of a passkey PRF output
  const keys = deriveKeyPair(prfStandIn, 1);
  const note = `Letterlock ${network} smoke note, ${new Date().toISOString()}. ${label}: derived by deriveKeyPair() from 32 random bytes standing in for a passkey PRF output; no passkey was used.`;
  const envelope = await seal({
    chainId, directory, to: { recipient: recipient.canonical, publicKey: keys.publicKey, epoch: 1 },
    plaintext: new TextEncoder().encode(note),
  });
  // self-check before anything goes onchain
  const back = new TextDecoder().decode(await open(envelope, keys));
  if (back !== note) throw new Error("self-check failed: envelope did not open");

  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "key.json"), JSON.stringify({
    label: `${label} - random 32-byte PRF stand-in, not a passkey`, recipient: recipient.canonical,
    prfStandIn: `0x${toHex(prfStandIn)}`, epoch: 1, publicKey: `0x${toHex(keys.publicKey)}`, kid: fingerprint(keys.publicKey),
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(out, "envelope.json"), JSON.stringify(envelope, null, 2));
  console.log(JSON.stringify({
    label, network, recipient: recipient.canonical, publicKey: `0x${toHex(keys.publicKey)}`, epoch: 1,
    kid: fingerprint(keys.publicKey), envelopeBytes: envelopeBytes.length, envelopeHex: `0x${toHex(envelopeBytes)}`,
    selfCheck: "opened",
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

const word = (n) => n.toString(16).padStart(64, "0");

async function verify() {
  const url = need("rpc");
  const directory = need("directory").toLowerCase();
  const recipient = parseRecipient(need("recipient"));
  const saved = JSON.parse(readFileSync(need("key"), "utf8"));
  if (!isAddress(directory)) throw new Error("bad directory address");

  // 1. keyOf(address) or keyOfAgent(id), selector taken from the forge artifact
  const artifact = JSON.parse(readFileSync(join(contracts, "out", "Letterlock.sol", "Letterlock.json"), "utf8"));
  const read = recipient.agentId === undefined ? "keyOf(address)" : "keyOfAgent(uint256)";
  const argument = recipient.agentId === undefined ? BigInt(recipient.address) : recipient.agentId;
  const ret = fromHex(await rpc(url, "eth_call", [
    { to: directory, data: `0x${artifact.methodIdentifiers[read]}${word(argument)}` }, "latest",
  ]));
  const onchainPub = `0x${toHex(ret.slice(0, 32))}`;
  const onchainEpoch = Number(BigInt(`0x${toHex(ret.slice(32, 64))}`));
  const updatedAt = Number(BigInt(`0x${toHex(ret.slice(64, 96))}`));
  if (onchainPub !== saved.publicKey.toLowerCase() || onchainEpoch !== saved.epoch)
    throw new Error(`${read} mismatch: ${onchainPub} epoch ${onchainEpoch}`);
  const result = { recipient: recipient.canonical, [read]: { pub: onchainPub, epoch: onchainEpoch, updatedAt } };

  if (args["drop-tx"]) {
    // 2. the Dropped log of the drop tx: emitted by the directory, topics (to, toAgent) naming exactly this recipient
    const chainId = Number(BigInt(await rpc(url, "eth_chainId", [])));
    const receipt = await rpc(url, "eth_getTransactionReceipt", [args["drop-tx"]]);
    if (!receipt || receipt.status !== "0x1") throw new Error("drop tx not found or failed");
    const to = recipient.agentId === undefined ? BigInt(recipient.address) : 0n;
    const toAgent = recipient.agentId ?? NO_AGENT;
    const log = receipt.logs.find((l) => l.address.toLowerCase() === directory && l.topics[0] === DROPPED_TOPIC
      && BigInt(l.topics[1]) === to && BigInt(l.topics[2]) === toAgent);
    if (!log) throw new Error(`no Dropped log for ${recipient.canonical} in the drop tx`);
    const bytes = decodeBytes(log.data);
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    if (envelope.chainId !== chainId || envelope.directory.toLowerCase() !== directory
      || envelope.recipient !== recipient.canonical)
      throw new Error("the dropped envelope names another chain, directory or recipient");

    // 3. open it with the re-derived key
    const keys = deriveKeyPair(fromHex(saved.prfStandIn), saved.epoch);
    if (`0x${toHex(keys.publicKey)}` !== saved.publicKey.toLowerCase()) throw new Error("stand-in does not derive the saved key");
    result.dropped = { block: Number(BigInt(receipt.blockNumber)), envelopeBytes: bytes.length, kid: envelope.kid };
    result.opened = new TextDecoder().decode(await open(envelope, keys));
  }
  console.log(JSON.stringify(result, null, 2));
}

const cmd = process.argv[2];
if (cmd === "prepare") await prepare();
else if (cmd === "verify") await verify();
else {
  console.error("usage: smoke.mjs prepare|verify ... (see header)");
  process.exit(2);
}
