import type { ReactNode } from "react";
import { addressLine, addressSpoken, formatCount, formatUtc, shortHex } from "@/lib/format.ts";
import { AddressRule } from "./AddressRule";
import { ExampleBadge } from "./ExampleBadge";
import { ArrowOutIcon } from "./Icons";
import { FingerprintText, KeyStrip } from "./KeyStrip";
import { Postmark, type PostmarkProps } from "./Postmark";
import styles from "./AddressCard.module.css";

/** Where the key's publish transaction stands. Example cards are never linked: nothing in them is on chain. */
export type Posted =
  | { kind: "tx"; hash: `0x${string}`; href: string; block?: number; at?: number; network: string }
  | { kind: "pending" }
  | { kind: "example" };

export type AddressCardProps = {
  address: `0x${string}`;
  fingerprint: string;
  epoch: number;
  posted: Posted;
  /** stamps the card "Example" */
  example?: boolean;
  /** the card's heading; the address line itself is not a heading */
  title?: string;
  headingLevel?: 2 | 3;
  /** a postmark struck over the card's corner (decorative: the same facts are printed on the card) */
  postmark?: Pick<PostmarkProps, "top" | "bottom" | "center" | "centerLabel">;
  /** e.g. a Rotate button */
  actions?: ReactNode;
  /** one line under the actions */
  footnote?: ReactNode;
  className?: string;
};

export function AddressCard({
  address,
  fingerprint,
  epoch,
  posted,
  example,
  title = "Your encryption address",
  headingLevel = 2,
  postmark,
  actions,
  footnote,
  className,
}: AddressCardProps) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <article
      className={[styles.card, className].filter(Boolean).join(" ")}
      data-example={example ? "" : undefined}
      data-postmark={postmark ? "" : undefined}
    >
      {postmark && <Postmark className={styles.postmark} size={104} tilt={-11} {...postmark} />}
      <header className={styles.head}>
        <H className={`${styles.title} label-caps`}>{title}</H>
        {example && <ExampleBadge />}
      </header>

      <p className={`${styles.address} address-line`}>
        <span aria-hidden="true">{addressLine(address)}</span>
        <span className="visually-hidden">{addressSpoken(address)}</span>
      </p>
      <AddressRule className={styles.rule} />

      <dl className={styles.facts}>
        <div className={styles.row}>
          <dt className="label-caps">Key</dt>
          <dd className={styles.key}>
            <KeyStrip fingerprint={fingerprint} tone="open" height={13} />
            <FingerprintText fingerprint={fingerprint} />
          </dd>
        </div>
        <div className={styles.row}>
          <dt className="label-caps">Epoch</dt>
          <dd className={styles.epoch}>{epoch}</dd>
        </div>
        <div className={styles.row}>
          <dt className="label-caps">Address</dt>
          <dd className={`${styles.full} data`}>{address}</dd>
        </div>
        <div className={styles.row}>
          <dt className="label-caps">Posted</dt>
          <dd>
            <PostedValue posted={posted} />
          </dd>
        </div>
      </dl>

      {(actions || footnote) && (
        <footer className={styles.actions}>
          {actions}
          {footnote && <p className={styles.footnote}>{footnote}</p>}
        </footer>
      )}
    </article>
  );
}

export function PostedValue({ posted }: { posted: Posted }) {
  if (posted.kind === "example") return <span className={styles.muted}>Not posted: example card</span>;
  if (posted.kind === "pending")
    return (
      <span className={styles.pending}>
        <span className={styles.dots} aria-hidden="true" />
        Waiting for the transaction
      </span>
    );
  return (
    <span className={styles.tx}>
      <a className={`${styles.txLink} data`} href={posted.href} target="_blank" rel="noreferrer">
        {shortHex(posted.hash, 8, 6)}
        <ArrowOutIcon size={15} />
        <span className="visually-hidden"> (opens the explorer)</span>
      </a>
      <span className={styles.when}>
        {posted.network}
        {posted.block !== undefined && <> · block {formatCount(posted.block)}</>}
        {posted.at !== undefined && <> · {formatUtc(posted.at)}</>}
      </span>
    </span>
  );
}
