// A live inbox count for the judges' step 3. rpc1.monad.xyz is load-balanced over nodes that may lag, so one poll can
// report an older finalized block than the last: the scan never moves back, and counts each letter once, by
// transactionHash:logIndex, however often it is read (InboxDesk de-duplicates the same way).

export type ScanState = { readonly who: string; readonly next?: bigint; readonly seen: ReadonlySet<string> };

type ScanResult = {
  readonly envelopes: readonly { readonly transactionHash: string; readonly logIndex: number }[];
  readonly toBlock: bigint;
  readonly finalizedBlock: bigint;
};

export const advanceScan = (s: ScanState, r: ScanResult): ScanState => {
  const seen = new Set(s.seen);
  for (const e of r.envelopes) seen.add(`${e.transactionHash}:${e.logIndex}`);
  const read = (r.toBlock < r.finalizedBlock ? r.toBlock : r.finalizedBlock) + 1n;
  return { who: s.who, next: s.next === undefined || read > s.next ? read : s.next, seen };
};
