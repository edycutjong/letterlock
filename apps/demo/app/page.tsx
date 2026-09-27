import { ArrowRightIcon } from "@/components/Icons";
import { PageHead } from "@/components/PageHead";
import { currentKey, persona } from "@/lib/examples.ts";
import { AddressDesk } from "./AddressDesk";
import styles from "./home.module.css";

export default function YourAddress() {
  const maya = persona("Maya");
  return (
    <main id="main" className={`page ${styles.main}`}>
      <AddressDesk
        example={{ address: maya.address, key: currentKey(maya) }}
        intro={
          <PageHead
            size="hero"
            title={
              <>
                One passkey, <em>one encryption address.</em>
              </>
            }
            lede="Your device turns your passkey into an encryption key and posts only its public half to a register on Monad. Anyone can look up your address and seal a note to it. Only your passkey opens it, on any device the passkey syncs to."
          />
        }
      />

      <section className={styles.how} aria-labelledby="how-title">
        <h2 id="how-title" className={styles.howTitle}>
          What happens when you press it
        </h2>
        <ol className={styles.steps3}>
          <li>
            <span className={styles.no} aria-hidden="true">
              1
            </span>
            <h3>Derive</h3>
            <p>Your passkey’s PRF output becomes an X25519 key on this device. The secret half is never stored and never leaves it.</p>
            <code className="data">createEncryptionAddress()</code>
          </li>
          <li>
            <span className={styles.no} aria-hidden="true">
              2
            </span>
            <h3>Post</h3>
            <p>
              The same passkey derives an account, and the account posts the public half to the register on Monad as epoch 1. A new account holds
              no MON, so the Letterlock gas drip pays for this first post.
            </p>
            <code className="data">publish(pk, epoch)</code>
          </li>
          <li>
            <span className={styles.no} aria-hidden="true">
              3
            </span>
            <h3>Receive</h3>
            <p>Any app or agent looks you up and seals to that key without asking you. Opening it takes your passkey.</p>
            {/* the arrow is drawn: the mono face has no → glyph, and a fallback font would break the data line. It is
                kept with the call it leads to, so a narrow column breaks the chain before the arrow, never after it */}
            <code className="data">
              keyOf(address)
              <span className={styles.nobreak}>
                <ArrowRightIcon size={14} className={styles.then} />
                <span className="visually-hidden"> then </span>
                seal()
              </span>
            </code>
          </li>
        </ol>
      </section>
    </main>
  );
}
