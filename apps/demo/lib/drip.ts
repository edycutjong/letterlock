// The gas drip's rules, as pure functions over what the server observed: the request, the account's state on chain,
// the drip wallet's own history, and the per-instance counters. app/api/drip/route.ts gathers the observations
// (lib/drip-server.ts) and sends the transfer; test/drip.test.ts pins every rule here.
//
// Why a drip at all: a passkey account is new, holds no MON, and msg.sender of publish() must be that account, so
// nobody else can pay for its first publish. The drip sends it just enough for ONE publish.
import { formatEther, getAddress, isAddress, isHex, parseEther, verifyMessage, type Address, type Hex } from "viem";

/** Gas one publish() used on Monad mainnet (deployments/143.json, gasUsed.publish): Monad charges the gas limit. */
export const PUBLISH_GAS = 70_863n;
/** A plain MON transfer: the drip's own transaction. */
export const TRANSFER_GAS = 21_000n;
/** The drip never sends more than 0.02 MON. */
export const DRIP_CAP_WEI = parseEther("0.02");
/**
 * viem prepares a transaction on Monad with the RPC's eth_fillTransaction and multiplies the maxFeePerGas it returns by
 * 1.2 (its baseFeeMultiplier). The RPC accepts a transaction only when the sender holds its gas limit times that
 * maxFeePerGas: on 2026-09-27 mainnet filled 152 gwei at a 100 gwei base fee, so a publish bid 182.4 gwei and needed
 * 70,863 x 182.4 gwei = 0.0129254112 MON in the account, though it is charged 70,863 x 102 gwei. A drip of 1.5 x
 * 70,863 x 102 gwei (0.010842039 MON) was refused with "Signer had insufficient balance".
 */
export const WALLET_FEE_MULTIPLIER_TENTHS = 12n;
/** Headroom over the bid, in tenths: the base fee may move between the drip and the publish. */
export const BID_HEADROOM_TENTHS = 11n;
/** At most 0.5 MON leaves the drip wallet in any 24 hours: drips and their fees together. */
export const DAILY_CAP_WEI = parseEther("0.5");
/**
 * At most 0.1 MON leaves the drip wallet for requests without the judges' pass in any hour (about six drips at a 100
 * gwei base fee). Any fresh key passes the per-account rules and the per-IP limits hold per region at best, so without
 * this a burst of new accounts from many IPs could spend the day in minutes. With it, what an hour spent is free again an
 * hour later.
 */
export const HOURLY_CAP_WEI = parseEther("0.1");
/**
 * While a judges' pass is configured (DRIP_JUDGE_PASS), a request without it is refused once the day's spend would pass
 * 70% of the daily cap: the last 30% (0.15 MON, about eight drips) is spent only through the judges' link, so however
 * many fresh accounts a script makes, a judge still gets a drip.
 */
export const JUDGE_RESERVE_PERCENT = 30n;
/** A judges' pass shorter than this is treated as not configured: a guessable pass would reserve nothing. */
export const JUDGE_PASS_MIN_LENGTH = 16;
/** A signature names the minute it was made; the server takes it for 5 minutes either side. */
export const WINDOW_MINUTES = 5;
/** Monad's minimum base fee, 100 MON-gwei (docs.monad.xyz, gas pricing). */
export const MIN_BASE_FEE = 100n * 10n ** 9n;
/** The least one drip can take out of the wallet: 1.5 publishes at the minimum base fee, plus its transfer's gas. */
export const MIN_OUT_PER_DRIP = (PUBLISH_GAS * MIN_BASE_FEE * 3n) / 2n + TRANSFER_GAS * MIN_BASE_FEE;
/** The most one drip can take out: the 0.02 MON cap, plus its transfer's gas at ten times the minimum base fee. */
export const MAX_OUT_PER_DRIP = DRIP_CAP_WEI + TRANSFER_GAS * MIN_BASE_FEE * 10n;
/** How far back the daily cap looks. */
export const DAY_SECONDS = 86_400;
/** How far back the hourly cap looks. */
export const HOUR_SECONDS = 3_600;

/** The EIP-191 message the passkey account signs: it proves the caller holds the account the drip would fund. */
export const dripMessage = (address: string, chainId: number, minute: number): string =>
  `letterlock-drip:${address.toLowerCase()}:${chainId}:${minute}`;

