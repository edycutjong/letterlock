"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "./Wordmark";
import styles from "./SiteHeader.module.css";

const NAV = [
  { href: "/", label: "Address", title: "Your address" },
  { href: "/seal", label: "Seal", title: "Seal a note" },
  { href: "/open", label: "Open", title: "Inbox" },
  { href: "/register", label: "Register", title: "The register" },
  { href: "/judge", label: "Judge", title: "For judges" },
] as const;

export type SiteHeaderProps = {
  /** the directory's network, printed as a franking label */
  network: string;
  chainId: number;
};

/** The letterhead: the outlined wordmark, the five routes, and which directory the app reads. */
export function SiteHeader({ network, chainId }: SiteHeaderProps) {
  const path = usePathname();
  return (
    <header className={styles.header}>
      <div className={`${styles.bar} page`}>
        <Link href="/" className={styles.home} aria-label="Letterlock, your address">
          <Wordmark height={30} title="" className={styles.wordmark} />
        </Link>
        <nav className={styles.nav} aria-label="Pages">
          <ul>
            {NAV.map((n) => {
              const current = n.href === "/" ? path === "/" : path === n.href || path.startsWith(`${n.href}/`);
              return (
                <li key={n.href}>
                  <Link href={n.href} aria-current={current ? "page" : undefined} title={n.title}>
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <p className={styles.network}>
          <span className={styles.frank} aria-hidden="true" />
          <span>
            {network}
            <span className={styles.chain}> · {chainId}</span>
          </span>
        </p>
      </div>
      <div className="page">
        <hr className="double-rule" />
      </div>
    </header>
  );
}
