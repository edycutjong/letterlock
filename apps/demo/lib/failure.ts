"use client";

// Every failure a page can meet, sorted into what the person sees: an ErrorSlip for an SDK code (lib/error-copy.ts), a
// form error beside the field for INPUT_INVALID, or a plain message for anything else. The SDK's own message is never
// shown as the explanation: the slips say what happened in the page's words, and quote only values the error carries.
import { isLetterlockError } from "letterlock";
import { formatEther } from "viem";
import type { SlipCode, SlipValues } from "./error-copy.ts";

/** The gas drip refused, or could not be reached: what it answered, kept apart from the SDK's errors. */
export class DripRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transactionHash?: string,
  ) {
    super(message);
    this.name = "DripRefused";
  }
}

/**
 * The passkey account cannot pay for the transaction: what it holds, what the transaction needs, and why the gas drip
 * did not pay (it pays for a first publish only). Thrown before any prompt when the page can tell in advance.
 */
export class PostageDue extends Error {
  constructor(
    readonly account: string,
    readonly balance: bigint,
    readonly needed: bigint,
    readonly drip?: string,
  ) {
    super("postage due");
    this.name = "PostageDue";
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

export const toFailure = (e: unknown, context?: FailureContext): Failure => {
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
