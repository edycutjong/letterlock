"use client";

// Postage: what a transaction needs in the passkey account, the gas drip that pays for a first publish, and waiting
// until the drip's MON can be spent. Monad charges the gas limit, and its consensus checks a sender's balance three
// blocks back (the reserve-balance rule), so a publish sent the moment the drip lands could be refused.
import { NO_AGENT, encodeEnvelope, letterlockAbi, toAgentId, type Envelope } from "letterlock";
import { bytesToHex, zeroAddress, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "./chain.ts";
import { publicClient } from "./client.ts";
import { PUBLISH_GAS, dripMessage, unixMinute } from "./drip.ts";
import { walletBidFeePerGas } from "./fees.ts";
import { DripRefused, asChainError } from "./failure.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Postage = { readonly balance: bigint; readonly needed: bigint };

/**
 * What a transaction of `gas` needs in `address` now: its gas at the fee cap the wallet will bid (lib/fees.ts). The RPC
 * refuses a transaction whose sender holds less, however little it is then charged.
 */
export const postageFor = async (address: Address, gas: bigint): Promise<Postage> => {
  const pc = publicClient();
  try {
    const [balance, bid] = await Promise.all([pc.getBalance({ address }), walletBidFeePerGas(pc, address)]);
    return { balance, needed: gas * bid };
  } catch (e) {
    throw asChainError(e, "reading the account's balance and the fee cap");
  }
};

export const publishPostage = (address: Address): Promise<Postage> => postageFor(address, PUBLISH_GAS);

/** The gas a drop() of this envelope from `from` would use, estimated by the RPC (no balance needed). */
export const dropGas = async (from: Address, envelope: Envelope): Promise<bigint> => {
  const recipient = envelope.recipient.toLowerCase();
  const agent = recipient.startsWith("agent:");
  const args = [agent ? zeroAddress : (recipient as Address), agent ? toAgentId(recipient) : NO_AGENT, bytesToHex(encodeEnvelope(envelope))] as const;
  try {
    return await publicClient().estimateContractGas({ account: from, address: DEPLOYMENT.directory, abi: letterlockAbi, functionName: "drop", args });
  } catch (e) {
    throw asChainError(e, "estimating the drop's gas");
  }
};

export type DripReceipt = { readonly transactionHash: Hex; readonly amount: string; readonly explorer: string };

type Signer = { readonly address: Address; signMessage(a: { message: string }): Promise<Hex> };

/**
 * Asks the gas drip to fund `account` for one publish: the account signs "letterlock-drip:<address>:<chainId>:<minute>"
 * (no prompt: the passkey account's session signs) and the server checks everything else (app/api/drip). Returns the
 * drip's transaction, or undefined when the server found the account already funded. A busy drip is asked again.
 */
export const requestDrip = async (account: Signer): Promise<DripReceipt | undefined> => {
  for (let attempt = 0; ; attempt++) {
    const minute = unixMinute(Date.now());
    const signature = await account.signMessage({ message: dripMessage(account.address, DEPLOYMENT.chainId, minute) });
    let res: Response;
    try {
      res = await fetch("/api/drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: account.address, chainId: DEPLOYMENT.chainId, minute, signature }),
      });
    } catch {
      throw new DripRefused("UNREACHABLE", "the drip could not be reached");
    }
    let body: { dripped?: boolean; transactionHash?: Hex; amount?: string; explorer?: string; error?: string; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // not JSON: reported by status below
    }
    if (res.ok) return body.dripped && body.transactionHash ? { transactionHash: body.transactionHash, amount: body.amount ?? "", explorer: body.explorer ?? "" } : undefined;
    if (body.error === "DRIP_BUSY" && attempt < 5) {
      await sleep(1_500);
      continue;
    }
    throw new DripRefused(body.error ?? `HTTP_${res.status}`, body.message ?? `the drip answered HTTP ${res.status}`, body.transactionHash);
  }
};

/**
 * Waits until the account's balance as consensus sees it (three blocks back) covers `needed`, for up to 30 s. Returns
 * the balance.
 */
export const waitForFunds = async (address: Address, needed: bigint, timeoutMs = 30_000): Promise<bigint> => {
  const pc = publicClient();
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const head = await pc.getBlockNumber({ cacheTime: 0 });
      const seen = await pc.getBalance({ address, blockNumber: head > 3n ? head - 3n : head });
      if (seen >= needed) return seen;
    } catch {
      // one failed read (a node a block behind, a dropped request) is not an answer: ask again
    }
    if (Date.now() > until) throw new DripRefused("NOT_ARRIVED", "the drip’s MON had not arrived after 30 seconds");
    await sleep(500);
  }
};
