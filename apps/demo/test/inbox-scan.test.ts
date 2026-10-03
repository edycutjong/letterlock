// lib/inbox-scan.ts: the judges' step-3 counter against a load-balanced RPC whose nodes lag.
import assert from "node:assert/strict";
import test from "node:test";
import { advanceScan, type ScanState } from "../lib/inbox-scan.ts";

const letter = { transactionHash: "0xaa", logIndex: 0 };

test("an RPC that answers an older finalized block neither moves the scan back nor counts a letter twice", () => {
  let s: ScanState = { who: "0x1", seen: new Set() };
  s = advanceScan(s, { envelopes: [letter], toBlock: 1000n, finalizedBlock: 1000n });
  s = advanceScan(s, { envelopes: [], toBlock: 995n, finalizedBlock: 995n }); // a lagging node
  assert.equal(s.next, 1001n);
  s = advanceScan(s, { envelopes: [letter], toBlock: 1010n, finalizedBlock: 1010n }); // the same letter read again
  assert.equal(s.seen.size, 1);
  assert.equal(s.next, 1011n);
});

test("two letters in one transaction are two letters", () => {
  const s = advanceScan({ who: "0x1", seen: new Set() }, { envelopes: [letter, { ...letter, logIndex: 1 }], toBlock: 5n, finalizedBlock: 5n });
  assert.equal(s.seen.size, 2);
});
