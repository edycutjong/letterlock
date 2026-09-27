// The gas drip's rules (lib/drip.ts): the signed request, its replay window, the amount, the one-drip-per-account rule
// and the daily cap, against real viem signatures. The drip wallet holds real MON, so every refusal is pinned here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { formatEther, parseEther, parseGwei } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DAILY_CAP_WEI,
  DRIP_CAP_WEI,
  MAX_OUT_PER_DRIP,
  MIN_OUT_PER_DRIP,
  PUBLISH_GAS,
  TRANSFER_GAS,
  WINDOW_MINUTES,
  checkMinute,
  dailyCapFrom,
  decideDrip,
  dripAmount,
  dripMessage,
  parseDripRequest,
  publishNeeds,
  spentInWindow,
  unixMinute,
  verifyDripSignature,
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
const MAX_FEE = parseGwei("122"); // viem's bid: base fee × 1.2 + tip

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
  wallet: { balance: parseEther("1"), nonce: 0, pendingNonce: 0, recentNonce: 0, dayAgo: { balance: parseEther("1"), nonce: 0 } },
  dailyCap: DAILY_CAP_WEI,
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

test("the drip is 1.5 × the measured publish gas at the current gas price, capped at 0.02 MON", () => {
  assert.equal(PUBLISH_GAS, 70_863n);
  assert.equal(dripAmount(GAS_PRICE), (70_863n * parseGwei("102") * 3n) / 2n);
  assert.equal(formatEther(dripAmount(GAS_PRICE)), "0.010842039");
  assert.equal(dripAmount(parseGwei("1000")), DRIP_CAP_WEI);
  assert.equal(formatEther(DRIP_CAP_WEI), "0.02");
  // at today's prices the drip pays for the publish at the fee cap viem bids, with room to spare
  assert.ok(dripAmount(GAS_PRICE) > publishNeeds(MAX_FEE));
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
  assert.ok(MIN_OUT_PER_DRIP < dripAmount(GAS_PRICE) + TRANSFER_GAS * GAS_PRICE, "a real drip is never below the minimum");
  assert.ok(MAX_OUT_PER_DRIP > DRIP_CAP_WEI + TRANSFER_GAS * MAX_FEE, "nor above the maximum");
});

test("a new, empty account with a valid signature gets exactly one publish's drip", async () => {
  const d = decideDrip(await observation());
  assert.equal(d.ok, true);
  if (d.ok && !("funded" in d)) {
    assert.equal(d.amount, dripAmount(GAS_PRICE));
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
  await refused({ gasPrice: parseGwei("400"), maxFeePerGas: parseGwei("480") }, "GAS_TOO_HIGH");
  await refused({ wallet: { ...good.wallet, pendingNonce: 1 } }, "DRIP_BUSY");
  await refused({ wallet: { ...good.wallet, nonce: 5, pendingNonce: 5, recentNonce: 4, dayAgo: { balance: parseEther("1.1"), nonce: 0 } } }, "DRIP_BUSY");
  await refused({ wallet: { ...good.wallet, balance: parseEther("0.01") } }, "DRIP_EMPTY");
  const { dayAgo: _, ...noHistory } = good.wallet;
  await refused({ wallet: noHistory }, "CAP_UNVERIFIABLE");
});

test("an account that already holds enough for a publish is told so, and nothing is sent", async () => {
  const d = decideDrip(await observation({ account: { hasKey: false, balance: publishNeeds(MAX_FEE), nonce: 0 } }));
  assert.deepEqual(d, { ok: true, amount: 0n, funded: true });
});

test("the daily cap counts every drip of the last 24 hours, fees included", async () => {
  const one = parseEther("1");
  const next = dripAmount(GAS_PRICE) + TRANSFER_GAS * MAX_FEE;
  // spent so far: exactly what leaves room for one more drip, then one wei more
  const room = DAILY_CAP_WEI - next;
  const wallet = (spent: bigint, drips: number) => ({ balance: one - spent, nonce: drips, pendingNonce: drips, recentNonce: drips, dayAgo: { balance: one, nonce: 0 } });
  assert.equal(decideDrip(await observation({ wallet: wallet(room, 38) })).ok, true);
  await refused({ wallet: wallet(room + 1n, 38) }, "DAILY_CAP");
  // a top-up inside the window cannot buy more drips than the cap allows at their maximum cost
  const topped = { balance: one + one, nonce: 13, pendingNonce: 13, recentNonce: 13, dayAgo: { balance: one, nonce: 0 } };
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
  const after = decideDrip(await observation({ request: r, account: { hasKey: false, balance: dripAmount(GAS_PRICE), nonce: 0 } }));
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
