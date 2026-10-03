"use client";

import { decodeEnvelope, isLetterlockError, type Envelope as SealedEnvelope, type InboxEnvelope, type RejectedDrop } from "letterlock";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ButtonLink } from "@/components/Button";
import { Envelope, Letter } from "@/components/Envelope";
import { FailureNotice } from "@/components/FailureNotice";
import { TextField } from "@/components/Field";
import { ArrowRightIcon } from "@/components/Icons";
import { PageHead, PageLede } from "@/components/PageHead";
import { PasskeyButton } from "@/components/PasskeyButton";
import { TxLink } from "@/components/TxLink";
import { WaxSeal } from "@/components/WaxSeal";
import { findMyAddress, openEnvelope } from "@/lib/actions.ts";
import { DEPLOYMENT, SCAN_RANGE, TESTNET } from "@/lib/chain.ts";
import { readClient, scanClient, usePasskeyHost } from "@/lib/client.ts";
import { toFailure, type Failure } from "@/lib/failure.ts";
import { addressLine, formatBytes, formatCount } from "@/lib/format.ts";
import { useNow, usePoll } from "@/lib/hooks.ts";
import { firstKeyBlock } from "@/lib/register.ts";
import { useStoredPasskey } from "@/lib/session.ts";
import styles from "./open.module.css";

const POLL_MS = 5_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Box = {
  envelopes: InboxEnvelope[];
  rejected: RejectedDrop[];
  /** the next block to scan */
  next?: bigint;
  /** the last finalized block scanned, and when */
  finalized?: bigint;
  readAt?: number;
  noKey?: boolean;
  failure?: Failure;
};

type Selected = { id: string; envelope: SealedEnvelope; where?: { block: bigint; tx: `0x${string}`; bytes: number } };

type ReaderStage = "sealed" | "opening" | "cracking" | "opened";

const idOf = (e: InboxEnvelope) => `${e.transactionHash}:${e.logIndex}`;

