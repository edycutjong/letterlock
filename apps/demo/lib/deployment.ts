// The directory the app points at, read from the deployment records at the repository root (written when the
// contract was deployed). These are real values, not examples: the header, the footer, /register and /judge show them.
// test/deployment.test.ts fails on any chain value typed into this file.
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

export const directoryFor = (chain: LetterlockChain): Directory => {
  const r = chain === "monad-testnet" ? testnet : mainnet;
  return {
    chainId: r.chainId,
    network: r.network,
    address: r.address as `0x${string}`,
    explorer: r.explorer.contract,
    verified: r.verified,
    verifier: r.verification.verifier,
    match: r.verification.match.split(" ")[0] ?? "",
    sourceCheck: r.verification.check,
    agentPathEnabled: r.identityRegistry !== "0x0000000000000000000000000000000000000000",
    deployBlock: r.block,
  };
};

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

export const smokeKeysFor = (chain: LetterlockChain): SmokeKey[] => {
  if (chain === "monad-testnet") {
    const s = testnet.smokeTest;
    return [
      {
        recipient: testnet.deployer.toLowerCase() as `0x${string}`,
        publisher: testnet.deployer as `0x${string}`,
        publicKey: s.publishedKey as `0x${string}`,
        epoch: s.epoch,
        fingerprint: s.kid,
        block: s.publishBlock,
        txHash: testnet.publishTx as `0x${string}`,
        txUrl: testnet.explorer.publishTx,
        updatedAt: s.updatedAt,
        label: s.label,
      },
    ];
  }
  const s = mainnet.smokeTest;
  return [
    {
      recipient: mainnet.deployer.toLowerCase() as `0x${string}`,
      publisher: mainnet.deployer as `0x${string}`,
      publicKey: s.publishedKey as `0x${string}`,
      epoch: s.epoch,
      fingerprint: s.kid,
      block: s.publishBlock,
      txHash: mainnet.publishTx as `0x${string}`,
      txUrl: mainnet.explorer.publishTx,
      updatedAt: s.updatedAt,
      label: s.label,
    },
    {
      recipient: `agent:${s.agentKey.agentId}`,
      publisher: mainnet.agent.owner as `0x${string}`,
      publicKey: s.agentKey.publishedKey as `0x${string}`,
      epoch: s.agentKey.epoch,
      fingerprint: s.agentKey.kid,
      block: s.agentKey.publishBlock,
      txHash: mainnet.publishForAgentTx as `0x${string}`,
      txUrl: mainnet.explorer.publishForAgentTx,
      updatedAt: s.agentKey.updatedAt,
      label: s.agentKey.label,
    },
  ];
};

/** The smoke-test keys on the directory this build points at: the first is the deployer's own. */
export const SMOKE_KEYS = smokeKeysFor(CHAIN);

/** The ERC-8004 agent the reference agent answers as (mainnet only: testnet has no registry). */
export const REFERENCE_AGENT =
  CHAIN === "monad" ? { agentId: mainnet.agentId, card: mainnet.agentCardUrl, registry: mainnet.identityRegistry } : undefined;
