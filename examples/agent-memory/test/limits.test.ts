import { describe, expect, it } from "vitest";
import { RateLimiter, ReplayGuard, charCount } from "../src/limits.ts";

describe("RateLimiter", () => {
  const minute = 60_000;

  it("takes up to max per window, then says how long until the oldest hit leaves it", () => {
    const l = new RateLimiter([{ windowSec: 600, max: 5 }]);
    for (let i = 0; i < 5; i++) expect(l.take("ip", i * minute).ok).toBe(true);
    const v = l.take("ip", 5 * minute);
    expect(v).toMatchObject({ ok: false, retryAfterSec: 300, window: { windowSec: 600, max: 5 } });
    expect(l.take("ip", 10 * minute - 1).ok).toBe(false); // the first hit (t = 0) is still inside the window
    expect(l.take("ip", 10 * minute).ok).toBe(true); // ...and leaves it here
  });

  it("keeps each key apart", () => {
    const l = new RateLimiter([{ windowSec: 60, max: 1 }]);
    expect(l.take("a", 0).ok).toBe(true);
    expect(l.take("a", 1).ok).toBe(false);
    expect(l.take("b", 1).ok).toBe(true);
  });

  it("applies every window: the longer one bites when the short one has room", () => {
    const l = new RateLimiter([{ windowSec: 600, max: 5 }, { windowSec: 86_400, max: 7 }]);
    const hour = 60 * minute;
    for (let i = 0; i < 7; i++) expect(l.take("ip", i * hour).ok, `hit ${i}`).toBe(true);
    const v = l.take("ip", 7 * hour);
    expect(v).toMatchObject({ ok: false, window: { windowSec: 86_400, max: 7 }, retryAfterSec: 17 * 3600 });
  });

  it("check() looks without recording; a refused take() records nothing", () => {
    const l = new RateLimiter([{ windowSec: 60, max: 2 }]);
    expect(l.check("ip", 0).ok).toBe(true);
    expect(l.check("ip", 0).ok).toBe(true);
    expect(l.take("ip", 0).ok).toBe(true);
    expect(l.take("ip", 1).ok).toBe(true);
    expect(l.take("ip", 2).ok).toBe(false);
    expect(l.take("ip", 60_000).ok).toBe(true); // only the two taken hits counted
  });

  it("forgets the least recently used keys past maxKeys", () => {
    const l = new RateLimiter([{ windowSec: 60, max: 1 }], 2);
    l.take("a", 0);
    l.take("b", 0);
    l.take("c", 0);
    expect(l.take("a", 1).ok).toBe(true); // a was dropped
    expect(l.take("c", 1).ok).toBe(false);
  });
});

describe("ReplayGuard", () => {
  it("remembers a key for ttl, and forgets a deleted one", () => {
    const g = new ReplayGuard(1000);
    expect(g.has("n", 0)).toBe(false);
    g.add("n", 0);
    expect(g.has("n", 999)).toBe(true);
    expect(g.has("n", 1000)).toBe(false);
    g.add("m", 0);
    g.delete("m");
    expect(g.has("m", 1)).toBe(false);
  });

  it("drops the oldest keys past maxKeys", () => {
    const g = new ReplayGuard(1000, 2);
    g.add("a", 0);
    g.add("b", 0);
    g.add("c", 0);
    expect([g.has("a", 1), g.has("b", 1), g.has("c", 1)]).toEqual([false, true, true]);
  });
});

describe("charCount", () => {
  it("counts code points: an emoji is one character, not two UTF-16 units", () => {
    expect(charCount("abc")).toBe(3);
    expect(charCount("🔒")).toBe(1);
    expect("🔒".length).toBe(2);
    expect(charCount("日本語")).toBe(3);
  });
});
