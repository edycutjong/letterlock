// The agent's configuration, read once from the environment. Every value is checked; an error names the variable and
// never repeats a secret's value.
import { DEPLOYMENTS, type LetterlockChain } from "letterlock";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/** A sliding window: at most `max` events per `windowSec` seconds. */
export type Window = { readonly windowSec: number; readonly max: number };

export type Limits = {
  /** Characters (Unicode code points) a note's text may hold. */
  readonly textMaxChars: number;
  /** Bytes of request body read before the request is refused (413). */
  readonly bodyMaxBytes: number;
  /** Drops one IP may cause (POST /remember or /task that reach the chain), per server instance. */
  readonly perIpDrops: readonly Window[];
  /** Requests of any kind one IP may make, per server instance. */
  readonly perIpRequests: readonly Window[];
  /** Drops per UTC day from the agent's wallet, counted onchain from its nonce: shared by every instance. */
  readonly dailyDrops: number;
  /** The wallet keeps at least this much MON (in wei); below it no drop is sent. */
  readonly minBalanceWei: bigint;
  /** A task is refused when its `issuedAt` is more than this many seconds old... */
  readonly taskMaxAgeSec: number;
  /** ...or more than this many seconds in the future. */
  readonly taskMaxSkewSec: number;
};

export type AgentConfig = {
  /** The kill switch: POST endpoints answer 503 AGENT_DISABLED unless AGENT_ENABLED is exactly "true". */
  readonly enabled: boolean;
  readonly chain: LetterlockChain;
  readonly rpcUrl: string | undefined;
  /** Another directory than the chain's built-in one (tests on a local chain). */
  readonly directory: Address | undefined;
  readonly deployBlock: bigint | undefined;
  /** The ERC-8004 agent this service answers for. */
  readonly agentId: bigint;
  /** The first key epoch derived from the seed; earlier epochs of the agent were published from other secrets. */
  readonly keyFirstEpoch: number;
  /** LETTERLOCK_AGENT_KEY_SEED: the secret the agent's keys are derived from (agent-key.ts). */
  readonly seed: Uint8Array | undefined;
  /** LETTERLOCK_AGENT_PRIVATE_KEY: the wallet that pays for drops. */
  readonly account: PrivateKeyAccount | undefined;
  /** Where the agent is served: links in /health. */
  readonly publicUrl: string;
  readonly limits: Limits;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_AGENT_ID = 10260n;
export const DEFAULT_PUBLIC_URL = "https://letterlock-agent.vercel.app";

export const DEFAULT_LIMITS: Limits = {
  textMaxChars: 1000,
  bodyMaxBytes: 16 * 1024,
  perIpDrops: [{ windowSec: 600, max: 5 }, { windowSec: 86_400, max: 20 }],
  perIpRequests: [{ windowSec: 60, max: 60 }],
  dailyDrops: 150,
  minBalanceWei: parseEther("0.1"),
  taskMaxAgeSec: 600,
  taskMaxSkewSec: 60,
};

type Env = Readonly<Record<string, string | undefined>>;

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

const integer = (env: Env, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be in ${min}..${max}, got ${n}`);
  return n;
};

/** 32 bytes from hex. The value is a secret: errors never include it. */
const secret32 = (env: Env, name: string): Uint8Array | undefined => {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!HEX32.test(raw)) throw new ConfigError(`${name} must be 32 bytes as 64 hex digits (0x optional)`);
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  const bytes = Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
  if (bytes.every((b) => b === 0)) throw new ConfigError(`${name} must not be all zeros`);
  return bytes;
};

export const loadConfig = (env: Env): AgentConfig => {
  const chain = (env.LETTERLOCK_CHAIN ?? "monad") as LetterlockChain;
  if (!(chain in DEPLOYMENTS)) throw new ConfigError(`LETTERLOCK_CHAIN must be "monad" or "monad-testnet", got ${JSON.stringify(env.LETTERLOCK_CHAIN)}`);

  const directoryRaw = env.LETTERLOCK_DIRECTORY?.trim();
  if (directoryRaw && !isAddress(directoryRaw)) throw new ConfigError(`LETTERLOCK_DIRECTORY must be a 0x address with a valid checksum`);
  const deployBlockRaw = env.LETTERLOCK_DEPLOY_BLOCK?.trim();
  if (deployBlockRaw && !/^\d+$/.test(deployBlockRaw)) throw new ConfigError("LETTERLOCK_DEPLOY_BLOCK must be a block number");

  const agentIdRaw = env.LETTERLOCK_AGENT_ID?.trim();
  if (agentIdRaw && !/^(0|[1-9]\d{0,76})$/.test(agentIdRaw)) throw new ConfigError("LETTERLOCK_AGENT_ID must be a decimal agent id");

  let account: PrivateKeyAccount | undefined;
  const key = secret32(env, "LETTERLOCK_AGENT_PRIVATE_KEY");
  if (key) {
    try {
      account = privateKeyToAccount(`0x${Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("")}`);
    } catch {
      throw new ConfigError("LETTERLOCK_AGENT_PRIVATE_KEY is not a valid secp256k1 private key");
    } finally {
      key.fill(0);
    }
  }

  const minBalanceRaw = env.AGENT_MIN_BALANCE_MON?.trim();
  if (minBalanceRaw && !/^\d+(\.\d{1,18})?$/.test(minBalanceRaw)) throw new ConfigError("AGENT_MIN_BALANCE_MON must be a MON amount such as 0.1");

  const publicUrl = (env.AGENT_PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(publicUrl)) throw new ConfigError("AGENT_PUBLIC_URL must be an http(s) URL");

  return {
    enabled: env.AGENT_ENABLED === "true",
    chain,
    rpcUrl: env.MONAD_RPC_URL?.trim() || undefined,
    directory: directoryRaw ? getAddress(directoryRaw) : undefined,
    deployBlock: deployBlockRaw ? BigInt(deployBlockRaw) : undefined,
    agentId: agentIdRaw ? BigInt(agentIdRaw) : DEFAULT_AGENT_ID,
    keyFirstEpoch: integer(env, "LETTERLOCK_AGENT_KEY_FIRST_EPOCH", 2, 1, 0xffff_ffff),
    seed: secret32(env, "LETTERLOCK_AGENT_KEY_SEED"),
    account,
    publicUrl,
    limits: {
      ...DEFAULT_LIMITS,
      perIpDrops: [
        { windowSec: 600, max: integer(env, "AGENT_PER_IP_DROPS_10MIN", 5, 1, 10_000) },
        { windowSec: 86_400, max: integer(env, "AGENT_PER_IP_DROPS_DAY", 20, 1, 100_000) },
      ],
      dailyDrops: integer(env, "AGENT_DAILY_DROP_CAP", DEFAULT_LIMITS.dailyDrops, 0, 1_000_000),
      minBalanceWei: minBalanceRaw ? parseEther(minBalanceRaw) : DEFAULT_LIMITS.minBalanceWei,
    },
  };
};
