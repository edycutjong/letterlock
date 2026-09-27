// What the agent's wallet signs, decided on the transaction itself at the moment it is signed.
//
// The wallet pays for drops and nothing else, and anyone may ask for a drop. The checks app.ts makes when a request
// arrives only refuse early: concurrent requests all read the same balance and the same count, and each server
// instance counts only its own requests. The checks that bound what the wallet spends are made here, on the
// transaction viem hands the signer — its gas limit, its fee cap and its nonce are final — inside the instance's
// one-at-a-time send queue (chain.ts), after the previous drop's receipt:
//
//   - it is a drop: to the directory, the drop() selector, no value;
//   - its gas limit is at most maxDropGas;
//   - the balance minus gas × maxFeePerGas, the most this transaction can cost (and what Monad requires its sender to
//     hold), stays at or above the reserve;
//   - its nonce says fewer transactions went out today (UTC) than the day's allowance. The nonce is the chain's own
//     count, so two instances cannot both use the last one: the chain accepts one transaction per nonce, and the
//     other instance's is signed again with the next nonce (chain.ts, oneAtATime) and checked again.
//
// The day's allowance is min(dailyDrops, dailySpendPercent of what the wallet held at 00:00 UTC, divided by perDrop,
// the most a drop costs: maxDropGas at the price it pays, the base fee plus its priority fee). What it held at 00:00
// is at most balance + used × perDrop, since every drop today cost at most perDrop; MON sent to the wallet during the
// day counts as held, so a refill raises the allowance at once. The fee cap does not enter it: on Monad mainnet viem
// signs a fee cap of 182.4 gwei (the node's eth_fillTransaction answer, 152, × 1.2) while a drop pays 102.
import { letterlockAbi } from "letterlock";
import { formatEther, getAbiItem, toFunctionSelector, type Address, type Hex, type TransactionSerializable } from "viem";
import { toAccount, type LocalAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Limits } from "./config.ts";

export type SpendLimits = Pick<Limits, "maxDropGas" | "minBalanceWei" | "dailyDrops" | "dailySpendPercent">;

export type SpendCode = "DROP_TOO_COSTLY" | "DAILY_CAP" | "GAS_RESERVE" | "NOT_A_DROP" | "COUNT_UNAVAILABLE";

/** The wallet refused to sign: nothing was signed, so nothing was sent. */
export class SpendRefused extends Error {
  readonly code: SpendCode;
  /** DAILY_CAP: when the count starts over, in ms since the epoch (the next 00:00 UTC). */
  readonly resetsAt: number | undefined;

