// An AgentChain without a chain, for the HTTP tests: keys live in a map, drops are recorded, the wallet's balance and
// its drops today are plain numbers the test sets. Sealing and opening stay the SDK's real code.
import { LetterlockError, canonicalRecipient, encodeEnvelope, fingerprint, type Envelope, type Recipient } from "letterlock";
import type { AgentChain } from "../src/chain.ts";

export const DIRECTORY = "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e" as const;

export type FakeChain = AgentChain & {
  readonly keys: Map<Recipient, { publicKey: Uint8Array; epoch: number }>;
  readonly dropped: Envelope[];
  readonly state: { balance: bigint; usedToday: number; balanceFails: boolean };
};

export const fakeChain = (): FakeChain => {
  const keys = new Map<Recipient, { publicKey: Uint8Array; epoch: number }>();
  const dropped: Envelope[] = [];
  const state = { balance: 10n ** 18n, usedToday: 0, balanceFails: false };
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
    async drop(_account, envelope) {
      const bytes = encodeEnvelope(envelope).length;
      dropped.push(envelope);
      state.usedToday++;
      const n = dropped.length;
      return {
        transactionHash: `0x${n.toString(16).padStart(64, "0")}`,
        blockNumber: 1000n + BigInt(n),
        gasUsed: 50_000n,
        recipient: canonicalRecipient(envelope.recipient),
        bytes,
      };
    },
    async balance() {
      if (state.balanceFails) throw new Error("rpc down");
      return state.balance;
    },
    async nonce() {
      return state.usedToday;
    },
    async dropsToday(_address, nowMs) {
      return { used: state.usedToday, resetsAt: Math.floor(nowMs / 86_400_000) * 86_400_000 + 86_400_000, source: "chain" };
    },
  };
};
