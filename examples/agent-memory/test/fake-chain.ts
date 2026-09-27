// An AgentChain without a chain, for the HTTP tests: keys live in a map, drops are recorded, the wallet's balance, its
// nonce and the fee are plain numbers the test sets. Sealing and opening stay the SDK's real code, and a drop goes
// through the same one-at-a-time queue and the same signing check (spend.ts, refusal) as on a chain: what the real
// guarded wallet does is test/spend-race.test.ts, on anvil.
import { LetterlockError, canonicalRecipient, encodeEnvelope, fingerprint, type Envelope, type Recipient } from "letterlock";
import { oneAtATime, type AgentChain } from "../src/chain.ts";
import { DEFAULT_LIMITS, type Limits } from "../src/config.ts";
import { paidPerGas, refusal } from "../src/spend.ts";

export const DIRECTORY = "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e" as const;
export const GWEI = 1_000_000_000n;
const DAY_MS = 86_400_000;

/** A drop's gas as Monad mainnet estimates it: 87,769 for a 1,585-byte envelope, 248,600 for 5,585 (README.md, Limits). */
export const dropGas = (bytes: number): bigint => 24_050n + (402n * BigInt(bytes)) / 10n;

export type FakeChain = AgentChain & {
  readonly keys: Map<Recipient, { publicKey: Uint8Array; epoch: number }>;
  readonly dropped: Envelope[];
  readonly state: {
    balance: bigint;
    usedToday: number;
    balanceFails: boolean;
    /**
     * The fees, as on Monad mainnet on 2026-09-27: a 100 gwei base fee and a 2 gwei priority fee, so a drop pays 102
     * gwei per gas, under the 182.4 gwei fee cap viem signs (the node's eth_fillTransaction answer, 152, × 1.2).
     */
    baseFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
  };
};

export const fakeChain = (o: { limits?: Limits; now?: () => number } = {}): FakeChain => {
  const limits = o.limits ?? DEFAULT_LIMITS;
  const now = o.now ?? Date.now;
  const keys = new Map<Recipient, { publicKey: Uint8Array; epoch: number }>();
  const dropped: Envelope[] = [];
  const state = { balance: 100n * 10n ** 18n, usedToday: 0, balanceFails: false, baseFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 2n * GWEI, maxFeePerGas: 1824n * GWEI / 10n };
  const drop = oneAtATime(async (_account: unknown, envelope: Envelope) => {
    const bytes = encodeEnvelope(envelope).length;
    const gas = dropGas(bytes);
    const resetsAt = Math.floor(now() / DAY_MS) * DAY_MS + DAY_MS;
    const tx = { gas, maxFeePerGas: state.maxFeePerGas, maxPriorityFeePerGas: state.maxPriorityFeePerGas, nonce: state.usedToday };
    const why = refusal(limits, tx, { balance: state.balance, baseFeePerGas: state.baseFeePerGas, dayStartNonce: 0, resetsAt });
    // as the SDK reports a signer's refusal: CHAIN_UNAVAILABLE, with the refusal as its cause
    if (why) throw new LetterlockError("CHAIN_UNAVAILABLE", `drop ${bytes} bytes: ${why.message}`, { cause: why });
    await new Promise((r) => setTimeout(r, 1)); // the receipt takes a moment
    state.balance -= gas * paidPerGas(tx, state.baseFeePerGas);
    state.usedToday++;
    dropped.push(envelope);
    const n = dropped.length;
    return {
      transactionHash: `0x${n.toString(16).padStart(64, "0")}` as const,
      blockNumber: 1000n + BigInt(n),
      gasUsed: gas,
      recipient: canonicalRecipient(envelope.recipient),
      bytes,
    };
  });
  return {
    chainId: 143,
    network: "Monad mainnet",
    directory: DIRECTORY,
    explorer: "https://monadvision.com",
    ll: undefined as never,
    keys,
    dropped,
    state,
    async resolve(to) {
      const recipient = canonicalRecipient(to);
      const key = keys.get(recipient);
      if (!key) throw new LetterlockError("NO_KEY_PUBLISHED", `${recipient} has no key in the Monad mainnet directory ${DIRECTORY}`);
      return { recipient, ...key, kid: fingerprint(key.publicKey), updatedAt: 1_790_000_000, chainId: 143, directory: DIRECTORY };
    },
    drop: (account, envelope) => drop(account, envelope),
    async balance() {
      if (state.balanceFails) throw new Error("rpc down");
      return state.balance;
    },
    async nonce() {
      return state.usedToday;
    },
    async gasPrice() {
      return state.baseFeePerGas + state.maxPriorityFeePerGas;
    },
    async dropsToday(_address, nowMs) {
      return { used: state.usedToday, resetsAt: Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS, source: "chain" };
    },
  };
};
