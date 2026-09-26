// A postmark is struck over the corner of an AddressCard and hangs past its edge. It may cover paper, never words:
// no line of text anywhere on the page may fall under its ring. Checked on every route and width qa.mjs loads, and
// across a sweep of the home page from 320 to 1440 px, where the hero stacks and the card moves under the fine print.
import { installHelpers, openPage, spans } from "./_lib.mjs";

export const name = "postmark-clear";
export const about = "no text lies under an AddressCard postmark's ring";

const scan = () => {
  const hits = [];
  for (const svg of document.querySelectorAll('article[data-postmark] > svg[class*="Postmark_postmark__"]')) {
    const ring = svg.querySelector("circle");
    const bb = ring.getBoundingClientRect();
    const cx = bb.left + bb.width / 2;
    const cy = bb.top + bb.height / 2;
    // ring: r 60 of a 128-unit box, plus half the 2.2-unit stroke
    const r = (parseFloat(getComputedStyle(svg).width) * 61.1) / 128;
    for (const run of window.__qa.textRuns()) {
      if (svg.contains(run.el)) continue;
      for (const t of run.rects) {
        const dx = Math.max(t.left - cx, 0, cx - t.right);
        const dy = Math.max(t.top - cy, 0, cy - t.bottom);
        if (dx * dx + dy * dy < (r - 1) * (r - 1)) {
          hits.push(`${window.__qa.describe(run.el)} "${window.__qa.snippet(run.text)}"`);
          break;
        }
      }
    }
  }
  return [...new Set(hits)];
};

export async function page(page, { fail }) {
  for (const hit of await page.evaluate(scan)) fail(`postmark ring covers ${hit}`);
}

export async function run({ browser, base, routes, fail }) {
  if (!routes.includes("/")) return;
  const { page, context } = await openPage(browser, base, "/", { width: 1280, height: 1100 });
  const bad = new Map();
  for (let w = 320; w <= 1440; w += 10) {
    await page.setViewportSize({ width: w, height: 1100 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await installHelpers(page);
    for (const hit of await page.evaluate(scan)) bad.set(hit, [...(bad.get(hit) ?? []), w]);
  }
  for (const [hit, ws] of bad) fail(`home sweep: postmark ring covers ${hit} at ${spans(ws, 10)} px`);
  await context.close();
}
