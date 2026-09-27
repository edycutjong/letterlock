// The gas drip's rules (lib/drip.ts): the signed request, its replay window, the amount, the one-drip-per-account rule
// and the daily cap, against real viem signatures. The drip wallet holds real MON, so every refusal is pinned here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { formatEther, parseEther, parseGwei } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DAILY_CAP_WEI,
  DAY_SECONDS,
  DRIP_CAP_WEI,
  HOURLY_CAP_WEI,
  HOUR_SECONDS,
  JUDGE_RESERVE_PERCENT,
  MAX_OUT_PER_DRIP,
  MIN_OUT_PER_DRIP,
  PUBLISH_GAS,
  TRANSFER_GAS,
  WINDOW_MINUTES,
  checkMinute,
  configuredPass,
  dailyCapFrom,
  decideDrip,
  dripAmount,
  dripMessage,
  dripReply,
  hourlyCapFrom,
  laneFor,
  parseDripRequest,
  passMatches,
  publicDailyCap,
  publishNeeds,
  settleDrip,
  spentInWindow,
  unixMinute,
  verifyDripSignature,
  walletBid,
  type DripLane,
  type DripObservation,
  type DripRequest,
} from "../lib/drip.ts";

const NOW = Date.UTC(2026, 8, 27, 3, 0, 0);
const MAINNET = 143;
const account = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const signed = async (o: { by?: typeof account; address?: `0x${string}`; chainId?: number; minute?: number } = {}): Promise<DripRequest> => {
  const address = o.address ?? account.address;
  const chainId = o.chainId ?? MAINNET;
  const minute = o.minute ?? unixMinute(NOW);
  const signature = await (o.by ?? account).signMessage({ message: dripMessage(address, chainId, minute) });
  return { address, chainId, minute, signature };
};

const GAS_PRICE = parseGwei("102"); // eth_gasPrice on Monad mainnet, 2026-09-27: base fee 100 + tip 2
const MAX_FEE = parseGwei("122"); // the drip's own transfer: base fee x 1.2 + tip
const FILLED = parseGwei("152"); // eth_fillTransaction's maxFeePerGas on Monad mainnet, 2026-09-27
const BID = walletBid(FILLED); // what viem bids for the passkey account's publish: 182.4 gwei

/** A request that passes every rule: a new account, a healthy wallet with a quiet day behind it. */
const observation = async (over: Partial<DripObservation> = {}): Promise<DripObservation> => ({
  enabled: true,
  expectedChainId: MAINNET,
  nowMs: NOW,
  request: await signed(),
  signatureValid: true,
  ipAllowed: true,
  alreadyDripped: false,
  account: { hasKey: false, balance: 0n, nonce: 0 },
  gasPrice: GAS_PRICE,
  maxFeePerGas: MAX_FEE,
  bidFeePerGas: BID,
  wallet: {
    balance: parseEther("1"),
    nonce: 0,
    pendingNonce: 0,
    recentNonce: 0,
    dayAgo: { balance: parseEther("1"), nonce: 0 },
    hourAgo: { balance: parseEther("1"), nonce: 0 },
  },
  dailyCap: DAILY_CAP_WEI,
  hourlyCap: HOURLY_CAP_WEI,
  lane: "public",
  reserve: false,
  ...over,
});

const refused = async (over: Partial<DripObservation>, code: string) => {
  const d = decideDrip(await observation(over));
  assert.equal(d.ok, false, `expected ${code}`);
  if (!d.ok) assert.equal(d.code, code);
};

test("the message names the address (lower-case), the chain and the minute", () => {
  assert.equal(
    dripMessage("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", 143, 29841264),
    "letterlock-drip:0xabcdef0123456789abcdef0123456789abcdef01:143:29841264",
  );
});

test("a request is exactly { address, chainId, minute, signature } of the right types", async () => {
  const good = await signed();
  const ok = parseDripRequest({ ...good, address: good.address.toLowerCase() });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.request.address, account.address, "the address comes back checksummed");
  for (const bad of [
    null,
    [],
    "x",
    { ...good, extra: 1 },
    { ...good, address: "0x1234" },
    { ...good, chainId: "143" },
    { ...good, chainId: 1.5 },
    { ...good, minute: -1 },
    { ...good, minute: "29841264" },
    { ...good, signature: good.signature.slice(0, -2) },
    { ...good, signature: `${good.signature}00` },
    { ...good, signature: good.signature.replace("0x", "0X") },
  ]) {
    const r = parseDripRequest(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.equal(r.code, "BAD_REQUEST");
  }
});

