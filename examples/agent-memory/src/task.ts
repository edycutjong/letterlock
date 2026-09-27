// What travels inside a task envelope, and the agent's answer.
//
// HPKE base mode is anonymous (docs/SPEC.md §6): the agent cannot know who sealed a task, and a copied envelope opens
// again. So the address to answer is sealed INSIDE the task, never taken from the request alone: someone who copies
// a task sealed to agent:10260 and posts it with their own `from` gets a refusal, not the answer. A nonce and a
// timestamp inside the seal let the agent refuse a replay (§6: "put a nonce and timestamp inside the plaintext and
// deduplicate on it"). Whatever parseTask finds wrong, the HTTP answer is one code, TASK_REFUSED (app.ts): a reason
// would tell whoever posts a copied task something about what is sealed in it. The TaskError codes below are for
// callers checking their own task (scripts/call.ts), and their messages repeat nothing from the seal either.
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalRecipient, type Recipient } from "letterlock";
import { charCount } from "./limits.ts";

/** A task, as UTF-8 JSON inside the envelope sealed to the agent. */
export type Task = {
  readonly v: 1;
  /** Where the answer is sealed and dropped: must equal the request's `from`. */
  readonly replyTo: Recipient;
  /** 16 random bytes, 32 lower-case hex digits: each server instance answers a nonce once (limits.ts, ReplayGuard). */
  readonly nonce: string;
  /** When the task was sealed, in seconds since the epoch. */
  readonly issuedAt: number;
  /** The task itself. */
  readonly text: string;
};

/** The agent's answer, as UTF-8 JSON inside the envelope sealed to `replyTo`. */
export type TaskReply = {
  readonly v: 1;
  /** The agent that answers, as a Letterlock recipient. */
  readonly from: Recipient;
  /** The task's nonce. */
  readonly inReplyTo: string;
  /** When the agent opened the task, in seconds since the epoch. */
  readonly openedAt: number;
  readonly task: {
    /** SHA-256 of the task's text (UTF-8), lower-case hex. */
    readonly sha256: string;
    readonly chars: number;
    /** The key the task was sealed to. */
    readonly sealedTo: { readonly recipient: Recipient; readonly epoch: number; readonly kid: string };
  };
  /**
   * A sentence for people: what the agent read, quoted in full when it is at most QUOTE_CHARS characters, else its
   * first QUOTE_CHARS and "…" (task.sha256 names the whole text). The quote is bounded so that no task, whatever its
   * characters, makes the answer cost more gas than the largest note /remember seals.
   */
  readonly text: string;
};

export class TaskError extends Error {
  readonly code: "TASK_INVALID" | "TASK_STALE" | "TASK_TOO_LONG";

  constructor(code: TaskError["code"], message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

const NONCE = /^[0-9a-f]{32}$/;

/** The task inside an opened envelope, checked: shape, reply address, nonce, age, and length. */
export const parseTask = (plaintext: Uint8Array, o: { nowSec: number; maxAgeSec: number; maxSkewSec: number; textMaxChars: number }): Task => {
  let o1: unknown;
  try {
    o1 = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new TaskError("TASK_INVALID", "the sealed task is not UTF-8 JSON");
  }
  if (typeof o1 !== "object" || o1 === null || Array.isArray(o1)) throw new TaskError("TASK_INVALID", "the sealed task is not a JSON object");
  const t = o1 as Record<string, unknown>;
  if (t.v !== 1) throw new TaskError("TASK_INVALID", 'the sealed task must have "v": 1');
  let replyTo: Recipient;
  try {
    if (typeof t.replyTo !== "string") throw new TypeError("not a string");
    replyTo = canonicalRecipient(t.replyTo);
  } catch {
    throw new TaskError("TASK_INVALID", 'the sealed task\'s "replyTo" must be 0x<40 hex> or agent:<id>');
  }
  if (typeof t.nonce !== "string" || !NONCE.test(t.nonce))
    throw new TaskError("TASK_INVALID", 'the sealed task\'s "nonce" must be 32 lower-case hex digits (16 random bytes)');
  if (typeof t.issuedAt !== "number" || !Number.isSafeInteger(t.issuedAt))
    throw new TaskError("TASK_INVALID", 'the sealed task\'s "issuedAt" must be whole seconds since the epoch');
  if (t.issuedAt < o.nowSec - o.maxAgeSec || t.issuedAt > o.nowSec + o.maxSkewSec)
    throw new TaskError("TASK_STALE", `the task was not sealed within the last ${o.maxAgeSec} s`);
  if (typeof t.text !== "string" || !t.text.isWellFormed() || t.text.trim() === "")
    throw new TaskError("TASK_INVALID", 'the sealed task\'s "text" must be a non-empty string');
  if (charCount(t.text) > o.textMaxChars) throw new TaskError("TASK_TOO_LONG", `the task's text is over ${o.textMaxChars} characters`);
  return { v: 1, replyTo, nonce: t.nonce, issuedAt: t.issuedAt, text: t.text };
};

/** A task's plaintext, fields in a fixed order: what a caller seals to the agent. */
export const encodeTask = (t: Omit<Task, "v">): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ v: 1, replyTo: canonicalRecipient(t.replyTo), nonce: t.nonce, issuedAt: t.issuedAt, text: t.text }));

/** A fresh nonce for a task. */
export const newNonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** How much of a task the answer quotes. */
export const QUOTE_CHARS = 80;

/**
 * The quote: the first QUOTE_CHARS characters, with control characters and line or paragraph separators as spaces
 * (JSON writes a control character as a 6-byte escape), and "…" when the text is longer. At most QUOTE_CHARS × 4 + 3
 * bytes of JSON, whatever the task holds.
 */
export const quoteOf = (text: string): string => {
  const chars = Array.from(text);
  const head = chars.slice(0, QUOTE_CHARS).join("").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
  return chars.length > QUOTE_CHARS ? `${head}…` : head;
};

export const buildReply = (o: {
  agent: Recipient;
  task: Task;
  sealedTo: { recipient: Recipient; epoch: number; kid: string };
  openedAt: number;
}): TaskReply => {
  const digest = hex(sha256(new TextEncoder().encode(o.task.text)));
  const chars = charCount(o.task.text);
  const wrote = chars > QUOTE_CHARS
    ? `You wrote ${chars} characters, SHA-256 ${digest}, beginning “${quoteOf(o.task.text)}”`
    : `You wrote (${chars} characters): “${quoteOf(o.task.text)}”`;
  return {
    v: 1,
    from: o.agent,
    inReplyTo: o.task.nonce,
    openedAt: o.openedAt,
    task: { sha256: digest, chars, sealedTo: o.sealedTo },
    text:
      `I opened your task, sealed to ${o.sealedTo.recipient} at epoch ${o.sealedTo.epoch} (key ${o.sealedTo.kid}), ` +
      `at ${new Date(o.openedAt * 1000).toISOString()}. ${wrote} ` +
      `This answer is sealed to ${o.task.replyTo}'s published key; once it is sent, I cannot open it either.`,
  };
};

export const encodeReply = (r: TaskReply): Uint8Array => new TextEncoder().encode(JSON.stringify(r));

export const parseReply = (plaintext: Uint8Array): TaskReply => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as TaskReply;