/** The unix minute of a time in milliseconds. */
export const unixMinute = (ms: number): number => Math.floor(ms / 60_000);

export type DripRequest = {
  readonly address: Address;
  readonly chainId: number;
  readonly minute: number;
  readonly signature: Hex;
  /** the judges' pass, when the page was opened with the judges' link: it reaches the reserve (JUDGE_RESERVE_PERCENT) */
  readonly pass?: string;
};

/** Which part of the day's budget a request may draw on. */
export type DripLane = "public" | "judge";

export type Refusal = { readonly ok: false; readonly status: number; readonly code: DripRefusalCode; readonly message: string };

export type DripRefusalCode =
  | "DRIP_DISABLED"
  | "BAD_REQUEST"
  | "WRONG_CHAIN"
  | "STALE_SIGNATURE"
  | "BAD_SIGNATURE"
  | "RATE_LIMITED"
  | "ALREADY_DRIPPED"
  | "HAS_KEY"
  | "NOT_NEW"
  | "ALREADY_FUNDED"
  | "DAILY_CAP"
  | "HOURLY_CAP"
  | "GAS_TOO_HIGH"
  | "DRIP_BUSY"
  | "DRIP_EMPTY"
  | "CAP_UNVERIFIABLE"
  | "CHAIN_UNAVAILABLE"
  | "SEND_FAILED";

const refuse = (status: number, code: DripRefusalCode, message: string): Refusal => ({ ok: false, status, code, message });

/**
 * Reads the request body. Anything but { address, chainId, minute, signature } of the right types, and optionally the
 * judges' `pass` (a string of at most 128 characters), is refused.
 */
export const parseDripRequest = (body: unknown): { ok: true; request: DripRequest } | Refusal => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse(400, "BAD_REQUEST", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["address", "chainId", "minute", "signature", "pass"].includes(k));
  if (extra.length) return refuse(400, "BAD_REQUEST", `unexpected field ${JSON.stringify(extra[0])}`);
  if (typeof b.address !== "string" || !isAddress(b.address, { strict: false }))
    return refuse(400, "BAD_REQUEST", "address must be a 0x address");
  if (typeof b.chainId !== "number" || !Number.isSafeInteger(b.chainId)) return refuse(400, "BAD_REQUEST", "chainId must be an integer");
  if (typeof b.minute !== "number" || !Number.isSafeInteger(b.minute) || b.minute < 0)
    return refuse(400, "BAD_REQUEST", "minute must be a unix minute");
  // 65 bytes: r, s and v. A longer signature would be a smart-account signature, which a passkey account never makes.
  if (typeof b.signature !== "string" || !isHex(b.signature, { strict: true }) || b.signature.length !== 132)
    return refuse(400, "BAD_REQUEST", "signature must be a 65-byte hex signature");
  if (b.pass !== undefined && (typeof b.pass !== "string" || b.pass.length > 128)) return refuse(400, "BAD_REQUEST", "pass must be a string of at most 128 characters");
  return {
    ok: true,
    request: { address: getAddress(b.address), chainId: b.chainId, minute: b.minute, signature: b.signature as Hex, ...(typeof b.pass === "string" ? { pass: b.pass } : {}) },
  };
};

/** The judges' pass the server holds, when it is long enough to reserve anything (JUDGE_PASS_MIN_LENGTH). */
export const configuredPass = (env: string | undefined): string | undefined => {
  const p = env?.trim();
  return p && p.length >= JUDGE_PASS_MIN_LENGTH ? p : undefined;
};

/** Compares a given pass with the configured one in time that does not depend on where they differ. */
export const passMatches = (given: string | undefined, configured: string | undefined): boolean => {
  if (configured === undefined || given === undefined || given.length === 0) return false;
  let diff = given.length ^ configured.length;
  for (let i = 0; i < configured.length; i++) diff |= given.charCodeAt(i % given.length) ^ configured.charCodeAt(i);
  return diff === 0;
};

/** The judges' lane for the configured pass, the public lane for anything else (a wrong or mistyped pass included). */
export const laneFor = (pass: string | undefined, configured: string | undefined): DripLane => (passMatches(pass, configured) ? "judge" : "public");