test(`a signature is taken for ${WINDOW_MINUTES} minutes either side of the server's clock, and no longer`, () => {
  const m = unixMinute(NOW);
  for (const d of [-WINDOW_MINUTES, -1, 0, 1, WINDOW_MINUTES]) assert.equal(checkMinute(m + d, NOW), undefined, `${d}`);
  for (const d of [-WINDOW_MINUTES - 1, WINDOW_MINUTES + 1, -60 * 24]) assert.equal(checkMinute(m + d, NOW)?.code, "STALE_SIGNATURE", `${d}`);
});

test("only the account's own EIP-191 signature over this exact message verifies", async () => {
  assert.equal(await verifyDripSignature(await signed()), true);
  // someone else signing for the account
  assert.equal(await verifyDripSignature(await signed({ by: stranger })), false);
  // a valid signature moved to another chain, minute or address
  const r = await signed();
  assert.equal(await verifyDripSignature({ ...r, chainId: 10143 }), false);
  assert.equal(await verifyDripSignature({ ...r, minute: r.minute + 1 }), false);
  assert.equal(await verifyDripSignature({ ...r, address: stranger.address }), false);
  // a flipped byte
  const flipped = `${r.signature.slice(0, 10)}${r.signature[10] === "0" ? "1" : "0"}${r.signature.slice(11)}` as `0x${string}`;
  assert.equal(await verifyDripSignature({ ...r, signature: flipped }), false);
  // garbage that is the right length
  assert.equal(await verifyDripSignature({ ...r, signature: `0x${"00".repeat(65)}` }), false);
});

test("the drip covers the publish at the fee cap the wallet bids, never less than 1.5 x its gas at the gas price, capped at 0.02 MON", () => {
  assert.equal(PUBLISH_GAS, 70_863n);
  assert.equal(BID, parseGwei("182.4"), "viem multiplies the filled fee by 1.2");
  // the first live drip on mainnet was 1.5 x 70,863 x 102 gwei, and the RPC refused the publish that followed:
  // the account held less than 70,863 x 182.4 gwei ("Signer had insufficient balance")
  const byPrice = (70_863n * parseGwei("102") * 3n) / 2n;
  assert.equal(formatEther(byPrice), "0.010842039");
  assert.ok(byPrice < publishNeeds(BID), "1.5 x the gas price alone does not pay for the bid");
  assert.equal(formatEther(publishNeeds(BID)), "0.0129254112");
  // so the drip is the bid's need plus 10%
  assert.equal(dripAmount(GAS_PRICE, BID), (publishNeeds(BID) * 11n) / 10n);
  assert.equal(formatEther(dripAmount(GAS_PRICE, BID)), "0.01421795232");
  assert.ok(dripAmount(GAS_PRICE, BID) >= publishNeeds(BID));
  // where the wallet bids less than 1.5 x the gas price, the price rule decides
  assert.equal(dripAmount(GAS_PRICE, MAX_FEE), byPrice);
  // and never over the cap
  assert.equal(dripAmount(parseGwei("1000"), parseGwei("1000")), DRIP_CAP_WEI);
  assert.equal(formatEther(DRIP_CAP_WEI), "0.02");
});

test("the day's spend is the wallet's own balance difference, unless a top-up hides it", () => {
  const one = parseEther("1");
  assert.equal(spentInWindow({ balanceThen: one, balanceNow: one, nonceThen: 3, nonceNow: 3 }), 0n);
  // three drips of 0.013 MON: measured
  const three = parseEther("0.039");
  assert.equal(spentInWindow({ balanceThen: one, balanceNow: one - three, nonceThen: 0, nonceNow: 3 }), three);
  // three drips but the balance rose (topped up by 1 MON): counted at the most a drip can cost
  assert.equal(spentInWindow({ balanceThen: one, balanceNow: one + one - three, nonceThen: 0, nonceNow: 3 }), 3n * MAX_OUT_PER_DRIP);
  // a wallet first funded inside the window, with no drips yet
  assert.equal(spentInWindow({ balanceThen: 0n, balanceNow: one, nonceThen: 0, nonceNow: 0 }), 0n);
  assert.ok(MIN_OUT_PER_DRIP < dripAmount(GAS_PRICE, BID) + TRANSFER_GAS * GAS_PRICE, "a real drip is never below the minimum");
  assert.ok(MAX_OUT_PER_DRIP > DRIP_CAP_WEI + TRANSFER_GAS * MAX_FEE, "nor above the maximum");
});

