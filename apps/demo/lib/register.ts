"use client";

// The register: every KeyPublished event of the directory, read from the chain by the page itself (no server, no
// index). A KeyPublished log is history, not liveness (docs/SPEC.md §8): the page seals only to what a keyOf read
// returns, and uses these lines to show where and when each key was posted.
import { NO_AGENT, fingerprint, fromHex, letterlockAbi } from "letterlock";
import type { Address, Hex, PublicClient } from "viem";
import { DEPLOYMENT, SCAN_RANGE } from "./chain.ts";
import { publicClient, scanPublicClient } from "./client.ts";

export type KeyLine = {
  /** transaction hash and log index: unique */
  readonly id: string;
  readonly recipient: `0x${string}` | `agent:${string}`;
  /** msg.sender of the publish: the address itself, or the agent's owner */
  readonly publisher: Address;
  readonly publicKey: Hex;
  readonly fingerprint: string;
  readonly epoch: number;
  readonly block: number;
  readonly txHash: Hex;
  readonly logIndex: number;
  /** block timestamp, in seconds */
  readonly at?: number;
};

const KEY_PUBLISHED = letterlockAbi.find((e) => e.type === "event" && e.name === "KeyPublished")!;

/** RPC wording for "this eth_getLogs range is too wide" (Monad's public RPCs). */
const RANGE_REFUSED = /range|limit|too large|too many|exceed/i;
const messageOf = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 12; i++) {
    const r = x as { message?: unknown; details?: unknown; cause?: unknown };
    if (typeof r.message === "string") parts.push(r.message);
    if (typeof r.details === "string") parts.push(r.details);
    x = r.cause;
  }
  return parts.join(" | ");
};
const narrowed = (range: number, message: string): number => {
  const named = /limited to (?:a )?(\d+) range/i.exec(message) ?? /(\d+) block/i.exec(message);
  const n = named ? Number(named[1]) : 0;
  return n >= 1 && n < range ? n : Math.max(1, Math.floor(range / 10));
};

type Args = { who?: Address; agentId?: bigint };

/**
 * KeyPublished logs from `fromBlock` to `toBlock`, oldest first, in pages the RPC accepts: the whole range at once on
 * mainnet's scan RPC, 100 blocks at a time on testnet (4 requests in flight).
 */
export const readKeyLines = async (
  o: { fromBlock: bigint; toBlock: bigint; args?: Args; client?: PublicClient; onProgress?: (done: bigint, total: bigint) => void },
): Promise<KeyLine[]> => {
  const client = o.client ?? scanPublicClient();
  let range = SCAN_RANGE;
  const total = o.toBlock >= o.fromBlock ? o.toBlock - o.fromBlock + 1n : 0n;
  const pending: [bigint, bigint][] = [];
  let next = o.fromBlock;
  let done = 0n;
  const out: KeyLine[] = [];
  let accepted = false;
  while (pending.length > 0 || next <= o.toBlock) {
    const batch: [bigint, bigint][] = [];
    while (batch.length < (accepted ? 4 : 1) && (pending.length > 0 || next <= o.toBlock)) {
      if (pending.length) { batch.push(pending.shift()!); continue; }
      const hi = next + BigInt(range) - 1n < o.toBlock ? next + BigInt(range) - 1n : o.toBlock;
      batch.push([next, hi]);
      next = hi + 1n;
    }
    const results = await Promise.allSettled(
      batch.map(([lo, hi]) =>
        client.getLogs({ address: DEPLOYMENT.directory, event: KEY_PUBLISHED, args: o.args, fromBlock: lo, toBlock: hi, strict: true }),
      ),
    );
    for (const [i, r] of results.entries()) {
      const [lo, hi] = batch[i]!;
      if (r.status === "fulfilled") {
        accepted = true;
        done += hi - lo + 1n;
        for (const log of r.value) out.push(toLine(log as unknown as RawLog));
        continue;
      }
      const m = messageOf(r.reason);
      if (RANGE_REFUSED.test(m) && hi > lo) {
        range = Math.min(range, narrowed(Number(hi - lo + 1n), m));
        for (let a = lo; a <= hi; a += BigInt(range)) pending.push([a, a + BigInt(range) - 1n < hi ? a + BigInt(range) - 1n : hi]);
        continue;
      }
      throw r.reason;
    }
    o.onProgress?.(done, total);
  }
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
};

type RawLog = {
  args: { who: Address; agentId: bigint; pub: Hex; epoch: number };
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  blockTimestamp?: bigint | null;
};

const toLine = (log: RawLog): KeyLine => {
  const { who, agentId, pub, epoch } = log.args;
  return {
    id: `${log.transactionHash}:${log.logIndex}`,
    recipient: agentId === NO_AGENT ? (who.toLowerCase() as `0x${string}`) : `agent:${agentId}`,
    publisher: who,
    publicKey: pub,
    fingerprint: fingerprint(fromHex(pub)),
    epoch: Number(epoch),
    block: Number(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    ...(log.blockTimestamp !== undefined && log.blockTimestamp !== null ? { at: Number(log.blockTimestamp) } : {}),
  };
};

/**
 * The first block whose timestamp is `ts` or later, by binary search over block headers (about 17 reads from the deploy
 * block to the head). Used on testnet, where no RPC scans the whole chain at once.
 */
export const firstBlockAt = async (ts: number, client: PublicClient = publicClient()): Promise<bigint> => {
  let lo = BigInt(DEPLOYMENT.deployBlock);
  let hi = await client.getBlockNumber({ cacheTime: 0 });
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await client.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
};

/**
 * The transaction that posted `address`'s key at `epoch` (its KeyPublished log), or undefined if no scan finds it.
 * `updatedAt` (the keyOf read's timestamp) narrows the search on testnet to the blocks of that second.
 */
export const findPublish = async (address: Address, epoch: number, updatedAt: number): Promise<KeyLine | undefined> => {
  const match = (lines: KeyLine[]) =>
    lines.filter((l) => l.recipient === address.toLowerCase() && l.epoch === epoch).at(-1);
  const head = await scanPublicClient().getBlockNumber({ cacheTime: 0 });
  if (SCAN_RANGE >= 1_000_000) return match(await readKeyLines({ fromBlock: BigInt(DEPLOYMENT.deployBlock), toBlock: head, args: { who: address } }));
  const from = await firstBlockAt(updatedAt);
  const to = from + 99n < head ? from + 99n : head;
  return match(await readKeyLines({ fromBlock: from, toBlock: to, args: { who: address } }));
};
