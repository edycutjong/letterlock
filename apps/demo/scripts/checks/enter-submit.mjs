// Typing an address and pressing Enter is the natural way to use a one-field form. It must do what the page's
// button does (on these example pages: say that nothing is connected yet), never reload the page, and never
// throw away what was typed.
import { openPage } from "./_lib.mjs";

export const name = "enter-submit";
export const about = "Enter in a form runs the page's action in place: no reload, nothing typed is lost";

const ADDRESS = "0x4ccacf6625c9290a533d71998a33b24cfe85fa30";

export async function run({ browser, base, routes, fail }) {
  if (routes.includes("/register")) {
    const { page, context } = await openPage(browser, base, "/register");
    let navigations = 0;
    page.on("framenavigated", (f) => f === page.mainFrame() && navigations++);
    const input = page.locator('form[role="search"] input[name="q"]');
    await input.fill(ADDRESS);
    await input.press("Enter");
    await page.waitForTimeout(500);
    if (navigations || !page.url().endsWith("/register")) fail(`/register: Enter in the lookup field navigated to ${page.url()}`);
    if ((await input.inputValue()) !== ADDRESS) fail(`/register: Enter in the lookup field cleared it`);
    const said = await page.locator('form[role="search"] [role="status"]').innerText();
    if (!/Not connected yet/.test(said)) fail(`/register: Enter in the lookup field did not run the lookup action (status: "${said}")`);
    await context.close();
  }
  if (routes.includes("/seal")) {
    const { page, context } = await openPage(browser, base, "/seal");
    let navigations = 0;
    page.on("framenavigated", (f) => f === page.mainFrame() && navigations++);
    const note = page.locator("main form textarea");
    await note.fill("An edited note.");
    const to = page.locator('main form input[name="to"]');
    await to.press("End");
    await to.press("Enter");
    await page.waitForTimeout(500);
    if (navigations || !page.url().endsWith("/seal")) fail(`/seal: Enter in the To field navigated to ${page.url()}`);
    if ((await note.inputValue()) !== "An edited note.") fail(`/seal: Enter in the To field threw away the edited note`);
    const said = await page.locator("main form [role=status]").allInnerTexts();
    if (!said.some((s) => /Not connected yet/.test(s))) fail(`/seal: Enter in the To field did not run the seal action (status: ${JSON.stringify(said)})`);
    await context.close();
  }
}
