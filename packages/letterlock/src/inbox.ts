import { hexToBytes, type Hex, type PublicClient } from "viem";
import { letterlockAbi } from "./abi.ts";
import { toLetterlockError } from "./chain-errors.ts";
import { NO_AGENT } from "./deployments.ts";
import { canonicalRecipient, decodeEnvelope, type Envelope, type Recipient } from "./envelope.ts";
import { LetterlockError, isLetterlockError } from "./errors.ts";

export type InboxOptions = {
  /** First block to scan (inclusive). Default: the directory's deploy block. */
  readonly fromBlock?: bigint | number;
  /** Last block to scan (inclusive). Default, and upper bound: the chain head when the scan starts. */
  readonly toBlock?: bigint | number;
  /**
   * Blocks per eth_getLogs request to start with (default 10,000). When the RPC refuses the range, the scan
   * retries the same window with the limit the error names ("limited to a 100 range" → 100), or a tenth of the
   * range, down to 1 block.
   */
  readonly blockRange?: number;
  /** Requests in flight at once, after the first page has been accepted (default 4). */
  readonly concurrency?: number;
  /** Called after each round of requests with the number of blocks scanned so far. */
  readonly onProgress?: (p: { readonly scannedBlocks: bigint; readonly totalBlocks: bigint }) => void;
};

/** A Dropped envelope addressed to this recipient in this directory. It may still fail to open. */
export type InboxEnvelope = {
  readonly envelope: Envelope;
  /** Size of the dropped JSON, in bytes. */
  readonly bytes: number;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
};

/** A Dropped log for this recipient whose bytes are not an envelope for it (anyone can drop anything). */
export type RejectedDrop = {
  readonly reason: string;
  readonly bytes: number;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
};

export type InboxResult = {
  readonly recipient: Recipient;
  readonly envelopes: InboxEnvelope[];
  readonly rejected: RejectedDrop[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** eth_getLogs requests made, refused ones included. */
  readonly requests: number;
  /** The block range the last request used. */
  readonly blockRange: number;
};

const DROPPED = letterlockAbi.find((e) => e.type === "event" && e.name === "Dropped")!;

/** RPC wording for "this eth_getLogs range is too wide" (Monad's public RPCs: -32614, -32602, -32062). */
const RANGE_REFUSED = /block range|range limit|limited to (a )?\d+ range|range (is )?too (large|big|wide)|exceed(s|ed)? .*range|max(imum)? .*range|too many (logs|results)|more than \d+ (logs|results)|returned more than/i;
const HEAD_BEHIND = /beyond (the )?current head|block .* (is )?(not found|in the future|after (the )?latest)/i;

const messageOf = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 16; depth++) {
    const r = x as { message?: unknown; details?: unknown; cause?: unknown };
    if (typeof r.message === "string") parts.push(r.message);
    if (typeof r.details === "string") parts.push(r.details);
    x = r.cause;
  }
  return parts.join(" | ");
};

/** The next range to try after a refusal: the limit the RPC named, else a tenth. */
export const narrowRange = (range: number, message: string): number => {
  const named = /limited to (?:a )?(\d+) range/i.exec(message) ?? /(?:max(?:imum)?|up to|at most|limit(?:ed)? (?:of|to)) (\d+) blocks?/i.exec(message) ?? /(\d+) block range/i.exec(message);
  const n = named ? Number(named[1]) : 0;
  return n >= 1 && n < range ? n : Math.max(1, Math.floor(range / 10));
};

