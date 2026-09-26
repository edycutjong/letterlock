import type { Metadata } from "next";
import { Envelope } from "@/components/Envelope";
import { ExampleAction } from "@/components/ExampleAction";
import { ExampleForm } from "@/components/ExampleForm";
import { NoteField, TextField } from "@/components/Field";
import { EnvelopeIcon } from "@/components/Icons";
import { PageHead } from "@/components/PageHead";
import { RegisterTable } from "@/components/RegisterTable";
import { WaxSeal } from "@/components/WaxSeal";
import { currentKey, letter, persona } from "@/lib/examples.ts";
import { addressLine, formatBytes } from "@/lib/format.ts";
import { groupFingerprint } from "@/lib/keystrip.ts";
import styles from "./seal.module.css";

export const metadata: Metadata = { title: "Seal a note" };

export default function SealANote() {
  const maya = persona("Maya");
  const key = currentKey(maya);
  const note = letter("maya-dentist");
  return (
    <main id="main" className="page">
      <PageHead
        title="Seal a note"
        lede="Look up an address in the register and seal to the key on its line. Sealing needs no passkey and no account: anyone can write to a published key, and only the addressee’s passkey opens it."
        example="The address, key and envelope below are examples made by the SDK. Nothing was looked up, and nothing was sent."
      />

      <div className={styles.grid}>
        <ExampleForm className={styles.form} aria-label="Seal a note">
          <TextField label="To" name="to" defaultValue={maya.address} data hint="An address (0x…) or an agent (agent:<id>)." />

          <RegisterTable
            className={styles.found}
            caption="The line a keyOf lookup of this address returns"
            layout="compact"
            rows={[
              { id: "found", addressee: maya.address, epoch: key.epoch, fingerprint: key.fingerprint, posted: { kind: "example" }, state: "found", example: true },
            ]}
          />

          <NoteField label="Note" defaultValue={note.text} rows={4} />

          <div className={styles.submit}>
            <ExampleAction submit does="Sealing runs on this device, with the key on the line above; no passkey is needed.">
              Seal
            </ExampleAction>
          </div>
        </ExampleForm>

        <section className={styles.result} aria-labelledby="sealed-title">
          <h2 id="sealed-title" className={styles.resultTitle}>
            Sealed to <span className="address-line">{addressLine(maya.address)}</span>
          </h2>
          <Envelope
            recipient={maya.address}
            epoch={key.epoch}
            fingerprint={key.fingerprint}
            flap="closed"
            seal={<WaxSeal state="pressed" decorative />}
            label={`Sealed envelope to address ${maya.address}, epoch ${key.epoch}`}
          />
          <dl className={styles.facts}>
            <div>
              <dt className="label-caps">Sealed to key</dt>
              <dd className="data">{groupFingerprint(note.envelope.kid)}</dd>
            </div>
            <div>
              <dt className="label-caps">Epoch</dt>
              <dd>{note.envelope.epoch}</dd>
            </div>
            <div>
              <dt className="label-caps">Envelope</dt>
              <dd>{formatBytes(note.bytes)}</dd>
            </div>
          </dl>
          <div className={styles.send}>
            <ExampleAction tone="airmail" icon={<EnvelopeIcon />} does="Sending will post the envelope to the mailbox on Monad in one transaction.">
              Send
            </ExampleAction>
            <p className={styles.sendNote}>Only the addressee’s passkey can open it now. Not even you can read it back.</p>
          </div>
          <details className={styles.json}>
            <summary>
              <span>Envelope as it would be sent</span>
              <span className={styles.jsonMeta}>JSON · {formatBytes(note.bytes)}</span>
            </summary>
            <pre className="data">{JSON.stringify(note.envelope, null, 2)}</pre>
          </details>
        </section>
      </div>
    </main>
  );
}
