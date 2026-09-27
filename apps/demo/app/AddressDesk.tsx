"use client";

import { useCallback, useState, type ReactNode } from "react";
import { AddressCard, type Posted } from "@/components/AddressCard";
import { Button, ButtonLink } from "@/components/Button";
import { ExampleNote } from "@/components/ExampleBadge";
import { FailureNotice } from "@/components/FailureNotice";
import { ArrowRightIcon, EnvelopeIcon, PasskeyIcon } from "@/components/Icons";
import { PasskeyButton } from "@/components/PasskeyButton";
import { Steps, type StepItem } from "@/components/Steps";
import { TxLink } from "@/components/TxLink";
import { createAddress, postMyKey, rotateKey, type StepName, type StepReport } from "@/lib/actions.ts";
import { LETTERLOCK_RP_ID, explorerTx } from "@/lib/chain.ts";
import { usePasskeyHost } from "@/lib/client.ts";
import { DIRECTORY } from "@/lib/deployment.ts";
import type { ExampleKey } from "@/lib/examples.ts";
import { toFailure, type Failure } from "@/lib/failure.ts";
import { postmarkDate } from "@/lib/format.ts";
import { useKeyOf } from "@/lib/hooks.ts";
import { forgetStored, useStoredPasskey } from "@/lib/session.ts";
import styles from "./home.module.css";

type Flow = "create" | "post" | "rotate";
type Reports = Partial<Record<StepName, StepReport | { step: StepName; status: "failed" }>>;

const STEPS: Record<Flow, { name: StepName; title: string }[]> = {
  create: [
    { name: "key", title: "Your key: passkey prompt" },
    { name: "account", title: "Your account: passkey prompt" },
    { name: "postage", title: "Postage: gas for one publish" },
    { name: "publish", title: "Posted to the register" },
  ],
  post: [
    { name: "key", title: "Your key: passkey prompt" },
    { name: "account", title: "Your account: passkey prompt" },
    { name: "postage", title: "Postage: gas for one publish" },
    { name: "publish", title: "Posted to the register" },
  ],
  rotate: [
    { name: "account", title: "Your account: passkey prompt" },
    { name: "postage", title: "Postage: the account’s own MON" },
    { name: "publish", title: "Next epoch’s key: passkey prompt, then posted" },
  ],
};

const WAITING: Record<StepName, string> = {
  key: "Waiting for your passkey…",
  account: "Waiting for your passkey…",
  postage: "Getting postage…",
  publish: "Posting your key…",
};

export type AddressDeskProps = {
  /** the page head, set by the server */
  intro: ReactNode;
  /** shown in the card's place until this device has an address: made by the SDK from a labelled string */
  example: { address: `0x${string}`; key: ExampleKey };
};

