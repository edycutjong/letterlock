import Link from "next/link";
import { DIRECTORY } from "@/lib/deployment.ts";
import { shortHex } from "@/lib/format.ts";
import { ArrowOutIcon } from "./Icons";
import styles from "./SiteFooter.module.css";

/** The foot of the register page: which directory this app reads, and where to check it. */
export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className="page">
        <hr className="double-rule" />
        <div className={styles.row}>
          <p className={styles.directory}>
            <span className="label-caps">Directory</span>
            <a className={`${styles.addr} data`} href={DIRECTORY.explorer} target="_blank" rel="noreferrer">
              {shortHex(DIRECTORY.address, 6, 4)}
              <ArrowOutIcon size={14} />
              <span className="visually-hidden"> (opens the explorer)</span>
            </a>
            <span>
              {DIRECTORY.network}, chain {DIRECTORY.chainId}
              {DIRECTORY.verified && <> · source verified ({DIRECTORY.verifier}, {DIRECTORY.match.replace("_", " ")})</>}
            </span>
          </p>
          <p className={styles.links}>
            <Link href="/kit">Component kit</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
