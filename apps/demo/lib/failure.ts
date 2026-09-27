"use client";

// Every failure a page can meet, sorted into what the person sees: an ErrorSlip for an SDK code (lib/error-copy.ts), a
// form error beside the field for INPUT_INVALID, or a plain message for anything else. The SDK's own message is never
// shown as the explanation: the slips say what happened in the page's words, and quote only values the error carries.
//
// The pages also read the chain with viem directly (balances and fee caps for postage, a drop's gas, the register's
// block and log scans). A viem error from those reads is sorted the way the SDK sorts its own (toLetterlockError): a
// failed RPC is the CHAIN_UNAVAILABLE slip, with its "Try again", never viem's message, which names the RPC URL, the
// request body with the account's address, and viem's version.
import { isLetterlockError, toLetterlockError } from "letterlock";
import { BaseError, formatEther } from "viem";
import type { SlipCode, SlipValues } from "./error-copy.ts";

// The fields are declared, not constructor parameter properties, so the module loads in Node's type stripping (the
// unit tests) as well as in Next.js.

/** The gas drip refused, or could not be reached: what it answered, kept apart from the SDK's errors. */
export class DripRefused extends Error {
  readonly code: string;
  /** set when the drip broadcast a transfer: its hash, whether or not it has landed yet */
  readonly transactionHash: string | undefined;
  constructor(code: string, message: string, transactionHash?: string) {
    super(message);
    this.name = "DripRefused";
    this.code = code;
    this.transactionHash = transactionHash;
  }
}

/**
 * The passkey account cannot pay for the transaction: what it holds, what the transaction needs, and why the gas drip
 * did not pay (it pays for a first publish only). Thrown before any prompt when the page can tell in advance.
 */
export class PostageDue extends Error {
  readonly account: string;
  readonly balance: bigint;
  readonly needed: bigint;
  readonly drip: string | undefined;
  constructor(account: string, balance: bigint, needed: bigint, drip?: string) {
    super("postage due");
    this.name = "PostageDue";
    this.account = account;
    this.balance = balance;
    this.needed = needed;
    this.drip = drip;
  }
}

export type Failure =
  | { readonly kind: "slip"; readonly code: SlipCode; readonly values: SlipValues }
  | { readonly kind: "input"; readonly message: string }
  | { readonly kind: "message"; readonly title: string; readonly message: string };

/** What the page knew when the failure happened, for the slip to quote. */
export type FailureContext = { readonly account?: string; readonly balance?: bigint; readonly needed?: bigint };

const mon = (wei: bigint | undefined): string | undefined => {
  if (wei === undefined) return undefined;
  const s = formatEther(wei);
  // four significant decimals are enough to act on
  const [i, f = ""] = s.split(".");
  const cut = f.replace(/^(0*\d{0,4}).*$/, "$1").replace(/0+$/, "");
  return cut ? `${i}.${cut}` : i!;
};

const contextValues = (c: FailureContext = {}): SlipValues => ({
  ...(c.account ? { account: c.account } : {}),
  ...(c.balance !== undefined ? { balance: mon(c.balance) } : {}),
  ...(c.needed !== undefined ? { needed: mon(c.needed) } : {}),
});

/** The SDK's message without its "CODE: " prefix and the action it names (for a form error). */
const bare = (message: string): string => message.replace(/^[A-Z_]+: /, "");

/** True when a viem error is anywhere in `e`'s cause chain: a read or call the page made with viem itself. */
export const isChainClientError = (e: unknown): boolean => {
  for (let x: unknown = e, depth = 0; x !== null && typeof x === "object" && depth < 32; depth++) {
    if (x instanceof BaseError) return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * A viem error from the page's own chain reads, as the SDK's error for the same failure (a failed RPC is
 * CHAIN_UNAVAILABLE; a directory revert maps by its name), so it is shown the way the SDK's own reads are. `action`
 * names the read for a form error; a slip never shows it. Anything else is returned as it is.
 */
export const asChainError = (e: unknown, action: string): unknown => (!isLetterlockError(e) && isChainClientError(e) ? toLetterlockError(e, action) : e);

export const toFailure = (e: unknown, context?: FailureContext): Failure => {
  // a viem error that reached the page unwrapped: the reads in lib/gas.ts and lib/register.ts wrap theirs, this catches the rest
  if (!isLetterlockError(e) && isChainClientError(e)) return toFailure(toLetterlockError(e, "reading the chain"), context);
  if (e instanceof PostageDue)
    return {
      kind: "slip",
      code: "INSUFFICIENT_FUNDS",
      values: { ...contextValues({ account: e.account, balance: e.balance, needed: e.needed }), ...(e.drip ? { drip: e.drip } : {}) },
    };
  if (e instanceof DripRefused) {
    if (e.code === "CHAIN_UNAVAILABLE") return { kind: "slip", code: "CHAIN_UNAVAILABLE", values: {} };
    return { kind: "slip", code: "INSUFFICIENT_FUNDS", values: { ...contextValues(context), drip: e.message } };
  }
  if (isLetterlockError(e)) {
    if (e.code === "INPUT_INVALID") return { kind: "input", message: bare(e.message) };
    const values: SlipValues = { ...contextValues(context) };
    const m = e.message;
    if (e.code === "WRONG_KEY") {
      const k = /sealed to key ([0-9a-f]{16}), this passkey derives ([0-9a-f]{16})/.exec(m);
      if (k) Object.assign(values, { sealedTo: k[1], derived: k[2] });
    }
    if (e.code === "EPOCH_MISMATCH") {
      const k = /sealed to epoch (\d+), key is epoch (\d+)/.exec(m);
      if (k) Object.assign(values, { envelopeEpoch: Number(k[1]), keyEpoch: Number(k[2]) });
    }
    return { kind: "slip", code: e.code, values };
  }
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message))
    return { kind: "message", title: "No connection", message: "The page could not reach the network. Check your connection and try again." };
  const message = e instanceof Error ? e.message : String(e);
  return { kind: "message", title: "Something went wrong", message };
};
