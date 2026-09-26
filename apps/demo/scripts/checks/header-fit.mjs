// The letterhead must fit at every width, not only the four or five qa.mjs screenshots: the network chip is the
// testnet disclosure on every route, so it may never be pushed past the double rule or off the screen. Swept from
// 320 to 1440 px in 2 px steps (the header is the same on every route).
import { openPage, spans } from "./_lib.mjs";

export const name = "header-fit";
export const about = "the header's wordmark, routes and network chip fit inside the double rule at every width";

const measure = () => {
  const header = document.querySelector("body > header");
  const rule = header.querySelector("hr.double-rule").getBoundingClientRect();
  const chip = header.querySelector('[class*="SiteHeader_network__"]');
  const c = chip.getBoundingClientRect();
  const home = header.querySelector('[class*="SiteHeader_home__"]').getBoundingClientRect();
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) problems.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
  if (c.right > rule.right + 0.5 || c.left < rule.left - 0.5) problems.push(`network chip [${Math.round(c.left)}, ${Math.round(c.right)}] outside the rule [${Math.round(rule.left)}, ${Math.round(rule.right)}]`);
  const lines = window.__qa.lines([...(() => { const r = document.createRange(); r.selectNodeContents(chip); return r.getClientRects(); })()]);
  if (lines.length > 1) problems.push(`network chip wraps onto ${lines.length} lines`);
  const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  for (const a of header.querySelectorAll("nav a")) {
    const r = document.createRange();
    r.selectNodeContents(a);
    const t = r.getBoundingClientRect();
    if (overlap(t, c)) problems.push(`route "${a.textContent}" runs into the network chip`);
    if (overlap(t, home)) problems.push(`route "${a.textContent}" runs into the wordmark`);
    if (t.right > rule.right + 0.5) problems.push(`route "${a.textContent}" ends past the rule`);
  }
  return problems;
};

export async function run({ browser, base, routes, fail }) {
  const { page, context } = await openPage(browser, base, routes.includes("/") ? "/" : routes[0], { width: 1280, height: 800 });
  const bad = new Map();
  for (let w = 320; w <= 1440; w += 2) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    for (const p of await page.evaluate(measure)) {
      const key = p.replace(/\d+/g, "#");
      const e = bad.get(key) ?? { example: p, widths: [] };
      e.widths.push(w);
      bad.set(key, e);
    }
  }
  for (const { example, widths } of bad.values()) fail(`${example} (e.g.) at ${spans(widths, 2)} px`);
  await context.close();
}
