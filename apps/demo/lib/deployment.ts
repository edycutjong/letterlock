// The directory the app points at, read from the deployment records at the repository root (written when the
// contract was deployed). These are real values, not examples: the header, the footer, /register and /judge show them.
// test/deployment.test.ts fails on any chain value typed into this file.
//
// Each field is read here by name, straight off its record, and no record is passed around whole: the bundler then
// puts only these fields in the pages' scripts, not the records' notes, the agent's hosts or their other
// transactions, so editing any other part of a record never leaves the live app's scripts behind the repository.
import mainnet from "../../../deployments/143.json";
import testnet from "../../../deployments/10143.json";
import type { LetterlockChain } from "letterlock";
import { CHAIN } from "./chain.ts";

type Directory = {
  chainId: number;
  network: string;
  address: `0x${string}`;
  explorer: string;
  verified: boolean;
  verifier: string;
  /** "exact_match": the first word of the recorded verification result */
  match: string;
  sourceCheck: string;
  agentPathEnabled: boolean;
  /** the block of the deploy transaction: scans start here */
  deployBlock: number;
};

/** The registry of a directory deployed with no agent path (testnet): the zero address. */
const NO_REGISTRY = "0x0000000000000000000000000000000000000000";

const DIRECTORIES: Record<LetterlockChain, Directory> = {
  monad: {
    chainId: mainnet.chainId,
    network: mainnet.network,
    address: mainnet.address as `0x${string}`,
    explorer: mainnet.explorer.contract,
    verified: mainnet.verified,
    verifier: mainnet.verification.verifier,
    match: mainnet.verification.match.split(" ")[0] ?? "",
    sourceCheck: mainnet.verification.check,
    agentPathEnabled: mainnet.identityRegistry !== NO_REGISTRY,
    deployBlock: mainnet.block,
  },
  "monad-testnet": {
    chainId: testnet.chainId,
    network: testnet.network,
    address: testnet.address as `0x${string}`,
    explorer: testnet.explorer.contract,
    verified: testnet.verified,
    verifier: testnet.verification.verifier,
    match: testnet.verification.match.split(" ")[0] ?? "",
    sourceCheck: testnet.verification.check,
    agentPathEnabled: testnet.identityRegistry !== NO_REGISTRY,
    deployBlock: testnet.block,
  },
};

export const directoryFor = (chain: LetterlockChain): Directory => DIRECTORIES[chain];

export const DIRECTORY = directoryFor(CHAIN);

/**
 * A key the deploy smoke test published: the SDK's derivation over 32 random bytes standing in for a passkey PRF
 * output (no passkey was used). Its stand-in is kept outside the repository, so it opens anything sealed to the key:
 * the register marks these lines, and nobody should seal a real note to them.
 */
export type SmokeKey = {
  recipient: `0x${string}` | `agent:${string}`;
  /** who sent the publish transaction: the deployer, which also owns the agent */
  publisher: `0x${string}`;
  publicKey: `0x${string}`;
  epoch: number;
  fingerprint: string;
  block: number;
  txHash: `0x${string}`;
  txUrl: string;
  updatedAt: number;
  /** the record's own label, e.g. "DEMO KEY: …" */
  label: string;
};

const SMOKE_KEYS_BY_CHAIN: Record<LetterlockChain, SmokeKey[]> = {
  "monad-testnet": [
    {
      recipient: testnet.deployer.toLowerCase() as `0x${string}`,
      publisher: testnet.deployer as `0x${string}`,
      publicKey: testnet.smokeTest.publishedKey as `0x${string}`,
      epoch: testnet.smokeTest.epoch,
      fingerprint: testnet.smokeTest.kid,
      block: testnet.smokeTest.publishBlock,
      txHash: testnet.publishTx as `0x${string}`,
      txUrl: testnet.explorer.publishTx,
      updatedAt: testnet.smokeTest.updatedAt,
      label: testnet.smokeTest.label,
    },
  ],
  monad: [
    {
      recipient: mainnet.deployer.toLowerCase() as `0x${string}`,
      publisher: mainnet.deployer as `0x${string}`,
      publicKey: mainnet.smokeTest.publishedKey as `0x${string}`,
      epoch: mainnet.smokeTest.epoch,
      fingerprint: mainnet.smokeTest.kid,
      block: mainnet.smokeTest.publishBlock,
      txHash: mainnet.publishTx as `0x${string}`,
      txUrl: mainnet.explorer.publishTx,
      updatedAt: mainnet.smokeTest.updatedAt,
      label: mainnet.smokeTest.label,
    },
    {
      recipient: `agent:${mainnet.smokeTest.agentKey.agentId}`,
      publisher: mainnet.agent.owner as `0x${string}`,
      publicKey: mainnet.smokeTest.agentKey.publishedKey as `0x${string}`,
      epoch: mainnet.smokeTest.agentKey.epoch,
      fingerprint: mainnet.smokeTest.agentKey.kid,
      block: mainnet.smokeTest.agentKey.publishBlock,
      txHash: mainnet.publishForAgentTx as `0x${string}`,
      txUrl: mainnet.explorer.publishForAgentTx,
      updatedAt: mainnet.smokeTest.agentKey.updatedAt,
      label: mainnet.smokeTest.agentKey.label,
    },
  ],
};

export const smokeKeysFor = (chain: LetterlockChain): SmokeKey[] => SMOKE_KEYS_BY_CHAIN[chain];

/** The smoke-test keys on the directory this build points at: the first is the deployer's own. */
export const SMOKE_KEYS = smokeKeysFor(CHAIN);
