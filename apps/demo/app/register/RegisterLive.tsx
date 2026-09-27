"use client";

import type { ResolvedKey } from "letterlock";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { FailureNotice } from "@/components/FailureNotice";
import { TextField } from "@/components/Field";
import { LookupIcon } from "@/components/Icons";
import { RegisterTable, type RegisterRow } from "@/components/RegisterTable";
import { DEPLOYMENT, explorerTx } from "@/lib/chain.ts";
import { readClient } from "@/lib/client.ts";
import { DIRECTORY, SMOKE_KEYS } from "@/lib/deployment.ts";
import { toFailure, type Failure } from "@/lib/failure.ts";
import { formatCount, shortHex } from "@/lib/format.ts";
import { useNow, usePoll } from "@/lib/hooks.ts";
import { KNOWN_KEYS } from "@/lib/known-keys.ts";
import { readKeyLines, scanHead, type KeyLine } from "@/lib/register.ts";
import styles from "./register.module.css";

/** How often the register reads the chain again. Monad makes a block about every 400 ms. */
const POLL_MS = 5_000;

type Scan = {
  lines: KeyLine[];
  /** the last block read */
  head?: bigint;
  /** when the last read finished, in seconds */
  readAt?: number;
  progress?: { done: bigint; total: bigint };
  failure?: Failure;
};

/** A line's note: the deploy smoke test's demo keys and the app's own test keys say what they are. */
const noteFor = (l: KeyLine): string | undefined => {
  const known = KNOWN_KEYS.find((k) => k.txHash.toLowerCase() === l.txHash.toLowerCase());
  if (known) return known.note;
  if (SMOKE_KEYS.some((k) => k.txHash.toLowerCase() === l.txHash.toLowerCase()))
    return "Demo key from the deploy smoke test: random bytes stood in for a passkey. Don’t seal real notes to it";
  if (l.recipient.startsWith("agent:")) return `Posted by the agent’s ERC-8004 owner ${shortHex(l.publisher, 6, 4)}`;
  return undefined;
};

export const rowsFrom = (lines: KeyLine[], found?: string): RegisterRow[] => {
  const latest = new Map<string, number>();
  for (const l of lines) latest.set(l.recipient, Math.max(latest.get(l.recipient) ?? 0, l.epoch));
  return [...lines]
    .sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)
    .map((l) => {
      const note = noteFor(l);
      return {
        id: l.id,
        addressee: l.recipient,
        epoch: l.epoch,
        fingerprint: l.fingerprint,
        posted: { kind: "tx", hash: l.txHash, href: explorerTx(l.txHash), block: l.block, ...(l.at !== undefined ? { at: l.at } : {}), network: DIRECTORY.network },
        state: l.epoch < (latest.get(l.recipient) ?? 0) ? "superseded" : found === l.id ? "found" : "current",
        ...(note ? { note } : {}),
      } satisfies RegisterRow;
    });
};