test("a new, empty account with a valid signature gets exactly one publish's drip", async () => {
  const d = decideDrip(await observation());
  assert.equal(d.ok, true);
  if (d.ok && !("funded" in d)) {
    assert.equal(d.amount, dripAmount(GAS_PRICE, BID));
    assert.equal(d.fee, TRANSFER_GAS * MAX_FEE);
    assert.equal(d.spent, 0n);
  } else assert.fail("expected a drip");
});

test("each rule refuses on its own", async () => {
  const good = await observation();
  await refused({ enabled: false }, "DRIP_DISABLED");
  await refused({ expectedChainId: 10143 }, "WRONG_CHAIN");
  await refused({ nowMs: NOW + (WINDOW_MINUTES + 1) * 60_000 }, "STALE_SIGNATURE");
  await refused({ signatureValid: false }, "BAD_SIGNATURE");
  await refused({ ipAllowed: false }, "RATE_LIMITED");
  await refused({ alreadyDripped: true }, "ALREADY_DRIPPED");
  await refused({ account: { ...good.account, hasKey: true } }, "HAS_KEY");
  await refused({ account: { ...good.account, nonce: 1 } }, "NOT_NEW");
  await refused({ account: { ...good.account, balance: 1n } }, "ALREADY_FUNDED");
  await refused({ gasPrice: parseGwei("400"), maxFeePerGas: parseGwei("480"), bidFeePerGas: parseGwei("720") }, "GAS_TOO_HIGH");
  await refused({ wallet: { ...good.wallet, pendingNonce: 1 } }, "DRIP_BUSY");
  await refused({ wallet: { ...good.wallet, nonce: 5, pendingNonce: 5, recentNonce: 4, dayAgo: { balance: parseEther("1.1"), nonce: 0 } } }, "DRIP_BUSY");
  await refused({ wallet: { ...good.wallet, balance: parseEther("0.01") } }, "DRIP_EMPTY");
  const { dayAgo: _, ...noHistory } = good.wallet;
  await refused({ wallet: noHistory }, "CAP_UNVERIFIABLE");
});

test("an account that already holds enough for a publish is told so, and nothing is sent", async () => {
  const d = decideDrip(await observation({ account: { hasKey: false, balance: publishNeeds(BID), nonce: 0 } }));
  assert.deepEqual(d, { ok: true, amount: 0n, funded: true });
});

test("the daily cap counts every drip of the last 24 hours, fees included", async () => {
  const one = parseEther("1");
  const next = dripAmount(GAS_PRICE, BID) + TRANSFER_GAS * MAX_FEE;
  // spent so far: exactly what leaves room for one more drip, then one wei more
  const room = DAILY_CAP_WEI - next;
  // the day's drips were all more than an hour ago: only the daily cap is in play here
  const wallet = (spent: bigint, drips: number) => ({
    balance: one - spent,
    nonce: drips,
    pendingNonce: drips,
    recentNonce: drips,
    dayAgo: { balance: one, nonce: 0 },
    hourAgo: { balance: one - spent, nonce: drips },
  });
  assert.equal(decideDrip(await observation({ wallet: wallet(room, 28) })).ok, true);
  await refused({ wallet: wallet(room + 1n, 28) }, "DAILY_CAP");
  // a top-up inside the window cannot buy more drips than the cap allows at their maximum cost
  const topped = { balance: one + one, nonce: 13, pendingNonce: 13, recentNonce: 13, dayAgo: { balance: one, nonce: 0 }, hourAgo: { balance: one + one, nonce: 13 } };
  await refused({ wallet: topped }, "DAILY_CAP");
});

test("the cap is 0.5 MON; an environment variable can only lower it on mainnet", () => {
  assert.equal(formatEther(DAILY_CAP_WEI), "0.5");
  assert.equal(dailyCapFrom(undefined, 143), DAILY_CAP_WEI);
  assert.equal(dailyCapFrom("", 143), DAILY_CAP_WEI);
  assert.equal(dailyCapFrom("0.1", 143), parseEther("0.1"));
  assert.equal(dailyCapFrom("5", 143), DAILY_CAP_WEI);
  assert.equal(dailyCapFrom("not a number", 143), DAILY_CAP_WEI);
  assert.equal(dailyCapFrom("-1", 143), DAILY_CAP_WEI);
  assert.equal(dailyCapFrom("5", 10143), parseEther("5"));
});

