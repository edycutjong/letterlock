// In-memory abuse limits, per server instance and best effort. A Vercel function instance serves many requests in turn
// (Fluid compute), so these hold across requests to one instance, but instances do not share them: a burst that
// lands on three instances meets three fresh limiters. The limits every instance shares are elsewhere: the Vercel
// firewall rule (vercel-firewall.json) counts each IP's POSTs at the edge, and the wallet (spend.ts) counts the day's
// drops on the chain, by the nonce of the transaction it is asked to sign.
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

  /** Give back a hit take() recorded at `at`: what it counted was refused before anything was sent. */
  refund(key: string, at: number): void {
    const list = this.hits.get(key);
    if (!list) return;
    const i = list.lastIndexOf(at);
    if (i < 0) return;
    list.splice(i, 1);
    if (list.length === 0) this.hits.delete(key);
  }
}

/**
 * Keys seen within `ttlMs` (task nonces): a replayed task is refused while its nonce is remembered. In memory, so per
 * server instance: a copy of a task that reaches another instance is answered again (another drop to the same
 * sealed reply address, counted in the day's allowance like any other).
 */
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
