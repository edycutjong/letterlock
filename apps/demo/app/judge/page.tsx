import type { Metadata } from "next";
import { ArrowOutIcon } from "@/components/Icons";
import { PageHead } from "@/components/PageHead";
import { DIRECTORY } from "@/lib/deployment.ts";
import { shortHex } from "@/lib/format.ts";
import { JudgeRoute } from "./JudgeRoute";
import styles from "./judge.module.css";

export const metadata: Metadata = { title: "For judges" };

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
      />

      <div className={styles.grid}>
        <JudgeRoute />

        <aside className={styles.check} aria-labelledby="check-title">
          <h2 id="check-title" className="label-caps">
            What to check
          </h2>
          <ul>
            <li>
              <strong>The writer knew only an address.</strong> The agent read your key from the register and sealed to it. It never talked to your
              devices, and its drop transaction is linked in step 2.
            </li>
            <li>
              <strong>Nothing secret is stored.</strong> This site keeps your passkey’s id and your address, nothing else. A browser with its storage
              cleared still opens the note: “Find my inbox with my passkey” derives your address again, and the passkey re-derives the key.
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
              on {DIRECTORY.network}, source verified ({DIRECTORY.verifier}, {DIRECTORY.match.replace("_", " ")}). Every step’s transaction opens on
              the explorer.
            </li>
            <li>
              <strong>Your first post is paid for.</strong> A new passkey account holds no MON, so the Letterlock gas drip sends it enough for one
              publish, once, after checking a signature from that account.
            </li>
          </ul>
        </aside>
      </div>
    </main>
  );
}
