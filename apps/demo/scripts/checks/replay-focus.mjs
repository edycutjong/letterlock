// The kit's replay controls stop applying as the replay moves on (Seal it once the letter is going in, Open it once
// it is open, Crack once the seal is broken). A control pressed from the keyboard must keep the focus when that
// happens: a disabled button drops it to the page, the focus ring vanishes, and the next Tab starts again from the
// top. A control that does not apply is announced as unavailable and does nothing when pressed.
import { openPage } from "./_lib.mjs";

export const name = "replay-focus";
export const about = "a replay control pressed from the keyboard keeps the focus when it stops applying, and does nothing while it does not apply";

const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return !a || a === document.body ? "the page" : `"${a.textContent.trim()}"`;
  });

export async function run({ browser, base, routes, fail }) {
  if (!routes.includes("/kit")) return;
  const { page, context } = await openPage(browser, base, "/kit", { width: 1280 });
  const button = (label) => page.getByRole("button", { name: label, exact: true });
  const status = (text) => page.getByRole("status").filter({ hasText: text });

  // [control, key, what the replay says once it has settled]
  const steps = [
    ["Seal it", "Enter", "Sealed."],
    ["Open it", "Space", "Opened."],
    ["Start over", "Enter", null],
    ["Crack", "Space", null],
  ];
  for (const [label, key, settled] of steps) {
    await button(label).focus();
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
    const now = await focused(page);
    if (now !== `"${label}"`) fail(`/kit: pressing "${label}" with ${key} moves the focus to ${now}`);
    if (settled) await status(settled).waitFor({ timeout: 5000 });
    else await page.waitForTimeout(900);
    const later = await focused(page);
    if (later !== `"${label}"` && now === `"${label}"`) fail(`/kit: after "${label}" settles the focus is on ${later}`);
  }

  // after sealing, the next Tab from "Seal it" reaches "Open it"
  await button("Seal it").focus();
  await page.keyboard.press("Enter");
  await status("Sealed.").waitFor({ timeout: 5000 });
  await page.keyboard.press("Tab");
  const next = await focused(page);
  if (next !== '"Open it"') fail(`/kit: after "Sealed.", Tab from "Seal it" reaches ${next}, not "Open it"`);

  // a control that does not apply is announced so, and pressing it changes nothing
  const unavailable = await button("Seal it").evaluate((b) => b.disabled || b.getAttribute("aria-disabled") === "true");
  if (!unavailable) fail(`/kit: "Seal it" does not say it is unavailable while the envelope is sealed`);
  await button("Seal it").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  if (!(await status("Sealed.").count())) fail(`/kit: pressing "Seal it" while the envelope is sealed changed the replay`);
  await context.close();
}