/** What a request without the judges' pass may let the day spend: all of the cap, or 70% of it while a pass is configured. */
export const publicDailyCap = (dailyCap: bigint, reserve: boolean): bigint => (reserve ? (dailyCap * (100n - JUDGE_RESERVE_PERCENT)) / 100n : dailyCap);

/** The signature's minute must be within WINDOW_MINUTES of the server's clock, so an old signature cannot be replayed. */
export const checkMinute = (minute: number, nowMs: number): Refusal | undefined =>
  Math.abs(minute - unixMinute(nowMs)) > WINDOW_MINUTES
    ? refuse(401, "STALE_SIGNATURE", `the signature names minute ${minute}; the server takes minutes ${unixMinute(nowMs) - WINDOW_MINUTES} to ${unixMinute(nowMs) + WINDOW_MINUTES}`)
    : undefined;

/** EIP-191 over dripMessage(): only the holder of `address`'s key can make it. */
export const verifyDripSignature = async (r: DripRequest): Promise<boolean> => {
  try {
    return await verifyMessage({ address: r.address, message: dripMessage(r.address, r.chainId, r.minute), signature: r.signature });
  } catch {
    return false;
  }
};

/** The fee cap viem bids when the RPC's eth_fillTransaction filled `filledMaxFee`: 1.2 times it. */
export const walletBid = (filledMaxFee: bigint): bigint => (filledMaxFee * WALLET_FEE_MULTIPLIER_TENTHS) / 10n;

/** What one publish needs in the account for the RPC to take it: its gas limit at the fee cap the wallet bids. */
export const publishNeeds = (bidFeePerGas: bigint): bigint => PUBLISH_GAS * bidFeePerGas;

/**
 * The drip for one publish: 1.5 x PUBLISH_GAS at the current gas price, or what the publish needs at the wallet's bid
 * plus 10% if that is more (it is on Monad today), and never more than DRIP_CAP_WEI.
 */
export const dripAmount = (gasPrice: bigint, bidFeePerGas: bigint): bigint => {
  const byPrice = (gasPrice * PUBLISH_GAS * 3n) / 2n;
  const byBid = (publishNeeds(bidFeePerGas) * BID_HEADROOM_TENTHS) / 10n;
  const want = byPrice > byBid ? byPrice : byBid;
  return want < DRIP_CAP_WEI ? want : DRIP_CAP_WEI;
};

/**
 * What left the drip wallet in the window, from its own history: `measured` is its balance then minus now. Every one of
 * the window's `count` transactions (nonce now minus nonce then) is a drip, and each takes at least MIN_OUT_PER_DRIP;
 * a smaller `measured` means MON came in during the window (a top-up), which hides spending, so the window is then
 * counted at MAX_OUT_PER_DRIP per drip instead.
 */
export const spentInWindow = (h: { balanceThen: bigint; balanceNow: bigint; nonceThen: number; nonceNow: number }): bigint => {
  const count = BigInt(Math.max(0, h.nonceNow - h.nonceThen));
  const measured = h.balanceThen - h.balanceNow;
  if (count === 0n) return measured > 0n ? measured : 0n;
  return measured >= count * MIN_OUT_PER_DRIP ? measured : count * MAX_OUT_PER_DRIP;
};

/** Everything the server observed before deciding. Amounts in wei. */
export type DripObservation = {
  readonly enabled: boolean;
  readonly expectedChainId: number;
  readonly nowMs: number;
  readonly request: DripRequest;
  readonly signatureValid: boolean;
  /** the per-instance counters (lib/drip-server.ts): serverless memory is per instance, so these only slow a caller down */
  readonly ipAllowed: boolean;
  readonly alreadyDripped: boolean;
  readonly account: { readonly hasKey: boolean; readonly balance: bigint; readonly nonce: number };
  readonly gasPrice: bigint;
  /** the fee cap of the drip's own transfer */
  readonly maxFeePerGas: bigint;
  /** the fee cap the passkey account's wallet will bid for its publish (walletBid of the RPC's filled fee) */
  readonly bidFeePerGas: bigint;
  readonly wallet: {
    readonly balance: bigint;
    /** nonce at the latest block, and counting pending transactions */
    readonly nonce: number;
    readonly pendingNonce: number;
    /** nonce four blocks ago: a transfer from a wallet under Monad's 10 MON reserve must be its only one in 3 blocks */
    readonly recentNonce: number;
    /** balance and nonce DAY_SECONDS ago (historical state), or undefined when the RPC no longer holds that block */
    readonly dayAgo?: { readonly balance: bigint; readonly nonce: number };
    /** balance and nonce HOUR_SECONDS ago, or undefined when no RPC answered for that block */
    readonly hourAgo?: { readonly balance: bigint; readonly nonce: number };
  };
  readonly dailyCap: bigint;
  /** the most the public lane may spend in any hour (HOURLY_CAP_WEI unless DRIP_HOURLY_CAP_MON lowers it) */
  readonly hourlyCap: bigint;
  /** the judges' lane when the request carried the configured pass (laneFor) */
  readonly lane: DripLane;
  /** true while a judges' pass is configured: the public lane then stops at publicDailyCap */
  readonly reserve: boolean;
};

