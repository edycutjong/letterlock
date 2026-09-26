import { useId, type ReactNode } from "react";
import { SLIP_CODES, SLIP_COPY, type SlipCode, type SlipValues } from "@/lib/error-copy.ts";
import { ExampleBadge } from "./ExampleBadge";
import { CheckIcon, ReturnIcon } from "./Icons";
import styles from "./ErrorSlip.module.css";

export type ErrorSlipProps = {
  code: SlipCode;
  /** values the slip can quote (epochs, fingerprints); every sentence stays true without them */
  values?: SlipValues;
  /** the button that carries out the recovery, when the page has one */
  action?: ReactNode;
  example?: boolean;
  headingLevel?: 2 | 3;
  /** announce the slip as it appears (role="alert"); off for slips rendered with the page */
  live?: boolean;
  className?: string;
};

const FINGERPRINT_TEXT = /([0-9a-f]{4}(?: [0-9a-f]{4}){3})/;

/** A key fingerprint quoted inside a sentence is data, so it is set in the data face. */
const withData = (text: string) =>
  text.split(FINGERPRINT_TEXT).map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className={styles.fp}>
        {part}
      </code>
    ) : (
      part
    ),
  );

/**
 * A "returned to sender" slip: what the SDK error means, in plain words, and what to do about it. Every slip prints
 * the full list of reasons with the one that applies ticked, the way a postal return slip does. It is inked, never red.
 */
export function ErrorSlip({ code, values = {}, action, example, headingLevel = 3, live, className }: ErrorSlipProps) {
  const copy = SLIP_COPY[code];
  const H = headingLevel === 2 ? "h2" : "h3";
  const headingId = `slip-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <section
      className={[styles.slip, className].filter(Boolean).join(" ")}
      role={live ? "alert" : undefined}
      aria-labelledby={headingId}
      data-code={code}
    >
      <header className={styles.head}>
        <p className={styles.stamp}>
          <ReturnIcon size={18} />
          <span>Returned to sender</span>
        </p>
        <span className={styles.meta}>
          {example && <ExampleBadge />}
          <code className={styles.code}>{code}</code>
        </span>
      </header>

      <H className={styles.reason} id={headingId}>
        <span className="visually-hidden">Returned to sender: </span>
        {copy.reason}
      </H>
      <p className={styles.meaning}>{withData(copy.meaning(values))}</p>

      <ul className={styles.boxes} aria-hidden="true">
        {SLIP_CODES.map((c) => (
          <li key={c} data-ticked={c === code ? "" : undefined}>
            <span className={styles.box}>{c === code && <CheckIcon size={14} strokeWidth={2.2} />}</span>
            {SLIP_COPY[c].box}
          </li>
        ))}
      </ul>

      <div className={styles.recovery}>
        <p>
          <span className={`${styles.todo} label-caps`}>What to do</span>
          {withData(copy.recovery(values))}
        </p>
        {action && <div className={styles.action}>{action}</div>}
      </div>
    </section>
  );
}
