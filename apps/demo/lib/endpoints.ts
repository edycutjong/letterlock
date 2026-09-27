// The network endpoints this build talks to, without the SDK, so the per-request middleware (lib/csp.ts) stays small.
// lib/chain.ts builds on these; test/endpoints.test.ts checks them against the SDK's DEPLOYMENTS and the deploy records.
import mainnet from "../../../deployments/143.json";
import testnet from "../../../deployments/10143.json";

export const CHAIN_NAME: "monad" | "monad-testnet" = process.env.NEXT_PUBLIC_LETTERLOCK_CHAIN === "monad-testnet" ? "monad-testnet" : "monad";

/** The chain's default JSON-RPC endpoint: the SDK's own (DEPLOYMENTS[chain].rpcUrl). */
export const RPC_URL = CHAIN_NAME === "monad" ? "https://rpc.monad.xyz" : "https://testnet-rpc.monad.xyz";

/**
 * The RPC the log scans (the register, the inbox) read from. On mainnet rpc1.monad.xyz answers eth_getLogs over any
 * block range in one request, where rpc.monad.xyz takes 100 blocks at a time (checked 2026-09-27); testnet has no such
 * endpoint, so its scans go 100 blocks at a time.
 */
export const SCAN_RPC_URL = CHAIN_NAME === "monad" ? "https://rpc1.monad.xyz" : RPC_URL;

/**
 * The reference agent (ERC-8004 agent 10260, examples/agent-memory in this repository): POST /remember { to, text }
 * seals the text to `to` and drops it. It writes on Monad mainnet; a testnet build names one only when it is built with
 * NEXT_PUBLIC_LETTERLOCK_AGENT_URL.
 */
export const AGENT_URL: string | undefined =
  process.env.NEXT_PUBLIC_LETTERLOCK_AGENT_URL?.replace(/\/+$/, "") || (CHAIN_NAME === "monad" ? "https://agent.letterlock.edycu.dev" : undefined);

/**
 * The Sourcify record the register checks the directory's source against. Read by name off each record, never the
 * record whole, so the pages' scripts carry this field and not the records (lib/deployment.ts).
 */
export const SOURCE_CHECK_URL: string = CHAIN_NAME === "monad" ? mainnet.verification.check : testnet.verification.check;
