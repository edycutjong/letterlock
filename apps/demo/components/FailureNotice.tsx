"use client";

import type { ReactNode } from "react";
import type { Failure } from "@/lib/failure.ts";
import { ErrorSlip } from "./ErrorSlip";
import { ReturnIcon } from "./Icons";
import styles from "./FailureNotice.module.css";

/**
 * Shows a failure where it happened: an SDK code as a returned-to-sender slip (with the page's recovery button), any
 * other failure as a short ruled note. A form error (INPUT_INVALID) belongs beside its field, so it is not shown here
 * unless the page has no field for it. A slip's heading is an h3 by default; where the notice sits directly under the
 * page's h1 (no h2 between), pass headingLevel={2} so the outline does not skip a level.
 */
export function FailureNotice({
  failure,
  action,
  className,
  headingLevel,
}: {
  failure: Failure | undefined;
  action?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  if (!failure) return null;
  if (failure.kind === "slip")
    return <ErrorSlip code={failure.code} values={failure.values} action={action} live headingLevel={headingLevel} className={className} />;
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
