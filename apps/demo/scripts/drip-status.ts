// Read-only: the gas drip's budget now, read from Monad mainnet and counted by the route's own rule (lib/drip.ts):
// what the drip wallet holds, what the last hour and the last 24 hours count for, what one drip costs at today's fees,
// and how many drips each lane has left. The drips left are found by stepping decideDrip() itself forward from the
// chain's state, one drip at a time, so they are the drips the route would pay. Sends nothing and needs no key.
//
//   node scripts/drip-status.ts          # a summary
//   node scripts/drip-status.ts --json   # the same, as JSON
//
// "public" is a request without the judges' pass; "judges" is one with it (apps/demo/README.md, the gas drip). The
// public lane's share of the day assumes DRIP_JUDGE_PASS is set in production, as it is. Each lane's figure assumes
// the other lane takes nothing meanwhile: they share the day's cap.
import { createPublicClient, formatEther, http, type Address, type PublicClient } from "viem";
import { monad } from "viem/chains";
import {
  DAILY_CAP_WEI,
  DAY_SECONDS,
  HOURLY_CAP_WEI,
  HOUR_SECONDS,
  TRANSFER_GAS,
  dripAmount,
  dripsLeft,
  publicDailyCap,
  spentInWindow,
  unixMinute,
  type DripLane,
  type DripObservation,
} from "../lib/drip.ts";
import { walletBidFeePerGas } from "../lib/fees.ts";
import { blocksAgo } from "../lib/past-blocks.ts";

const DRIP_WALLET: Address = "0x679f4d96bB36fE383110E3Ef6F46daAf92fb315b";
const client = (url: string) => createPublicClient({ chain: monad, transport: http(url, { timeout: 15_000 }) }) as PublicClient;
const main = client("https://rpc.monad.xyz");
const history = client("https://rpc1.monad.xyz");

/** Balance and nonce at a past block, from whichever RPC still holds it (the route reads the same way). */
const at = async (blockNumber: bigint) => {
  for (const c of [main, history]) {
    try {
      const [balance, nonce] = await Promise.all([c.getBalance({ address: DRIP_WALLET, blockNumber }), c.getTransactionCount({ address: DRIP_WALLET, blockNumber })]);
      return { balance, nonce };
    } catch {
      // not held by this RPC: the next one
    }
  }
  throw new Error(`no RPC holds block ${blockNumber}: the route would refuse (CAP_UNVERIFIABLE)`);
};

const [head, balance, nonce, pending, gasPrice, fees, bid, [dayBlock, hourBlock]] = await Promise.all([
  main.getBlockNumber({ cacheTime: 0 }),
  main.getBalance({ address: DRIP_WALLET }),
  main.getTransactionCount({ address: DRIP_WALLET }),
  main.getTransactionCount({ address: DRIP_WALLET, blockTag: "pending" }),
  main.getGasPrice(),
  main.estimateFeesPerGas(),
  walletBidFeePerGas(main, DRIP_WALLET),
  blocksAgo(main, [DAY_SECONDS, HOUR_SECONDS]),
]);
const [day, hour] = await Promise.all([at(dayBlock!), at(hourBlock!)]);
const amount = dripAmount(gasPrice, bid);
// what the route adds for a drip (its transfer's gas at the fee cap), and what a drip is charged (at the gas price)
const perDrip = amount + TRANSFER_GAS * fees.maxFeePerGas;
const charged = amount + TRANSFER_GAS * (gasPrice < fees.maxFeePerGas ? gasPrice : fees.maxFeePerGas);
const spentDay = spentInWindow({ balanceThen: day.balance, balanceNow: balance, nonceThen: day.nonce, nonceNow: nonce, perDrip });
const spentHour = spentInWindow({ balanceThen: hour.balance, balanceNow: balance, nonceThen: hour.nonce, nonceNow: nonce, perDrip });

