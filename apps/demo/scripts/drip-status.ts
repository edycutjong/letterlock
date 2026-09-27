// Read-only: the gas drip's budget now, read from Monad mainnet and counted by the route's own rules (lib/drip.ts):
// what the drip wallet holds, what left it in the last hour and the last 24 hours, what one drip costs at today's
// fees, and how many drips each lane has left. Sends nothing and needs no key.
//
//   node scripts/drip-status.ts          # a summary
//   node scripts/drip-status.ts --json   # the same, as JSON
//
// "public" is a request without the judges' pass; "judges" is one with it (apps/demo/README.md, the gas drip). The
// public lane's share of the day assumes DRIP_JUDGE_PASS is set in production, as it is.
import { createPublicClient, formatEther, http, type Address, type PublicClient } from "viem";
import { monad } from "viem/chains";
import { DAILY_CAP_WEI, DAY_SECONDS, HOURLY_CAP_WEI, HOUR_SECONDS, TRANSFER_GAS, dripAmount, publicDailyCap, spentInWindow } from "../lib/drip.ts";
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
const spentDay = spentInWindow({ balanceThen: day.balance, balanceNow: balance, nonceThen: day.nonce, nonceNow: nonce });
const spentHour = spentInWindow({ balanceThen: hour.balance, balanceNow: balance, nonceThen: hour.nonce, nonceNow: nonce });
const amount = dripAmount(gasPrice, bid);
const perDrip = amount + TRANSFER_GAS * fees.maxFeePerGas;
const left = (cap: bigint, spent: bigint) => (cap > spent ? Number((cap - spent) / perDrip) : 0);
const publicLeft = Math.min(left(publicDailyCap(DAILY_CAP_WEI, true), spentDay), left(HOURLY_CAP_WEI, spentHour));
const status = {
  wallet: DRIP_WALLET,
  head: Number(head),
  balance: formatEther(balance),
  nonce,
  inFlight: pending - nonce,
  oneDrip: { amount: formatEther(amount), withFee: formatEther(perDrip), gasPriceGwei: Number(gasPrice) / 1e9, bidGwei: Number(bid) / 1e9 },
  lastHour: { fromBlock: Number(hourBlock), drips: nonce - hour.nonce, spent: formatEther(spentHour), cap: formatEther(HOURLY_CAP_WEI) },
  last24h: {
    fromBlock: Number(dayBlock),
    drips: nonce - day.nonce,
    spent: formatEther(spentDay),
    cap: formatEther(DAILY_CAP_WEI),
    publicCap: formatEther(publicDailyCap(DAILY_CAP_WEI, true)),
    toppedUp: spentDay !== (day.balance > balance ? day.balance - balance : 0n),
  },
  dripsLeftNow: { public: publicLeft, judges: left(DAILY_CAP_WEI, spentDay) },
  walletRunway: Number(balance / perDrip),
};

if (process.argv.includes("--json")) console.log(JSON.stringify(status, null, 2));
else {
  console.log(`drip wallet ${status.wallet}: ${status.balance} MON at nonce ${nonce}${status.inFlight ? `, ${status.inFlight} in flight` : ""} (block ${status.head})`);
  console.log(`one drip: ${status.oneDrip.amount} MON, ${status.oneDrip.withFee} with its fee (gas price ${status.oneDrip.gasPriceGwei} gwei, the wallet's bid ${status.oneDrip.bidGwei} gwei)`);
  console.log(`last hour: ${status.lastHour.drips} drips, ${status.lastHour.spent} of ${status.lastHour.cap} MON (public lane)`);
  console.log(`last 24 h: ${status.last24h.drips} drips, ${status.last24h.spent} MON of ${status.last24h.cap} (public ${status.last24h.publicCap})${status.last24h.toppedUp ? "; a top-up in the window: each drip counted at its most" : ""}`);
  console.log(`drips left now: ${status.dripsLeftNow.public} public, ${status.dripsLeftNow.judges} with the judges' pass; the wallet pays for ${status.walletRunway} in all`);
}
