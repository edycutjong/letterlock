import type { ReactNode } from "react";
import { ExampleNote } from "./ExampleBadge";
import styles from "./PageHead.module.css";

export type PageHeadProps = {
  title: ReactNode;
  lede?: ReactNode;
  /** what on the page is example content; printed beside an "Example" stamp */
  example?: ReactNode;
  /** `hero` sets the title larger (the home page) */
  size?: "hero" | "title";
  id?: string;
  children?: ReactNode;
  className?: string;
};

export function PageHead({ title, lede, example, size = "title", id, children, className }: PageHeadProps) {
  return (
    <header className={[styles.head, className].filter(Boolean).join(" ")} data-size={size}>
      <h1 id={id} className={styles.title}>
        {title}
      </h1>
      {lede && <PageLede>{lede}</PageLede>}
      {children}
      {example && <ExampleNote className={styles.example}>{example}</ExampleNote>}
    </header>
  );
}

/** A page head's lede, for a page that lays it out apart from its title (the inbox, on narrow screens). */
export function PageLede({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={[styles.lede, className].filter(Boolean).join(" ")}>{children}</p>;
}
