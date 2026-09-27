// Short labels are set on one line at every width:
//   - a button's label (a two-line "Open with / passkey" reads as two controls), from 360 px up; on narrower phones
//     (and a 1280 px screen zoomed to 400%) a long label may take two balanced lines, as the Button is drawn to, never
//     three;
//   - a transaction link: its hash is never split, its arrow stays on the hash's line, and it fits its column;
//   - an arrow in a link or a call chain stays on the line of the text it belongs to: after the text it marks in a
//     link, before the call it leads to in the home page's "keyOf(address) → seal()" (which may break before the
//     arrow, never after it).
// Swept from 320 to 1440 px in 8 px steps on every route; the page is resized, not reloaded.
import { openPage, spans } from "./_lib.mjs";

export const name = "label-wrap";
export const about = "button labels, transaction links and arrows in running text never break across lines";

const STEP = 8;
/** from this width every button label is one line; below it, two at most */
const ONE_LINE_FROM = 360;

const measure = (oneLine) => {
  const visible = (el) => el.getClientRects().length > 0 && !window.__qa.hiddenByStyle(el);
  const mid = (r) => r.top + r.height / 2;
  /** the line fragments of the visible text in el, in document order (screen-reader-only text left out); `keep`
   *  picks the text nodes */
  const textRects = (el, keep = () => true) => {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest(".visually-hidden") || !keep(n)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      out.push(...[...range.getClientRects()].filter((r) => r.width * r.height >= 4));
    }
    return out;
  };
  const lineCount = (rects) => window.__qa.lines(rects).length;
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
  const bad = [];

  for (const l of document.querySelectorAll('[class*="Button_label__"]')) {
    const n = visible(l) ? lineCount(textRects(l)) : 1;
    if (n > (oneLine ? 1 : 2)) bad.push(`button "${text(l)}" breaks over ${n} lines`);
  }

  for (const a of document.querySelectorAll('[class*="AddressCard_txLink__"]')) {
    if (!visible(a)) continue;
    if (lineCount(textRects(a)) > 1) bad.push(`transaction link "${text(a)}" is split over ${lineCount(textRects(a))} lines`);
    // kept to one line, it must still fit the column it is set in
    const cell = a.closest("dd, td");
    const cs = getComputedStyle(cell);
    const inner = cell.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    if (a.getBoundingClientRect().right > inner + 1) bad.push(`transaction link "${text(a)}" runs ${Math.round(a.getBoundingClientRect().right - inner)}px past its column`);
  }

  // arrows: in a link, on the line of the text before it; in code, on the line of the text after it
  for (const svg of document.querySelectorAll("main a svg, footer a svg, main code svg")) {
    if (!visible(svg) || svg.closest("[data-tone]")) continue;
    const host = svg.closest("a, code");
    const before = svg.closest("a") !== null;
    const side = before ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    const rects = textRects(host, (n) => svg.compareDocumentPosition(n) & side);
    const ref = before ? rects.at(-1) : rects[0];
    if (!ref) continue;
    const own = svg.getBoundingClientRect();
    if (Math.abs(mid(ref) - mid(own)) > Math.max(4, ref.height / 2))
      bad.push(`the arrow in "${text(host)}" is not on the line of the text ${before ? "it follows" : "it leads to"}`);
  }
  return bad;
};

export async function run({ browser, base, routes, fail }) {
  for (const route of routes) {
    const { page, context } = await openPage(browser, base, route, { width: 1280 });
    const seen = new Map();
    for (let w = 320; w <= 1440; w += STEP) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      for (const b of await page.evaluate(measure, w >= ONE_LINE_FROM)) seen.set(b, [...(seen.get(b) ?? []), w]);
    }
    for (const [what, ws] of seen) fail(`${route}: ${what} at ${spans(ws, STEP)} px`);
    await context.close();
  }
}
