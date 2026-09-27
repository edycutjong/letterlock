// The fee cap a viem wallet will bid on this chain, read the way viem reads it: the RPC's eth_fillTransaction fills
// maxFeePerGas and viem multiplies it by 1.2 (lib/drip.ts, walletBid). The RPC takes a transaction only when its sender
// holds gas limit x that bid, so the drip is sized by it and the pages check postage with it. Where the RPC has no
// eth_fillTransaction, viem falls back to its own estimate, and so does this.
import type { Address, PublicClient } from "viem";
import { walletBid } from "./drip.ts";

export const walletBidFeePerGas = async (client: PublicClient, from: Address): Promise<bigint> => {
  try {
    const filled = (await client.request({ method: "eth_fillTransaction", params: [{ from, to: from, value: "0x0" }] } as never)) as {
      tx?: { maxFeePerGas?: unknown };
    };
    const fee = filled?.tx?.maxFeePerGas;
    if (typeof fee === "string" && /^0x[0-9a-fA-F]+$/.test(fee)) return walletBid(BigInt(fee));
  } catch {
    // no eth_fillTransaction here: viem uses its own estimate
  }
  return (await client.estimateFeesPerGas()).maxFeePerGas;
};
