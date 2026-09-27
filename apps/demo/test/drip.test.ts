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
  dripsLeft,
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
/** What one drip counts for today: its amount, and its transfer's gas at the fee cap (0.01677995232 MON). */
const PER_DRIP = dripAmount(GAS_PRICE, BID) + TRANSFER_GAS * MAX_FEE;
/** What one drip is charged: its transfer's gas at the price paid, 102 gwei (0.01635995232 MON, as the chain showed). */
const CHARGED = dripAmount(GAS_PRICE, BID) + TRANSFER_GAS * GAS_PRICE;

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

test("the window's spend counts the wallet's drips at today's cost, or its balance difference when that is more", () => {
  const one = parseEther("1");
  const window = (balanceNow: bigint, drips: number, balanceThen = one) => spentInWindow({ balanceThen, balanceNow, nonceThen: 0, nonceNow: drips, perDrip: PER_DRIP });
  assert.equal(window(one, 0), 0n);
  // three drips, charged at the gas price: counted at today's cost with the transfer's fee cap, a little more
  assert.equal(window(one - 3n * CHARGED, 3), 3n * PER_DRIP);
  assert.ok(3n * PER_DRIP > 3n * CHARGED);
  // three drips sent while fees were higher: the balance moved more than today's cost, and that counts
  assert.equal(window(one - parseEther("0.06"), 3), parseEther("0.06"));
  // a wallet first funded inside the window: its drips count, its funding does not hide them
  assert.equal(window(one, 0, 0n), 0n);
  assert.equal(window(one - 2n * CHARGED, 2, 0n), 2n * PER_DRIP);
  // a drip never counts for less than at Monad's minimum base fee, so a day admits at most 39, whatever the fees
  assert.equal(spentInWindow({ balanceThen: one, balanceNow: one, nonceThen: 0, nonceNow: 1, perDrip: 1n }), MIN_OUT_PER_DRIP);
  assert.equal(Number(DAILY_CAP_WEI / MIN_OUT_PER_DRIP), 39);
  assert.ok(MIN_OUT_PER_DRIP < CHARGED, "a real drip is never below the minimum");
});