/** The home page's live part: create an encryption address, see it in the register, rotate it. */
export function AddressDesk({ intro, example }: AddressDeskProps) {
  const host = usePasskeyHost();
  const rpId = host?.ok ? host.rpId : undefined;
  const stored = useStoredPasskey(rpId);
  const address = stored?.address;
  const { state: onchain, refresh } = useKeyOf(address);
  const [running, setRunning] = useState<Flow | undefined>(undefined);
  const [shown, setShown] = useState<Flow | undefined>(undefined);
  const [reports, setReports] = useState<Reports>({});
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [drip, setDrip] = useState<`0x${string}` | undefined>(undefined);

  const run = useCallback(
    async (flow: Flow) => {
      setRunning(flow);
      setShown(flow);
      setReports({});
      setFailure(undefined);
      const report = (r: StepReport) => setReports((prev) => ({ ...prev, [r.step]: r }));
      try {
        if (flow === "rotate") {
          if (stored?.address) await rotateKey({ ...stored, address: stored.address }, report);
        } else {
          const done = flow === "create" || !stored ? await createAddress(report) : await postMyKey(stored, report);
          if (done.drip) setDrip(done.drip.transactionHash);
        }
        refresh();
      } catch (e) {
        setFailure(toFailure(e, stored?.address ? { account: stored.address } : undefined));
        setReports((prev) => {
          const active = Object.values(prev).find((r) => r?.status === "active");
          return active ? { ...prev, [active.step]: { step: active.step, status: "failed" } } : prev;
        });
      } finally {
        setRunning(undefined);
      }
    },
    [stored, refresh],
  );

  const activeStep = (Object.values(reports).find((r) => r?.status === "active") as StepReport | undefined)?.step;
  const steps = (flow: Flow): StepItem[] =>
    STEPS[flow].map(({ name, title }) => {
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

  // ---- the card --------------------------------------------------------------------------------------------------
  let card: ReactNode;
  if (address && onchain.status === "found") {
    const { key, line } = onchain;
    const posted: Posted = line
      ? { kind: "tx", hash: line.txHash, href: explorerTx(line.txHash), block: line.block, at: line.at ?? key.updatedAt, network: DIRECTORY.network }
      : { kind: "unknown", at: key.updatedAt, network: DIRECTORY.network };
    card = (
      <AddressCard
        address={address}
        fingerprint={key.kid}
        epoch={key.epoch}
        posted={posted}
        postmark={{ top: "Letterlock register", bottom: postmarkDate(key.updatedAt), center: String(key.epoch), centerLabel: "Epoch" }}
        actions={
          <Button
            tone="outline"
            size="md"
            icon={<PasskeyIcon />}
            status={running === "rotate" ? "waiting" : running ? "disabled" : "idle"}
            waitingLabel={activeStep ? WAITING[activeStep] : "Waiting for your passkey…"}
            onClick={() => void run("rotate")}
          >
            Rotate key
          </Button>
        }
        footnote={`Rotating posts epoch ${key.epoch + 1}. Notes sealed to earlier epochs still open: your passkey re-derives every earlier key.`}
      />
    );
  } else if (address && (onchain.status === "none" || (running && running !== "rotate"))) {
    const fp = reports.key && "detail" in reports.key ? reports.key.detail : undefined;
    card = <AddressCard address={address} fingerprint={fp} epoch={1} posted={running ? { kind: "pending" } : { kind: "none" }} />;
  } else {
    card = (
      <>
        <AddressCard example address={example.address} fingerprint={example.key.fingerprint} epoch={example.key.epoch} posted={{ kind: "example" }} />
        <ExampleNote className={styles.cardNote}>
          What your card will show once your key is posted. This one is an example made by the SDK from a labelled string: not yours, and not on
          chain.
        </ExampleNote>
      </>
    );
  }

  // ---- the action ------------------------------------------------------------------------------------------------
  let cta: ReactNode;
  if (host === null || stored === null) {
    cta = <PasskeyButton status="disabled">Create my encryption address</PasskeyButton>;
  } else if (!host.ok) {
    cta = (
      <div className={styles.elsewhere}>
        <p>{host.reason}</p>
        <ButtonLink href={`https://${LETTERLOCK_RP_ID}/`} icon={<ArrowRightIcon />}>
          Go to the live site
        </ButtonLink>
      </div>
    );
  } else if (running && running !== "rotate") {
    cta = (
      <PasskeyButton status="waiting" waitingLabel={activeStep ? WAITING[activeStep] : undefined}>
        {running === "create" ? "Create my encryption address" : "Post my key"}
      </PasskeyButton>
    );
  } else if (!stored) {
    cta = (
      <>
        <PasskeyButton status={running ? "disabled" : "idle"} onClick={() => void run("create")}>
          Create my encryption address
        </PasskeyButton>
        <p className={styles.fine}>Two passkey prompts, three on some browsers: one for your key, one for the account that posts it. Nothing secret is stored or sent.</p>
      </>
    );
  } else if (!address || onchain.status === "none") {
    cta = (
      <>
        <p className={styles.state}>This device holds your passkey’s details, and its key is not in the register yet.</p>
        <PasskeyButton status={running ? "disabled" : "idle"} onClick={() => void run("post")}>
          Post my key
        </PasskeyButton>
        <p className={styles.fine}>Two passkey prompts: your key, then the account that posts it. The first post is paid for by the gas drip.</p>
      </>
    );
  } else {
    cta = (
      <>
        <p className={styles.state} role="status">
          {onchain.status === "found" ? "Your address is in the register. Anyone can seal a note to it now." : onchain.status === "failed" ? "" : "Reading the register…"}
        </p>
        <div className={styles.next}>
          <ButtonLink href={`/seal?to=${address}`} tone="ink" size="md" icon={<EnvelopeIcon />}>
            Seal a note to yourself
          </ButtonLink>
          <ButtonLink href="/open" size="md" icon={<ArrowRightIcon />}>
            Open your inbox
          </ButtonLink>
        </div>
      </>
    );
  }

  const retryable = failure?.kind === "slip" && ["PASSKEY_FAILED", "CHAIN_UNAVAILABLE", "PRF_UNSUPPORTED"].includes(failure.code);
  return (
    <section className={styles.hero}>
      <div className={styles.intro}>
        {intro}
        <div className={styles.cta}>
          {cta}
          {shown && Object.keys(reports).length > 0 && (
            <Steps className={styles.steps} items={steps(shown)} label={shown === "rotate" ? "Rotating your key" : "Creating your encryption address"} />
          )}
          {drip && !running && (
            <p className={styles.fine}>
              Your first post was paid for by the Letterlock gas drip: <TxLink hash={drip} />
            </p>
          )}
          <FailureNotice
            failure={failure}
            className={styles.failure}
            action={
              retryable ? (
                <Button size="md" tone="outline" onClick={() => setFailure(undefined)}>
                  {failure?.kind === "slip" && failure.code === "PRF_UNSUPPORTED" ? "Try another passkey" : "Try again"}
                </Button>
              ) : undefined
            }
          />
          {onchain.status === "failed" && !failure && (
            <FailureNotice
              failure={onchain.failure}
              className={styles.failure}
              action={
                <Button size="md" tone="outline" onClick={refresh}>
                  Read the register again
                </Button>
              }
            />
          )}
          {stored && !running && (
            <p className={styles.forget}>
              This device remembers only your passkey’s id{address ? " and your address" : ""}: nothing secret.{" "}
              <button type="button" className={styles.textButton} onClick={() => rpId && forgetStored(rpId)}>
                Forget this device
              </button>
            </p>
          )}
        </div>
      </div>
      <div className={styles.cardCol}>{card}</div>
    </section>
  );
}
