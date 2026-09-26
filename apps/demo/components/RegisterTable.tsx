import type { ReactNode } from "react";
import { addressLine, addressSpoken } from "@/lib/format.ts";
import { PostedValue, type Posted } from "./AddressCard";
import { ExampleBadge } from "./ExampleBadge";
import { FingerprintText, KeyStrip } from "./KeyStrip";
import { ScrollFrame } from "./ScrollFrame";
import styles from "./RegisterTable.module.css";

export type RegisterRow = {
  id: string;
  /** a 0x address or `agent:<id>` */
  addressee: string;
  epoch: number;
  fingerprint: string;
  posted: Posted;
  /**
   * `found`: the line a keyOf lookup just resolved (inked airmail blue: open, readable by anyone).
   * `superseded`: an earlier epoch of an addressee who has rotated; ruled through, still listed as history.
   */
  state?: "current" | "found" | "superseded";
  /** one short line under the addressee, e.g. "test key · no passkey" */
  note?: string;
  /** stamp the line "Example" */
  example?: boolean;
};

export type RegisterTableProps = {
  caption: ReactNode;
  /** keep the caption for screen readers only, when a visible heading already names the table */
  captionHidden?: boolean;
  rows: RegisterRow[];
  /**
   * `auto`: every column from 1024 px up; below that addressee · epoch · key. `full` and `compact` force one of the
   * two (the /kit shows both at any width).
   */
  layout?: "auto" | "full" | "compact";
  /** shown when there are no rows */
  empty?: ReactNode;
  className?: string;
};

export function RegisterTable({ caption, captionHidden, rows, layout = "auto", empty, className }: RegisterTableProps) {
  return (
    // on the narrowest phones the register slides sideways inside its own frame, which is then a named,
    // keyboard-reachable region (and only then: a frame that fits is no Tab stop)
    <ScrollFrame className={[styles.wrap, className].filter(Boolean).join(" ")} data-layout={layout} label={typeof caption === "string" ? caption : "Register"}>
      <table className={styles.table}>
        <caption className={captionHidden ? "visually-hidden" : styles.caption}>{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={`${styles.colAddressee} label-caps`}>
              Addressee
            </th>
            <th scope="col" className={`${styles.colEpoch} label-caps`}>
              Epoch
            </th>
            <th scope="col" className={`${styles.colKey} label-caps`}>
              Key
            </th>
            <th scope="col" className={`${styles.colPosted} label-caps`}>
              Posted
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className={styles.empty} colSpan={4}>
                {empty ?? "No keys posted yet."}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} data-state={r.state ?? "current"}>
              <th scope="row" className={styles.addressee}>
                <span className={styles.addresseeLine}>
                  <span className={`${styles.name} address-line`} aria-hidden="true">
                    {addressLine(r.addressee)}
                  </span>
                  <span className="visually-hidden">{addressSpoken(r.addressee)}</span>
                  {r.example && <ExampleBadge className={styles.badge} />}
                </span>
                {r.state === "found" && <span className={`${styles.found} label-caps`}>Found by keyOf</span>}
                {r.state === "superseded" && <span className={`${styles.superseded} label-caps`}>Superseded</span>}
                {r.note && <span className={styles.note}>{r.note}</span>}
              </th>
              <td className={styles.epoch}>{r.epoch}</td>
              <td className={styles.key}>
                <span className={styles.keyInner}>
                  <KeyStrip fingerprint={r.fingerprint} tone={r.state === "superseded" ? "pencil" : "open"} height={12} className={styles.strip} />
                  <FingerprintText fingerprint={r.fingerprint} />
                </span>
              </td>
              <td className={styles.posted}>
                {r.posted.kind === "example" ? <span className={styles.muted}>Example, not posted</span> : <PostedValue posted={r.posted} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollFrame>
  );
}
