// Every button, button-styled link and disclosure must visibly change under the pointer. Measured, not assumed: the
// control is captured idle and hovered, and enough of its pixels must change by more than a faint tint.
// Gallery specimens that draw a forced state (data-force) and disabled or waiting buttons are left out.
// Every text link turns airmail blue under the pointer, all of its text (a component rule that sets a link's colour,
// or a span inside it that sets its own, keeps it ink): each visible run of text in the link must change colour.
// A link with no text of its own (the wordmark) is held to the pixel measure instead.
import { openPage, pngDiff } from "./_lib.mjs";

export const name = "hover-feedback";
export const about = "every button, button link and summary changes visibly on hover, and every text link's text changes colour";

// a pixel counts as changed when its R+G+B moves by more than 32 of 765 (under a faint tint the paper's grain alone
// moves some pixels by up to ~40, so a lower bar counts grain as feedback); a control passes when at least 6% of its
// box changes, or 600 px of it (a wide disclosure row whose label turns blue and underlines): a fill, a colour change
// or an underline clears it, a faint tint on paper does not
const PIXEL = 32;
const MIN_SHARE = 0.06;
const MIN_PIXELS = 600;
const SELECTOR = 'button:not(:disabled):not([aria-disabled="true"]):not([data-force]), a[data-tone]:not([data-force]), summary';
const LINKS = "a:not([data-tone]):not(.skip-link)";

// the colour of every visible run of text in a link, in document order
const textColours = (a) => {
  const out = [];
  const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || n.parentElement.closest(".visually-hidden")) continue;
    out.push({ text: n.textContent.trim().slice(0, 32), color: getComputedStyle(n.parentElement).color });
  }
  return out;
};

export async function run({ browser, base, routes, fail, verbose = process.env.QA_VERBOSE }) {
  const diffPage = await (await browser.newContext()).newPage();
  for (const route of routes) {
    const { page, context } = await openPage(browser, base, route, { width: 1280, height: 900 });
    const n = await page.locator(SELECTOR).count();
    for (let i = 0; i < n; i++) {
      const el = page.locator(SELECTOR).nth(i);
      if (!(await el.isVisible())) continue;
      await el.scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(260);
      const box = await el.boundingBox();
      if (!box || box.width < 2) continue;
      const clip = { x: Math.max(0, box.x - 2), y: Math.max(0, box.y - 2), width: box.width + 4, height: box.height + 4 };
      const idle = await page.screenshot({ clip });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(260);
      const hovered = await page.screenshot({ clip });
      const d = await pngDiff(diffPage, idle, hovered, PIXEL);
      const share = d.changed / d.total;
      const label = (await el.innerText()).trim().split("\n")[0].slice(0, 40);
      if (verbose) console.log(`  hover ${route} "${label}": ${d.changed}/${d.total} px (${(share * 100).toFixed(1)}%), max ${d.max}`);
      if (share < MIN_SHARE && d.changed < MIN_PIXELS) fail(`${route}: "${label}" barely changes on hover (${d.changed} of ${d.total} px, ${(share * 100).toFixed(1)}%)`);
    }

    const links = await page.locator(LINKS).count();
    for (let i = 0; i < links; i++) {
      const el = page.locator(LINKS).nth(i);
      if (!(await el.isVisible())) continue;
      await el.scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(260);
      const idle = await el.evaluate(textColours);
      const box = await el.boundingBox();
      if (!box || box.width < 2) continue;
      const clip = { x: Math.max(0, box.x - 2), y: Math.max(0, box.y - 2), width: box.width + 4, height: box.height + 4 };
      const idleShot = idle.length ? null : await page.screenshot({ clip });
      // the middle of the link's first line: the middle of its box can fall between the lines of a wrapped link
      const at = await el.evaluate((a) => {
        const r = a.getClientRects()[0];
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(260);
      const label = (await el.innerText()).trim().split("\n")[0].slice(0, 40) || (await el.getAttribute("aria-label")) || "link";
      if (idle.length) {
        const hovered = await el.evaluate(textColours);
        const kept = idle.filter((c, j) => hovered[j]?.color === c.color);
        if (verbose) console.log(`  link ${route} "${label}": ${idle.length - kept.length}/${idle.length} text runs change colour`);
        for (const k of kept) fail(`${route}: in the link "${label}", "${k.text}" keeps its colour (${k.color}) on hover`);
      } else {
        const d = await pngDiff(diffPage, idleShot, await page.screenshot({ clip }), PIXEL);
        const share = d.changed / d.total;
        if (verbose) console.log(`  link ${route} "${label}": ${d.changed}/${d.total} px (${(share * 100).toFixed(1)}%)`);
        if (share < MIN_SHARE && d.changed < MIN_PIXELS) fail(`${route}: the link "${label}" barely changes on hover (${d.changed} of ${d.total} px, ${(share * 100).toFixed(1)}%)`);
      }
    }
    await context.close();
  }
  await diffPage.context().close();
}
