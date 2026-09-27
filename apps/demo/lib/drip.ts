// The gas drip's rules, as pure functions over what the server observed: the request, the account's state on chain,
// the drip wallet's own history, and the per-instance counters. app/api/drip/route.ts gathers the observations
// (lib/drip-server.ts) and sends the transfer; test/drip.test.ts pins every rule here.
//
// Why a drip at all: a passkey account is new, holds no MON, and msg.sender of publish() must be that account, so
// nobody else can pay for its first publish. The drip sends it just enough for ONE publish.
import { getAddress, isAddress, isHex, parseEther, verifyMessage, type Address, type Hex } from "viem";

/** Gas one publish() used on Monad mainnet (deployments/143.json, gasUsed.publish): Monad charges the gas limit. */
export const PUBLISH_GAS = 70_863n;
/** A plain MON transfer: the drip's own transaction. */
export const TRANSFER_GAS = 21_000n;
/** The drip is 1.5 × one publish at the current gas price, and never more than 0.02 MON. */
export const DRIP_CAP_WEI = parseEther("0.02");
/** At most 0.5 MON leaves the drip wallet in any 24 hours: drips and their fees together. */
export const DAILY_CAP_WEI = parseEther("0.5");
/** A signature names the minute it was made; the server takes it for 5 minutes either side. */
export const WINDOW_MINUTES = 5;
/** Monad's minimum base fee, 100 MON-gwei (docs.monad.xyz, gas pricing). */
export const MIN_BASE_FEE = 100n * 10n ** 9n;
/** The least one drip can take out of the wallet: a drip at the minimum base fee, plus its transfer's gas. */
export const MIN_OUT_PER_DRIP = (PUBLISH_GAS * MIN_BASE_FEE * 3n) / 2n + TRANSFER_GAS * MIN_BASE_FEE;
/** The most one drip can take out: the 0.02 MON cap, plus its transfer's gas at ten times the minimum base fee. */
export const MAX_OUT_PER_DRIP = DRIP_CAP_WEI + TRANSFER_GAS * MIN_BASE_FEE * 10n;
/** How far back the daily cap looks. */
export const DAY_SECONDS = 86_400;

/** The EIP-191 message the passkey account signs: it proves the caller holds the account the drip would fund. */
export const dripMessage = (address: string, chainId: number, minute: number): string =>
  `letterlock-drip:${address.toLowerCase()}:${chainId}:${minute}`;

/** The unix minute of a time in milliseconds. */
export const unixMinute = (ms: number): number => Math.floor(ms / 60_000);

export type DripRequest = { readonly address: Address; readonly chainId: number; readonly minute: number; readonly signature: Hex };

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
  | "GAS_TOO_HIGH"
  | "DRIP_BUSY"
  | "DRIP_EMPTY"
  | "CAP_UNVERIFIABLE"
  | "CHAIN_UNAVAILABLE"
  | "SEND_FAILED";

const refuse = (status: number, code: DripRefusalCode, message: string): Refusal => ({ ok: false, status, code, message });

/** Reads the request body. Anything but exactly { address, chainId, minute, signature } of the right types is refused. */
export const parseDripRequest = (body: unknown): { ok: true; request: DripRequest } | Refusal => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse(400, "BAD_REQUEST", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["address", "chainId", "minute", "signature"].includes(k));
  if (extra.length) return refuse(400, "BAD_REQUEST", `unexpected field ${JSON.stringify(extra[0])}`);
  if (typeof b.address !== "string" || !isAddress(b.address, { strict: false }))
    return refuse(400, "BAD_REQUEST", "address must be a 0x address");
  if (typeof b.chainId !== "number" || !Number.isSafeInteger(b.chainId)) return refuse(400, "BAD_REQUEST", "chainId must be an integer");
  if (typeof b.minute !== "number" || !Number.isSafeInteger(b.minute) || b.minute < 0)
    return refuse(400, "BAD_REQUEST", "minute must be a unix minute");
  // 65 bytes: r, s and v. A longer signature would be a smart-account signature, which a passkey account never makes.
  if (typeof b.signature !== "string" || !isHex(b.signature, { strict: true }) || b.signature.length !== 132)
    return refuse(400, "BAD_REQUEST", "signature must be a 65-byte hex signature");
  return { ok: true, request: { address: getAddress(b.address), chainId: b.chainId, minute: b.minute, signature: b.signature as Hex } };
};

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

