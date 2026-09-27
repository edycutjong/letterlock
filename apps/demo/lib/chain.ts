// Which Monad network this build of the app talks to. Chosen when the app is built, never at run time:
//   NEXT_PUBLIC_LETTERLOCK_CHAIN = "monad" (the default: Monad mainnet, chain 143) | "monad-testnet" (chain 10143)
// A testnet build says so on every page (the header's franking label and the development banner). The directory
// addresses, deploy blocks and default RPCs are the SDK's own constants (DEPLOYMENTS), copied from deployments/*.json.
import { DEPLOYMENTS, LETTERLOCK_RP_ID, type LetterlockChain } from "letterlock";
import { AGENT_URL, CHAIN_NAME, SCAN_RPC_URL } from "./endpoints.ts";

export const CHAIN: LetterlockChain = CHAIN_NAME;

export const DEPLOYMENT = DEPLOYMENTS[CHAIN];

export const TESTNET = CHAIN === "monad-testnet";

/** The RPC the log scans read from (lib/endpoints.ts); every other call uses the chain's default RPC. */
export const SCAN_RPC = SCAN_RPC_URL;

/** Blocks per eth_getLogs request to start a scan with: the SDK narrows it when the RPC refuses. */
export const SCAN_RANGE = CHAIN === "monad" ? 1_000_000 : 100;

export const explorerTx = (hash: string): string => `${DEPLOYMENT.explorer}/tx/${hash}`;
export const explorerAddress = (address: string): string => `${DEPLOYMENT.explorer}/address/${address}`;

/**
 * A testnet build may derive keys under the page's own host (localhost for the end-to-end tests) when it is built with
 * NEXT_PUBLIC_LETTERLOCK_DEV_RPID=1. A mainnet build never does: its keys are made only at LETTERLOCK_RP_ID.
 */
export const DEV_RPID_ALLOWED = TESTNET && process.env.NEXT_PUBLIC_LETTERLOCK_DEV_RPID === "1";

export type PasskeyHost =
  | { readonly ok: true; readonly rpId: string; readonly production: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Where passkeys may be made and used from the page at `hostname`. A PRF output is bound to the rpId, so a key made
 * anywhere but the production host could never be opened there (docs/SPEC.md §6): on any other host this build makes
 * no key, unless it is a testnet build made for development.
 */
export const passkeyHost = (hostname: string): PasskeyHost => {
  if (hostname === LETTERLOCK_RP_ID) return { ok: true, rpId: LETTERLOCK_RP_ID, production: true };
  if (DEV_RPID_ALLOWED) return { ok: true, rpId: hostname, production: false };
  return {
    ok: false,
    reason: `Passkeys for Letterlock are made only at ${LETTERLOCK_RP_ID}: a key derived on any other site could never be opened there.`,
  };
};

export { LETTERLOCK_RP_ID };

export { AGENT_URL };
