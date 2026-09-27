import { DEV_RPID_ALLOWED, LETTERLOCK_RP_ID, TESTNET } from "@/lib/chain.ts";
import { DIRECTORY } from "@/lib/deployment.ts";
import styles from "./DevBanner.module.css";

/**
 * A testnet build says so above everything, in words: its keys and envelopes are on Monad testnet, and a development
 * build derives keys under its own host, which the production site can never open.
 */
export function DevBanner() {
  if (!TESTNET) return null;
  return (
    <p className={styles.banner} role="note">
      <strong>Testnet build.</strong> This app reads and writes the {DIRECTORY.network} directory (chain {DIRECTORY.chainId}), not mainnet.
      {DEV_RPID_ALLOWED && ` Passkeys here are made for this site’s own host, so keys made here never open at ${LETTERLOCK_RP_ID}.`}
    </p>
  );
}