test("a signed request replayed later is refused, however valid its signature", async () => {
  const r = await signed();
  assert.equal(await verifyDripSignature(r), true);
  await refused({ request: r, nowMs: NOW + 6 * 60_000 }, "STALE_SIGNATURE");
  // replayed inside the window after the drip landed: the account now holds MON, so the chain refuses it
  const after = decideDrip(await observation({ request: r, account: { hasKey: false, balance: dripAmount(GAS_PRICE, BID), nonce: 0 } }));
  assert.equal(after.ok && "funded" in after, true);
});

test("only the drip route imports the server module that holds the drip key", () => {
  const importers: string[] = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(f)) continue;
      const src = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8");
      if (/(from\s*|import\s*\(\s*)["'][^"']*drip-server(\.ts)?["']/.test(src)) importers.push(`${dir}/${f}`);
      if (/^\s*["']use client["']/.test(src)) assert.doesNotMatch(src, /LETTERLOCK_DRIP_PRIVATE_KEY|drip-server/, `${dir}/${f} is a client module`);
    }
  }
  assert.deepEqual(importers.sort(), ["app/api/drip/route.ts"]);
});

// ---- one scripted caller, many fresh accounts ------------------------------------------------------------------------
// Any fresh key passes every per-account rule, and the per-IP limits are per instance or per region, so what bounds a
// script that makes accounts in a loop is what the chain shows of the drip wallet: its spend over the last hour and the
// last day. Below, a script asks for a drip every second for a whole day, each time with the wallet's real history
// (every drip it got moved the balance and the nonce), and a judge comes last.

type Snapshot = { readonly t: number; readonly balance: bigint; readonly nonce: number };

/** The wallet's history, as the drip reads it: its state now, an hour ago and a day ago (seconds from the start). */
const ledger = (balance: bigint) => {
  const history: Snapshot[] = [{ t: -DAY_SECONDS * 2, balance, nonce: 0 }];
  const at = (t: number) => history.filter((h) => h.t <= t).at(-1)!;
  const state = (now: number): DripObservation["wallet"] => {
    const cur = history.at(-1)!;
    const day = at(now - DAY_SECONDS);
    const hour = at(now - HOUR_SECONDS);
    return {
      balance: cur.balance,
      nonce: cur.nonce,
      pendingNonce: cur.nonce,
      recentNonce: cur.nonce,
      dayAgo: { balance: day.balance, nonce: day.nonce },
      hourAgo: { balance: hour.balance, nonce: hour.nonce },
    };
  };
  const ask = async (now: number, lane: DripLane, reserve: boolean) => {
    const d = decideDrip(await observation({ lane, reserve, wallet: state(now) }));
    if (d.ok && !("funded" in d)) {
      const cur = history.at(-1)!;
      history.push({ t: now, balance: cur.balance - d.amount - d.fee, nonce: cur.nonce + 1 });
      return "dripped";
    }
    return d.ok ? "funded" : d.code;
  };
  return { ask };
};

const PER_DRIP = dripAmount(GAS_PRICE, BID) + TRANSFER_GAS * MAX_FEE; // what one drip takes out of the wallet today

test("a script asking with fresh accounts all day gets at most the hour's limit each hour, and a judge still gets a drip", async () => {
  const wallet = ledger(parseEther("1"));
  const perHour: number[] = [];
  const refusals = new Set<string>();
  for (let hour = 0; hour < 24; hour++) {
    let got = 0;
    for (let s = 0; s < 120; s++) {
      const r = await wallet.ask(hour * HOUR_SECONDS + s * 30, "public", true);
      if (r === "dripped") got++;
      else refusals.add(r);
    }
    perHour.push(got);
  }
  const hourMax = Number(HOURLY_CAP_WEI / PER_DRIP);
  const dayMax = Number(publicDailyCap(DAILY_CAP_WEI, true) / PER_DRIP);
  assert.ok(perHour.every((n) => n <= hourMax), `at most ${hourMax} drips an hour: ${perHour.join(",")}`);
  assert.equal(perHour.reduce((a, b) => a + b, 0), dayMax, "the public lane stops at 70% of the day's cap");
  assert.ok(perHour[0]! < Number(DAILY_CAP_WEI / PER_DRIP), "the first hour's burst does not take the day");
  assert.deepEqual([...refusals].sort(), ["DAILY_CAP", "HOURLY_CAP"]);
  // the script has spent all the public may; the judges' link still gets a drip, and then as many as the reserve holds
  const end = 24 * HOUR_SECONDS - 60;
  assert.equal(await wallet.ask(end, "public", true), "DAILY_CAP");
  let judges = 0;
  while ((await wallet.ask(end + judges, "judge", true)) === "dripped") judges++;
  assert.equal(judges, Number(DAILY_CAP_WEI / PER_DRIP) - dayMax, "the reserve pays the rest of the day's cap to judges only");
  assert.ok(judges >= 8, `${judges} judges' drips are kept`);
});

