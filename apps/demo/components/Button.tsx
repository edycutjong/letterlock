import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

/**
 * Tones: `ink` is the primary action; `airmail` is the open state (a letter going out, a letter being opened);
 * `outline` is a secondary action. There is no red button: red is the wax seal's alone.
 */
export type ButtonTone = "ink" | "airmail" | "outline";

/** `waiting`: the action is running (a passkey prompt is up, a transaction is out); the button keeps its focus. */
export type ButtonStatus = "idle" | "waiting" | "disabled";

/** Gallery only: draw a pointer or keyboard state without a pointer or keyboard, so /kit can show every state. */
export type ButtonForce = "hover" | "focus" | "active";

type Common = {
  tone?: ButtonTone;
  size?: "md" | "lg";
  /** stretch to the container's width (phones) */
  block?: boolean;
  icon?: ReactNode;
  force?: ButtonForce;
  children: ReactNode;
};

export type ButtonProps = Common &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "children"> & {
    status?: ButtonStatus;
    /** replaces the label while waiting, e.g. "Waiting for your passkey…" */
    waitingLabel?: string;
  };

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export function Button({
  tone = "ink",
  size = "lg",
  block,
  icon,
  force,
  status = "idle",
  waitingLabel,
  children,
  className,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const waiting = status === "waiting";
  return (
    <button
      {...rest}
      // while waiting, a second press must neither submit a form nor start a second prompt
      type={waiting ? "button" : type}
      className={cx(styles.button, block && styles.block, className)}
      data-tone={tone}
      data-size={size}
      data-status={status}
      data-force={force}
      disabled={status === "disabled"}
      aria-disabled={waiting || undefined}
      aria-busy={waiting || undefined}
      onClick={waiting ? undefined : onClick}
    >
      {(icon || waiting) && (
        <span className={styles.icon} aria-hidden="true">
          {waiting ? <WaitRing /> : icon}
        </span>
      )}
      <span className={styles.label}>{waiting && waitingLabel ? waitingLabel : children}</span>
    </button>
  );
}

export type ButtonLinkProps = Common & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href"> & { href: string };

/** A navigation that looks like an action: same tones and sizes as Button, but it is a link. */
export function ButtonLink({ tone = "outline", size = "lg", block, icon, force, children, className, href, ...rest }: ButtonLinkProps) {
  const external = /^https?:/.test(href);
  const cls = cx(styles.button, block && styles.block, className);
  const inner = (
    <>
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.label}>{children}</span>
    </>
  );
  return external ? (
    <a {...rest} href={href} className={cls} data-tone={tone} data-size={size} data-force={force} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <Link {...rest} href={href} className={cls} data-tone={tone} data-size={size} data-force={force}>
      {inner}
    </Link>
  );
}

/** A quarter-ring turning round the icon's place while a passkey prompt or a transaction is out. */
function WaitRing() {
  return (
    <svg className={styles.wait} width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeOpacity=".28" strokeWidth="1.6" />
      <path d="M10 2.8a7.2 7.2 0 0 1 7.2 7.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
