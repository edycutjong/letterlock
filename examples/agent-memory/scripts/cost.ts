#!/usr/bin/env node
// What the agent's drops cost now, and what its wallet allows: read-only, nothing is signed or sent. Run it before and
// after a refill, and when the network's fee moves; README.md, "Limits" and "Running it during judging", quotes it.
//
//   node scripts/cost.ts [--chain monad|monad-testnet] [--wallet 0x…] [--to 0x…|agent:<id>] [--rpc URL]
//
// --wallet  the agent's wallet (default: the mainnet agent's, 0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4)
// --to      any recipient with a published key, to estimate drops to (default: the mainnet deployer, whose key is the
//           deploy smoke test's DEMO KEY). eth_estimateGas runs from the agent's wallet: a drop needs a keyed recipient.
//
// It seals, with the SDK, the largest note POST /remember takes (1,000 four-byte characters), a 1,000-character ASCII
// note, and the largest answer POST /task sends (a task of 1,000 control characters, answered by src/task.ts), then
// asks eth_estimateGas for each drop.
import { pathToFileURL } from "node:url";
import { DEPLOYMENTS, NO_AGENT, canonicalRecipient, encodeEnvelope, letterlock, letterlockAbi, seal, toAgentId, type LetterlockChain } from "letterlock";
import { bytesToHex, createPublicClient, encodeFunctionData, formatEther, formatGwei, http, zeroAddress, type Address } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { DEFAULT_LIMITS } from "../src/config.ts";
import { dropsAllowedToday } from "../src/spend.ts";
import { buildReply, encodeReply, newNonce } from "../src/task.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const chain = (arg("chain") ?? "monad") as LetterlockChain;
  const wallet = (arg("wallet") ?? "0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4") as Address;
  const to = canonicalRecipient(arg("to") ?? "0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3");
  const rpcUrl = arg("rpc") ?? DEPLOYMENTS[chain].rpcUrl;
  const ll = letterlock({ chain, rpcUrl });
  const pub = createPublicClient({ chain: chain === "monad" ? monad : monadTestnet, transport: http(rpcUrl) });
  const key = await ll.resolve(to);

  const estimate = async (plaintext: Uint8Array) => {
    const envelope = await seal({ chainId: ll.chainId, directory: ll.directory, to: key, plaintext });
    const agent = to.startsWith("agent:");
    const args = [agent ? zeroAddress : (to as Address), agent ? toAgentId(to) : NO_AGENT, bytesToHex(encodeEnvelope(envelope))] as const;
    const gas = await pub.estimateContractGas({ account: wallet, address: ll.directory, abi: letterlockAbi, functionName: "drop", args });
    return { bytes: encodeEnvelope(envelope).length, gas, data: encodeFunctionData({ abi: letterlockAbi, functionName: "drop", args }) };
  };
  const now = Math.floor(Date.now() / 1000);
  const reply = buildReply({
    agent: "agent:10260",
    task: { v: 1, replyTo: to, nonce: newNonce(), issuedAt: now, text: "\u0001".repeat(1000) },
    sealedTo: { recipient: "agent:10260", epoch: 2, kid: "e5b30e2e52ec0dec" },
    openedAt: now,
  });

  const [head, gasPrice, balance, nonce, largest, ascii, task] = await Promise.all([
    pub.getBlock({ blockTag: "latest" }),
    pub.getGasPrice(),
    pub.getBalance({ address: wallet }),
    pub.getTransactionCount({ address: wallet }),
    estimate(new TextEncoder().encode("\u{1F512}".repeat(1000))),
    estimate(new TextEncoder().encode("a".repeat(1000))),
    estimate(encodeReply(reply)),
  ]);
  // the fee cap viem signs a drop with (on Monad, eth_fillTransaction's × 1.2): what the wallet must hold, and what
  // the reserve check counts
  const filled = await pub.prepareTransactionRequest({ account: wallet, to: ll.directory, data: ascii.data, parameters: ["fees"] });
  const base = head.baseFeePerGas ?? 0n;
  const feeCap = filled.maxFeePerGas ?? gasPrice;
  const l = DEFAULT_LIMITS;
  const mon = (wei: bigint) => `${formatEther(wei)} MON`;
  // what a drop pays per gas (the base fee plus the priority fee: eth_gasPrice), and the most it can cost (its fee cap)
  const drop = (d: { bytes: number; gas: bigint }) => ({ bytes: d.bytes, gas: Number(d.gas), paid: mon(d.gas * gasPrice), atFeeCap: mon(d.gas * feeCap) });
  const allowed = dropsAllowedToday(l, { balance, used: 0, gasPrice });
  console.log(
    JSON.stringify(
      {
        chain: `${DEPLOYMENTS[chain].network} (${ll.chainId})`,
        block: Number(head.number),
        at: new Date(Number(head.timestamp) * 1000).toISOString(),
        fee: { baseFeeGwei: formatGwei(base), paidGwei: formatGwei(gasPrice), feeCapSignedGwei: formatGwei(feeCap) },
        wallet: { address: wallet, balance: mon(balance), nonce },
        drops: {
          rememberLargest: drop(largest),
          remember1000Ascii: drop(ascii),
          taskAnswerLargest: drop(task),
        },
        limits: {
          maxDropGas: Number(l.maxDropGas),
          largestFitsTheCap: largest.gas <= l.maxDropGas && task.gas <= l.maxDropGas,
          mostOneDropCosts: mon(l.maxDropGas * gasPrice),
          mostOneDropCanCostAtItsFeeCap: mon(l.maxDropGas * feeCap),
          reserve: mon(l.minBalanceWei),
          dailySpendPercent: l.dailySpendPercent,
          dropsAllowedIfTodayStartedNow: allowed,
          worstDaySpend: mon(BigInt(allowed) * largest.gas * gasPrice),
          walletFor150Drops: mon((BigInt(l.dailyDrops) * l.maxDropGas * gasPrice * 100n) / BigInt(l.dailySpendPercent)),
        },
      },
      null,
      2,
    ),
  );
}
