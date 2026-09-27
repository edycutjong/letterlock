// Everything the agent reads from or sends to Monad: the SDK's client for resolve and drop, and a viem client for the
// wallet's balance, nonce and fees. Drops from one instance are sent one at a time, so two requests never race for a
// nonce, and each is signed by the guarded wallet (spend.ts): the transaction itself is checked against the gas cap,
// the day's allowance and the reserve at the moment it is signed.
import { DEPLOYMENTS, letterlock, type DropResult, type Envelope, type LetterlockClient, type ResolvedKey } from "letterlock";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { AgentConfig } from "./config.ts";
import { SpendRefused, guardedWallet, type SpendState } from "./spend.ts";

export type DropsToday = {
  /** Transactions the wallet sent since 00:00 UTC: every one is a drop, since the wallet is used for nothing else. */
  readonly used: number;
  /** When the count starts over (ms since the epoch): the next 00:00 UTC. */
  readonly resetsAt: number;
  /** "chain": nonce now minus nonce at the day's first block. "instance": this instance's own count (the RPC refused a historical read). */
  readonly source: "chain" | "instance";
};

export type AgentChain = {
  readonly chainId: number;
  readonly network: string;
  readonly directory: Address;
  readonly explorer: string;
  readonly ll: LetterlockClient;
  resolve(to: string): Promise<ResolvedKey>;
  /**
   * drop() from `account`, one at a time per instance, signed only if spend.ts finds no reason not to (it throws
   * SpendRefused, inside the SDK's error, and nothing is sent); resent (fresh nonce) when another sender took the nonce.
   */
  drop(account: PrivateKeyAccount, envelope: Envelope): Promise<DropResult>;
  balance(address: Address): Promise<bigint>;
  nonce(address: Address): Promise<number>;
  dropsToday(address: Address, nowMs: number): Promise<DropsToday>;
  /** What a drop sent now pays per gas (eth_gasPrice: the base fee plus the priority fee), reused for 5 s. */
  gasPrice(): Promise<bigint>;
};

const DAY_MS = 86_400_000;

/** Messages meaning the transaction was not accepted because its nonce was taken: safe to resend with a new one. */
const NONCE_TAKEN = /nonce too low|nonce (has )?already (been )?used|replacement transaction underpriced/i;

