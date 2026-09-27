import { AddressCard } from "@/components/AddressCard";
import { ExampleNote } from "@/components/ExampleBadge";
import { ExampleAction } from "@/components/ExampleAction";
import { ArrowRightIcon } from "@/components/Icons";
import { PageHead } from "@/components/PageHead";
import { currentKey, persona } from "@/lib/examples.ts";
import styles from "./home.module.css";

export default function YourAddress() {
  const maya = persona("Maya");
  const key = currentKey(maya);
  return (
    <main id="main" className={`page ${styles.main}`}>
      <section className={styles.hero}>
        <div className={styles.intro}>
          <PageHead
            size="hero"
            title={
              <>
                One passkey, <em>one encryption address.</em>
              </>
            }
            lede="Your device turns your passkey into an encryption key and posts only its public half to a register on Monad. Anyone can look up your address and seal a note to it. Only your passkey opens it, on any device the passkey syncs to."
          />
          <div className={styles.cta}>
            <ExampleAction passkey does="Here your passkey will derive your key, and its public half will be posted to the register.">
              Create my encryption address
            </ExampleAction>
            <p className={styles.fine}>One passkey prompt, two on some browsers. Nothing secret is stored or sent.</p>
          </div>
        </div>

        <div className={styles.cardCol}>
          <AddressCard
            example
            address={maya.address}
            fingerprint={key.fingerprint}
            epoch={key.epoch}
            posted={{ kind: "example" }}
            postmark={{ top: "Letterlock register", bottom: "Example · not posted", center: String(key.epoch), centerLabel: "Epoch" }}
            actions={
              <ExampleAction tone="outline" passkey size="md" does="Rotating will derive your epoch 2 key and post it.">
                Rotate key
              </ExampleAction>
            }
            footnote="Rotating posts epoch 2. Notes sealed to epoch 1 still open: your passkey re-derives every earlier key."
          />
          <ExampleNote className={styles.cardNote}>
            An example address and key, made by the SDK from a labelled string. Not yours, and not on chain.
          </ExampleNote>
        </div>
      </section>

      <section className={styles.how} aria-labelledby="how-title">
        <h2 id="how-title" className={styles.howTitle}>
          What happens when you press it
        </h2>
        <ol className={styles.steps}>
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
            <p>The public half goes in the register on Monad, next to your address, as epoch 1.</p>
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
