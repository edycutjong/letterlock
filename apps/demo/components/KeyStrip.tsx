import { STRIP, STRIP_HEIGHT, STRIP_WIDTH, groupFingerprint, stripPath } from "@/lib/keystrip.ts";
import styles from "./KeyStrip.module.css";

export type KeyStripProps = {
  /** 16 lower-case hex digits: the SDK's fingerprint() of the public key */
  fingerprint: string;
  /** `open` inks the strip airmail blue: a public key found in the register, readable by anyone */
  tone?: "ink" | "open" | "pencil";
  /** bar height in px; the strip keeps its proportions */
  height?: number;
  /**
   * Read the strip out to screen readers. Leave it off when the fingerprint is printed as text next to it, so it is
   * not announced twice.
   */
  announce?: boolean;
  className?: string;
};

/** A key fingerprint as a postal 4-state bar code: 32 bars, two bits each, the same 16 digits as the text. */
export function KeyStrip({ fingerprint, tone = "ink", height = 14, announce = false, className }: KeyStripProps) {
  const width = (height * STRIP_WIDTH) / STRIP_HEIGHT;
  return (
    <svg
      className={[styles.strip, className].filter(Boolean).join(" ")}
      data-tone={tone}
      viewBox={`0 ${-STRIP.reach} ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
      width={+width.toFixed(1)}
      height={height}
      role={announce ? "img" : undefined}
      aria-label={announce ? `Key fingerprint ${groupFingerprint(fingerprint)}` : undefined}
      aria-hidden={announce ? undefined : true}
      focusable="false"
    >
      <path d={stripPath(fingerprint)} />
    </svg>
  );
}

/**
 * The fingerprint in hex, grouped in fours, in two unbreakable halves: it wraps as 2 + 2 groups, never 3 + 1.
 */
export function FingerprintText({ fingerprint, className }: { fingerprint: string; className?: string }) {
  const groups = groupFingerprint(fingerprint).split(" ");
  return (
    <span className={["data", styles.hex, className].filter(Boolean).join(" ")}>
      <span>{groups.slice(0, 2).join(" ")}</span> <span>{groups.slice(2).join(" ")}</span>
    </span>
  );
}
