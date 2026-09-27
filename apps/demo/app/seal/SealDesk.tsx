"use client";

import { encodeEnvelope, type Envelope as SealedEnvelope, type DropResult, type ResolvedKey } from "letterlock";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ButtonLink } from "@/components/Button";
import { Envelope, Letter } from "@/components/Envelope";
import { FailureNotice } from "@/components/FailureNotice";
import { NoteField, TextField } from "@/components/Field";
import { ArrowRightIcon, CheckIcon, EnvelopeIcon } from "@/components/Icons";
import { RegisterTable, type RegisterRow } from "@/components/RegisterTable";
import { TxLink } from "@/components/TxLink";
import { WaxSeal, type WaxSealState } from "@/components/WaxSeal";
import { postEnvelope } from "@/lib/actions.ts";
import { explorerTx } from "@/lib/chain.ts";
import { readClient, usePasskeyHost } from "@/lib/client.ts";
import { DIRECTORY, SMOKE_KEYS } from "@/lib/deployment.ts";
import { toFailure, type Failure } from "@/lib/failure.ts";
import { addressLine, formatBytes, formatCount } from "@/lib/format.ts";
import { KNOWN_KEYS } from "@/lib/known-keys.ts";
import { groupFingerprint } from "@/lib/keystrip.ts";
import { RECIPIENT, recipientError } from "@/lib/recipient.ts";
import { findPublish, type KeyLine } from "@/lib/register.ts";
import { useStoredPasskey } from "@/lib/session.ts";
import styles from "./seal.module.css";

/** The most a note may hold for its envelope to fit the directory's 16,384-byte drop (the JSON adds about a third). */
export const NOTE_MAX_BYTES = 12_000;

/** the flap's and the letter's own transitions (Envelope.module.css): tuck + close ≈ 280 + 440 ms */
const CLOSE_MS = 760;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Lookup =
  | { status: "idle" }
  | { status: "reading"; to: string }
  | { status: "found"; key: ResolvedKey; line?: KeyLine }
  | { status: "failed"; to: string; failure: Failure };

type Stage = "open" | "sealing" | "closing" | "pressing" | "sealed";

type Post = { status: "idle" } | { status: "posting" } | { status: "posted"; result: DropResult } | { status: "failed"; failure: Failure };

/** A warning for keys nobody should seal a real note to: the smoke test's demo keys, and the app's own test keys. */
const demoNote = (key: ResolvedKey): string | undefined => {
  if (SMOKE_KEYS.some((k) => k.recipient === key.recipient && k.fingerprint === key.kid))
    return "Demo key from the deploy smoke test: random bytes stood in for a passkey, and whoever holds them can open what you seal. Don’t seal a real note to it";
  return KNOWN_KEYS.find((k) => k.address.toLowerCase() === key.recipient)?.note;
};