export const readInbox = async (
  client: PublicClient,
  ctx: {
    readonly chainId: number;
    readonly directory: `0x${string}`;
    readonly deployBlock?: bigint;
    /** The client's one-time checks (chain, directory): run after the options are validated, before the scan. */
    readonly ready?: () => Promise<void>;
  },
  to: string,
  o: InboxOptions = {},
): Promise<InboxResult> => {
  const recipient = canonicalRecipient(to);
  const agentId = recipient.startsWith("agent:") ? BigInt(recipient.slice(6)) : undefined;
  if (agentId !== undefined && agentId >= NO_AGENT) throw new LetterlockError("INPUT_INVALID", `agent id must be below 2^256 - 1, got ${recipient}`);
  const start = o.fromBlock ?? ctx.deployBlock;
  if (start === undefined)
    throw new LetterlockError("INPUT_INVALID", "inbox() needs fromBlock for a directory whose deploy block the client does not know (pass deployBlock to letterlock())");
  const fromBlock = BigInt(start);
  let range = o.blockRange ?? 10_000;
  if (!Number.isSafeInteger(range) || range < 1) throw new LetterlockError("INPUT_INVALID", `blockRange must be a positive integer, got ${range}`);
  if (fromBlock < 0n) throw new LetterlockError("INPUT_INVALID", "fromBlock must not be negative");
  const concurrency = o.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new LetterlockError("INPUT_INVALID", `concurrency must be a positive integer, got ${concurrency}`);
  await ctx.ready?.();

  let requests = 0;
  const call = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) { throw toLetterlockError(e, what); }
  };
  const head = await call("inbox: eth_blockNumber", () => client.getBlockNumber({ cacheTime: 0 }));
  const toBlock = o.toBlock === undefined ? head : BigInt(o.toBlock) < head ? BigInt(o.toBlock) : head;

  const args = agentId === undefined
    ? { to: recipient as `0x${string}`, toAgent: NO_AGENT }
    : { to: "0x0000000000000000000000000000000000000000" as const, toAgent: agentId };
  const envelopes: InboxEnvelope[] = [];
  const rejected: RejectedDrop[] = [];

  type Window = readonly [bigint, bigint];
  type DroppedLog = Awaited<ReturnType<typeof getPage>>[number];
  const getPage = ([lo, hi]: Window) =>
    client.getLogs({ address: ctx.directory, event: DROPPED, args, fromBlock: lo, toBlock: hi, strict: true });

  const logs: DroppedLog[] = [];
  const retry: Window[] = [];
  let next = fromBlock;
  let accepted = false; // until one page is accepted, probe one request at a time
  let behind = 0;
  let scanned = 0n;
  const totalBlocks = toBlock >= fromBlock ? toBlock - fromBlock + 1n : 0n;
  while (retry.length > 0 || next <= toBlock) {
    const batch: Window[] = [];
    while (batch.length < (accepted ? concurrency : 1) && (retry.length > 0 || next <= toBlock)) {
      if (retry.length > 0) { batch.push(retry.shift()!); continue; }
      const hi = next + BigInt(range) - 1n < toBlock ? next + BigInt(range) - 1n : toBlock;
      batch.push([next, hi]);
      next = hi + 1n;
    }
    requests += batch.length;
    const results = await Promise.allSettled(batch.map(getPage));
    let wait = false;
    for (const [i, r] of results.entries()) {
      const [lo, hi] = batch[i]!;
      if (r.status === "fulfilled") { logs.push(...r.value); accepted = true; behind = 0; scanned += hi - lo + 1n; continue; }
      const m = messageOf(r.reason);
      if (HEAD_BEHIND.test(m) && behind < 10) { behind++; wait = true; retry.push([lo, hi]); continue; }
      const size = Number(hi - lo + 1n);
      if (RANGE_REFUSED.test(m) && size > 1) {
        range = Math.min(range, narrowRange(size, m));
        for (let a = lo; a <= hi; a += BigInt(range)) retry.push([a, a + BigInt(range) - 1n < hi ? a + BigInt(range) - 1n : hi]);
        continue;
      }
      throw toLetterlockError(r.reason, `inbox: eth_getLogs ${lo}..${hi}`);
    }
    // a load-balanced RPC may answer from a node behind the head read above: wait for it (never skip blocks)
    if (wait) await new Promise((res) => setTimeout(res, 400));
    o.onProgress?.({ scannedBlocks: scanned, totalBlocks });
  }

  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  for (const log of logs) {
    const data = log.args.envelope as Hex;
    const bytes = (data.length - 2) / 2;
    const where = { bytes, blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex };
    try {
      const envelope = decodeEnvelope(hexToBytes(data));
      if (envelope.chainId !== ctx.chainId) throw new LetterlockError("INPUT_INVALID", `sealed for chain ${envelope.chainId}`);
      if (envelope.directory.toLowerCase() !== ctx.directory.toLowerCase()) throw new LetterlockError("INPUT_INVALID", `sealed for directory ${envelope.directory}`);
      if (canonicalRecipient(envelope.recipient) !== recipient) throw new LetterlockError("INPUT_INVALID", `sealed to ${envelope.recipient}`);
      envelopes.push({ envelope, ...where });
    } catch (e) {
      if (!isLetterlockError(e)) throw e;
      rejected.push({ reason: e.message.replace(/^[A-Z_]+: /, ""), ...where });
    }
  }
  return { recipient, envelopes, rejected, fromBlock, toBlock, requests, blockRange: range };
};