/** Every KeyPublished event of the directory, newest first, read again every five seconds; and a live keyOf lookup. */
export function RegisterLive() {
  const [scan, setScan] = useState<Scan>({ lines: [] });
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const now = useNow();

  const read = useCallback(async () => {
    const { head: last, lines } = scanRef.current;
    try {
      const head = await scanHead();
      const from = last === undefined ? BigInt(DEPLOYMENT.deployBlock) : last + 1n;
      if (from > head) {
        setScan((s) => ({ ...s, readAt: Math.floor(Date.now() / 1000), failure: undefined }));
        return;
      }
      const fresh = await readKeyLines({
        fromBlock: from,
        toBlock: head,
        onProgress: last === undefined ? (done, total) => setScan((s) => ({ ...s, progress: { done, total } })) : undefined,
      });
      const seen = new Set(lines.map((l) => l.id));
      setScan({ lines: [...lines, ...fresh.filter((l) => !seen.has(l.id))], head, readAt: Math.floor(Date.now() / 1000) });
    } catch (e) {
      setScan((s) => ({ ...s, failure: toFailure(e) }));
    }
  }, []);
  usePoll(read, POLL_MS);

  // ---- look up ----
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<{ status: "idle" | "reading" } | { status: "found"; key: ResolvedKey } | { status: "failed"; failure: Failure }>({ status: "idle" });
  const onLookup = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLookup({ status: "reading" });
    try {
      setLookup({ status: "found", key: await readClient().resolve(q) });
    } catch (err) {
      setLookup({ status: "failed", failure: toFailure(err) });
    }
  };
  const foundLine =
    lookup.status === "found"
      ? scan.lines.filter((l) => l.recipient === lookup.key.recipient && l.epoch === lookup.key.epoch).at(-1)
      : undefined;
  const foundRow: RegisterRow | undefined =
    lookup.status === "found"
      ? {
          id: "found",
          addressee: lookup.key.recipient,
          epoch: lookup.key.epoch,
          fingerprint: lookup.key.kid,
          posted: foundLine
            ? { kind: "tx", hash: foundLine.txHash, href: explorerTx(foundLine.txHash), block: foundLine.block, ...(foundLine.at !== undefined ? { at: foundLine.at } : {}), network: DIRECTORY.network }
            : { kind: "unknown", at: lookup.key.updatedAt, network: DIRECTORY.network },
          state: "found",
          ...(foundLine && noteFor(foundLine) ? { note: noteFor(foundLine) } : {}),
        }
      : undefined;
  const inputError = lookup.status === "failed" && lookup.failure.kind === "input" ? lookup.failure.message : undefined;

  const rows = rowsFrom(scan.lines);
  const age = scan.readAt === undefined ? undefined : Math.max(0, now - scan.readAt);
  return (
    <>
      <form className={styles.lookup} role="search" aria-label="Look up an address" onSubmit={onLookup}>
        <TextField
          className={styles.lookupField}
          label="Look up"
          name="q"
          data
          placeholder="0x… or agent:<id>"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          error={inputError}
          hint="keyOf(address) or keyOfAgent(id), read from the directory now. Free: a read sends no transaction."
        />
        <Button type="submit" icon={<LookupIcon />} size="md" className={styles.lookupAction} status={lookup.status === "reading" ? "waiting" : "idle"} waitingLabel="Reading keyOf…">
          Look up
        </Button>
      </form>
      <div className={styles.result} aria-live="polite">
        {foundRow && <RegisterTable caption={`What keyOf returned for ${foundRow.addressee}`} layout="auto" rows={[foundRow]} />}
        {lookup.status === "failed" && lookup.failure.kind !== "input" && <FailureNotice failure={lookup.failure} headingLevel={2} />}
      </div>

      <section className={styles.section} aria-labelledby="live-title">
        <div className={styles.sectionHead}>
          <h2 id="live-title" className={styles.h2}>
            On {DIRECTORY.network} now
          </h2>
          <p className={styles.sectionNote}>
            Every key posted to the directory, newest first, read from its KeyPublished events by this page, again every {POLL_MS / 1000} seconds.
            A line is history: a note is sealed to what a keyOf read returns when sealing.
          </p>
          <p className={styles.status} role="status" aria-live="off">
            {scan.head === undefined
              ? scan.progress
                ? `Reading the register: ${formatCount(Number(scan.progress.done))} of ${formatCount(Number(scan.progress.total))} blocks`
                : "Reading the register…"
              : `${formatCount(rows.length)} ${rows.length === 1 ? "key" : "keys"} · read to block ${formatCount(Number(scan.head))}${age !== undefined ? ` · ${age} s ago` : ""}`}
          </p>
        </div>
        {scan.failure && <FailureNotice failure={scan.failure} />}
        {scan.head !== undefined && (
          <RegisterTable caption={`Keys posted to the ${DIRECTORY.network} directory`} captionHidden rows={rows} empty="No keys in the register yet." />
        )}
      </section>
    </>
  );
}
