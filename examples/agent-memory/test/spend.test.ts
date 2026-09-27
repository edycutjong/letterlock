// The spend policy on its own (src/spend.ts): the day's allowance, the order of the checks, and the guarded wallet's
// refusal of anything but a drop. The same checks against a chain are test/spend-race.test.ts.
import { LetterlockError, letterlockAbi } from "letterlock";
import { BaseError, encodeFunctionData, parseEther, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/config.ts";
import { DROP_SELECTOR, SpendRefused, dropsAllowedToday, guardedWallet, paidPerGas, refusal, spendRefusalIn, type SpendState } from "../src/spend.ts";

const GWEI = 1_000_000_000n;
const DIRECTORY = "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e" as const;
const RESETS = Date.UTC(2026, 8, 28);
const l = DEFAULT_LIMITS;

describe("dropsAllowedToday", () => {
  it("on Monad mainnet on 2026-09-27 (0.988393318 MON; drops pay 102 gwei per gas): 9 drops, at most 0.0255 MON each", () => {
    expect(dropsAllowedToday(l, { balance: 988_393_318_000_000_000n, used: 0, gasPrice: 102n * GWEI })).toBe(9);
  });

  it("never lets the day's drops, at the most a drop can cost, exceed the share of what the wallet held", () => {
    for (const [balance, price, percent] of [[10n ** 18n, 102n, 25], [5n * 10n ** 18n, 100n, 25], [123_456_789n * GWEI, 7n, 10], [10n ** 17n, 122n, 100]] as const) {
      const limits = { ...l, dailySpendPercent: percent };
      const allowed = BigInt(dropsAllowedToday(limits, { balance, used: 0, gasPrice: price * GWEI }));
      expect(allowed * l.maxDropGas * price * GWEI * 100n <= balance * BigInt(percent), `${balance} ${price} ${percent}`).toBe(true);
      expect((allowed + 1n) * l.maxDropGas * price * GWEI * 100n > balance * BigInt(percent) || allowed === BigInt(l.dailyDrops)).toBe(true);
    }
  });

  it("counts today's drops as held (each cost at most one drop's worth), so the allowance does not shrink as they go out; a refill raises it at once", () => {
    const perDrop = l.maxDropGas * 102n * GWEI;
    const start = parseEther("1");
    for (let used = 0; used <= 9; used++) expect(dropsAllowedToday(l, { balance: start - BigInt(used) * perDrop, used, gasPrice: 102n * GWEI })).toBe(9);
    expect(dropsAllowedToday(l, { balance: start - 9n * perDrop + parseEther("5"), used: 9, gasPrice: 102n * GWEI })).toBe(58);
  });

  it("is never more than dailyDrops, and a zero price leaves only dailyDrops", () => {
    expect(dropsAllowedToday(l, { balance: parseEther("1000"), used: 0, gasPrice: 102n * GWEI })).toBe(150);
    expect(dropsAllowedToday(l, { balance: 1n, used: 0, gasPrice: 0n })).toBe(150);
  });
});

describe("paidPerGas", () => {
  it("is the base fee plus the priority fee, never above the fee cap: Monad mainnet's drop paid 102 gwei under a 182.4 gwei cap", () => {
    expect(paidPerGas({ maxFeePerGas: 1824n * GWEI / 10n, maxPriorityFeePerGas: 2n * GWEI }, 100n * GWEI)).toBe(102n * GWEI);
    expect(paidPerGas({ maxFeePerGas: 101n * GWEI, maxPriorityFeePerGas: 2n * GWEI }, 100n * GWEI)).toBe(101n * GWEI);
  });
});

describe("refusal", () => {
  const state = (balance: bigint, dayStartNonce = 0): SpendState => ({ balance, baseFeePerGas: 100n * GWEI, dayStartNonce, resetsAt: RESETS });
  const cap = 1824n * GWEI / 10n; // the fee cap viem signs on Monad mainnet
  const tip = 2n * GWEI;

  it("checks the gas cap, then the reserve with the drop's own cost at its fee cap, then the day's allowance by the transaction's nonce, at the price it pays", () => {
    expect(refusal(l, { gas: 250_001n, maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce: 0 }, state(parseEther("100")))?.code).toBe("DROP_TOO_COSTLY");
    expect(refusal(l, { gas: 250_000n, maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce: 0 }, state(parseEther("100")))).toBeUndefined();
    // the reserve: the balance minus gas × fee cap, the most the drop can cost (and what Monad makes its sender hold)
    expect(refusal(l, { gas: 100_000n, maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce: 0 }, state(parseEther("0.1") + 100_000n * cap - 1n))?.code).toBe("GAS_RESERVE");
    expect(refusal({ ...l, dailySpendPercent: 100 }, { gas: 100_000n, maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce: 0 }, state(parseEther("0.1") + 100_000n * cap))).toBeUndefined();
    // the day: nonce 110 is the 11th transaction since the day's first block (nonce 100 before it). 0.8 MON after 10
    // drops of at most 0.0255 MON each (250,000 gas at 102 gwei): it held at most 1.055 MON at 00:00, and a quarter of
    // that pays for 10. The fee cap does not enter it
    expect(refusal(l, { gas: 100_000n, maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce: 109 }, state(parseEther("0.8"), 100))).toBeUndefined();
    const day = refusal(l, { gas: 100_000n, maxFeePerGas: cap, maxPriorityFeePerGas: tip, nonce: 110 }, state(parseEther("0.8"), 100));
    expect([day?.code, day?.resetsAt]).toEqual(["DAILY_CAP", RESETS]);
    expect(day?.message).toBe("the agent has sent 10 of the 10 drops it allows itself today (UTC; at most 150, and at most 25% of its wallet at the most a drop can cost); it sends again from 2026-09-28T00:00:00.000Z");
  });

  it("never words a refusal the way the SDK or viem read a node's error (insufficient funds, nonce too low)", () => {
    const all = [
      refusal(l, { gas: 300_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI, nonce: 0 }, state(0n)),
      refusal(l, { gas: 100_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI, nonce: 0 }, state(0n)),
      refusal(l, { gas: 100_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI, nonce: 500 }, state(parseEther("1"))),
    ];
    for (const r of all) {
      expect(r).toBeInstanceOf(SpendRefused);
      expect(r!.message).not.toMatch(/insufficient (funds|balance)|reserve balance violation|nonce too low|already known|replacement transaction underpriced|execution reverted|gas limit reached|exceeds transaction sender/i);
    }
  });
});

describe("spendRefusalIn", () => {
  it("finds the refusal inside the errors viem and the SDK wrap it in", () => {
    const refused = new SpendRefused("GAS_RESERVE", "held too little");
    const viem = new BaseError("Transaction failed", { cause: new BaseError("Execution failed", { cause: refused }) });
    const sdk = new LetterlockError("CHAIN_UNAVAILABLE", "drop 478 bytes to 0x…: Transaction failed", { cause: viem });
    expect(spendRefusalIn(sdk)).toBe(refused);
    expect(spendRefusalIn(new LetterlockError("CHAIN_UNAVAILABLE", "rpc down"))).toBeUndefined();
  });
});

describe("guardedWallet", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = (balance = parseEther("1")) => guardedWallet(account, { directory: DIRECTORY, limits: l, state: async () => ({ balance, baseFeePerGas: 100n * GWEI, dayStartNonce: 0, resetsAt: RESETS }) });
  const drop: Hex = encodeFunctionData({ abi: letterlockAbi, functionName: "drop", args: [zeroAddress, 5n, "0x7b7d"] });
  const tx = { chainId: 143, type: "eip1559" as const, to: DIRECTORY, data: drop, gas: 60_000n, maxFeePerGas: 122n * GWEI, maxPriorityFeePerGas: 2n * GWEI, nonce: 0 };
  const code = async (p: Promise<unknown>) => p.then(() => "signed", (e: unknown) => (e instanceof SpendRefused ? e.code : String(e)));

  it("signs a drop on the directory, as the wallet itself would", async () => {
    expect(drop.startsWith(DROP_SELECTOR)).toBe(true);
    expect(await signer().signTransaction(tx)).toBe(await account.signTransaction(tx));
  });

  it("signs nothing else: another contract, another function, a value, a message, typed data", async () => {
    expect(await code(signer().signTransaction({ ...tx, to: zeroAddress }))).toBe("NOT_A_DROP");
    expect(await code(signer().signTransaction({ ...tx, data: encodeFunctionData({ abi: letterlockAbi, functionName: "publish", args: [`0x${"11".repeat(32)}`, 1] }) }))).toBe("NOT_A_DROP");
    expect(await code(signer().signTransaction({ ...tx, value: 1n }))).toBe("NOT_A_DROP");
    expect(await code(signer().signMessage({ message: "hello" }))).toBe("NOT_A_DROP");
    expect(await code(signer().signTypedData({ domain: {}, types: { M: [{ name: "a", type: "string" }] }, primaryType: "M", message: { a: "b" } }))).toBe("NOT_A_DROP");
  });

  it("refuses a drop the state does not allow, and signs nothing", async () => {
    expect(await code(signer(parseEther("0.1")).signTransaction(tx))).toBe("GAS_RESERVE");
    expect(await code(signer().signTransaction({ ...tx, gas: 250_001n }))).toBe("DROP_TOO_COSTLY");
  });
});
