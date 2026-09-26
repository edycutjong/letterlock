"use client";

import { useId, useState, type ReactNode } from "react";
import { Button, type ButtonTone } from "./Button";
import { PasskeyIcon } from "./Icons";
import styles from "./ExampleAction.module.css";

export type ExampleActionProps = {
  children: ReactNode;
  tone?: ButtonTone;
  /** draw the passkey icon: the real action raises a passkey prompt */
  passkey?: boolean;
  icon?: ReactNode;
  block?: boolean;
  size?: "md" | "lg";
  /** what the real action will do, said when the button is pressed on this example page */
  does: string;
  className?: string;
};

/**
 * A page's action while the page shows example content: it looks and responds like the real button, and when
 * pressed it says plainly that nothing is connected yet, instead of pretending to wait for a passkey or a chain.
 */
export function ExampleAction({ children, tone = "ink", passkey, icon, block, size, does, className }: ExampleActionProps) {
  const [pressed, setPressed] = useState(false);
  const noteId = useId();
  return (
    <div className={[styles.action, block && styles.block, className].filter(Boolean).join(" ")}>
      <Button
        tone={tone}
        size={size}
        block={block}
        icon={passkey ? <PasskeyIcon /> : icon}
        aria-describedby={pressed ? noteId : undefined}
        onClick={() => setPressed(true)}
      >
        {children}
      </Button>
      <p id={noteId} className={styles.note} role="status">
        {pressed ? `Not connected yet: this page shows example content. ${does}` : ""}
      </p>
    </div>
  );
}