  constructor(code: SpendCode, message: string, o: { resetsAt?: number; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "SpendRefused";
    this.code = code;
    this.resetsAt = o.resetsAt;
  }
}

/** The SpendRefused in an error's cause chain: viem and the SDK wrap what the signer throws, and keep it as a cause. */
export const spendRefusalIn = (e: unknown): SpendRefused | undefined => {
  let x: unknown = e;
  for (let depth = 0; x !== undefined && x !== null && depth < 32; depth++) {
    if (x instanceof SpendRefused) return x;
    x = typeof x === "object" && "cause" in x ? (x as { cause?: unknown }).cause : undefined;
  }
  return undefined;
};

/**
 * Drops the wallet may send in a UTC day in which `used` went out already and it holds `balance` now: at most
 * dailyDrops, and at most as many as dailySpendPercent of what it held at 00:00 UTC pays for at the most one drop can
 * cost, maxDropGas × `gasPrice` (what a drop pays per gas: the base fee plus the priority fee).
 */
export const dropsAllowedToday = (l: SpendLimits, o: { balance: bigint; used: number; gasPrice: bigint }): number => {
  const perDrop = l.maxDropGas * o.gasPrice;
  if (perDrop <= 0n) return l.dailyDrops;
  const held = o.balance + BigInt(Math.max(0, o.used)) * perDrop;
  const byWallet = (held * BigInt(l.dailySpendPercent)) / (100n * perDrop);
  return byWallet < BigInt(l.dailyDrops) ? Number(byWallet) : l.dailyDrops;
};

/**
 * What the signer reads when it is asked to sign: the balance and the base fee now, and the wallet's nonce before
 * today's first block.
 */
export type SpendState = { readonly balance: bigint; readonly baseFeePerGas: bigint; readonly dayStartNonce: number; readonly resetsAt: number };

/** The parts of a prepared transaction that decide what it can cost. */
export type DropCost = { readonly gas: bigint; readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint; readonly nonce: number };

/** What a transaction pays per gas (EIP-1559): the base fee plus its priority fee, and never more than its fee cap. */
export const paidPerGas = (tx: Pick<DropCost, "maxFeePerGas" | "maxPriorityFeePerGas">, baseFeePerGas: bigint): bigint => {
  const paid = baseFeePerGas + tx.maxPriorityFeePerGas;
  return paid < tx.maxFeePerGas ? paid : tx.maxFeePerGas;
};

/** Why the wallet must not sign this drop, or undefined. The messages never repeat a request's content. */
export const refusal = (l: SpendLimits, tx: DropCost, s: SpendState): SpendRefused | undefined => {
  if (tx.gas > l.maxDropGas)
    return new SpendRefused("DROP_TOO_COSTLY", `this drop needs ${tx.gas} gas; the agent signs no drop above ${l.maxDropGas}`);
  const cost = tx.gas * tx.maxFeePerGas;
  if (s.balance - cost < l.minBalanceWei)
    return new SpendRefused("GAS_RESERVE", `this drop can cost up to ${formatEther(cost)} MON; the wallet holds ${formatEther(s.balance)} MON and keeps ${formatEther(l.minBalanceWei)} MON`);
  const used = Math.max(0, tx.nonce - s.dayStartNonce);
  const allowed = dropsAllowedToday(l, { balance: s.balance, used, gasPrice: paidPerGas(tx, s.baseFeePerGas) });
  if (used >= allowed)
    return new SpendRefused("DAILY_CAP",
      `the agent has sent ${used} of the ${allowed} drops it allows itself today (UTC; at most ${l.dailyDrops}, and at most ${l.dailySpendPercent}% of its wallet at the most a drop can cost); it sends again from ${new Date(s.resetsAt).toISOString()}`,
      { resetsAt: s.resetsAt });
  return undefined;
};

export const DROP_SELECTOR: Hex = toFunctionSelector(getAbiItem({ abi: letterlockAbi, name: "drop" }));

/**
 * The wallet as a viem account that signs one kind of transaction, a drop on `directory`, and only when refusal()
 * finds no reason not to, on the state `state()` reads at that moment. Messages and typed data are never signed.
 */
export const guardedWallet = (account: PrivateKeyAccount, o: { directory: Address; limits: SpendLimits; state: () => Promise<SpendState> }): LocalAccount =>
  toAccount({
    address: account.address,
    async signMessage() {
      throw new SpendRefused("NOT_A_DROP", "the agent's wallet signs drops only, not messages");
    },
    async signTypedData() {
      throw new SpendRefused("NOT_A_DROP", "the agent's wallet signs drops only, not typed data");
    },
    async signTransaction(transaction, options) {
      const tx = transaction as TransactionSerializable;
      if (tx.to?.toLowerCase() !== o.directory.toLowerCase() || !(tx.data ?? "0x").toLowerCase().startsWith(DROP_SELECTOR) || (tx.value ?? 0n) !== 0n)
        throw new SpendRefused("NOT_A_DROP", "the agent's wallet signs one kind of transaction: drop() on its directory, with no value");
      const fee = tx.maxFeePerGas ?? tx.gasPrice;
      const tip = tx.maxPriorityFeePerGas ?? tx.gasPrice;
      if (tx.gas === undefined || fee === undefined || tip === undefined || tx.nonce === undefined)
        throw new SpendRefused("NOT_A_DROP", "the transaction to sign carries no gas limit, fee or nonce");
      const why = refusal(o.limits, { gas: tx.gas, maxFeePerGas: fee, maxPriorityFeePerGas: tip, nonce: tx.nonce }, await o.state());
      if (why) throw why;
      return account.signTransaction(transaction, options);
    },
  });