test("without a judges' pass configured, the public lane may spend the whole day's cap, an hour's limit at a time", async () => {
  const wallet = ledger(parseEther("1"));
  let got = 0;
  for (let hour = 0; hour < 24; hour++) for (let s = 0; s < 60; s++) if ((await wallet.ask(hour * HOUR_SECONDS + s * 60, "public", false)) === "dripped") got++;
  assert.equal(got, Number(DAILY_CAP_WEI / PER_DRIP));
});

test("the judges' lane is bound by the daily cap, not by the hour's limit", async () => {
  const wallet = ledger(parseEther("1"));
  let got = 0;
  for (let s = 0; s < 60; s++) if ((await wallet.ask(s, "judge", true)) === "dripped") got++;
  assert.equal(got, Number(DAILY_CAP_WEI / PER_DRIP), "a burst of judges' requests is not held to the hour");
  assert.ok(got > Number(HOURLY_CAP_WEI / PER_DRIP));
  assert.equal(await wallet.ask(61, "judge", true), "DAILY_CAP");
});

test("the hour's limit is read from the chain: no hour-old state, no public drip; the judges' lane does not need it", async () => {
  const good = await observation();
  const { hourAgo: _, ...noHour } = good.wallet;
  await refused({ wallet: noHour }, "CAP_UNVERIFIABLE");
  const judge = decideDrip(await observation({ wallet: noHour, lane: "judge", reserve: true }));
  assert.equal(judge.ok, true);
  // an hour that already spent its limit refuses the next public drip, whatever the day's spend
  const one = parseEther("1");
  await refused({ wallet: { ...good.wallet, balance: one - HOURLY_CAP_WEI, nonce: 6, pendingNonce: 6, recentNonce: 6, hourAgo: { balance: one, nonce: 0 } } }, "HOURLY_CAP");
});

test("the judges' pass: long enough to reserve anything, compared whole, and anything else is the public's lane", () => {
  const pass = "Jd7mQ2xLp9Rt4Vw8Zb3Nc6";
  assert.equal(configuredPass(undefined), undefined);
  assert.equal(configuredPass(""), undefined);
  assert.equal(configuredPass("short-pass"), undefined, "under 16 characters reserves nothing");
  assert.equal(configuredPass(`  ${pass}\n`), pass);
  assert.equal(laneFor(pass, pass), "judge");
  for (const wrong of [undefined, "", pass.slice(0, -1), `${pass}x`, pass.toLowerCase(), pass.replace("J", "K")]) {
    assert.equal(passMatches(wrong, pass), false, JSON.stringify(wrong));
    assert.equal(laneFor(wrong, pass), "public");
  }
  assert.equal(laneFor(pass, undefined), "public", "no pass configured: everyone is the public");
  assert.equal(publicDailyCap(DAILY_CAP_WEI, false), DAILY_CAP_WEI);
  assert.equal(publicDailyCap(DAILY_CAP_WEI, true), (DAILY_CAP_WEI * (100n - JUDGE_RESERVE_PERCENT)) / 100n);
  assert.equal(formatEther(publicDailyCap(DAILY_CAP_WEI, true)), "0.35");
});

test("a request may carry the judges' pass, a string of at most 128 characters", async () => {
  const good = await signed();
  const ok = parseDripRequest({ ...good, pass: "Jd7mQ2xLp9Rt4Vw8Zb3Nc6" });
  assert.equal(ok.ok && ok.request.pass, "Jd7mQ2xLp9Rt4Vw8Zb3Nc6");
  const none = parseDripRequest(good);
  assert.equal(none.ok && "pass" in none.request, false);
  for (const pass of [42, null, { p: 1 }, "x".repeat(129)]) {
    const r = parseDripRequest({ ...good, pass });
    assert.equal(r.ok ? "ok" : r.code, "BAD_REQUEST", JSON.stringify(pass));
  }
});