const messages = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 16; depth++) {
    const m = (x as { message?: unknown }).message;
    if (typeof m === "string") parts.push(m);
    x = (x as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
};

/**
 * `send`, one call at a time (a call starts when the previous one has settled), and sent again, at most twice, when
 * the node says another transaction took its nonce: then nothing of this call was accepted, and a new send reads a
 * fresh nonce (and the guarded wallet checks the new transaction again). Any other failure is thrown as it is, and
 * does not hold up the calls queued behind it.
 */
export const oneAtATime = <A extends unknown[], T>(send: (...args: A) => Promise<T>): ((...args: A) => Promise<T>) => {
  let queue: Promise<unknown> = Promise.resolve();
  const attempt = async (args: A): Promise<T> => {
    for (let tries = 1; ; tries++) {
      try {
        return await send(...args);
      } catch (e) {
        if (tries < 3 && NONCE_TAKEN.test(messages(e))) continue;
        throw e;
      }
    }
  };
  return (...args: A) => {
    const run = queue.then(() => attempt(args), () => attempt(args));
    queue = run.catch(() => undefined);
    return run;
  };
};

/**
 * The first block whose timestamp is at or after `ts` (seconds): gallop back from the head to bracket it, then
 * alternate interpolation and bisection. About a dozen reads for a day on Monad (~0.3 s blocks).
 */
export const firstBlockAtOrAfter = async (pub: Pick<PublicClient, "getBlock">, ts: bigint): Promise<bigint> => {
  const at = async (n: bigint) => (await pub.getBlock({ blockNumber: n })).timestamp;
  const head = await pub.getBlock({ blockTag: "latest" });
  if (head.timestamp < ts) return head.number + 1n;
  let hi = head.number;
  let hiTs = head.timestamp;
  let lo = hi;
  let loTs = hiTs;
  for (let span = 4096n; ; span *= 8n) {
    lo = hi > span ? hi - span : 0n;
    loTs = await at(lo);
    if (loTs < ts) break;
    if (lo === 0n) return 0n; // the chain's first block is already at or after ts
    hi = lo;
    hiTs = loTs;
  }
  // ts(lo) < ts <= ts(hi)
  for (let step = 0; hi - lo > 1n; step++) {
    let mid = (lo + hi) / 2n;
    if (step % 2 === 0 && hiTs > loTs) {
      mid = lo + ((ts - loTs) * (hi - lo)) / (hiTs - loTs);
      if (mid <= lo) mid = lo + 1n;
      if (mid >= hi) mid = hi - 1n;
    }
    const t = await at(mid);
    if (t >= ts) { hi = mid; hiTs = t; } else { lo = mid; loTs = t; }
  }
  return hi;
};

export const agentChain = (
  config: Pick<AgentConfig, "chain" | "rpcUrl" | "directory" | "deployBlock" | "limits"> & { pollingInterval?: number },
): AgentChain => {
  const deployment = DEPLOYMENTS[config.chain];
  const rpcUrl = config.rpcUrl ?? deployment.rpcUrl;
  const ll = letterlock({
    chain: config.chain,
    rpcUrl,
    ...(config.directory ? { directory: config.directory } : {}),
    ...(config.deployBlock !== undefined ? { deployBlock: config.deployBlock } : {}),
    ...(config.pollingInterval !== undefined ? { pollingInterval: config.pollingInterval } : {}),
  });
  const pub = createPublicClient({ transport: http(rpcUrl) });

  // The day's baseline, per wallet: its nonce before the day's first block. Read once per day per instance.
  const days = new Map<Address, { start: number; nonceBefore: number }>();
  const dayStart = async (address: Address, nowMs: number) => {
    const start = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const known = days.get(address);
    if (known?.start === start) return known;
    const first = await firstBlockAtOrAfter(pub, BigInt(start / 1000));
    const day = { start, nonceBefore: first === 0n ? 0 : await pub.getTransactionCount({ address, blockNumber: first - 1n }) };
    days.set(address, day);
    return day;
  };
  // This instance's own drops today: the count when the RPC refuses the historical read.
  let own = { start: 0, count: 0 };

  /** What the guarded wallet reads when asked to sign. Without it the wallet signs nothing: it cannot count. */
  const spendState = (address: Address) => async (): Promise<SpendState> => {
    const nowMs = Date.now();
    try {
      const [balance, block, day] = await Promise.all([pub.getBalance({ address }), pub.getBlock({ blockTag: "latest" }), dayStart(address, nowMs)]);
      return { balance, baseFeePerGas: block.baseFeePerGas ?? 0n, dayStartNonce: day.nonceBefore, resetsAt: day.start + DAY_MS };
    } catch (e) {
      throw new SpendRefused("COUNT_UNAVAILABLE", "the RPC did not answer the wallet's balance, the base fee or the wallet's nonce at 00:00 UTC, so the agent cannot count today's spend; nothing was signed", { cause: e });
    }
  };

  const nonce = (address: Address) => pub.getTransactionCount({ address, blockTag: "pending" });
  const drop = oneAtATime(async (account: PrivateKeyAccount, envelope: Envelope) => {
    const signer = guardedWallet(account, { directory: ll.directory, limits: config.limits, state: spendState(account.address) });
    const result = await ll.drop({ account: signer, envelope });
    const start = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    own = own.start === start ? { start, count: own.count + 1 } : { start, count: 1 };
    return result;
  });

  let price: { at: number; value: Promise<bigint> } | undefined;
  const gasPrice = (): Promise<bigint> => {
    const t = Date.now();
    if (!price || t - price.at >= 5000) {
      const value = pub.getGasPrice();
      value.catch(() => { if (price?.value === value) price = undefined; });
      price = { at: t, value };
    }
    return price.value;
  };

  return {
    chainId: deployment.chainId,
    network: deployment.network,
    directory: ll.directory,
    explorer: deployment.explorer,
    ll,
    resolve: (to) => ll.resolve(to),
    drop,
    balance: (address) => pub.getBalance({ address }),
    nonce,
    gasPrice,
    async dropsToday(address, nowMs) {
      const start = Math.floor(nowMs / DAY_MS) * DAY_MS;
      const resetsAt = start + DAY_MS;
      try {
        const day = await dayStart(address, nowMs);
        return { used: Math.max(0, (await nonce(address)) - day.nonceBefore), resetsAt, source: "chain" };
      } catch {
        return { used: own.start === start ? own.count : 0, resetsAt, source: "instance" };
      }
    },
  };
};
