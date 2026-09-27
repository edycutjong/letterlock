#!/usr/bin/env node
// A client for the agent that checks every answer against the chain instead of trusting it: the drop is read back
// with the SDK's inbox() (the recipient's own path) and must equal the envelope the agent returned; with --open-with
// it is opened with the recipient's key.
//
//   node scripts/call.ts remember --url URL --to 0x…|agent:<id> --text "…"  [--open-with FILE]
//   node scripts/call.ts task     --url URL --from 0x…|agent:<id> --text "…" [--open-with FILE] [--seal-to chain|health]
//
// task seals to the agent's key as `resolve("agent:<id>")` returns it (keyOfAgent), and checks that /health says the
// agent holds that key. --seal-to health seals to the key /health reports instead: only for Monad testnet, whose
// directory holds no agent keys (no ERC-8004 registry there).
//
// --open-with FILE: a key file as contracts/script/smoke.mjs writes it ({ prfStandIn, epoch, publicKey }), the
// stand-in of a DEMO or TEST KEY kept outside the repository. The file is read, never copied or printed.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  deriveAgentKeyPair,
  deriveKeyPair,
  fromHex,
  letterlock,
  open,
  seal,
  toHex,
  type EncryptionKeyPair,
  type Envelope,
  type LetterlockChain,
  type LetterlockClient,
  type Recipient,
} from "letterlock";
import { sha256 } from "@noble/hashes/sha2.js";
import { createPublicClient, http } from "viem";
import { encodeTask, newNonce, parseReply, quoteOf, type TaskReply } from "../src/task.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CHAINS: Readonly<Record<number, LetterlockChain>> = { 143: "monad", 10143: "monad-testnet" };

/** The key a smoke-test stand-in file opens, checked against the public key the file records. */
export const keyFromFile = (path: string): EncryptionKeyPair => {
  const k = JSON.parse(readFileSync(path, "utf8")) as { prfStandIn: string; epoch: number; publicKey: string; recipient?: string };
  const prf = fromHex(k.prfStandIn);
  for (const keys of [deriveKeyPair(prf, k.epoch), ...(k.recipient?.startsWith("agent:") ? [deriveAgentKeyPair(prf, BigInt(k.recipient.slice(6)), k.epoch)] : [])])
    if (`0x${toHex(keys.publicKey)}` === k.publicKey.toLowerCase()) return keys;
  throw new Error(`${path}: the stand-in does not derive the public key the file records`);
};

const request = async (url: string, init?: RequestInit): Promise<{ status: number; body: Json }> => {
  const res = await fetch(url, init);
  const body = (await res.json()) as Json;
  return { status: res.status, body };
};

export const post = (base: string, path: string, body: unknown) =>
  request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export type Session = { base: string; health: Json; chain: LetterlockChain; ll: LetterlockClient; rpcUrl: string | undefined };

/** /health, and a client for the chain and directory it names (which must be the SDK's built-in one). */
export const session = async (base: string, rpcUrl?: string): Promise<Session> => {
  const health = await request(`${base}/health`);
  const chain = CHAINS[health.body.chain?.chainId as number];
  if (!chain) throw new Error(`/health answered ${health.status} without a known chain: ${JSON.stringify(health.body)}`);
  const ll = letterlock({ chain, ...(rpcUrl ? { rpcUrl } : {}) });
  if (ll.directory !== health.body.chain.directory) throw new Error(`/health names directory ${health.body.chain.directory}; the SDK's ${chain} directory is ${ll.directory}`);
  return { base, health: health.body, chain, ll, rpcUrl };
};

/** The drop as the recipient finds it: inbox() over the drop's block. It must be exactly the envelope the agent returned. */
const readBack = async (s: Session, to: Recipient, answer: Json) => {
  const block = BigInt(answer.blockNumber as string);
  const box = await s.ll.inbox(to, { fromBlock: block, toBlock: block });
  const found = box.envelopes.find((e) => e.transactionHash === answer.dropTx);
  if (!found) throw new Error(`the drop ${answer.dropTx} is not in ${to}'s inbox at block ${block}`);
  const returned = (answer.envelope ?? answer.reply) as Envelope;
  if (JSON.stringify(found.envelope) !== JSON.stringify(returned)) throw new Error("the envelope onchain is not the one the agent returned");
  const pub = createPublicClient({ transport: http(s.rpcUrl ?? (s.chain === "monad" ? "https://rpc.monad.xyz" : "https://testnet-rpc.monad.xyz")) });
  const receipt = await pub.getTransactionReceipt({ hash: answer.dropTx as `0x${string}` });
  return { envelope: found.envelope, bytes: found.bytes, block: block.toString(), from: receipt.from, gasUsed: receipt.gasUsed.toString(), status: receipt.status };
};

