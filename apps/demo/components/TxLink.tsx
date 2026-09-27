import { explorerAddress, explorerTx } from "@/lib/chain.ts";
import { shortHex } from "@/lib/format.ts";
import { ArrowOutIcon } from "./Icons";
import styles from "./TxLink.module.css";

/** A transaction on the explorer: its hash shortened, never split across lines, with the arrow that leaves the app. */
export function TxLink({ hash, className }: { hash: string; className?: string }) {
  return (
    <a className={[styles.link, "data", className].filter(Boolean).join(" ")} href={explorerTx(hash)} target="_blank" rel="noreferrer">
      {shortHex(hash, 8, 6)}
      <ArrowOutIcon size={14} />
      <span className="visually-hidden"> (transaction, opens the explorer)</span>
    </a>
  );
}

/** An address on the explorer, shortened the same way. */
export function AddressLink({ address, className }: { address: string; className?: string }) {
  return (
    <a className={[styles.link, "data", className].filter(Boolean).join(" ")} href={explorerAddress(address)} target="_blank" rel="noreferrer">
      {shortHex(address, 6, 4)}
      <ArrowOutIcon size={14} />
      <span className="visually-hidden"> (address {address}, opens the explorer)</span>
    </a>
  );
}
