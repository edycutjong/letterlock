import { ButtonLink } from "@/components/Button";
import { ArrowRightIcon, ReturnIcon } from "@/components/Icons";
import styles from "./not-found.module.css";

export default function NotFound() {
  return (
    <main id="main" className={`page ${styles.main}`}>
      <p className={styles.stamp}>
        <ReturnIcon size={18} />
        <span>Returned to sender</span>
      </p>
      <h1 className={styles.title}>
        No page at <em>this address.</em>
      </h1>
      <p className={styles.lede}>The link may be mistyped, or the page may have moved. Every page of the register starts from your address.</p>
      <ButtonLink href="/" icon={<ArrowRightIcon />}>
        Your address
      </ButtonLink>
    </main>
  );
}