/** The drip for one publish: 1.5 × PUBLISH_GAS at `gasPrice`, capped at DRIP_CAP_WEI. */
export const dripAmount = (gasPrice: bigint): bigint => {
  const want = (gasPrice * PUBLISH_GAS * 3n) / 2n;
  return want < DRIP_CAP_WEI ? want : DRIP_CAP_WEI;
};

/** What one publish needs in the account for the chain to take it: its gas limit at the fee cap the wallet will bid. */
export const publishNeeds = (maxFeePerGas: bigint): bigint => PUBLISH_GAS * maxFeePerGas;

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
  readonly maxFeePerGas: bigint;
  readonly wallet: {
    readonly balance: bigint;
    /** nonce at the latest block, and counting pending transactions */
    readonly nonce: number;
    readonly pendingNonce: number;
    /** nonce four blocks ago: a transfer from a wallet under Monad's 10 MON reserve must be its only one in 3 blocks */
    readonly recentNonce: number;
    /** balance and nonce DAY_SECONDS ago (historical state), or undefined when the RPC no longer holds that block */
    readonly dayAgo?: { readonly balance: bigint; readonly nonce: number };
  };
  readonly dailyCap: bigint;
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
  const needs = publishNeeds(o.maxFeePerGas);
  if (o.account.balance >= needs) return { ok: true, amount: 0n, funded: true };
  if (o.account.balance > 0n) return refuse(409, "ALREADY_FUNDED", "this account already holds MON; the drip funds an account once, from zero");
  const amount = dripAmount(o.gasPrice);
  const fee = TRANSFER_GAS * o.maxFeePerGas;
  if (amount < needs) return refuse(503, "GAS_TOO_HIGH", "gas is too expensive right now for the capped drip to pay for a publish; try again later");
  if (o.wallet.pendingNonce !== o.wallet.nonce || o.wallet.recentNonce !== o.wallet.nonce)
    return refuse(503, "DRIP_BUSY", "the drip sent a transfer a moment ago; try again in two seconds");
  if (o.wallet.balance < amount + fee) return refuse(503, "DRIP_EMPTY", "the drip wallet is empty");
  if (!o.wallet.dayAgo) return refuse(503, "CAP_UNVERIFIABLE", "the RPC no longer holds the drip wallet's state from a day ago, so the daily cap cannot be checked");
  const spent = spentInWindow({ balanceThen: o.wallet.dayAgo.balance, balanceNow: o.wallet.balance, nonceThen: o.wallet.dayAgo.nonce, nonceNow: o.wallet.nonce });
  if (spent + amount + fee > o.dailyCap) return refuse(429, "DAILY_CAP", "the drip has paid out its daily limit; try again tomorrow");
  return { ok: true, amount, fee, spent };
};

/**
 * The daily cap in wei: DAILY_CAP_WEI, or DRIP_DAILY_CAP_MON when it is set. On mainnet the variable can only lower
 * the cap; a testnet build (the end-to-end tests, paid from the testnet deployer) may raise it.
 */
export const dailyCapFrom = (env: string | undefined, chainId: number): bigint => {
  if (env === undefined || env.trim() === "") return DAILY_CAP_WEI;
  let v: bigint;
  try { v = parseEther(env.trim() as `${number}`); } catch { return DAILY_CAP_WEI; }
  if (v < 0n) return DAILY_CAP_WEI;
  return chainId === 143 && v > DAILY_CAP_WEI ? DAILY_CAP_WEI : v;
};
