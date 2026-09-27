// Shared helpers for the layout and behaviour checks in this folder (scripts/qa.mjs loads every other *.mjs here).
// A check module exports `name`, `about`, and either or both of:
//   page(page, { route, width, fail })  run on every route × width that qa.mjs loads
//   run({ browser, base, routes, fail })  a scenario of its own (it opens its own pages)

/** Browser-side helpers, installed once per page as window.__qa. */
const HELPERS = () => {
  if (window.__qa) return;
  const moduleName = (c) => c.replace(/__[A-Za-z0-9_-]{5}$/, "");
  const describe = (el) => {
    if (!el) return "?";
    const cls = String(el.className?.baseVal ?? el.className ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map(moduleName)
      .slice(0, 2)
      .join(".");
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };
  const hiddenByStyle = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true;
      if (e.classList?.contains("visually-hidden")) return true;
    }
    return false;
  };
  /** every visible run of text as { text, el, rects }, one rect per line fragment */
  const textRuns = (root = document.body) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest("script, style, noscript, title, template")) continue;
      if (hiddenByStyle(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width * r.height >= 4);
      if (rects.length) out.push({ text: n.textContent.trim(), el, rects });
    }
    return out;
  };
  /** group a run's rects into lines (fragments whose vertical centres are within 3 px) */
  const lines = (rects) => {
    const ls = [];
    for (const r of [...rects].sort((a, b) => a.top - b.top)) {
      const mid = (r.top + r.bottom) / 2;
      const l = ls.find((x) => Math.abs(x.mid - mid) < 3);
      if (l) l.rects.push(r);
      else ls.push({ mid, top: r.top, rects: [r] });
    }
    return ls;
  };
  const snippet = (s, n = 36) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  window.__qa = { describe, hiddenByStyle, textRuns, lines, snippet };
};

export const installHelpers = (page) => page.evaluate(HELPERS);

export async function openPage(browser, base, route, { width = 1280, height = 900, reducedMotion } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion });
  const page = await context.newPage();
  await page.goto(base + route, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await installHelpers(page);
  return { page, context };
}

/** [590, 600, 610, 700] → "590-610, 700" for a sweep with the given step */
export const spans = (xs, step) => {
  const out = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && x - last[1] <= step) last[1] = x;
    else out.push([x, x]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
};

/** Compare two PNG screenshots of the same size in a browser page: how many pixels changed, and by how much. */
export async function pngDiff(page, a, b, threshold = 24) {
  return page.evaluate(
    async ({ a, b, threshold }) => {
      const load = async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return { total: 0, changed: -1, max: 0 };
      let changed = 0;
      let max = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        const d = Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]);
        if (d > threshold) changed++;
        if (d > max) max = d;
      }
      return { total: x.width * x.height, changed, max };
    },
    { a: a.toString("base64"), b: b.toString("base64"), threshold },
  );
}

/**
 * The pages read the chain, so a check that needs a live state brings it about the way a person would. The address
 * used is the directory's deployer (deployments/<chain>.json): it has a key and letters on both chains.
 */
import { readFileSync } from "node:fs";
const chainRecord = JSON.parse(
  readFileSync(new URL(`../../../../deployments/${process.env.NEXT_PUBLIC_LETTERLOCK_CHAIN === "monad-testnet" ? "10143" : "143"}.json`, import.meta.url), "utf8"),
);
export const KNOWN_ADDRESS = chainRecord.deployer;

/** /register: the live register has been read (its table has lines). */
export const registerRead = (page) =>
  page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="live-title"] tbody tr').length > 0, null, { timeout: 60_000 });

/** /register or /seal: look KNOWN_ADDRESS up and wait for the line keyOf returned. */
export async function lookUpKnown(page, route) {
  const field = route === "/seal" ? page.locator('main form input[name="to"]') : page.locator('form[role="search"] input[name="q"]');
  await field.fill(KNOWN_ADDRESS);
  if (route !== "/seal") await field.press("Enter");
  await page.locator('tr[data-state="found"]').first().waitFor({ timeout: 30_000 });
}