test("the hour's limit is 0.1 MON; an environment variable can only lower it on mainnet", () => {
  assert.equal(formatEther(HOURLY_CAP_WEI), "0.1");
  assert.equal(hourlyCapFrom(undefined, 143), HOURLY_CAP_WEI);
  assert.equal(hourlyCapFrom("0.05", 143), parseEther("0.05"));
  assert.equal(hourlyCapFrom("5", 143), HOURLY_CAP_WEI);
  assert.equal(hourlyCapFrom("nope", 143), HOURLY_CAP_WEI);
  assert.equal(hourlyCapFrom("2", 10143), parseEther("2"));
});

// ---- a sent drip is never reported as not sent ------------------------------------------------------------------------

const HASH = `0x${"ab".repeat(32)}` as const;
const explorer = (h: string) => `https://monadvision.com/tx/${h}`;

test("a drip whose broadcast failed sent nothing, and says so", async () => {
  const s = await settleDrip(() => Promise.reject(new Error("rpc refused: insufficient funds")), () => assert.fail("no wait after a failed broadcast"));
  assert.deepEqual(s, { sent: false });
  const r = dripReply(s, parseEther("0.014"), explorer);
  assert.equal(r.status, 502);
  assert.equal(r.body.error, "SEND_FAILED");
  assert.match(String(r.body.message), /nothing was sent/);
});

test("a drip broadcast whose receipt could not be read answers 202 with its hash, never 'nothing was sent'", async () => {
  const s = await settleDrip(() => Promise.resolve(HASH), () => Promise.reject(new Error("timed out waiting for the receipt")));
  assert.deepEqual(s, { sent: true, transactionHash: HASH });
  const r = dripReply(s, parseEther("0.01421795232"), explorer);
  assert.equal(r.status, 202);
  assert.equal(r.body.dripped, true, "the page waits for the MON, as after a 200");
  assert.equal(r.body.transactionHash, HASH);
  assert.equal(r.body.explorer, explorer(HASH));
  assert.equal(r.body.amount, "0.01421795232");
  assert.doesNotMatch(JSON.stringify(r.body), /nothing was sent/);
});

test("a drip that landed answers 200 with its block; one that reverted answers 502 with its hash", async () => {
  const ok = dripReply(await settleDrip(() => Promise.resolve(HASH), () => Promise.resolve({ status: "success", blockNumber: 108_359_720n })), parseEther("0.014"), explorer);
  assert.deepEqual([ok.status, ok.body.dripped, ok.body.blockNumber, ok.body.transactionHash], [200, true, 108_359_720, HASH]);
  const reverted = dripReply(await settleDrip(() => Promise.resolve(HASH), () => Promise.resolve({ status: "reverted", blockNumber: 1n })), parseEther("0.014"), explorer);
  assert.deepEqual([reverted.status, reverted.body.error, reverted.body.transactionHash], [502, "SEND_FAILED", HASH]);
});

// ---- the firewall -------------------------------------------------------------------------------------------------

test("Vercel's firewall limits POST /api/drip per IP for every instance, and lets one create's retries through", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel-firewall.json", import.meta.url), "utf8")) as {
    firewallEnabled: boolean;
    rules: { active: boolean; conditionGroup: { conditions: { type: string; op: string; value: string }[] }[]; action: { mitigate: { action: string; rateLimit: { algo: string; window: number; limit: number; keys: string[] } } } }[];
  };
  assert.equal(config.firewallEnabled, true);
  const limits = config.rules.filter((r) => r.active && r.action.mitigate.action === "rate_limit");
  assert.equal(limits.length, 1, "the Hobby plan allows one rate-limit rule per project");
  const [rule] = limits;
  const conditions = rule!.conditionGroup.flatMap((g) => g.conditions);
  assert.deepEqual(conditions.map((c) => `${c.type} ${c.op} ${c.value}`).sort(), ["method eq POST", "path eq /api/drip"]);
  const { rateLimit } = rule!.action.mitigate;
  assert.deepEqual(rateLimit.keys, ["ip"]);
  assert.ok(rateLimit.window <= 600, "the Hobby plan's longest window is 10 minutes");
  // lib/gas.ts asks a busy drip again up to 5 times: one create sends at most 6 POSTs
  const gas = readFileSync(new URL("../lib/gas.ts", import.meta.url), "utf8");
  const retries = Number(/body\.error === "DRIP_BUSY" && attempt < (\d+)/.exec(gas)?.[1]);
  assert.equal(rateLimit.limit, retries + 1, "the limit is one create's worth of requests");
});
