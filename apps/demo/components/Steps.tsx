import type { ReactNode } from "react";
import { CheckIcon } from "./Icons";
import styles from "./Steps.module.css";

export type StepStatus = "todo" | "active" | "done" | "skipped" | "failed";

export type StepItem = {
  id: string;
  title: ReactNode;
  status: StepStatus;
  /** one line under the title: a fingerprint, an address, an amount, a transaction link */
  detail?: ReactNode;
};

const SAID: Record<StepStatus, string> = { todo: "to do", active: "in progress", done: "done", skipped: "not needed", failed: "stopped" };

/**
 * A flow's steps as a ruled docket: one numbered line per step and a box that fills in as it completes. The box is
 * ink when done, an airmail ring while the step runs (a passkey prompt or a transaction), dashed while it waits.
 */
export function Steps({ items, label, className }: { items: StepItem[]; label: string; className?: string }) {
  return (
    <ol className={[styles.steps, className].filter(Boolean).join(" ")} aria-label={label}>
      {items.map((s, i) => (
        <li key={s.id} className={styles.step} data-status={s.status}>
          <span className={styles.no} aria-hidden="true">
            {i + 1}
          </span>
          <div className={styles.body}>
            <p className={styles.title}>
              {s.title}
              <span className="visually-hidden">: {SAID[s.status]}</span>
            </p>
            {s.detail && <div className={styles.detail}>{s.detail}</div>}
          </div>
          <span className={styles.box} aria-hidden="true">
            {s.status === "done" && <CheckIcon size={14} strokeWidth={2.2} />}
            {s.status === "skipped" && <span className={styles.dash} />}
          </span>
        </li>
      ))}
    </ol>
  );
}