/** The route's observation for a new account asking now, in `lane`, with the chain's state as read above. */
const now = Date.now();
const asking = (lane: DripLane): DripObservation => ({
  enabled: true,
  expectedChainId: 143,
  nowMs: now,
  request: { address: "0x0000000000000000000000000000000000000001", chainId: 143, minute: unixMinute(now), signature: "0x" },
  signatureValid: true,
  ipAllowed: true,
  alreadyDripped: false,
  account: { hasKey: false, balance: 0n, nonce: 0 },
  gasPrice,
  maxFeePerGas: fees.maxFeePerGas,
  bidFeePerGas: bid,
  wallet: { balance, nonce, pendingNonce: nonce, recentNonce: nonce, dayAgo: day, hourAgo: hour },
  dailyCap: DAILY_CAP_WEI,
  hourlyCap: HOURLY_CAP_WEI,
  lane,
  reserve: true,
});

/** The balance's change over a window, signed: MON that came in (the funding, a top-up, anyone's transfer) shows here. */
const change = (then: bigint) => (balance >= then ? "+" : "-") + formatEther(balance >= then ? balance - then : then - balance);
// the most the public lane can take in one hour at today's fees, from a quiet hour
const quiet = asking("public");
const hourMax = dripsLeft({ ...quiet, wallet: { ...quiet.wallet, dayAgo: { balance, nonce }, hourAgo: { balance, nonce } } }, charged);

const status = {
  wallet: DRIP_WALLET,
  head: Number(head),
  balance: formatEther(balance),
  nonce,
  inFlight: pending - nonce,
  oneDrip: { amount: formatEther(amount), counted: formatEther(perDrip), charged: formatEther(charged), gasPriceGwei: Number(gasPrice) / 1e9, bidGwei: Number(bid) / 1e9 },
  lastHour: { fromBlock: Number(hourBlock), drips: nonce - hour.nonce, balanceChange: change(hour.balance), counted: formatEther(spentHour), cap: formatEther(HOURLY_CAP_WEI) },
  last24h: {
    fromBlock: Number(dayBlock),
    drips: nonce - day.nonce,
    balanceChange: change(day.balance),
    counted: formatEther(spentDay),
    cap: formatEther(DAILY_CAP_WEI),
    publicCap: formatEther(publicDailyCap(DAILY_CAP_WEI, true)),
  },
  dripsLeft: {
    publicThisHour: dripsLeft(quiet, charged),
    publicToday: dripsLeft(quiet, charged, { newHourEachDrip: true }),
    publicPerHour: hourMax,
    judges: dripsLeft(asking("judge"), charged),
  },
  walletRunway: Number(balance / charged),
};

if (process.argv.includes("--json")) console.log(JSON.stringify(status, null, 2));
else {
  const d = status.dripsLeft;
  console.log(`drip wallet ${status.wallet}: ${status.balance} MON at nonce ${nonce}${status.inFlight ? `, ${status.inFlight} in flight` : ""} (block ${status.head})`);
  console.log(`one drip: ${status.oneDrip.amount} MON, counted as ${status.oneDrip.counted} with its transfer's fee cap, charged about ${status.oneDrip.charged} (gas price ${status.oneDrip.gasPriceGwei} gwei, the wallet's bid ${status.oneDrip.bidGwei} gwei)`);
  console.log(`last hour: ${status.lastHour.drips} drips, balance ${status.lastHour.balanceChange} MON, counted as ${status.lastHour.counted} of ${status.lastHour.cap} MON (public lane)`);
  console.log(`last 24 h: ${status.last24h.drips} drips, balance ${status.last24h.balanceChange} MON, counted as ${status.last24h.counted} of ${status.last24h.cap} MON (public ${status.last24h.publicCap})`);
  console.log(`drips the route would pay now: ${d.publicThisHour} public this hour, ${d.publicToday} public in the day (at most ${d.publicPerHour} an hour), ${d.judges} with the judges' pass; the wallet holds ${status.walletRunway} in all`);
}
