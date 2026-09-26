// No kicker above a heading: a short line of capitals set directly over an h1 or h2 is the most common template
// tell, and the type system reserves capitals for labels, column heads and stamps beside what they mark. Checked on
// every route and on the returned-to-sender (404) page.
import { openPage } from "./_lib.mjs";

export const name = "no-kicker";
export const about = "no short all-capitals line sits directly above an h1 or h2";

const scan = () => {
  const hits = [];
  for (const h of document.querySelectorAll("h1, h2")) {
    const prev = h.previousElementSibling;
    if (!prev || window.__qa.hiddenByStyle(prev)) continue;
    const text = prev.innerText.replace(/\s+/g, " ").trim();
    if (!text || text.length > 40 || !/[A-Za-z]/.test(text) || text !== text.toUpperCase()) continue;
    const p = prev.getBoundingClientRect();
    const t = h.getBoundingClientRect();
    if (p.bottom <= t.top + 2) hits.push(`"${text}" (${window.__qa.describe(prev)}) above ${h.tagName.toLowerCase()} "${h.innerText.trim().slice(0, 40)}"`);
  }
  return hits;
};

export async function run({ browser, base, routes, fail }) {
  for (const route of [...routes, "/no-such-page"]) {
    for (const width of [1280, 390]) {
      const { page, context } = await openPage(browser, base, route, { width });
      for (const hit of await page.evaluate(scan)) fail(`${route} @${width}: kicker ${hit}`);
      await context.close();
    }
  }
}
