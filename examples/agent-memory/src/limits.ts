// In-memory abuse limits. A Vercel function instance serves many requests in turn (Fluid compute), so these hold
// across requests to one instance; instances do not share them. The limit every instance shares is the daily drop
// cap, which chain.ts counts onchain from the wallet's nonce.
import type { Window } from "./config.ts";

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly retryAfterSec: number; readonly window: Window };

/** Sliding windows per key (an IP): `check` looks, `take` looks and records. Oldest keys are dropped past `maxKeys`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windows: readonly Window[];
  private readonly maxKeys: number;
  private readonly longestMs: number;

  constructor(windows: readonly Window[], maxKeys = 10_000) {
    if (windows.length === 0) throw new RangeError("at least one window");
    this.windows = windows;
    this.maxKeys = maxKeys;
    this.longestMs = Math.max(...windows.map((w) => w.windowSec)) * 1000;
  }

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.longestMs);
  }

  private verdict(list: readonly number[], now: number): Verdict {
    for (const window of this.windows) {
      const inWindow = list.filter((t) => now - t < window.windowSec * 1000);
      if (inWindow.length >= window.max) {
        const oldest = inWindow[0]!; // timestamps are appended in order
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + window.windowSec * 1000 - now) / 1000)), window };
      }
    }
    return { ok: true };
  }

  check(key: string, now: number): Verdict {
    return this.verdict(this.recent(key, now), now);
  }

  take(key: string, now: number): Verdict {
    const list = this.recent(key, now);
    const v = this.verdict(list, now);
    if (v.ok) list.push(now);
    this.hits.delete(key); // re-insert: the map's order is least recently used first
    if (list.length > 0) this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return v;
  }
}

/** Keys seen within `ttlMs` (task nonces): a replayed task is refused while its nonce is remembered. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxKeys: number;

  constructor(ttlMs: number, maxKeys = 50_000) {
    this.ttlMs = ttlMs;
    this.maxKeys = maxKeys;
  }

  has(key: string, now: number): boolean {
    const expires = this.seen.get(key);
    if (expires === undefined) return false;
    if (expires <= now) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, now: number): void {
    this.seen.delete(key);
    this.seen.set(key, now + this.ttlMs);
    while (this.seen.size > this.maxKeys) this.seen.delete(this.seen.keys().next().value!);
  }

  /** Forget a key: its task was refused before anything was sent, so the same envelope may be posted again. */
  delete(key: string): void {
    this.seen.delete(key);
  }
}

/** Unicode code points: what "characters" means for the text limit (an emoji is one, not two UTF-16 units). */
export const charCount = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