test("MON sent to the drip wallet never raises the window's spend, and never hides a drip", () => {
  const one = parseEther("1");
  const after12 = one - 12n * CHARGED;
  const spent = (came: bigint) => spentInWindow({ balanceThen: one, balanceNow: after12 + came, nonceThen: 0, nonceNow: 12, perDrip: PER_DRIP });
  // anyone can send MON to it: a wei, the 0.045 MON that four dripped accounts could send back, a 1 MON top-up
  for (const came of [0n, 1n, parseEther("0.045"), parseEther("0.2"), one]) {
    assert.ok(spent(came) <= spent(0n), `${formatEther(came)} MON sent in raised the spend`);
    assert.equal(spent(came), 12n * PER_DRIP, `${formatEther(came)} MON sent in hid a drip`);
  }
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
  // a top-up inside the window hides no drip: they are counted, so the day still stops at 29 drips at today's fees
  const topped = (drips: number) => ({ balance: one + one, nonce: drips, pendingNonce: drips, recentNonce: drips, dayAgo: { balance: one, nonce: 0 }, hourAgo: { balance: one + one, nonce: drips } });
  assert.equal(decideDrip(await observation({ wallet: topped(28) })).ok, true);
  await refused({ wallet: topped(29) }, "DAILY_CAP");
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
// last day. Below, a script asks for a drip every 30 seconds for a whole day, each time with the wallet's real history
// (every drip it got moved the balance and the nonce, charged at the gas price as on chain), and a judge comes last.

type Snapshot = { readonly t: number; readonly balance: bigint; readonly nonce: number };

/** The wallet's history, as the drip reads it: its state now, an hour ago and a day ago (seconds from the start). */
const ledger = (balance: bigint, startNonce = 0) => {
  const history: Snapshot[] = [{ t: -DAY_SECONDS * 2, balance, nonce: startNonce }];
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
  /** A new account asks at `now`: what the route would answer, and the drip's transfer when it pays. */
  const ask = async (now: number, lane: DripLane, reserve: boolean) => {
    const d = decideDrip(await observation({ lane, reserve, wallet: state(now) }));
    if (d.ok && !("funded" in d)) {
      const cur = history.at(-1)!;
      history.push({ t: now, balance: cur.balance - d.amount - TRANSFER_GAS * GAS_PRICE, nonce: cur.nonce + 1 });
      return "dripped";
    }
    return d.ok ? "funded" : d.code;
  };
  /** MON sent TO the wallet at `now`, by anyone: the balance rises, the nonce does not move. */
  const receive = (now: number, amount: bigint) => {
    const cur = history.at(-1)!;
    history.push({ t: now, balance: cur.balance + amount, nonce: cur.nonce });
  };
  return { ask, receive, state };
};

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
  // five an hour at today's fees (each drip counted at its transfer's fee cap, not the lower price it is charged:
  // counted at the charge, the hour paid six), and twenty in the day
  assert.deepEqual([hourMax, dayMax], [5, 20]);
  assert.ok(perHour.every((n) => n <= hourMax), `at most ${hourMax} drips an hour: ${perHour.join(",")}`);
  assert.equal(perHour[0], hourMax, "the first hour pays its limit");
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

test("MON sent to the drip wallet cannot shut the judges' lane: 12 public drips, then 0.045 MON sent in, and judges get drips all day", async () => {
  // the wallet as it is on mainnet: 0.97 MON after its first two transfers
  const wallet = ledger(parseEther("0.97"), 2);
  // a script takes 12 public drips with fresh accounts, one request every 30 s
  let got = 0;
  let t = 0;
  for (; got < 12; t += 30) if ((await wallet.ask(t, "public", true)) === "dripped") got++;
  // then four of those accounts send 0.045 MON back: the balance rises, the nonce does not move
  wallet.receive(t, parseEther("0.045"));
  // counted at the most a drip can cost after a rise in the balance, 12 x 0.041 MON left no room in the day for these
  for (const h of [3, 6, 12, 18, 22]) assert.equal(await wallet.ask(h * HOUR_SECONDS, "judge", true), "dripped", `a judge at +${h} h`);
  // and the public lane keeps the rest of its share: it stops once the day's drips (every lane's) reach 70% of the cap,
  // 20 at today's fees, and 12 + 5 are taken
  let more = 0;
  for (let s = 0; s < 40; s++) if ((await wallet.ask(23 * HOUR_SECONDS + s * 30, "public", true)) === "dripped") more++;
  assert.equal(more, 3);
});

test("a top-up inside the day buys no drip beyond the day's cap: the drips are counted, not the balance", async () => {
  const wallet = ledger(parseEther("1"));
  for (let i = 0; i < 13; i++) assert.equal(await wallet.ask(i, "judge", true), "dripped");
  wallet.receive(100, parseEther("1"));
  let more = 0;
  while ((await wallet.ask(200 + more, "judge", true)) === "dripped") more++;
  assert.equal(13 + more, Number(DAILY_CAP_WEI / PER_DRIP), "29 in the day at today's fees, top-up or not");
  assert.equal(13 + more, 29);
});

test("dripsLeft() is what the route pays: stepping its rule forward predicts each lane's drips from the chain's state", async () => {
  // 12 public drips over two hours, then MON sent in; the figures are read at 2 h 30 min, as scripts/drip-status.ts reads them
  for (const lane of ["public", "judge"] as const) {
    const wallet = ledger(parseEther("0.97"), 2);
    let got = 0;
    for (let t = 0; got < 12; t += 30) if ((await wallet.ask(t, "public", true)) === "dripped") got++;
    const T = 2 * HOUR_SECONDS + 30 * 60;
    wallet.receive(T - 60, parseEther("0.045"));
    const o = await observation({ lane, reserve: true, wallet: wallet.state(T) });
    const predicted = { now: dripsLeft(o, CHARGED), day: dripsLeft(o, CHARGED, { newHourEachDrip: true }) };
    // the route, asked by new accounts one second apart
    let burst = 0;
    while ((await wallet.ask(T + burst, lane, true)) === "dripped") burst++;
    assert.equal(predicted.now, burst, `${lane}: predicted ${predicted.now} now, the route paid ${burst}`);
    if (lane === "public") {
      assert.equal(burst, 3, "two drips in the last hour leave three in it");
      assert.equal(predicted.day, 8, "the public's 20, less the 12 taken");
      // spread over the hours that follow, the route pays exactly the day's figure
      let spread = burst;
      for (let h = 1; h < 20; h++) if ((await wallet.ask(T + h * HOUR_SECONDS, lane, true)) === "dripped") spread++;
      assert.equal(spread, predicted.day);
    } else {
      assert.equal(burst, 17, "the judges' lane: the day's 29, less the 12 taken");
      assert.equal(predicted.day, predicted.now, "the judges' lane is not held to the hour");
    }
  }
});

test("DRIP_HOURLY_CAP_MON=0 switches the public lane off and leaves the judges' link paying", async () => {
  const off = hourlyCapFrom("0", 143);
  assert.equal(off, 0n);
  await refused({ hourlyCap: off, reserve: true }, "HOURLY_CAP");
  assert.equal(decideDrip(await observation({ hourlyCap: off, lane: "judge", reserve: true })).ok, true);
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
