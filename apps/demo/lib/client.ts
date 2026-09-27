"use client";

// The SDK's chain clients as the pages use them, one of each per page load:
//   reader  — resolve, sealTo: no passkey, so no rpId matters
//   scanner — inbox and the register's log scans, over SCAN_RPC (one request for the whole range on mainnet)
//   passkey — publish, rotate, drop, open: pinned to the rpId of the host the page is served from (lib/chain.ts)
// and a viem public client for what the SDK does not wrap: balances, fees, logs.
import { letterlock, type LetterlockClient } from "letterlock";
import { useSyncExternalStore } from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { CHAIN, DEPLOYMENT, SCAN_RPC, passkeyHost, type PasskeyHost } from "./chain.ts";

let reader: LetterlockClient | undefined;
let scanner: LetterlockClient | undefined;
let signer: { rpId: string; client: LetterlockClient } | undefined;
let chainClient: PublicClient | undefined;
let logClient: PublicClient | undefined;

export const readClient = (): LetterlockClient => (reader ??= letterlock({ chain: CHAIN }));

export const scanClient = (): LetterlockClient => (scanner ??= letterlock({ chain: CHAIN, rpcUrl: SCAN_RPC }));

/** The client that publishes, rotates, drops and opens, under the rpId this host may use; throws where it may use none. */
export const passkeyClient = (): { rpId: string; client: LetterlockClient } => {
  if (signer) return signer;
  const host = passkeyHost(window.location.hostname);
  if (!host.ok) throw new Error(host.reason);
  signer = {
    rpId: host.rpId,
    // a development build (testnet only) derives under its own host: the SDK refuses that unless told it is a test
    client: letterlock({ chain: CHAIN, rpId: host.rpId, ...(host.production ? {} : { unsafeAllowAnyRpId: true }) }),
  };
  return signer;
};

const VIEM_CHAIN = CHAIN === "monad" ? monad : monadTestnet;

export const publicClient = (): PublicClient =>
  (chainClient ??= createPublicClient({ chain: VIEM_CHAIN, transport: http(DEPLOYMENT.rpcUrl) }) as PublicClient);

export const scanPublicClient = (): PublicClient =>
  (logClient ??= createPublicClient({ chain: VIEM_CHAIN, transport: http(SCAN_RPC) }) as PublicClient);

const noop = () => () => {};

/** Where passkeys may be used from this page: `null` until the page runs in the browser (the server cannot know). */
export function usePasskeyHost(): PasskeyHost | null {
  return useSyncExternalStore(noop, () => hostSnapshot(), () => null);
}
let hostCache: PasskeyHost | undefined;
const hostSnapshot = (): PasskeyHost => (hostCache ??= passkeyHost(window.location.hostname));

/** This page's origin (https://letterlock-app.vercel.app in production): `null` until the page runs in the browser. */
export function useOrigin(): string | null {
  return useSyncExternalStore(noop, () => window.location.origin, () => null);
}
