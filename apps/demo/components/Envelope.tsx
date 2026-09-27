import { useId, type ReactNode } from "react";
import { addressLine, addressSpoken } from "@/lib/format.ts";
import { KeyStrip } from "./KeyStrip";
import styles from "./Envelope.module.css";

export type EnvelopeProps = {
  /** the address line: a 0x address (shown shortened, read out in full) or `agent:<id>` */
  recipient: string;
  /** printed under the address line */
  epoch?: number;
  /** the recipient key's fingerprint, drawn as a bar strip at the end of the address line */
  fingerprint?: string;
  /**
   * `closed`: the flap is down and the letter, if any, is tucked inside. `open`: the flap is folded back and the
   * letter stands out of the pocket. Changing it animates the flap (and the letter), unless motion is reduced.
   */
  flap: "open" | "closed";
  /** slot at the flap's tip, usually a <WaxSeal> */
  seal?: ReactNode;
  /**
   * The letter. Pass it only while its text exists on this device: a sealed envelope from the directory has no
   * plaintext to pass. While the flap is closed it is tucked in, hidden and inert.
   */
  children?: ReactNode;
  /** `compact` draws the envelope only (inbox thumbnails); the facts go in the text beside it */
  variant?: "full" | "compact";
  /** accessible name; defaults to "Envelope to <recipient>" */
  label?: string;
  /** hide it from assistive technology when the text beside it says everything (inbox thumbnails) */
  decorative?: boolean;
  className?: string;
};

const W = 380;
const H = 240;
/** the swelled address rule with its curled ends and ball terminals, in envelope units */
const ADDRESS_RULE =
  "M42 192.6L52.6 192.4L63.1 192.1L73.7 191.9L84.3 191.7L94.9 191.5L105.4 191.3L116 191.1L126.6 191L137.1 190.8L147.7 190.7L158.3 190.6L168.9 190.6L179.4 190.5L190 190.5L200.6 190.5L211.1 190.6L221.7 190.6L232.3 190.7L242.9 190.8L253.4 191L264 191.1L274.6 191.3L285.1 191.5L295.7 191.7L306.3 191.9L316.9 192.1L327.4 192.4L338 192.6L338 193.4L327.4 193.6L316.9 193.9L306.3 194.1L295.7 194.3L285.1 194.5L274.6 194.7L264 194.9L253.4 195L242.9 195.2L232.3 195.3L221.7 195.4L211.1 195.4L200.6 195.5L190 195.5L179.4 195.5L168.9 195.4L158.3 195.4L147.7 195.3L137.1 195.2L126.6 195L116 194.9L105.4 194.7L94.9 194.5L84.3 194.3L73.7 194.1L63.1 193.9L52.6 193.6L42 193.4ZM44.9 192.3C37.9 192.2 34.2 194.2 33.8 197.5L35.5 197.6C35.7 195.1 38.8 193.5 44.9 193.4ZM335.1 193.7C342.1 193.8 345.8 191.8 346.2 188.5L344.5 188.4C344.3 190.9 341.2 192.5 335.1 192.6ZM32 198.9a2.49 2.49 0 1 0 5 0a2.49 2.49 0 1 0 -5 0ZM343.1 187.1a2.49 2.49 0 1 0 5 0a2.49 2.49 0 1 0 -5 0Z";
/** the airmail ring: a 10-unit band inset 7 from the edge */
const AIRMAIL_RING = "M7 7H373V233H7ZM17 17V223H363V17Z";
/** the front of the pocket: the whole face except the V the flap covers */
const POCKET = "M0 0L190 132L380 0L380 240L0 240Z";
const FLAP = "M0 0L190 132L380 0Z";

