"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Envelope, Letter } from "@/components/Envelope";
import { WaxSeal, type WaxSealState } from "@/components/WaxSeal";
import styles from "./kit.module.css";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** the flap and the letter's own transitions (Envelope.module.css): tuck + close ≈ 280 + 440 ms */
const CLOSE_MS = 760;

type Stage = "open" | "closing" | "sealing" | "sealed" | "cracking" | "opened";

export type ReplayProps = {
  recipient: string;
  epoch: number;
  fingerprint: string;
  text: string;
};

/**
 * The whole moment, played with the real components: the letter goes into the envelope, the flap closes, the wax
 * presses shut; then the seal cracks, the flap folds back and the letter rises. Timings are the components' own.
 */
export function EnvelopeReplay({ recipient, epoch, fingerprint, text }: ReplayProps) {
  const [stage, setStage] = useState<Stage>("open");
  const [said, setSaid] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const seal: WaxSealState =
    stage === "sealing" ? "pressing" : stage === "sealed" ? "pressed" : stage === "cracking" ? "cracking" : stage === "opened" ? "cracked" : "absent";
  const flap = stage === "open" || stage === "opened" ? "open" : "closed";
  // the plaintext exists on this device before sealing and after opening; while sealed there is none to show
  const letter = stage === "open" || stage === "closing" || stage === "opened";

  const sealIt = useCallback(() => {
    setStage("closing");
    setSaid("");
    timer.current = window.setTimeout(() => setStage("sealing"), reducedMotion() ? 0 : CLOSE_MS);
  }, []);

  const onSettled = useCallback((s: "pressed" | "cracked") => {
    if (s === "pressed") {
      setStage("sealed");
      setSaid("Sealed.");
    } else {
      setStage("opened");
      setSaid("Opened.");
    }
  }, []);

  return (
    <div className={styles.replay}>
      <div className={styles.replayStage}>
        <Envelope
          recipient={recipient}
          epoch={epoch}
          fingerprint={fingerprint}
          flap={flap}
          seal={seal === "absent" ? undefined : <WaxSeal state={seal} onSettled={onSettled} decorative />}
          label="Replay envelope"
        >
          {letter ? (
            <Letter>
              <p>{text}</p>
            </Letter>
          ) : undefined}
        </Envelope>
      </div>
      <div className={styles.replayControls}>
        <Button tone="outline" size="md" status={stage === "open" ? "idle" : "disabled"} onClick={sealIt}>
          Seal it
        </Button>
        <Button
          tone="outline"
          size="md"
          status={stage === "sealed" ? "idle" : "disabled"}
          onClick={() => {
            setStage("cracking");
            setSaid("");
          }}
        >
          Open it
        </Button>
        <Button
          tone="outline"
          size="md"
          status={stage === "sealed" || stage === "opened" ? "idle" : "disabled"}
          onClick={() => {
            window.clearTimeout(timer.current);
            setStage("open");
            setSaid("");
          }}
        >
          Start over
        </Button>
        <p className={styles.replayState} role="status">
          {said}
        </p>
      </div>
    </div>
  );
}

/** One seal, replayable: press it shut, crack it open. */
export function SealReplay() {
  const [state, setState] = useState<WaxSealState>("pressed");
  const [run, setRun] = useState(0);
  return (
    <div className={styles.sealReplay}>
      <div className={styles.sealReplaySeal}>
        <WaxSeal key={run} state={state} onSettled={(s) => setState(s)} size={142} />
      </div>
      <div className={styles.replayControls}>
        <Button
          tone="outline"
          size="md"
          onClick={() => {
            setRun((r) => r + 1);
            setState("pressing");
          }}
        >
          Press
        </Button>
        <Button
          tone="outline"
          size="md"
          status={state === "pressed" ? "idle" : "disabled"}
          onClick={() => {
            setRun((r) => r + 1);
            setState("cracking");
          }}
        >
          Crack
        </Button>
      </div>
    </div>
  );
}
