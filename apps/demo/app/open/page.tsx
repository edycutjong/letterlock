import type { Metadata } from "next";
import { Envelope, Letter } from "@/components/Envelope";
import { ErrorSlip } from "@/components/ErrorSlip";
import { ExampleNote } from "@/components/ExampleBadge";
import { ExampleAction } from "@/components/ExampleAction";
import { PageHead } from "@/components/PageHead";
import { WaxSeal } from "@/components/WaxSeal";
import { EXAMPLE_TAMPERED, currentKey, letter, persona } from "@/lib/examples.ts";
import { addressLine, formatBytes, utf8Bytes } from "@/lib/format.ts";
import styles from "./open.module.css";

export const metadata: Metadata = { title: "Inbox" };

export default function Inbox() {
  const maya = persona("Maya");
  const key = currentKey(maya);
  const opened = letter("maya-dentist");
  const sealed = letter("maya-flight");
  const tamperedBytes = utf8Bytes(JSON.stringify(EXAMPLE_TAMPERED.envelope));
  return (
    // wide screens: the open letter stands beside the page head, so its seal is in the first screen; narrow: under it
    <main id="main" className={`page ${styles.main}`}>
      <PageHead
        className={styles.head}
        title="Inbox"
        lede={
          <>
            Letters addressed to <span className="address-line">{addressLine(maya.address)}</span>. Each opens with one passkey tap, on
            any device your passkey syncs to, and nothing is stored.
          </>
        }
        example="Example envelopes, sealed by the SDK to an example key. The open letter is the real decryption of the first one."
      />

      <section className={styles.reader} aria-labelledby="reader-title">
        <h2 id="reader-title" className="visually-hidden">
          The opened letter
        </h2>
        <Envelope
          recipient={maya.address}
          epoch={opened.epoch}
          fingerprint={key.fingerprint}
          flap="open"
          seal={<WaxSeal state="cracked" decorative />}
          label={`Opened envelope to address ${maya.address}, epoch ${opened.epoch}`}
        >
          <Letter>
            <p>{opened.text}</p>
          </Letter>
        </Envelope>
        <ExampleNote className={styles.caption}>
          The SDK’s real decryption of this example envelope, opened with the example key: no passkey was used · epoch {opened.epoch} ·{" "}
          {formatBytes(opened.bytes)}. No sender is shown: anyone may seal to a published key, so the envelope cannot say who wrote it.
        </ExampleNote>
      </section>

      <section className={styles.inbox} aria-labelledby="inbox-title">
        <h2 id="inbox-title" className={styles.inboxTitle}>
          Letters for you
        </h2>
        <ol className={styles.list}>
          <li className={styles.item} data-state="opened">
            <div className={styles.thumb}>
              <Envelope recipient={maya.address} flap="open" variant="compact" seal={<WaxSeal state="cracked" decorative />} decorative />
            </div>
            <div className={styles.meta}>
              <p className={styles.state}>Opened</p>
              <p className={styles.detail}>
                Epoch {opened.epoch} · {formatBytes(opened.bytes)}
              </p>
              <p className={styles.detail}>Shown on this page</p>
            </div>
          </li>
          <li className={styles.item} data-state="sealed">
            <div className={styles.thumb}>
              <Envelope recipient={maya.address} flap="closed" variant="compact" seal={<WaxSeal state="pressed" decorative />} decorative />
            </div>
            <div className={styles.meta}>
              <p className={styles.state}>Sealed</p>
              <p className={styles.detail}>
                Epoch {sealed.epoch} · {formatBytes(sealed.bytes)}
              </p>
              <ExampleAction
                tone="airmail"
                passkey
                size="md"
                does="Opening will ask for your passkey, re-derive the epoch 1 key, and open the letter here."
              >
                Open with passkey
              </ExampleAction>
            </div>
          </li>
          <li className={styles.item} data-state="returned">
            <div className={styles.thumb}>
              <Envelope recipient={maya.address} flap="closed" variant="compact" seal={<WaxSeal state="pressed" decorative />} decorative />
              <span className={styles.returned} aria-hidden="true">
                Returned
              </span>
            </div>
            <div className={styles.meta}>
              <p className={styles.state}>Returned to sender</p>
              <p className={styles.detail}>
                Epoch {EXAMPLE_TAMPERED.envelope.epoch} · {formatBytes(tamperedBytes)} · changed in transit
              </p>
            </div>
          </li>
        </ol>

        <ErrorSlip code="TAMPERED" example />
      </section>
    </main>
  );
}
