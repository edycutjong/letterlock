// Server only: what the gas drip reads from the chain and from its own memory, and the transfer it sends. The rules are
// lib/drip.ts. Imported by app/api/drip/route.ts alone (test/drip.test.ts fails if a client module imports it).
//
// Memory here is per serverless instance: Vercel may run several instances, each with its own maps, and a new one starts
// empty. So the in-memory limits (per IP, per address) only slow a caller down; Vercel's firewall counts POSTs to the
// route per IP for every instance (apps/demo/vercel-firewall.json). What cannot be bypassed is read from the chain on
// every request: the account's key, nonce and balance, and the drip wallet's own balance and nonce now, an hour ago
// (the hourly cap) and a day ago (the daily cap).
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { letterlockAbi } from "letterlock";
import { CHAIN, DEPLOYMENT, SCAN_RPC } from "./chain.ts";
import {
  DAY_SECONDS,
  HOUR_SECONDS,
  TRANSFER_GAS,
  configuredPass,
  laneFor,
  precheckDrip,
  verifyDripSignature,
  type DripLane,
  type DripObservation,
  type DripPrecheck,
  type DripRequest,
  type Refusal,
} from "./drip.ts";
import { walletBidFeePerGas } from "./fees.ts";
import { blocksAgo } from "./past-blocks.ts";

const VIEM_CHAIN = CHAIN === "monad" ? monad : monadTestnet;

const clientFor = (url: string): PublicClient => createPublicClient({ chain: VIEM_CHAIN, transport: http(url, { timeout: 12_000 }) }) as PublicClient;
const main = clientFor(DEPLOYMENT.rpcUrl);
/** a second RPC for historical state, when the first no longer holds the block (the lookback depends on the provider) */
const fallback = SCAN_RPC !== DEPLOYMENT.rpcUrl ? clientFor(SCAN_RPC) : undefined;

// ---- per-instance limits ----------------------------------------------------------------------------------------

const MINUTE = 60_000;
/** requests from one IP in 10 minutes, and drips to one IP in 24 hours */
export const IP_REQUESTS = { max: 12, windowMs: 10 * MINUTE };
export const IP_DRIPS = { max: 3, windowMs: 24 * 60 * MINUTE };

const requestsByIp = new Map<string, number[]>();
const dripsByIp = new Map<string, number[]>();
/** addresses this instance has funded (a least-recently-used set, at most 5,000) */
const dripped = new Map<string, number>();
const DRIPPED_MAX = 5_000;

const recent = (m: Map<string, number[]>, key: string, windowMs: number, now: number): number[] => {
  const kept = (m.get(key) ?? []).filter((t) => now - t < windowMs);
  if (kept.length) m.set(key, kept);
  else m.delete(key);
  return kept;
};

/**
 * Counts this request against the caller's IP; false when the IP is over a limit that binds the request's lane. Every
 * lane is held to IP_REQUESTS. IP_DRIPS binds the public only: judges who share one network (a venue's Wi-Fi, an
 * office's NAT, one VPN exit) each get their drip, bounded still by the daily cap and the firewall's limit per IP.
 */
export const allowIp = (ip: string, lane: DripLane, now = Date.now()): boolean => {
  if (requestsByIp.size > 50_000) requestsByIp.clear(); // a flood of distinct IPs must not grow the map without bound
  const hits = recent(requestsByIp, ip, IP_REQUESTS.windowMs, now);
  hits.push(now);
  requestsByIp.set(ip, hits);
  if (hits.length > IP_REQUESTS.max) return false;
  return lane === "judge" || recent(dripsByIp, ip, IP_DRIPS.windowMs, now).length < IP_DRIPS.max;
};
export const wasDripped = (address: Address): boolean => {
  const key = address.toLowerCase();
  const at = dripped.get(key);
  if (at === undefined) return false;
  dripped.delete(key); // refresh its place in the LRU order
  dripped.set(key, at);
  return true;
};

export const recordDrip = (address: Address, ip: string, now = Date.now()): void => {
  dripped.set(address.toLowerCase(), now);
  while (dripped.size > DRIPPED_MAX) dripped.delete(dripped.keys().next().value!);
  const d = recent(dripsByIp, ip, IP_DRIPS.windowMs, now);
  d.push(now);
  dripsByIp.set(ip, d);
};

// ---- the chain ----------------------------------------------------------------------------------------------------

export const dripAccount = () => {
  const key = process.env.LETTERLOCK_DRIP_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined;
  return privateKeyToAccount(key as Hex);
};

export type Admission = {
  /** what decideDrip() needs from before the chain is read */
  readonly pre: DripPrecheck;
  /** the judges' lane when the request carries the configured pass (DRIP_JUDGE_PASS) */
  readonly lane: DripLane;
  /** true while a judges' pass is configured: the public lane then stops at publicDailyCap */
  readonly reserve: boolean;
  /** set when a check that needs no chain read refuses: the route answers it without reading the chain */
  readonly refusal: Refusal | undefined;
};