export const remember = async (s: Session, o: { to: string; text: string; openWith?: string }) => {
  const r = await post(s.base, "/remember", { to: o.to, text: o.text });
  if (r.status !== 200) return { call: "remember", status: r.status, error: r.body.error };
  const onchain = await readBack(s, r.body.recipient as Recipient, r.body);
  const opened = o.openWith ? new TextDecoder().decode(await open(onchain.envelope, keyFromFile(o.openWith))) : undefined;
  return {
    call: "remember",
    status: r.status,
    dropTx: r.body.dropTx as string,
    explorer: r.body.explorer as string,
    recipient: r.body.recipient as string,
    kid: r.body.kid as string,
    epoch: r.body.epoch as number,
    onchain: { block: onchain.block, from: onchain.from, gasUsed: onchain.gasUsed, bytes: onchain.bytes, receipt: onchain.status, inInbox: true, sameEnvelope: true },
    ...(opened !== undefined ? { opened: { text: opened, matches: opened === o.text } } : {}),
  };
};

export const task = async (s: Session, o: { from: string; text: string; openWith?: string; sealTo?: "chain" | "health" }) => {
  const agent = s.health.agent.recipient as Recipient;
  const held = s.health.key?.held as { epoch: number; kid: string; publicKey: string } | null;
  if (!held) throw new Error("/health reports no key held by the agent");
  let to: { recipient: Recipient; publicKey: Uint8Array; epoch: number };
  if ((o.sealTo ?? "chain") === "chain") {
    const key = await s.ll.resolve(agent); // keyOfAgent: the key anyone would seal to
    if (`0x${toHex(key.publicKey)}` !== held.publicKey || key.epoch !== held.epoch)
      throw new Error(`${agent} resolves to ${key.kid} at epoch ${key.epoch}, and /health says the agent holds ${held.kid} at epoch ${held.epoch}`);
    to = key;
  } else {
    if (s.chain !== "monad-testnet") throw new Error("--seal-to health is for Monad testnet only; on mainnet seal to the key keyOfAgent returns");
    to = { recipient: agent, publicKey: fromHex(held.publicKey), epoch: held.epoch };
  }
  const t = { replyTo: o.from as Recipient, nonce: newNonce(), issuedAt: Math.floor(Date.now() / 1000), text: o.text };
  const envelope = await seal({ chainId: s.ll.chainId, directory: s.ll.directory, to, plaintext: encodeTask(t) });
  const r = await post(s.base, "/task", { from: o.from, envelope });
  if (r.status !== 200) return { call: "task", status: r.status, error: r.body.error, envelope, nonce: t.nonce };
  const onchain = await readBack(s, r.body.recipient as Recipient, r.body);
  let reply: TaskReply | undefined;
  if (o.openWith) reply = parseReply(await open(onchain.envelope, keyFromFile(o.openWith)));
  return {
    call: "task",
    status: r.status,
    sealedTo: { recipient: agent, epoch: envelope.epoch, kid: envelope.kid, via: (o.sealTo ?? "chain") === "chain" ? `resolve("${agent}") → keyOfAgent` : "/health (testnet: no agent keys onchain)" },
    dropTx: r.body.dropTx as string,
    explorer: r.body.explorer as string,
    recipient: r.body.recipient as string,
    kid: r.body.kid as string,
    epoch: r.body.epoch as number,
    onchain: { block: onchain.block, from: onchain.from, gasUsed: onchain.gasUsed, bytes: onchain.bytes, receipt: onchain.status, inInbox: true, sameEnvelope: true },
    ...(reply
      ? {
          opened: {
            reply,
            inReplyToMatches: reply.inReplyTo === t.nonce,
            // the answer names the whole task by its SHA-256, and quotes its first 80 characters (src/task.ts, quoteOf)
            sha256Matches: reply.task.sha256 === toHex(sha256(new TextEncoder().encode(o.text))) && reply.task.chars === Array.from(o.text).length,
            quotesTask: reply.text.includes(`“${quoteOf(o.text)}”`),
            sealedToMatches: reply.task.sealedTo.kid === envelope.kid,
          },
        }
      : {}),
    envelope,
    nonce: t.nonce,
  };
};

const arg = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  const base = (arg(args, "url") ?? "https://agent.letterlock.edycu.dev").replace(/\/+$/, "");
  const text = arg(args, "text");
  const openWith = arg(args, "open-with");
  if (!text) throw new Error("--text is required");
  const s = await session(base, arg(args, "rpc"));
  let out: unknown;
  if (command === "remember") out = await remember(s, { to: arg(args, "to") ?? "", text, ...(openWith ? { openWith } : {}) });
  else if (command === "task") {
    const sealTo = (arg(args, "seal-to") ?? "chain") as "chain" | "health";
    const full = await task(s, { from: arg(args, "from") ?? "", text, sealTo, ...(openWith ? { openWith } : {}) });
    const { envelope: _e, ...rest } = full as Json;
    out = rest;
  } else throw new Error('command must be "remember" or "task"');
  console.log(JSON.stringify(out, null, 2));
}
