// Every register line posted by a transaction links that transaction, at every width: from 1024 px up in its Posted
// column, below that (and in the compact register, at any width) under its key. /judge sends people on to a second
// device, most often a phone, and the register there must still show where each key was posted. Exactly one link
// per line is visible, so the proof is neither missing nor said twice.
import { lookUpKnown, openPage, registerRead } from "./_lib.mjs";

export const name = "register-proof";
export const about = "every register line with a transaction shows its explorer link, once, at every width";

const scan = () => {
  const bad = [];
  let lines = 0;
  for (const tr of document.querySelectorAll("table tbody tr")) {
    const links = [...tr.querySelectorAll('a[href*="/tx/"]')];
    if (!links.length) continue;
    lines++;
    const shown = links.filter((a) => {
      const r = a.getBoundingClientRect();
      return !window.__qa.hiddenByStyle(a) && r.width > 0 && r.height > 0;
    });
    if (shown.length !== 1) bad.push(`"${window.__qa.snippet(tr.textContent.replace(/\s+/g, " ").trim(), 48)}": ${shown.length} transaction links shown`);
  }
  return { lines, bad };
};

export async function run({ browser, base, routes, fail }) {
  for (const width of [1280, 1024, 820, 768, 390]) {
    for (const route of ["/register", "/seal"]) {
      if (!routes.includes(route)) continue;
      const { page, context } = await openPage(browser, base, route, { width, height: 900 });
      if (route === "/register") await registerRead(page).catch(() => fail(`@${width} /register: the register was not read`));
      else {
        // the line keyOf returned, once the page has found the transaction that posted it
        await lookUpKnown(page, route).catch(() => fail(`@${width} /seal: the keyOf lookup found no line`));
        await page.locator('tr[data-state="found"] a[href*="/tx/"]').first().waitFor({ state: "attached", timeout: 30_000 }).catch(() => fail(`@${width} /seal: the found line has no transaction`));
      }
      const { lines, bad } = await page.evaluate(scan);
      if (!lines) fail(`@${width} ${route}: no register line with a transaction`);
      for (const b of bad) fail(`@${width} ${route}: ${b}`);
      await context.close();
    }
  }
}
