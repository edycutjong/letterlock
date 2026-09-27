// An address's published keys by epoch, from the directory's KeyPublished logs (scripts/seed.ts reads the key a
// persona held before its last rotation). docs/SPEC.md §8: a log is history, never the key to seal a NEW note to;
// the seed script seals to a previous epoch on purpose, to show that a note sealed before a rotation still opens.
import { NO_AGENT, letterlockAbi } from "letterlock";
import { hexToBytes, type Address, type Hex, type PublicClient } from "viem";

export type PublishedKey = { readonly epoch: number; readonly publicKey: Uint8Array; readonly block: bigint; readonly tx: Hex };

const KEY_PUBLISHED = letterlockAbi.find((e) => e.type === "event" && e.name === "KeyPublished")!;

const textOf = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 16; depth++) {
    const r = x as { message?: unknown; details?: unknown; cause?: unknown };
    if (typeof r.message === "string") parts.push(r.message);
    if (typeof r.details === "string") parts.push(r.details);
    x = r.cause;
  }
  return parts.join(" | ");
};
/** RPC wording for "this eth_getLogs range is too wide" (Monad's public mainnet RPC: "eth_getLogs is limited to a 100 range"). */
const RANGE_REFUSED = /limited to (?:a )?\d+ range|block range|range (?:is )?too (?:large|big|wide)|max(?:imum)? .*range|too many (?:logs|results)|more than \d+ (?:logs|results)/i;
/** The window the RPC names, else a tenth of the refused one. */
const narrower = (range: bigint, message: string): bigint => {
  const named = /limited to (?:a )?(\d+) range/i.exec(message) ?? /(\d+) block range/i.exec(message);
  const n = named ? BigInt(named[1]!) : range / 10n;
  return n >= 1n && n < range ? n : range / 10n;
};

/**
 * The KeyPublished logs of `who`'s own key (agentId = NO_AGENT) for each epoch in `epochs`, searched backwards from
 * the head to `fromBlock` in windows the RPC accepts, `concurrency` at a time once one window has been accepted, and
 * stopping once every epoch is found. An address publishes each epoch once (the directory takes only current + 1), so
 * each epoch has at most one log. A refused range narrows the window; any other failure is retried 3 times.
 */
export const keyPublishedLogs = async (
  rpc: PublicClient,
  directory: Address,
  who: Address,
  epochs: readonly number[],
  fromBlock: bigint,
  o: { concurrency?: number; onProgress?: (p: { block: bigint; requests: number }) => void } = {},
): Promise<Map<number, PublishedKey>> => {
  const found = new Map<number, PublishedKey>();
  const concurrency = o.concurrency ?? 6;
  let range = 10_000n;
  let hi = await rpc.getBlockNumber({ cacheTime: 0 });
  let requests = 0;
  let accepted = false;
  let failures = 0;
  let reported = 0;
  while (hi >= fromBlock && found.size < epochs.length) {
    const windows: (readonly [bigint, bigint])[] = [];
    for (let top = hi; windows.length < (accepted ? concurrency : 1) && top >= fromBlock; ) {
      const lo = top - range + 1n > fromBlock ? top - range + 1n : fromBlock;
      windows.push([lo, top]);
      top = lo - 1n;
    }
    requests += windows.length;
    const results = await Promise.allSettled(windows.map(([lo, top]) =>
      rpc.getLogs({ address: directory, event: KEY_PUBLISHED, args: { who, agentId: NO_AGENT }, fromBlock: lo, toBlock: top, strict: true })));
    let refused: unknown;
    for (const [i, r] of results.entries()) {
      if (r.status === "rejected") { refused = r.reason; break; }
      accepted = true;
      failures = 0;
      hi = windows[i]![0] - 1n; // everything from here up has been searched
      for (const log of r.value) {
        const epoch = Number(log.args.epoch);
        if (epochs.includes(epoch) && !found.has(epoch))
          found.set(epoch, { epoch, publicKey: hexToBytes(log.args.pub as Hex), block: log.blockNumber, tx: log.transactionHash });
      }
    }
    if (refused !== undefined) {
      const message = textOf(refused);
      if (RANGE_REFUSED.test(message) && range > 1n) range = narrower(range, message);
      else if (++failures > 3) throw refused;
      else await new Promise((res) => setTimeout(res, 500 * failures));
    }
    if (requests - reported >= 100) { reported = requests; o.onProgress?.({ block: hi, requests }); }
  }
  return found;
};