export type DripDecision = { readonly ok: true; readonly amount: bigint; readonly fee: bigint; readonly spent: bigint } | { readonly ok: true; readonly amount: 0n; readonly funded: true } | Refusal;

export type DripPrecheck = Pick<DripObservation, "enabled" | "expectedChainId" | "nowMs" | "request" | "signatureValid" | "ipAllowed" | "alreadyDripped">;

/** The checks that need no chain read: the route runs them first, so a bad request costs no RPC call. */
export const precheckDrip = (o: DripPrecheck): Refusal | undefined => {
  if (!o.enabled) return refuse(503, "DRIP_DISABLED", "the gas drip is switched off");
  if (o.request.chainId !== o.expectedChainId)
    return refuse(400, "WRONG_CHAIN", `this drip pays on chain ${o.expectedChainId}, not ${o.request.chainId}`);
  const stale = checkMinute(o.request.minute, o.nowMs);
  if (stale) return stale;
  if (!o.signatureValid) return refuse(401, "BAD_SIGNATURE", "the signature is not the account's own over the drip message");
  if (!o.ipAllowed) return refuse(429, "RATE_LIMITED", "too many drip requests from this network; try again later");
  if (o.alreadyDripped) return refuse(409, "ALREADY_DRIPPED", "this account has had its drip");
  return undefined;
};

/** The drip's whole policy. Order matters only for which reason a refusal names; every check must pass. */
export const decideDrip = (o: DripObservation): DripDecision => {
  const early = precheckDrip(o);
  if (early) return early;
  if (o.account.hasKey) return refuse(409, "HAS_KEY", "this account already has a key in the directory; the drip pays only for a first publish");
  if (o.account.nonce > 0) return refuse(409, "NOT_NEW", "this account has sent transactions before; the drip is for new passkey accounts");
  const needs = publishNeeds(o.bidFeePerGas);
  if (o.account.balance >= needs) return { ok: true, amount: 0n, funded: true };
  if (o.account.balance > 0n) return refuse(409, "ALREADY_FUNDED", "this account already holds MON; the drip funds an account once, from zero");
  const amount = dripAmount(o.gasPrice, o.bidFeePerGas);
  const fee = TRANSFER_GAS * o.maxFeePerGas;
  if (amount < needs) return refuse(503, "GAS_TOO_HIGH", "gas is too expensive right now for the capped drip to pay for a publish; try again later");
  if (o.wallet.pendingNonce !== o.wallet.nonce || o.wallet.recentNonce !== o.wallet.nonce)
    return refuse(503, "DRIP_BUSY", "the drip sent a transfer a moment ago; try again in two seconds");
  if (o.wallet.balance < amount + fee) return refuse(503, "DRIP_EMPTY", "the drip wallet is empty");
  if (!o.wallet.dayAgo) return refuse(503, "CAP_UNVERIFIABLE", "the RPC no longer holds the drip wallet's state from a day ago, so the daily cap cannot be checked");
  const spent = spentInWindow({ balanceThen: o.wallet.dayAgo.balance, balanceNow: o.wallet.balance, nonceThen: o.wallet.dayAgo.nonce, nonceNow: o.wallet.nonce });
  const out = amount + fee;
  if (spent + out > o.dailyCap) return refuse(429, "DAILY_CAP", "the drip has paid out its daily limit; try again tomorrow");
  if (o.lane === "public") {
    // what the judges' link keeps for itself, and the hour's limit, bind only a request without the judges' pass
    if (spent + out > publicDailyCap(o.dailyCap, o.reserve))
      return refuse(429, "DAILY_CAP", "the drip has paid out its daily limit for the public (the rest is kept for the judges' link); try again tomorrow");
    if (!o.wallet.hourAgo) return refuse(503, "CAP_UNVERIFIABLE", "no RPC holds the drip wallet's state from an hour ago, so the hourly limit cannot be checked");
    const hour = spentInWindow({ balanceThen: o.wallet.hourAgo.balance, balanceNow: o.wallet.balance, nonceThen: o.wallet.hourAgo.nonce, nonceNow: o.wallet.nonce });
    if (hour + out > o.hourlyCap) return refuse(429, "HOURLY_CAP", "the drip has paid out its limit for this hour; try again in an hour");
  }
  return { ok: true, amount, fee, spent };
};