/** Look an address up, seal a note to its key on this device, and post the envelope or hand it over yourself. */
export function SealDesk({ initialTo }: { initialTo?: string }) {
  const host = usePasskeyHost();
  const stored = useStoredPasskey(host?.ok ? host.rpId : undefined);
  const [to, setTo] = useState(initialTo ?? "");
  const [note, setNote] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  const [stage, setStage] = useState<Stage>("open");
  const [sealed, setSealed] = useState<{ envelope: SealedEnvelope; bytes: number } | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [post, setPost] = useState<Post>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // keyOf, read as soon as the field holds a whole address or agent id
  const target = to.trim();
  // a recipient that is neither form says so beside the field, after the same pause as the lookup (so a whole address
  // being typed shows nothing), rather than leaving Seal disabled without a word
  const [malformed, setMalformed] = useState<string | undefined>(undefined);
  useEffect(() => {
    setMalformed(undefined);
    const why = recipientError(target);
    if (!why) return;
    const t = window.setTimeout(() => setMalformed(why), 300);
    return () => window.clearTimeout(t);
  }, [target]);
  useEffect(() => {
    if (!RECIPIENT.test(target)) {
      setLookup({ status: "idle" });
      return;
    }
    let live = true;
    setLookup({ status: "reading", to: target });
    const t = window.setTimeout(() => {
      readClient()
        .resolve(target)
        .then(
          async (key) => {
            if (!live) return;
            setLookup({ status: "found", key });
            if (key.recipient.startsWith("0x")) {
              const line = await findPublish(key.recipient as `0x${string}`, key.epoch, key.updatedAt).catch(() => undefined);
              if (live && line) setLookup({ status: "found", key, line });
            }
          },
          (e: unknown) => live && setLookup({ status: "failed", to: target, failure: toFailure(e) }),
        );
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [target]);

  const noteBytes = new TextEncoder().encode(note).length;
  const canSeal = stage === "open" && lookup.status === "found" && note.trim().length > 0 && noteBytes <= NOTE_MAX_BYTES;

  const onSeal = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSeal) return;
      setFailure(undefined);
      setPost({ status: "idle" });
      setStage("sealing");
      try {
        // sealTo reads keyOf again and seals to that one read: the key on the line above, unless it changed since
        const envelope = await readClient().sealTo(target, new TextEncoder().encode(note));
        setSealed({ envelope, bytes: encodeEnvelope(envelope).length });
        setStage("closing");
        timer.current = window.setTimeout(() => setStage("pressing"), reducedMotion() ? 0 : CLOSE_MS);
      } catch (err) {
        setStage("open");
        setFailure(toFailure(err));
      }
    },
    [canSeal, target, note],
  );

  const onPost = async () => {
    if (!sealed || !stored?.address) return;
    setPost({ status: "posting" });
    try {
      setPost({ status: "posted", result: await postEnvelope({ ...stored, address: stored.address }, sealed.envelope) });
    } catch (err) {
      setPost({ status: "failed", failure: toFailure(err, { account: stored.address }) });
    }
  };

  const onCopy = async () => {
    if (!sealed) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(sealed.envelope));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const again = () => {
    window.clearTimeout(timer.current);
    setStage("open");
    setSealed(undefined);
    setNote("");
    setPost({ status: "idle" });
    setCopied(false);
  };

  const recipient = lookup.status === "found" ? lookup.key.recipient : target || "0x…";
  const found = lookup.status === "found" ? lookup : undefined;
  const foundRow: RegisterRow | undefined = found && {
    id: "found",
    addressee: found.key.recipient,
    epoch: found.key.epoch,
    fingerprint: found.key.kid,
    posted: found.line
      ? { kind: "tx", hash: found.line.txHash, href: explorerTx(found.line.txHash), block: found.line.block, ...(found.line.at !== undefined ? { at: found.line.at } : {}), network: DIRECTORY.network }
      : { kind: "unknown", at: found.key.updatedAt, network: DIRECTORY.network },
    state: "found",
    ...(demoNote(found.key) ? { note: demoNote(found.key) } : {}),
  };
  const lookupFailure = lookup.status === "failed" ? lookup.failure : undefined;
  const wax: WaxSealState = stage === "pressing" ? "pressing" : stage === "sealed" ? "pressed" : "absent";
  const letterShown = stage === "open" || stage === "sealing" || stage === "closing";
  const mine = stored?.address !== undefined && target.toLowerCase() === stored.address.toLowerCase();

  return (
    <div className={styles.grid}>
      <form className={styles.form} aria-label="Seal a note" onSubmit={onSeal}>
        <TextField
          label="To"
          name="to"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            if (stage !== "open") again();
          }}
          data
          placeholder="0x… or agent:<id>"
          hint="An address (0x…) or an agent (agent:<id>). Its key is read from the register as you type."
          error={malformed ?? (lookupFailure?.kind === "input" ? lookupFailure.message : undefined)}
        />
        {stored?.address && !mine && stage === "open" && (
          <p className={styles.quick}>
            <button type="button" className={styles.textButton} onClick={() => setTo(stored.address!)}>
              Seal to my own address
            </button>{" "}
            <span className="data">{addressLine(stored.address)}</span>
          </p>
        )}

        <div aria-live="polite" className={styles.lookup}>
          {lookup.status === "reading" && <p className={styles.reading}>Reading keyOf…</p>}
          {foundRow && <RegisterTable className={styles.found} caption="The line keyOf returned for this address" layout="compact" rows={[foundRow]} />}
          {lookupFailure && lookupFailure.kind !== "input" && <FailureNotice failure={lookupFailure} headingLevel={2} />}
        </div>

        <NoteField label="Note" value={note} onValueChange={setNote} rows={4} maxBytes={NOTE_MAX_BYTES} disabled={stage !== "open"} placeholder="What only they should read" />

        <div className={styles.submit}>
          <Button type="submit" status={stage === "sealing" ? "waiting" : canSeal ? "idle" : "disabled"} waitingLabel="Sealing…">
            Seal
          </Button>
        </div>
        {/* the form comes before the result's h2, directly under the page's h1: its slips' headings are h2s */}
        <FailureNotice failure={failure} headingLevel={2} />
      </form>

      <section className={styles.result} aria-labelledby="sealed-title">
        <h2 id="sealed-title" className={styles.resultTitle}>
          {sealed && stage !== "open" ? (
            <>
              Sealed to <span className="address-line">{addressLine(sealed.envelope.recipient)}</span>
            </>
          ) : (
            "Not sealed yet"
          )}
        </h2>
        <Envelope
          recipient={recipient}
          epoch={found?.key.epoch}
          fingerprint={found?.key.kid}
          flap={letterShown && stage !== "closing" ? "open" : "closed"}
          seal={wax === "absent" ? undefined : <WaxSeal state={wax} decorative onSettled={() => setStage("sealed")} />}
          label={sealed && stage === "sealed" ? `Sealed envelope to ${sealed.envelope.recipient}, epoch ${sealed.envelope.epoch}` : "The letter, not sealed yet"}
        >
          {letterShown ? (
            <Letter>
              <p className={note ? undefined : styles.placeholder}>{note || "Your note appears here as you write it. Only this device has read it."}</p>
            </Letter>
          ) : undefined}
        </Envelope>

        {sealed && stage === "sealed" && (
          <>
            <dl className={styles.facts}>
              <div>
                <dt className="label-caps">Sealed to key</dt>
                <dd className="data">{groupFingerprint(sealed.envelope.kid)}</dd>
              </div>
              <div>
                <dt className="label-caps">Epoch</dt>
                <dd>{sealed.envelope.epoch}</dd>
              </div>
              <div>
                <dt className="label-caps">Envelope</dt>
                <dd>{formatBytes(sealed.bytes)}</dd>
              </div>
            </dl>
            <div className={styles.send}>
              {stored?.address ? (
                <Button tone="airmail" icon={<EnvelopeIcon />} status={post.status === "posting" ? "waiting" : post.status === "posted" ? "disabled" : "idle"} waitingLabel="Waiting for your passkey…" onClick={() => void onPost()}>
                  Post to their inbox
                </Button>
              ) : null}
              <Button tone="outline" icon={copied ? <CheckIcon /> : undefined} onClick={() => void onCopy()}>
                {copied ? "Copied" : "Copy envelope"}
              </Button>
              <p className={styles.sendNote}>
                Only the addressee’s passkey can open it now. Not even you can read it back.
                {!stored?.address && " Posting takes a passkey account with MON: create your address first, or hand the envelope over any way you like. It opens on /open, pasted."}
              </p>
            </div>
            <div aria-live="polite">
              {post.status === "posted" && (
                <p className={styles.posted}>
                  Posted to the inbox of <span className="data">{addressLine(post.result.recipient)}</span>: <TxLink hash={post.result.transactionHash} /> · block{" "}
                  {formatCount(Number(post.result.blockNumber))} · {formatBytes(post.result.bytes)}
                </p>
              )}
              {post.status === "failed" && <FailureNotice failure={post.failure} />}
            </div>
            <details className={styles.json}>
              <summary>
                <span>Envelope as sealed</span>
                <span className={styles.jsonMeta}>JSON · {formatBytes(sealed.bytes)}</span>
              </summary>
              <pre className="data">{JSON.stringify(sealed.envelope, null, 2)}</pre>
            </details>
            <div className={styles.again}>
              <Button tone="outline" size="md" onClick={again}>
                Seal another
              </Button>
              {mine && (
                <ButtonLink href="/open" size="md" icon={<ArrowRightIcon />}>
                  Go to your inbox
                </ButtonLink>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
