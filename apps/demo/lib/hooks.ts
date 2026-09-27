"use client";

// Live reads the pages share: an address's key as keyOf returns it now, with the transaction that posted it.
import { isLetterlockError, type ResolvedKey } from "letterlock";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { readClient } from "./client.ts";
import { toFailure, type Failure } from "./failure.ts";
import { findPublish, type KeyLine } from "./register.ts";

export type KeyOfState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "found"; readonly key: ResolvedKey; readonly line?: KeyLine; readonly lineStatus: "loading" | "found" | "missing" }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly failure: Failure };

/**
 * keyOf(address), read live (one contract read), then the KeyPublished log of that epoch for its transaction link.
 * `refresh()` reads again: after a publish or a rotation.
 */
export function useKeyOf(address: Address | undefined): { state: KeyOfState; refresh: () => void } {
  const [state, setState] = useState<KeyOfState>({ status: address ? "loading" : "idle" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!address) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState((s) => (s.status === "found" && s.key.recipient === address.toLowerCase() ? s : { status: "loading" }));
    readClient()
      .resolve(address)
      .then(
        async (key) => {
          if (!live) return;
          setState({ status: "found", key, lineStatus: "loading" });
          try {
            const line = await findPublish(address, key.epoch, key.updatedAt);
            if (live) setState({ status: "found", key, lineStatus: line ? "found" : "missing", ...(line ? { line } : {}) });
          } catch {
            if (live) setState({ status: "found", key, lineStatus: "missing" });
          }
        },
        (e: unknown) => {
          if (!live) return;
          if (isLetterlockError(e, "NO_KEY_PUBLISHED")) setState({ status: "none" });
          else setState({ status: "failed", failure: toFailure(e) });
        },
      );
    return () => {
      live = false;
    };
  }, [address, tick]);
  return { state, refresh };
}

/** Runs `f` every `ms` while the page is visible, and once at once. */
export function usePoll(f: () => void | Promise<void>, ms: number, enabled = true): void {
  const saved = useRef(f);
  saved.current = f;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let running = false;
    let timer: number | undefined;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      window.clearTimeout(timer);
      try {
        if (document.visibilityState === "visible") await saved.current();
      } catch {
        // the next poll tries again; the page shows the failure it recorded
      } finally {
        running = false;
      }
      if (!stopped) timer = window.setTimeout(run, ms);
    };
    void run();
    // a tab brought back reads at once instead of waiting out the interval
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled]);
}

/** The current time in seconds, updated every `ms`: for "3 s ago" labels. */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
