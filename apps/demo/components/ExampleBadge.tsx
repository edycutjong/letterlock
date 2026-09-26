import type { ReactNode } from "react";
import styles from "./ExampleBadge.module.css";

/** A rubber-stamped "Example" mark: whatever carries it is illustration, not a key, envelope or transaction on chain. */
export function ExampleBadge({ className, label = "Example" }: { className?: string; label?: string }) {
  return <span className={[styles.badge, className].filter(Boolean).join(" ")}>{label}</span>;
}

/** One line under a page title saying what on the page is an example, and why. */
export function ExampleNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={[styles.note, className].filter(Boolean).join(" ")}>
      <ExampleBadge />
      <span>{children}</span>
    </p>
  );
}
