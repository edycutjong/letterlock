import type { Metadata } from "next";
import { ButtonLink } from "@/components/Button";
import { ExampleAction } from "@/components/ExampleAction";
import { ArrowOutIcon, ArrowRightIcon, CheckIcon, EnvelopeIcon } from "@/components/Icons";
import { PageHead } from "@/components/PageHead";
import { DIRECTORY } from "@/lib/deployment.ts";
import { shortHex } from "@/lib/format.ts";
import styles from "./judge.module.css";

export const metadata: Metadata = { title: "For judges" };

type Status = "done" | "next" | "todo";

const STATUS_LABEL: Record<Status, string> = { done: "Done", next: "Next", todo: "To do" };

function Mark({ status }: { status: Status }) {
  return (
    <span className={styles.mark} data-status={status}>
      <span className={styles.box} aria-hidden="true">
        {status === "done" && <CheckIcon size={18} strokeWidth={2.2} />}
      </span>
      <span className={`${styles.markLabel} label-caps`}>{STATUS_LABEL[status]}</span>
    </span>
  );
}

export default function ForJudges() {
  return (
    <main id="main" className="page">
      <PageHead
        title={
          <>
            Two devices, <em>three steps.</em>
          </>
        }
        lede="The claim to test: something that has never met you seals a note to your address, and you open it with one passkey tap on a device you just picked up. No account, no server key, no key exchange between your devices."
        example="The ticks below show an example run. The agent is not live yet, and these buttons are not connected."
      />

      <div className={styles.grid}>
        <ol className={styles.route} aria-label="The three steps">
          <li className={styles.step} data-status="done">
            <span className={styles.no} aria-hidden="true">
              1
            </span>
            <div className={styles.body}>
              <h2 className={styles.h2}>Create your address</h2>
              <p>On this device. One passkey prompt derives your key, and its public half is posted to the register.</p>
              <div className={styles.actions}>
                <ButtonLink href="/" size="md" icon={<ArrowRightIcon />}>
                  Your address
                </ButtonLink>
              </div>
            </div>
            <Mark status="done" />
          </li>
          <li className={styles.step} data-status="next">
            <span className={styles.no} aria-hidden="true">
              2
            </span>
            <div className={styles.body}>
              <h2 className={styles.h2}>Ask an agent to write to you</h2>
              <p>
                The agent is a separate process that knows only your address. It looks up your key in the register, seals a note, and drops it
                in the mailbox on Monad.
              </p>
              <div className={styles.actions}>
                <ExampleAction tone="airmail" size="md" icon={<EnvelopeIcon />} does="The agent will be asked to seal a note to your address.">
                  Ask the agent
                </ExampleAction>
              </div>
            </div>
            <Mark status="next" />
          </li>
          <li className={styles.step} data-status="todo">
            <span className={styles.no} aria-hidden="true">
              3
            </span>
            <div className={styles.body}>
              <h2 className={styles.h2}>Open it somewhere else</h2>
              <p>
                Clear this browser’s storage, or pick up another device your passkey syncs to. Open the note from the inbox with one passkey
                tap: the seal breaks and the text appears.
              </p>
              <div className={styles.actions}>
                <ButtonLink href="/open" size="md" icon={<ArrowRightIcon />}>
                  Go to the inbox
                </ButtonLink>
              </div>
            </div>
            <Mark status="todo" />
          </li>
        </ol>

        <aside className={styles.check} aria-labelledby="check-title">
          <h2 id="check-title" className="label-caps">
            What to check
          </h2>
          <ul>
            <li>
              <strong>The writer knew only an address.</strong> It read your key from the register and sealed to it. It never talked to your
              devices.
            </li>
            <li>
              <strong>Nothing secret is stored.</strong> A browser with its storage cleared still opens the note: the passkey re-derives the
              key.
            </li>
            <li>
              <strong>No sender is claimed.</strong> Anyone may seal to a published key, so the inbox never names who wrote a note.
            </li>
            <li>
              <strong>The directory is on chain.</strong>{" "}
              <a href={DIRECTORY.explorer} target="_blank" rel="noreferrer" className={styles.inline}>
                <span className="data">{shortHex(DIRECTORY.address, 6, 4)}</span>
                <ArrowOutIcon size={14} />
                <span className="visually-hidden"> (opens the explorer)</span>
              </a>{" "}
              on {DIRECTORY.network}, source verified ({DIRECTORY.verifier}, {DIRECTORY.match.replace("_", " ")}).
            </li>
          </ul>
        </aside>
      </div>
    </main>
  );
}
