// A numeral standing alone (an epoch, a step number, a postmark's centre) is read as a number only if its face
// makes a 1 unmistakable. Bodoni Moda's upright 1 reads as a capital I at display sizes, so lone numerals are set in
// the body face with lining figures, the way the register sets its epoch column.
export const name = "numerals";
export const about = "numerals standing alone are set in the body face (Public Sans), never the Didone";

const scan = () => {
  const hits = [];
  for (const run of window.__qa.textRuns()) {
    // the element's whole text, not one text node of it ("0" of "0 ms" is not a lone numeral)
    const text = run.el.textContent.trim();
    if (!/^\d{1,4}$/.test(text)) continue;
    const family = getComputedStyle(run.el).fontFamily.split(",")[0].replace(/["']/g, "").trim();
    if (family !== "Public Sans") hits.push(`${window.__qa.describe(run.el)} "${text}" is set in ${family}`);
  }
  return [...new Set(hits)];
};

export async function page(page, { width, fail }) {
  if (width !== 1280) return;
  for (const hit of await page.evaluate(scan)) fail(`lone numeral ${hit}`);
}
