import { useId } from "react";
import styles from "./Postmark.module.css";

export type PostmarkProps = {
  /** lettering round the top of the ring (upper-cased) */
  top: string;
  /** lettering round the bottom of the ring (upper-cased) */
  bottom: string;
  /** the large italic mark in the centre, e.g. an epoch number */
  center: string;
  /** small capitals above the centre mark */
  centerLabel?: string;
  /** wavy cancellation bars beside the ring */
  bars?: "left" | "right" | "none";
  /** ring diameter in px */
  size?: number;
  /** degrees; a hand-struck postmark is never square to the page */
  tilt?: number;
  /** Accessible text. Leave it off when the same facts are printed nearby: the postmark is then decorative. */
  label?: string;
  className?: string;
};

const RING = 128; // user units: ring centre (64, 64), outer r 60, inner r 36
const BARS_W = 104;

/** A struck cancellation mark in ink: a double ring with lettering on both arcs and optional wavy bars. */
export function Postmark({ top, bottom, center, centerLabel, bars = "none", size = 116, tilt = -8, label, className }: PostmarkProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const topId = `pm-top-${uid}`;
  const bottomId = `pm-bottom-${uid}`;
  const withBars = bars !== "none";
  const w = withBars ? RING + BARS_W : RING;
  const ringX = bars === "left" ? BARS_W : 0;
  const barsX = bars === "left" ? 0 : RING + 6;
  const scale = size / RING;
  const wave = "q6.5 -5 13 0t13 0t13 0t13 0t13 0t13 0t13 0";
  return (
    <svg
      className={[styles.postmark, className].filter(Boolean).join(" ")}
      viewBox={`0 0 ${w} ${RING}`}
      width={Math.round(w * scale)}
      height={Math.round(RING * scale)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={{ ["--tilt" as string]: `${tilt}deg` }}
    >
      <defs>
        <path id={topId} d={`M${ringX + 18} 64A46 46 0 0 1 ${ringX + 110} 64`} />
        <path id={bottomId} d={`M${ringX + 12} 64A52 52 0 0 0 ${ringX + 116} 64`} />
      </defs>
      <g className={styles.ink}>
        {withBars && (
          <g className={styles.bars} transform={`translate(${barsX} 0)`}>
            {[40, 55, 70, 85].map((y) => (
              <path key={y} d={`M4 ${y}${wave}`} />
            ))}
          </g>
        )}
        <circle className={styles.outer} cx={ringX + 64} cy="64" r="60" />
        <circle className={styles.inner} cx={ringX + 64} cy="64" r="36" />
        <text className={styles.arc}>
          <textPath href={`#${topId}`} startOffset="50%" textAnchor="middle">
            {top}
          </textPath>
        </text>
        <text className={`${styles.arc} ${styles.arcBottom}`}>
          <textPath href={`#${bottomId}`} startOffset="50%" textAnchor="middle">
            {bottom}
          </textPath>
        </text>
        {centerLabel && (
          <text className={styles.centerLabel} x={ringX + 64} y="55" textAnchor="middle">
            {centerLabel}
          </text>
        )}
        <text className={styles.center} x={ringX + 64} y={centerLabel ? 80 : 73} textAnchor="middle">
          {center}
        </text>
      </g>
    </svg>
  );
}
