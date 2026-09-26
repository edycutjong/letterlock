// The mono face is for data (fingerprints, hashes, addresses, envelope JSON, function and component names), never for
// prose. Any element whose own words read as a phrase (two or more words of letters, no code punctuation) must not
// be set in it.
export const name = "data-face";
export const about = "no prose is set in the data (mono) face";

const scan = () => {
  const hits = [];
  for (const run of window.__qa.textRuns()) {
    const family = getComputedStyle(run.el).fontFamily.split(",")[0].replace(/["']/g, "").trim();
    if (family !== "IBM Plex Mono") continue;
    const t = run.el.textContent.trim(); // the element's whole text, however React split it into nodes
    // code-shaped text: calls, objects, hex, custom properties, hashes, units after numbers
    if (/[(){}[\]#=<>]|0x|--|·/.test(t)) continue;
    if (/\b[A-Za-z]{2,}[,;.]?\s+[A-Za-z]{2,}\b/.test(t)) hits.push(`${window.__qa.describe(run.el)} "${window.__qa.snippet(t)}"`);
  }
  return [...new Set(hits)];
};

export async function page(page, { width, fail }) {
  if (width !== 1280) return;
  for (const hit of await page.evaluate(scan)) fail(`prose in the data face: ${hit}`);
}
