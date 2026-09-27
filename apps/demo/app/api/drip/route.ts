// POST /api/drip — funds a new passkey account with just enough MON for its first publish() (lib/drip.ts has the rules).
//
//   request  { address, chainId, minute, signature }   signature: EIP-191 by `address` over
//            "letterlock-drip:<address, lower-case>:<chainId>:<unix minute>", made within 5 minutes of the server's clock
//   200      { dripped: true, transactionHash, amount, blockNumber, explorer } | { dripped: false, reason: "FUNDED" }
//   4xx/5xx  { error: <code>, message }                   codes: lib/drip.ts, DripRefusalCode
//
// The drip wallet's key is read from LETTERLOCK_DRIP_PRIVATE_KEY (a Vercel environment variable) inside this handler
// only; it is never logged or returned, and no client module imports lib/drip-server.ts. DRIP_ENABLED=true turns the
// drip on; anything else (or no key) turns it off.
import { NextResponse, type NextRequest } from "next/server";
import { formatEther } from "viem";
import { DEPLOYMENT, explorerTx } from "@/lib/chain.ts";
import { dailyCapFrom, decideDrip, parseDripRequest, precheckDrip, verifyDripSignature, type Refusal } from "@/lib/drip.ts";
import { allowIp, dripAccount, readChainState, recordDrip, sendDrip, wasDripped } from "@/lib/drip-server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refusal = (r: Refusal) => json(r.status, { error: r.code, message: r.message });

/** One drip at a time per instance: a second request waits its turn instead of racing for the wallet's nonce. */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const run = queue.then(f, f);
  queue = run.catch(() => undefined);
  return run;
};

const callerIp = (req: NextRequest): string =>
  req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

export async function POST(req: NextRequest) {
  const text = await req.text();
  if (text.length > 2_048) return json(413, { error: "BAD_REQUEST", message: "the body is too large" });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json(400, { error: "BAD_REQUEST", message: "the body is not JSON" }); }
  const parsed = parseDripRequest(body);
  if (!parsed.ok) return refusal(parsed);
  const { request } = parsed;

  const account = dripAccount();
  const enabled = process.env.DRIP_ENABLED === "true" && account !== undefined;
  const ip = callerIp(req);
  const pre = {
    enabled,
    expectedChainId: DEPLOYMENT.chainId,
    nowMs: Date.now(),
    request,
    signatureValid: enabled ? await verifyDripSignature(request) : false,
    ipAllowed: enabled ? allowIp(ip) : true,
    alreadyDripped: wasDripped(request.address),
  };
  const early = precheckDrip(pre);
  if (early) return refusal(early);

  return serial(async () => {
    let state;
    try {
      state = await readChainState(request, account!.address);
    } catch {
      return json(502, { error: "CHAIN_UNAVAILABLE", message: "the Monad RPC did not answer; nothing was sent" });
    }
    const decision = decideDrip({
      ...pre,
      nowMs: Date.now(),
      alreadyDripped: wasDripped(request.address),
      ...state,
      dailyCap: dailyCapFrom(process.env.DRIP_DAILY_CAP_MON, DEPLOYMENT.chainId),
    });
    if (!decision.ok) return refusal(decision);
    if ("funded" in decision) return json(200, { dripped: false, reason: "FUNDED" });

    let sent;
    try {
      sent = await sendDrip(request.address, decision.amount, state.wallet.nonce, state.maxFeePerGas);
    } catch {
      // the error text can carry RPC details; the reason is enough for the caller
      return json(502, { error: "SEND_FAILED", message: "the drip transfer was not accepted by the RPC; nothing was sent" });
    }
    if (sent.status !== "success")
      return json(502, {
        error: "SEND_FAILED",
        message: "the drip transfer was included but reverted; try again in a few seconds",
        transactionHash: sent.transactionHash,
        explorer: explorerTx(sent.transactionHash),
      });
    recordDrip(request.address, ip);
    return json(200, {
      dripped: true,
      transactionHash: sent.transactionHash,
      blockNumber: Number(sent.blockNumber),
      amount: formatEther(decision.amount),
      explorer: explorerTx(sent.transactionHash),
    });
  });
}

export function GET() {
  return json(405, { error: "BAD_REQUEST", message: "POST a signed drip request" });
}
