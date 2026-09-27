// The blocks the drip's limits look back to (lib/drip.ts: an hour, a day), found from block timestamps: Monad's block
// time is not a constant. Used by the drip route (lib/drip-server.ts) and by scripts/drip-status.ts, so both count the
// same windows.
import type { PublicClient } from "viem";

/** Blocks of margin taken off each estimate (about four minutes): a window is a little longer than its name, never shorter. */
export const MARGIN_BLOCKS = 600n;

/** For each of `seconds`, the first block at least that many seconds older than the head. */
export const blocksAgo = async (client: PublicClient, seconds: readonly number[]): Promise<bigint[]> => {
  const head = await client.getBlock({ blockTag: "latest" });
  const span = 100_000n < head.number ? 100_000n : head.number;
  const sample = await client.getBlock({ blockNumber: head.number - span });
  const perSecond = Number(span) / Math.max(1, Number(head.timestamp - sample.timestamp));
  return Promise.all(
    seconds.map(async (s) => {
      const target = head.timestamp - BigInt(s);
      let guess = head.number - BigInt(Math.round(s * perSecond));
      if (guess < 0n) guess = 0n;
      const at = await client.getBlock({ blockNumber: guess });
      guess -= BigInt(Math.round(Number(at.timestamp - target) * perSecond)); // a block later than the target moves back
      guess -= MARGIN_BLOCKS;
      return guess < 0n ? 0n : guess;
    }),
  );
};