/**
 * The route's checks before any chain read, in its order: the kill switch, the chain, the signature's minute and
 * signer, this IP's limits, this instance's funded addresses. The lane is decided first, from the pass compared whole,
 * because the per-IP drips limit binds only the public's lane (allowIp).
 */
export const admitDrip = async (request: DripRequest, ip: string, now = Date.now()): Promise<Admission> => {
  const enabled = process.env.DRIP_ENABLED === "true" && dripAccount() !== undefined;
  const judgePass = configuredPass(process.env.DRIP_JUDGE_PASS);
  const lane = laneFor(request.pass, judgePass);
  const pre: DripPrecheck = {
    enabled,
    expectedChainId: DEPLOYMENT.chainId,
    nowMs: now,
    request,
    signatureValid: enabled ? await verifyDripSignature(request) : false,
    ipAllowed: enabled ? allowIp(ip, lane, now) : true,
    alreadyDripped: wasDripped(request.address),
  };
  return { pre, lane, reserve: judgePass !== undefined, refusal: precheckDrip(pre) };
};

let pastCache: { at: number; day: bigint; hour: bigint } | undefined;

/** The first blocks at least DAY_SECONDS and HOUR_SECONDS old (lib/past-blocks.ts), cached for a minute. */
const pastBlocks = async (): Promise<{ day: bigint; hour: bigint }> => {
  if (pastCache && Date.now() - pastCache.at < MINUTE) return pastCache;
  const [day, hour] = await blocksAgo(main, [DAY_SECONDS, HOUR_SECONDS]);
  pastCache = { at: Date.now(), day: day!, hour: hour! };
  return pastCache;
};

/** Balance and nonce at a past block; the fallback RPC if the main one no longer holds it; undefined if neither does. */
const historical = async (address: Address, blockNumber: bigint): Promise<{ balance: bigint; nonce: number } | undefined> => {
  for (const c of fallback ? [main, fallback] : [main]) {
    try {
      const [balance, nonce] = await Promise.all([c.getBalance({ address, blockNumber }), c.getTransactionCount({ address, blockNumber })]);
      return { balance, nonce };
    } catch {
      // not held by this RPC: try the next one
    }
  }
  return undefined;
};

export type ChainState = Pick<DripObservation, "account" | "gasPrice" | "maxFeePerGas" | "bidFeePerGas" | "wallet">;

/** Everything decideDrip() needs from the chain, read in parallel. Throws when the RPC fails (CHAIN_UNAVAILABLE). */
export const readChainState = async (request: DripRequest, wallet: Address): Promise<ChainState> => {
  const [key, balance, nonce, gasPrice, fees, bidFeePerGas, head, walletBalance, walletNonce, walletPending, past] = await Promise.all([
    main.readContract({ address: DEPLOYMENT.directory, abi: letterlockAbi, functionName: "keyOf", args: [request.address] }),
    main.getBalance({ address: request.address }),
    main.getTransactionCount({ address: request.address }),
    main.getGasPrice(),
    main.estimateFeesPerGas(),
    walletBidFeePerGas(main, request.address),
    main.getBlockNumber({ cacheTime: 0 }),
    main.getBalance({ address: wallet }),
    main.getTransactionCount({ address: wallet }),
    main.getTransactionCount({ address: wallet, blockTag: "pending" }),
    pastBlocks(),
  ]);
  const [recentNonce, dayAgo, hourAgo] = await Promise.all([
    main.getTransactionCount({ address: wallet, blockNumber: head > 4n ? head - 4n : 0n }),
    historical(wallet, past.day),
    historical(wallet, past.hour),
  ]);
  const [pub, epoch] = key;
  return {
    account: { hasKey: epoch !== 0 || BigInt(pub) !== 0n, balance, nonce },
    gasPrice,
    maxFeePerGas: fees.maxFeePerGas,
    bidFeePerGas,
    wallet: { balance: walletBalance, nonce: walletNonce, pendingNonce: walletPending, recentNonce, ...(dayAgo ? { dayAgo } : {}), ...(hourAgo ? { hourAgo } : {}) },
  };
};

/**
 * Broadcasts `amount` to `to` from the drip wallet with the nonce it read (so two instances can never both spend it),
 * and returns the transaction's hash as soon as the RPC has taken it.
 */
export const broadcastDrip = async (to: Address, amount: bigint, nonce: number, maxFeePerGas: bigint): Promise<Hex> => {
  const account = dripAccount();
  if (!account) throw new Error("no drip key configured");
  const wallet = createWalletClient({ account, chain: VIEM_CHAIN, transport: http(DEPLOYMENT.rpcUrl, { timeout: 12_000 }) });
  const fees = await main.estimateFeesPerGas();
  return wallet.sendTransaction({
    to,
    value: amount,
    gas: TRANSFER_GAS,
    nonce,
    maxFeePerGas: maxFeePerGas > fees.maxFeePerGas ? maxFeePerGas : fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
};

/** Waits up to 30 s for a broadcast drip's receipt. */
export const waitForDrip = async (hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint }> => {
  const receipt = await main.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 400 });
  return { status: receipt.status, blockNumber: receipt.blockNumber };
};
