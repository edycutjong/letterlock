// Copy that points at another part of the page ("above", "below") must be true in every layout the page has. The
// inbox's opened line points at the open letter, which is beside it on wide screens and above it on narrow ones.
import { openPage } from "./_lib.mjs";

export const name = "copy-orientation";
export const about = "copy that says 'above' or 'below' is true at every width";

const measure = () => {
  const reader = document.querySelector('section[aria-labelledby="reader-title"]').getBoundingClientRect();
  return [...document.querySelectorAll("main li")].flatMap((li) => {
    const m = li.innerText.match(/\b(above|below)\b/i);
    if (!m) return [];
    const r = li.getBoundingClientRect();
    const truth = m[1].toLowerCase() === "above" ? reader.bottom <= r.top : reader.top >= r.bottom;
    return truth ? [] : [`"${li.innerText.replace(/\s+/g, " ").trim().slice(0, 50)}" says ${m[1]}, but the letter is not ${m[1]} it`];
  });
};

export async function run({ browser, base, routes, fail }) {
  if (!routes.includes("/open")) return;
  for (const width of [390, 820, 1024, 1280]) {
    const { page, context } = await openPage(browser, base, "/open", { width });
    for (const p of await page.evaluate(measure)) fail(`/open @${width}: ${p}`);
    await context.close();
  }
}
