// A live region speaks every time its text changes. Typing in the note must not make a screen reader recite the byte
// count after every key; the count stays readable on the field (aria-describedby). Only crossing the byte limit is
// announced, once.
import { openPage } from "./_lib.mjs";

export const name = "live-regions";
export const about = "typing in the note announces nothing until it crosses its byte limit, and that only once";

const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';

/** count text changes in the live regions of the field that holds `textarea`, while `type` runs */
const watch = (page, textarea) =>
  textarea.evaluate((ta, LIVE) => {
    const field = ta.closest('[class*="Field_field__"]');
    window.__qaAnnounced = [];
    const regions = [...field.querySelectorAll(LIVE)];
    const seen = new Map(regions.map((r) => [r, r.textContent]));
    window.__qaObserver = new MutationObserver(() => {
      for (const r of regions)
        if (r.textContent !== seen.get(r)) {
          seen.set(r, r.textContent);
          if (r.textContent.trim()) window.__qaAnnounced.push(r.textContent.trim());
        }
    });
    for (const r of regions) window.__qaObserver.observe(r, { subtree: true, childList: true, characterData: true });
    return regions.length;
  }, LIVE);

const announced = (page) => page.evaluate(() => window.__qaAnnounced);

export async function run({ browser, base, routes, fail }) {
  if (routes.includes("/seal")) {
    const { page, context } = await openPage(browser, base, "/seal");
    const ta = page.locator("main form textarea");
    await watch(page, ta);
    await ta.click();
    await ta.press("End");
    await ta.pressSequentially(" Bring the card.", { delay: 15 });
    await page.waitForTimeout(1500);
    const said = await announced(page);
    if (said.length) fail(`/seal: typing 16 characters in the note announced ${said.length} time(s): ${JSON.stringify(said.slice(0, 4))}`);
    await context.close();
  }
  if (routes.includes("/kit")) {
    const { page, context } = await openPage(browser, base, "/kit");
    const over = page.locator('#fields textarea[aria-invalid="true"]');
    if (!(await over.count())) {
      fail("/kit: no NoteField over its byte limit to test the limit announcement on");
    } else {
      // held by its id: once emptied it is no longer invalid, and the selector above would lose it
      const ta = page.locator(`[id="${await over.first().getAttribute("id")}"]`);
      await watch(page, ta);
      await ta.click();
      await ta.fill(""); // back under the limit
      await ta.pressSequentially("A short note that grows past the limit, one key at a time, and keeps going.", { delay: 5 });
      await page.waitForTimeout(1500);
      const said = await announced(page);
      if (said.length !== 1) fail(`/kit: crossing the byte limit while typing should announce once, announced ${said.length} time(s): ${JSON.stringify(said.slice(0, 4))}`);
    }
    await context.close();
  }
}
