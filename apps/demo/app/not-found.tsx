import type { Metadata } from "next";
import { ButtonLink } from "@/components/Button";
import { ArrowRightIcon, ReturnIcon } from "@/components/Icons";
import styles from "./not-found.module.css";

// the tab, the history and a screen reader name the missing page, not the home page (scripts/checks/page-titles.mjs)
export const metadata: Metadata = { title: "No page at this address" };

export default function NotFound() {
  return (
    <main id="main" className={`page ${styles.main}`}>
      <h1 className={styles.title}>
        No page at <em>this address.</em>
      </h1>
      {/* struck under the address, the way the post office returns a letter; never a kicker over the heading */}
      <p className={styles.stamp}>
        <ReturnIcon size={18} />
        <span>Returned to sender</span>
      </p>
      <p className={styles.lede}>The link may be mistyped, or the page may have moved. Every page of the register starts from your address.</p>
      <ButtonLink href="/" icon={<ArrowRightIcon />}>
        Your address
      </ButtonLink>
    </main>
  );
}
