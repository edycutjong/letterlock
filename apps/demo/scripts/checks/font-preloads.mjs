// Every font file a page preloads is one its text is set in. A preload is fetched at high priority before the page
// paints, so an unused one (a face no text uses, or a weight only the kit uses) costs every page, the phone's first
// screen included. A preloaded file maps to its @font-face rule; the browser marks a face loaded only once some
// text on the page needs it.
export const name = "font-preloads";
export const about = "every preloaded font file is a face the page's text uses";

const audit = () => {
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of list) if (r instanceof CSSFontFaceRule) rules.push(r);
  }
  const unquote = (s) => s.replace(/["']/g, "").trim();
  return [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) => {
    const file = new URL(link.href).pathname.split("/").pop();
    const rule = rules.find((r) => r.style.getPropertyValue("src").includes(file));
    if (!rule) return { file, face: "no @font-face rule", status: "missing" };
    const d = (k, dflt) => rule.style.getPropertyValue(k) || dflt;
    const family = unquote(d("font-family", ""));
    const style = d("font-style", "normal");
    const weight = d("font-weight", "400");
    // the browser's own spelling of the rule's unicode-range
    const range = new FontFace("x", "local(x)", { unicodeRange: d("unicode-range", "U+0-10FFFF") }).unicodeRange;
    const face = [...document.fonts].find((f) => unquote(f.family) === family && f.style === style && f.weight === weight && f.unicodeRange === range);
    return { file, face: `${family.replace(/^__|_[0-9a-f]{6,}$/g, "").replace(/_/g, " ")} ${style} ${weight}`, status: face?.status ?? "not in document.fonts" };
  });
};

export async function page(page, { fail }) {
  for (const f of await page.evaluate(audit))
    if (f.status !== "loaded") fail(`preloads ${f.file} (${f.face}), which no text on the page uses (${f.status})`);
}
