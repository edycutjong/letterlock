// POST /api/drip — funds a new passkey account with just enough MON for its first publish() (lib/drip.ts has the rules).
//
//   request  { address, chainId, minute, signature, pass? }   signature: EIP-191 by `address` over
//            "letterlock-drip:<address, lower-case>:<chainId>:<unix minute>", made within 5 minutes of the server's clock;
//            pass: the judges' pass, when the page was opened with the judges' link
//   200      { dripped: true, transactionHash, amount, blockNumber, explorer } | { dripped: false, reason: "FUNDED" }
//   202      { dripped: true, pending: true, transactionHash, amount, explorer }: sent, its receipt not read yet
//   4xx/5xx  { error: <code>, message }                   codes: lib/drip.ts, DripRefusalCode
//
// The drip wallet's key is read from LETTERLOCK_DRIP_PRIVATE_KEY (a Vercel environment variable) inside this handler
// only; it is never logged or returned, and no client module imports lib/drip-server.ts. DRIP_ENABLED=true turns the
// drip on; anything else (or no key) turns it off. DRIP_JUDGE_PASS, when set, keeps the last 30% of each day's cap for
// requests that carry it (lib/drip.ts, JUDGE_RESERVE_PERCENT).
import { NextResponse, type NextRequest } from "next/server";
import { DEPLOYMENT, explorerTx } from "@/lib/chain.ts";
import {
  configuredPass,
  dailyCapFrom,
  decideDrip,
  dripReply,
  hourlyCapFrom,
  laneFor,
  parseDripRequest,
  precheckDrip,
  settleDrip,
  verifyDripSignature,
  type Refusal,
} from "@/lib/drip.ts";
import { allowIp, broadcastDrip, dripAccount, readChainState, recordDrip, waitForDrip, wasDripped } from "@/lib/drip-server.ts";

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
    const judgePass = configuredPass(process.env.DRIP_JUDGE_PASS);
    const decision = decideDrip({
      ...pre,
      nowMs: Date.now(),
      alreadyDripped: wasDripped(request.address),
      ...state,
      dailyCap: dailyCapFrom(process.env.DRIP_DAILY_CAP_MON, DEPLOYMENT.chainId),
      hourlyCap: hourlyCapFrom(process.env.DRIP_HOURLY_CAP_MON, DEPLOYMENT.chainId),
      lane: laneFor(request.pass, judgePass),
      reserve: judgePass !== undefined,
    });
    if (!decision.ok) return refusal(decision);
    if ("funded" in decision) return json(200, { dripped: false, reason: "FUNDED" });

    // a failed broadcast sent nothing; a failed wait for the receipt did send, and says so with the hash (202). The
    // errors themselves can carry RPC details, so only the outcome is answered.
    const settled = await settleDrip(
      () => broadcastDrip(request.address, decision.amount, state.wallet.nonce, state.maxFeePerGas),
      waitForDrip,
    );
    if (settled.sent && settled.receipt?.status !== "reverted") recordDrip(request.address, ip);
    const reply = dripReply(settled, decision.amount, explorerTx);
    return json(reply.status, reply.body);
  });
}

export function GET() {
  return json(405, { error: "BAD_REQUEST", message: "POST a signed drip request" });
}
