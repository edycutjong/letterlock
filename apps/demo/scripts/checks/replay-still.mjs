// The kit's replay changes the envelope's height as the letter goes into the pocket and comes out again. The
// controls must not move with it: a pointer that pressed "Seal it" has to be over the controls when "Open it"
// applies, and a second press lands where the first one did. Checked on a laptop, an iPad upright and a phone.
import { openPage } from "./_lib.mjs";

export const name = "replay-still";
export const about = "the kit replay's controls stay where they were pressed while the envelope seals and opens";

export async function run({ browser, base, routes, fail }) {
  if (!routes.includes("/kit")) return;
  for (const width of [1280, 820, 390]) {
    const { page, context } = await openPage(browser, base, "/kit", { width, height: 900 });
    const button = (label) => page.getByRole("button", { name: label, exact: true });
    const status = (text) => page.getByRole("status").filter({ hasText: text });
    const top = async (label) => (await button(label).boundingBox()).y + (await page.evaluate(() => window.scrollY));
    await button("Seal it").scrollIntoViewIfNeeded();
    const before = await top("Seal it");
    await button("Seal it").click();
    await status("Sealed.").waitFor({ timeout: 5000 });
    const sealed = await top("Open it");
    await button("Open it").click();
    await status("Opened.").waitFor({ timeout: 5000 });
    const opened = await top("Seal it");
    const moved = Math.max(Math.abs(sealed - before), Math.abs(opened - before));
    if (moved > 1) fail(`/kit @${width}: the replay controls move by ${Math.round(moved)} px as the envelope seals and opens (Seal it at ${Math.round(before)}, then ${Math.round(sealed)}, then ${Math.round(opened)})`);
    await context.close();
  }
}
