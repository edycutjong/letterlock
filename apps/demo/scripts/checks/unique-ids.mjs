// Every id in a document is unique. A repeated id resolves every reference to its first copy: an SVG url(#…), a
// label's for, an aria-describedby.
export const name = "unique-ids";
export const about = "no id appears twice in a page";

export async function page(page, { width, fail }) {
  if (width !== 1280) return;
  const dups = await page.evaluate(() => {
    const seen = new Map();
    for (const el of document.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`);
  });
  if (dups.length) fail(`${dups.length} duplicated id(s): ${dups.slice(0, 6).join(", ")}${dups.length > 6 ? ", …" : ""}`);
}