/** The inbox: envelopes dropped for an address, read from the chain; each opens with one passkey tap. */
export function InboxDesk({ initialTo }: { initialTo?: string }) {
  const host = usePasskeyHost();
  const stored = useStoredPasskey(host?.ok ? host.rpId : undefined);
  const [chosen, setChosen] = useState<string | undefined>(initialTo && ADDRESS.test(initialTo) ? initialTo.toLowerCase() : undefined);
  const who = chosen ?? stored?.address?.toLowerCase();
  const [box, setBox] = useState<Box>({ envelopes: [], rejected: [] });
  const boxRef = useRef(box);
  boxRef.current = box;
  const now = useNow();
  const [selected, setSelected] = useState<Selected | undefined>(undefined);
  const [stage, setStage] = useState<ReaderStage>("sealed");
  const [opened, setOpened] = useState<Record<string, string>>({});
  const [openFailure, setOpenFailure] = useState<Failure | undefined>(undefined);

  // a new address starts a new scan, with an empty reader
  useEffect(() => {
    setBox({ envelopes: [], rejected: [] });
    setSelected(undefined);
    setStage("sealed");
  }, [who]);

  const read = useCallback(async () => {
    if (!who) return;
    const cur = boxRef.current;
    try {
      let from = cur.next;
      if (from === undefined) {
        // no drop can precede the recipient's first key: on testnet (100 blocks a request) the scan starts at the block
        // where the address first had a key; on mainnet one request reads from the directory's deploy block anyway
        const key = await readClient().resolve(who).catch((e: unknown) => {
          if (isLetterlockError(e, "NO_KEY_PUBLISHED")) return undefined;
          throw e;
        });
        if (!key) {
          setBox((b) => ({ ...b, noKey: true, readAt: Math.floor(Date.now() / 1000), failure: undefined }));
          return;
        }
        from = (TESTNET ? await firstKeyBlock(who as `0x${string}`) : undefined) ?? BigInt(DEPLOYMENT.deployBlock);
      }
      const r = await scanClient().inbox(who, { fromBlock: from, blockRange: SCAN_RANGE });
      setBox((b) => {
        const seen = new Set(b.envelopes.map(idOf));
        const seenRejected = new Set(b.rejected.map((x) => `${x.transactionHash}:${x.logIndex}`));
        return {
          envelopes: [...b.envelopes, ...r.envelopes.filter((e) => !seen.has(idOf(e)))],
          rejected: [...b.rejected, ...r.rejected.filter((x) => !seenRejected.has(`${x.transactionHash}:${x.logIndex}`))],
          next: (r.toBlock < r.finalizedBlock ? r.toBlock : r.finalizedBlock) + 1n,
          finalized: r.finalizedBlock,
          readAt: Math.floor(Date.now() / 1000),
        };
      });
    } catch (e) {
      setBox((b) => ({ ...b, failure: toFailure(e) }));
    }
  }, [who]);
  usePoll(read, POLL_MS, who !== undefined);

  // ---- the reader ----

  // the newest envelope is in the reader until the person picks another
  const newest = [...box.envelopes].sort((a, b) => Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex)[0];
  useEffect(() => {
    if (!selected && newest) {
      setSelected({ id: idOf(newest), envelope: newest.envelope, where: { block: newest.blockNumber, tx: newest.transactionHash, bytes: newest.bytes } });
      setStage("sealed");
    }
  }, [newest, selected]);

  const pick = (s: Selected) => {
    setSelected(s);
    setOpenFailure(undefined);
    setStage(opened[s.id] !== undefined ? "opened" : "sealed");
  };

  const open = async (s: Selected) => {
    pick(s);
    if (opened[s.id] !== undefined) return;
    setStage("opening");
    setOpenFailure(undefined);
    try {
      const bytes = await openEnvelope(s.envelope, stored);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      bytes.fill(0);
      setOpened((o) => ({ ...o, [s.id]: text }));
      setStage("cracking");
    } catch (e) {
      setStage("sealed");
      setOpenFailure(toFailure(e));
    }
  };

  // ---- find the address with the passkey, or type one ----
  const [finding, setFinding] = useState(false);
  const [findFailure, setFindFailure] = useState<Failure | undefined>(undefined);
  const findMine = async () => {
    setFinding(true);
    setFindFailure(undefined);
    try {
      const s = await findMyAddress();
      setChosen(s.address.toLowerCase());
    } catch (e) {
      setFindFailure(toFailure(e));
    } finally {
      setFinding(false);
    }
  };
  const [typed, setTyped] = useState("");
  const typedError = typed.trim() && !ADDRESS.test(typed.trim()) ? "An address is 0x and 40 hex digits." : undefined;
  const onRead = (e: FormEvent) => {
    e.preventDefault();
    if (ADDRESS.test(typed.trim())) setChosen(typed.trim().toLowerCase());
  };

  // ---- paste an envelope ----
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | undefined>(undefined);
  const onPaste = (e: FormEvent) => {
    e.preventDefault();
    setPasteError(undefined);
    let env: SealedEnvelope;
    try {
      env = decodeEnvelope(pasted.trim());
    } catch (err) {
      setPasteError(toFailure(err).kind === "slip" ? "That envelope is damaged: its fields are not canonical." : "That is not a Letterlock envelope: paste the whole JSON, from { to }.");
      return;
    }
    if (env.chainId !== DEPLOYMENT.chainId || env.directory.toLowerCase() !== DEPLOYMENT.directory.toLowerCase()) {
      setPasteError(`That envelope was sealed for chain ${env.chainId} and directory ${env.directory}; this app opens envelopes for ${DEPLOYMENT.network} (${DEPLOYMENT.chainId}).`);
      return;
    }
    void open({ id: `pasted:${env.enc}`, envelope: env });
  };

  const letter = selected ? opened[selected.id] : undefined;
  const sorted = [...box.envelopes].sort((a, b) => Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex);
  const age = box.readAt === undefined ? undefined : Math.max(0, now - box.readAt);
  const flap = stage === "opened" ? "open" : "closed";
  const wax = stage === "cracking" ? "cracking" : stage === "opened" ? "cracked" : "pressed";

  return (
    <main id="main" className={`page ${styles.main}`}>
      <PageHead className={styles.head} title="Inbox" />
      <div className={styles.intro}>
        <PageLede>
          {who ? (
            <>
              Letters addressed to <span className="address-line">{addressLine(who)}</span>, read from the directory’s Dropped events. Each opens
              with one passkey tap, on any device your passkey syncs to, and nothing is stored.
            </>
          ) : (
            "Letters addressed to you, read from the directory’s Dropped events. Each opens with one passkey tap, on any device your passkey syncs to, and nothing is stored."
          )}
        </PageLede>
        {!who && host !== null && stored !== null && (
          <div className={styles.whose}>
            {host.ok ? (
              <>
                <PasskeyButton tone="airmail" size="md" status={finding ? "waiting" : "idle"} onClick={() => void findMine()}>
                  Find my inbox with my passkey
                </PasskeyButton>
                <p className={styles.detail}>One passkey prompt: your passkey derives your address again. No transaction, nothing stored but the address.</p>
                {/* above the page's first h2, directly under its h1 */}
                <FailureNotice failure={findFailure} headingLevel={2} />
              </>
            ) : null}
            <form className={styles.readForm} onSubmit={onRead} aria-label="Read the inbox of an address">
              <TextField label={host.ok ? "Or read the inbox of" : "Read the inbox of"} name="to" data placeholder="0x…" value={typed} onChange={(e) => setTyped(e.target.value)} error={typedError} />
              <Button type="submit" size="md" tone="outline" className={styles.readAction}>
                Read
              </Button>
            </form>
          </div>
        )}
      </div>

      <section className={styles.reader} aria-labelledby="reader-title">
        <h2 id="reader-title" className="visually-hidden">
          {letter !== undefined ? "The opened letter" : "The letter in hand"}
        </h2>
        <Envelope
          recipient={selected?.envelope.recipient ?? who ?? "0x…"}
          epoch={selected?.envelope.epoch}
          fingerprint={selected?.envelope.kid}
          flap={flap}
          seal={selected ? <WaxSeal state={wax} decorative onSettled={(s) => s === "cracked" && setStage("opened")} /> : undefined}
          label={selected ? `${letter !== undefined ? "Opened" : "Sealed"} envelope to ${selected.envelope.recipient}, epoch ${selected.envelope.epoch}` : "No envelope yet"}
        >
          {letter !== undefined && stage === "opened" ? (
            <Letter>
              <p className={styles.letterText}>{letter}</p>
            </Letter>
          ) : undefined}
        </Envelope>
        <div className={styles.readerFoot}>
          {selected && letter === undefined && (
            <PasskeyButton tone="airmail" status={stage === "opening" ? "waiting" : host?.ok ? "idle" : "disabled"} onClick={() => void open(selected)}>
              Open with passkey
            </PasskeyButton>
          )}
          <FailureNotice
            failure={openFailure}
            action={
              openFailure?.kind === "slip" && ["PASSKEY_FAILED", "WRONG_KEY", "EPOCH_MISMATCH", "PRF_UNSUPPORTED"].includes(openFailure.code) && selected ? (
                <PasskeyButton tone="airmail" size="md" onClick={() => void open(selected)}>
                  {openFailure.code === "WRONG_KEY" ? "Choose another passkey" : openFailure.code === "PRF_UNSUPPORTED" ? "Try another passkey" : "Open with passkey"}
                </PasskeyButton>
              ) : undefined
            }
          />
          <p className={styles.caption}>
            {selected?.where ? (
              <>
                Dropped in block {formatCount(Number(selected.where.block))} · <TxLink hash={selected.where.tx} /> · epoch {selected.envelope.epoch} ·{" "}
                {formatBytes(selected.where.bytes)}.{" "}
              </>
            ) : selected ? (
              <>Pasted envelope · epoch {selected.envelope.epoch}. </>
            ) : who && box.readAt !== undefined && !box.noKey ? (
              <>No letters for this address yet. Seal one to yourself, or ask the reference agent to write to you. </>
            ) : null}
            No sender is shown: anyone may seal to a published key, so the envelope cannot say who wrote it.
          </p>
          {who && box.readAt !== undefined && box.envelopes.length === 0 && !box.noKey && (
            <div className={styles.emptyActions}>
              <ButtonLink href={`/seal?to=${encodeURIComponent(who)}`} size="md" icon={<ArrowRightIcon />}>
                Seal a note
              </ButtonLink>
              <ButtonLink href="/judge" size="md" icon={<ArrowRightIcon />}>
                Ask the agent
              </ButtonLink>
            </div>
          )}
        </div>
      </section>

      <section className={styles.inbox} aria-labelledby="inbox-title">
        <h2 id="inbox-title" className={styles.inboxTitle}>
          Letters for you
        </h2>
        {who && (
          <p className={styles.status} role="status" aria-live="off">
            {box.noKey
              ? "This address has no key in the register, so nothing can be sealed to it yet."
              : box.finalized === undefined
                ? "Reading the directory’s Dropped events…"
                : `${formatCount(sorted.length)} ${sorted.length === 1 ? "letter" : "letters"} · read to finalized block ${formatCount(Number(box.finalized))}${age !== undefined ? ` · ${age} s ago` : ""}`}
          </p>
        )}
        {box.failure && <FailureNotice failure={box.failure} />}
        {(sorted.length > 0 || box.rejected.length > 0) && (
          <ol className={styles.list}>
            {sorted.map((e) => {
              const id = idOf(e);
              const isOpen = opened[id] !== undefined;
              const sel: Selected = { id, envelope: e.envelope, where: { block: e.blockNumber, tx: e.transactionHash, bytes: e.bytes } };
              return (
                <li key={id} className={styles.item} data-state={isOpen ? "opened" : "sealed"} data-action="" data-selected={selected?.id === id ? "" : undefined}>
                  <div className={styles.thumb}>
                    <Envelope
                      recipient={e.envelope.recipient}
                      flap={isOpen ? "open" : "closed"}
                      variant="compact"
                      seal={<WaxSeal state={isOpen ? "cracked" : "pressed"} decorative />}
                      decorative
                    />
                  </div>
                  <div className={styles.meta}>
                    <p className={styles.state}>{isOpen ? "Opened" : "Sealed"}</p>
                    <p className={styles.detail}>
                      Epoch {e.envelope.epoch} · {formatBytes(e.bytes)}
                    </p>
                    <p className={styles.detail}>
                      Block {formatCount(Number(e.blockNumber))} · <TxLink hash={e.transactionHash} />
                    </p>
                  </div>
                  <div className={styles.act}>
                    {isOpen ? (
                      <Button tone="outline" size="md" status={selected?.id === id ? "disabled" : "idle"} onClick={() => pick(sel)}>
                        {selected?.id === id ? "In the reader" : "Read it again"}
                      </Button>
                    ) : (
                      <PasskeyButton
                        tone="airmail"
                        size="md"
                        status={stage === "opening" && selected?.id === id ? "waiting" : stage === "opening" || !host?.ok ? "disabled" : "idle"}
                        onClick={() => void open(sel)}
                      >
                        Open with passkey
                      </PasskeyButton>
                    )}
                  </div>
                </li>
              );
            })}
            {box.rejected.map((x) => (
              <li key={`${x.transactionHash}:${x.logIndex}`} className={styles.item} data-state="returned">
                <div className={styles.thumb}>
                  <Envelope recipient={who ?? "0x…"} flap="closed" variant="compact" seal={<WaxSeal state="pressed" decorative />} decorative />
                  <span className={styles.returned} aria-hidden="true">
                    Returned
                  </span>
                </div>
                <div className={styles.meta}>
                  <p className={styles.state}>Returned: not an envelope for you</p>
                  <p className={styles.detail}>
                    {x.reason} · {formatBytes(x.bytes)}
                  </p>
                  <p className={styles.detail}>
                    Block {formatCount(Number(x.blockNumber))} · <TxLink hash={x.transactionHash} />
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}

        <details className={styles.paste}>
          <summary>
            <span>Paste an envelope</span>
            <span className={styles.pasteMeta}>one handed to you any other way</span>
          </summary>
          <form className={styles.pasteForm} onSubmit={onPaste} aria-label="Open a pasted envelope">
            <label className="label-caps" htmlFor="pasted-envelope">
              Envelope JSON
            </label>
            <textarea
              id="pasted-envelope"
              className={`${styles.pasteBox} data`}
              rows={5}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              spellCheck={false}
              aria-invalid={pasteError ? true : undefined}
              aria-describedby={pasteError ? "pasted-error" : undefined}
            />
            {pasteError && (
              <p id="pasted-error" className={styles.pasteError} role="alert">
                {pasteError}
              </p>
            )}
            <PasskeyButton tone="airmail" size="md" type="submit" status={pasted.trim() && host?.ok ? (stage === "opening" ? "waiting" : "idle") : "disabled"}>
              Open with passkey
            </PasskeyButton>
          </form>
        </details>
      </section>
    </main>
  );
}
