"use client";

import type { ReactNode } from "react";
import type { Failure } from "@/lib/failure.ts";
import { ErrorSlip } from "./ErrorSlip";
import { ReturnIcon } from "./Icons";
import styles from "./FailureNotice.module.css";

/**
 * Shows a failure where it happened: an SDK code as a returned-to-sender slip (with the page's recovery button), any
 * other failure as a short ruled note. A form error (INPUT_INVALID) belongs beside its field, so it is not shown here
 * unless the page has no field for it.
 */
export function FailureNotice({ failure, action, className }: { failure: Failure | undefined; action?: ReactNode; className?: string }) {
  if (!failure) return null;
  if (failure.kind === "slip") return <ErrorSlip code={failure.code} values={failure.values} action={action} live className={className} />;
  return (
    <div className={[styles.note, className].filter(Boolean).join(" ")} role="alert">
      <p className={styles.head}>
        <ReturnIcon size={16} />
        <span>{failure.kind === "input" ? "Not accepted" : failure.title}</span>
      </p>
      <p className={styles.text}>{failure.message}</p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
