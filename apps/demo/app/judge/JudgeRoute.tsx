"use client";

import { useCallback, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/Button";
import { FailureNotice } from "@/components/FailureNotice";
import { NoteField } from "@/components/Field";
import { ArrowRightIcon, CheckIcon, EnvelopeIcon } from "@/components/Icons";
import { PasskeyButton } from "@/components/PasskeyButton";
import { QrCode } from "@/components/QrCode";
import { Steps, type StepItem } from "@/components/Steps";
import { TxLink } from "@/components/TxLink";
import { createAddress, postMyKey, type StepName, type StepReport } from "@/lib/actions.ts";
import { AGENT_URL, LETTERLOCK_RP_ID, SCAN_RANGE } from "@/lib/chain.ts";
import { AGENT_TEXT_MAX, AgentError, agentFailureCopy, askAgent, type AgentDrop } from "@/lib/agent.ts";
import { scanClient, useOrigin, usePasskeyHost } from "@/lib/client.ts";
import { DIRECTORY } from "@/lib/deployment.ts";
import { toFailure, type Failure } from "@/lib/failure.ts";
import { addressLine, formatBytes, formatCount } from "@/lib/format.ts";
import { groupFingerprint } from "@/lib/keystrip.ts";
import { useKeyOf, usePoll } from "@/lib/hooks.ts";
import { useJudgePassFromUrl, useStoredPasskey } from "@/lib/session.ts";
import styles from "./judge.module.css";

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

const CREATE_STEPS: { name: StepName; title: string }[] = [
  { name: "key", title: "Your key: passkey prompt" },
  { name: "account", title: "Your account: passkey prompt" },
  { name: "postage", title: "Postage: gas for one publish" },
  { name: "publish", title: "Posted to the register" },
];

/** The three steps, live: every status is read from this device and the chain, every transaction linked. */
export function JudgeRoute() {
  const host = usePasskeyHost();
  const stored = useStoredPasskey(host?.ok ? host.rpId : undefined);
  useJudgePassFromUrl();
  const address = stored?.address;
  const { state: onchain, refresh } = useKeyOf(address);
  const hasKey = address !== undefined && onchain.status === "found";

  // ---- step 1 ----
  const [creating, setCreating] = useState(false);
  const [reports, setReports] = useState<Partial<Record<StepName, StepReport | { step: StepName; status: "failed" }>>>({});
  const [createFailure, setCreateFailure] = useState<Failure | undefined>(undefined);
  const create = useCallback(async () => {
    setCreating(true);
    setReports({});
    setCreateFailure(undefined);
    const report = (r: StepReport) => setReports((p) => ({ ...p, [r.step]: r }));
    try {
      if (stored) await postMyKey(stored, report);
      else await createAddress(report);
      refresh();
    } catch (e) {
      setCreateFailure(toFailure(e));
      setReports((p) => {
        const a = Object.values(p).find((r) => r?.status === "active");
        return a ? { ...p, [a.step]: { step: a.step, status: "failed" } } : p;
      });
    } finally {
      setCreating(false);
    }
  }, [stored, refresh]);
  const createItems: StepItem[] = CREATE_STEPS.map(({ name, title }) => {
    const r = reports[name];
    const detail = r && "detail" in r ? r.detail : undefined;
    const tx = r && "tx" in r ? r.tx : undefined;
    return {
      id: name,
      title,
      status: r ? r.status : "todo",
      detail:
        detail || tx ? (
          <>
            {detail && <span className={name === "key" || name === "account" ? "data" : undefined}>{detail}</span>}
            {detail && tx && " · "}
            {tx && <TxLink hash={tx} />}
          </>
        ) : undefined,
    };
  });

  // ---- step 2 ----
  const [text, setText] = useState("Remember for me: the dentist moved to Thursday at 10:40.");
  const [asking, setAsking] = useState(false);
  const [drop, setDrop] = useState<AgentDrop | undefined>(undefined);
  const [agentFailure, setAgentFailure] = useState<Failure | undefined>(undefined);
  const ask = async () => {
    if (!address) return;
    setAsking(true);
    setAgentFailure(undefined);
    try {
      setDrop(await askAgent(address, text));
    } catch (e) {
      // the copy says no letter left only when that is known; otherwise the inbox below says whether one came
      setAgentFailure(e instanceof AgentError ? { kind: "message", ...agentFailureCopy(e) } : toFailure(e));
    } finally {
      setAsking(false);
    }
  };

  // ---- step 3: the inbox, read live, so the letter shows here as soon as its block is final ----
  // One scan from the address's first key (no drop can precede it: Letterlock.sol's drop reverts NoKeyPublished), then
  // each poll reads only the blocks finalized since, as the inbox page does; never the whole chain every 5 s.
  const [waiting, setWaiting] = useState<{ count: number; finalized: bigint } | undefined>(undefined);
  const scan = useRef<{ who?: string; next?: bigint; count: number }>({ count: 0 });
  const lineKnown = onchain.status === "found" && onchain.lineStatus !== "loading";
  const firstKeyAt = onchain.status === "found" && onchain.key.epoch === 1 && onchain.line ? BigInt(onchain.line.block) : undefined;
  usePoll(
    async () => {
      if (!address) return;
      if (scan.current.who !== address) scan.current = { who: address, count: 0 };
      const s = scan.current;
      const r = await scanClient().inbox(address, { fromBlock: s.next ?? firstKeyAt ?? BigInt(DIRECTORY.deployBlock), blockRange: SCAN_RANGE });
      if (scan.current !== s) return; // the address changed while this scan ran
      s.count += r.envelopes.length;
      s.next = (r.toBlock < r.finalizedBlock ? r.toBlock : r.finalizedBlock) + 1n;
      setWaiting({ count: s.count, finalized: r.finalizedBlock });
    },
    5_000,
    hasKey && lineKnown && SCAN_RANGE >= 1_000_000,
  );

  const s1: Status = hasKey ? "done" : "next";
  const s2: Status = drop ? "done" : hasKey ? "next" : "todo";
  const s3: Status = drop || (waiting?.count ?? 0) > 0 ? "next" : "todo";
  const origin = useOrigin();
  const openUrl = origin && address ? `${origin}/open?to=${address}` : undefined;
  const textTooLong = [...text].length > AGENT_TEXT_MAX;

  return (
    <ol className={styles.route} aria-label="The three steps">
      <li className={styles.step} data-status={s1}>
        <span className={styles.no} aria-hidden="true">
          1
        </span>
        <div className={styles.body}>
          <h2 className={styles.h2}>Create your address</h2>
          <p>On this device. Your passkey derives your key, a second prompt derives the account that posts it, and its public half goes in the register.</p>
          {hasKey && onchain.status === "found" ? (
            <p className={styles.fact}>
              <span className="data">{addressLine(address!)}</span> · key <span className="data">{groupFingerprint(onchain.key.kid)}</span> · epoch{" "}
              {onchain.key.epoch}
              {onchain.line && (
                <>
                  {" "}
                  · <TxLink hash={onchain.line.txHash} />
                </>
              )}
            </p>
          ) : address && (onchain.status === "loading" || onchain.status === "idle") ? (
            <p className={styles.fact} role="status">
              Reading the register for <span className="data">{addressLine(address)}</span>…
            </p>
          ) : host && !host.ok ? (
            <div className={styles.actions}>
              <p className={styles.fact}>{host.reason}</p>
              <ButtonLink href={`https://${LETTERLOCK_RP_ID}/judge`} size="md" icon={<ArrowRightIcon />}>
                Go to the live site
              </ButtonLink>
            </div>
          ) : (
            <div className={styles.actions}>
              <PasskeyButton size="md" status={creating ? "waiting" : host === null || stored === null ? "disabled" : "idle"} onClick={() => void create()}>
                {stored ? "Post my key" : "Create my encryption address"}
              </PasskeyButton>
            </div>
          )}
          {Object.keys(reports).length > 0 && <Steps className={styles.docket} items={createItems} label="Creating your encryption address" />}
          <FailureNotice failure={createFailure} />
          {/* the register could not be read: whether the key is posted is not known, so "Post my key" stays beside this */}
          {onchain.status === "failed" && !createFailure && !creating && (
            <FailureNotice
              failure={onchain.failure}
              action={
                <Button size="md" tone="outline" onClick={refresh}>
                  Read the register again
                </Button>
              }
            />
          )}
        </div>
        <Mark status={s1} />
      </li>

      <li className={styles.step} data-status={s2}>
        <span className={styles.no} aria-hidden="true">
          2
        </span>
        <div className={styles.body}>
          <h2 className={styles.h2}>Ask an agent to write to you</h2>
          <p>
            The reference agent (ERC-8004 agent 10260) is a separate server that knows only your address. It reads your key from the register,
            seals your text to it, and drops the envelope on Monad from its own wallet. It keeps no copy, and cannot open what it sealed.
          </p>
          {AGENT_URL ? (
            <>
              <NoteField label="What should it remember?" value={text} onValueChange={setText} rows={2} disabled={!hasKey || asking} />
              {textTooLong && <p className={styles.fact}>The agent reads at most {formatCount(AGENT_TEXT_MAX)} characters.</p>}
              <div className={styles.actions}>
                <Button tone="airmail" size="md" icon={<EnvelopeIcon />} status={asking ? "waiting" : hasKey && !textTooLong && text.trim() ? "idle" : "disabled"} waitingLabel="The agent is sealing…" onClick={() => void ask()}>
                  Ask the agent
                </Button>
              </div>
            </>
          ) : (
            <p className={styles.fact}>This build of the app points at {DIRECTORY.network}; the reference agent writes on Monad mainnet only.</p>
          )}
          {drop && (
            <p className={styles.fact} aria-live="polite">
              Sealed to key <span className="data">{drop.kid ? groupFingerprint(drop.kid) : "—"}</span>
              {drop.epoch !== undefined && <> · epoch {drop.epoch}</>}
              {drop.bytes !== undefined && <> · {formatBytes(drop.bytes)}</>} · dropped: <TxLink hash={drop.dropTx} />
              {drop.blockNumber !== undefined && <> · block {formatCount(Number(drop.blockNumber))}</>}
            </p>
          )}
          <FailureNotice failure={agentFailure} />
        </div>
        <Mark status={s2} />
      </li>

      <li className={styles.step} data-status={s3}>
        <span className={styles.no} aria-hidden="true">
          3
        </span>
        <div className={styles.body}>
          <h2 className={styles.h2}>Open it here, or somewhere else</h2>
          <p>
            Open the note from the inbox with one passkey tap: the seal breaks and the text appears. To prove nothing is stored, clear this
            browser’s storage first, or scan the code with another device your passkey syncs to.
          </p>
          {waiting && (
            <p className={styles.fact} role="status">
              {formatCount(waiting.count)} {waiting.count === 1 ? "letter" : "letters"} in your inbox, read to finalized block{" "}
              {formatCount(Number(waiting.finalized))}.
            </p>
          )}
          <div className={styles.openRow}>
            <div className={styles.actions}>
              <ButtonLink href={address ? `/open?to=${address}` : "/open"} size="md" icon={<ArrowRightIcon />}>
                Go to the inbox
              </ButtonLink>
            </div>
            {openUrl && (
              <figure className={styles.qr}>
                <QrCode text={openUrl} label={`QR code of ${openUrl}`} size={148} />
                <figcaption className={styles.qrCaption}>
                  Your inbox on another device: <span className="data">{openUrl.replace(/^https?:\/\//, "")}</span>
                </figcaption>
              </figure>
            )}
          </div>
        </div>
        <Mark status={s3} />
      </li>
    </ol>
  );
}