/**
 * What became of a drip transfer: never broadcast, or broadcast with its hash, and its receipt once one was read. A
 * transfer whose receipt could not be read (a timeout, a failed read) was still sent, and may still land.
 */
export type SettledDrip =
  | { readonly sent: false }
  | { readonly sent: true; readonly transactionHash: Hex; readonly receipt?: { readonly status: "success" | "reverted"; readonly blockNumber: bigint } };

/** Broadcasts, then waits for the receipt, keeping the two failures apart: only a failed broadcast sent nothing. */
export const settleDrip = async (
  broadcast: () => Promise<Hex>,
  wait: (hash: Hex) => Promise<{ status: "success" | "reverted"; blockNumber: bigint }>,
): Promise<SettledDrip> => {
  let transactionHash: Hex;
  try {
    transactionHash = await broadcast();
  } catch {
    return { sent: false };
  }
  try {
    const { status, blockNumber } = await wait(transactionHash);
    return { sent: true, transactionHash, receipt: { status, blockNumber } };
  } catch {
    return { sent: true, transactionHash };
  }
};

/**
 * The route's answer for a settled drip. 202 when the transfer was sent but its receipt could not be read: the page
 * waits for the MON as it does after a 200, and nothing claims it was not sent.
 */
export const dripReply = (s: SettledDrip, amount: bigint, explorer: (hash: Hex) => string): { status: number; body: Record<string, unknown> } => {
  if (!s.sent) return { status: 502, body: { error: "SEND_FAILED", message: "the drip transfer was not accepted by the RPC; nothing was sent" } };
  const tx = { transactionHash: s.transactionHash, explorer: explorer(s.transactionHash) };
  if (!s.receipt)
    return { status: 202, body: { dripped: true, pending: true, ...tx, amount: formatEther(amount), message: "the drip transfer was sent; its receipt could not be read yet" } };
  if (s.receipt.status !== "success")
    return { status: 502, body: { error: "SEND_FAILED", message: "the drip transfer was included but reverted; try again in a few seconds", ...tx } };
  return { status: 200, body: { dripped: true, ...tx, blockNumber: Number(s.receipt.blockNumber), amount: formatEther(amount) } };
};

/**
 * The daily cap in wei: DAILY_CAP_WEI, or DRIP_DAILY_CAP_MON when it is set. On mainnet the variable can only lower
 * the cap; a testnet build (the end-to-end tests, paid from the testnet deployer) may raise it.
 */
export const dailyCapFrom = (env: string | undefined, chainId: number): bigint => capFrom(env, chainId, DAILY_CAP_WEI);

/** The hourly cap in wei: HOURLY_CAP_WEI, or DRIP_HOURLY_CAP_MON when it is set, by the same rule as the daily cap. */
export const hourlyCapFrom = (env: string | undefined, chainId: number): bigint => capFrom(env, chainId, HOURLY_CAP_WEI);

const capFrom = (env: string | undefined, chainId: number, standard: bigint): bigint => {
  if (env === undefined || env.trim() === "") return standard;
  let v: bigint;
  try { v = parseEther(env.trim() as `${number}`); } catch { return standard; }
  if (v < 0n) return standard;
  return chainId === 143 && v > standard ? standard : v;
};
