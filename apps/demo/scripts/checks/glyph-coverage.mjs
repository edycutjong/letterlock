// The three faces are self-hosted in subsets. A character outside every subset of the face it is set in falls back
// to a local font (Arial behind the mono face), which breaks the grid of a data line. Every character on the page
// must be covered by one of the @font-face unicode ranges of the face it is set in.
export const name = "glyph-coverage";
export const about = "every character is drawn by the face it is set in, not by a fallback font";

const scan = () => {
  const faces = new Map();
  const parse = (range) =>
    range.split(",").map((t) => {
      const u = t.trim().replace(/^u\+/i, "");
      if (u.includes("?")) return [parseInt(u.replace(/\?/g, "0"), 16), parseInt(u.replace(/\?/g, "f"), 16)];
      const [a, b] = u.split("-");
      return [parseInt(a, 16), parseInt(b ?? a, 16)];
    });
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      const range = rule.style.getPropertyValue("unicode-range") || "U+0-10FFFF";
      faces.set(family, [...(faces.get(family) ?? []), ...parse(range)]);
    }
  }
  const misses = new Map();
  for (const run of window.__qa.textRuns()) {
    const family = getComputedStyle(run.el).fontFamily.split(",")[0].replace(/["']/g, "").trim();
    const ranges = faces.get(family);
    if (!ranges) continue; // a system face: nothing self-hosted to fall back from
    for (const ch of run.text) {
      const cp = ch.codePointAt(0);
      if (cp <= 0x20 || ranges.some(([a, b]) => cp >= a && cp <= b)) continue;
      const key = `U+${cp.toString(16).toUpperCase().padStart(4, "0")} "${ch}" in ${family}`;
      misses.set(key, [...new Set([...(misses.get(key) ?? []), window.__qa.describe(run.el)])]);
    }
  }
  return [...misses].map(([k, els]) => `${k} (${els.slice(0, 3).join(", ")})`);
};

export async function page(page, { width, fail }) {
  if (width !== 1280) return; // the same text at every width
  for (const miss of await page.evaluate(scan)) fail(`no glyph for ${miss}`);
}