export function Envelope({ recipient, epoch, fingerprint, flap, seal, children, variant = "full", label, decorative, className }: EnvelopeProps) {
  const uid = `env${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const id = (n: string) => `${uid}-${n}`;
  const url = (n: string) => `url(#${id(n)})`;
  const hasLetter = children !== undefined && children !== null && children !== false;
  const full = variant === "full";

  // the airmail chevrons, defined in each of the two SVGs that paint them, under its own id: ids are unique in a page
  const airmail = (face: "flap" | "front") => (
    <pattern id={id(`airmail-${face}`)} width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="11.6" height="20" className={styles.airmailInk} />
    </pattern>
  );

  return (
    <figure
      className={[styles.envelope, className].filter(Boolean).join(" ")}
      data-flap={flap}
      data-letter={hasLetter ? "" : undefined}
      data-variant={variant}
      aria-label={decorative ? undefined : (label ?? `Envelope to ${addressSpoken(recipient)}`)}
      aria-hidden={decorative || undefined}
    >
      <div className={styles.stage}>
        {/* the letter's track above the pocket, rendered with or without a letter: a letter that arrives with the
            opening flap then rises out of the pocket instead of appearing at full height */}
        <div className={styles.letterRow}>
          {hasLetter && (
            <div className={styles.letterSlot} inert={flap === "closed" || undefined} aria-hidden={flap === "closed" || undefined}>
              <div className={styles.letter}>{children}</div>
            </div>
          )}
        </div>

        <div className={styles.body}>
          {/* the inside of the envelope, seen through the open V */}
          <svg className={styles.back} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id={id("inside")} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className={styles.insideDeep} />
                <stop offset=".55" className={styles.insideLit} />
              </linearGradient>
            </defs>
            <rect width={W} height={H} rx="4" fill={url("inside")} />
          </svg>

          {/* the flap: two faces on one hinge along the top edge */}
          <div className={styles.flap}>
            <svg className={`${styles.face} ${styles.outer}`} viewBox={`0 0 ${W} 132`} overflow="visible" aria-hidden="true" focusable="false">
              <defs>
                {airmail("flap")}
                <linearGradient id={id("flap")} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="132">
                  <stop offset="0" className={styles.flapFold} />
                  <stop offset=".24" className={styles.flapMid} />
                  <stop offset="1" className={styles.flapLit} />
                </linearGradient>
                <clipPath id={id("flap-clip")}>
                  <path d={FLAP} />
                </clipPath>
                <filter id={id("flap-soft")} x="-10%" y="-10%" width="120%" height="160%">
                  <feGaussianBlur stdDeviation="3" />
                </filter>
              </defs>
              {/* the flap's shadow on the pocket, falling down-right */}
              <path className={styles.flapShadow} d="M0 0L190 131L380 0" transform="translate(2 5)" filter={url("flap-soft")} />
              <path d={FLAP} fill={url("flap")} />
              <path d={AIRMAIL_RING} fill={url("airmail-flap")} fillRule="evenodd" clipPath={url("flap-clip")} />
              <path className={styles.flapHighlight} d="M3 1L190 128.6L377 1" />
              <path className={styles.edge} d="M0 0L190 131L380 0" />
            </svg>
            <svg className={`${styles.face} ${styles.inner}`} viewBox={`0 0 ${W} 132`} aria-hidden="true" focusable="false">
              <path className={styles.innerPaper} d="M0 132L190 0L380 132Z" />
              <path className={styles.innerEdge} d="M0 132L190 0L380 132" />
            </svg>
          </div>

          {/* the pocket's face: paper, airmail chevrons, the address rule, the ink outline */}
          <svg className={styles.front} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
            <defs>
              {airmail("front")}
              <linearGradient id={id("paper")} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" className={styles.paperLit} />
                <stop offset=".6" className={styles.paperLit} />
                <stop offset="1" className={styles.paperShade} />
              </linearGradient>
              <clipPath id={id("pocket")}>
                <path d={POCKET} />
              </clipPath>
              <clipPath id={id("round")}>
                <rect width={W} height={H} rx="4" />
              </clipPath>
            </defs>
            <g clipPath={url("round")}>
              <path d={POCKET} fill={url("paper")} />
              <path d={AIRMAIL_RING} fill={url("airmail-front")} fillRule="evenodd" clipPath={url("pocket")} />
              <path className={styles.pocketEdge} d="M0 0L190 131L380 0" />
            </g>
            {full && <path className={styles.rule} d={ADDRESS_RULE} />}
            <rect className={styles.outline} x="0" y="0" width={W} height={H} rx="4" />
          </svg>

          {full && (
            <>
              <p className={`${styles.address} address-line`}>
                <span aria-hidden="true">{addressLine(recipient)}</span>
                <span className="visually-hidden">To {addressSpoken(recipient)}</span>
              </p>
              {fingerprint && (
                <span className={styles.strip}>
                  <KeyStrip fingerprint={fingerprint} tone="open" announce />
                </span>
              )}
              {epoch !== undefined && <p className={`${styles.epoch} label-caps`}>Epoch {epoch}</p>}
            </>
          )}

          {seal && <div className={styles.seal}>{seal}</div>}
        </div>
      </div>
    </figure>
  );
}

/**
 * The letter's text, set as a note on ruled paper. Envelope takes any children; this is the usual one.
 * `stamp` is struck in the sheet's top right corner (an <ExampleBadge> while the letter is example content), so the
 * mark travels with the letter at every width instead of standing in a caption the layout may move away from it.
 */
export function Letter({ children, stamp }: { children: ReactNode; stamp?: ReactNode }) {
  return (
    <div className={styles.note}>
      {stamp && <span className={styles.stamp}>{stamp}</span>}
      {children}
    </div>
  );
}
