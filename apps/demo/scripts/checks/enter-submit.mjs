// Typing an address and pressing Enter is the natural way to use a one-field form. It must do what the page's
// button does (look the address up; seal the note), never reload the page, and never throw away what was typed.
// Before the page's script has run, the browser sends the form itself: /register's look-up then lands on
// /register?q=<address>, which must show the same result, with the address still in the field.
import { KNOWN_ADDRESS, openPage } from "./_lib.mjs";

export const name = "enter-submit";
export const about = "Enter in a form runs the page's action in place: no reload, nothing typed is lost (and a look-up sent before the page is ready still runs)";

export async function run({ browser, base, routes, fail }) {
  if (routes.includes("/register")) {
    const { page, context } = await openPage(browser, base, "/register");
    let navigations = 0;
    page.on("framenavigated", (f) => f === page.mainFrame() && navigations++);
    const input = page.locator('form[role="search"] input[name="q"]');
    await input.fill(KNOWN_ADDRESS);
    await input.press("Enter");
    const found = await page.locator('tr[data-state="found"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (navigations || !page.url().endsWith("/register")) fail(`/register: Enter in the lookup field navigated to ${page.url()}`);
    if ((await input.inputValue()) !== KNOWN_ADDRESS) fail(`/register: Enter in the lookup field cleared it`);
    if (!found) fail(`/register: Enter in the lookup field did not run the lookup (no line found for ${KNOWN_ADDRESS})`);
    await context.close();

    // Look up pressed before the page's script ran: the form goes out the browser's way, as GET /register?q=…
    const early = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
    const plain = await early.newPage();
    await plain.goto(base + "/register", { waitUntil: "domcontentloaded" });
    await plain.locator('form[role="search"] input[name="q"]').fill(KNOWN_ADDRESS);
    await Promise.all([plain.waitForURL(/\/register\?q=/, { timeout: 15_000 }).catch(() => {}), plain.locator('form[role="search"] button[type="submit"]').click()]);
    const landed = new URL(plain.url());
    await early.close();
    if (landed.pathname !== "/register" || landed.searchParams.get("q") !== KNOWN_ADDRESS) fail(`/register: the form sent before the page was ready went to ${landed.pathname}${landed.search}`);
    else {
      const { page: after, context: afterContext } = await openPage(browser, base, `${landed.pathname}${landed.search}`);
      const shown = await after.locator('tr[data-state="found"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
      if ((await after.locator('form[role="search"] input[name="q"]').inputValue()) !== KNOWN_ADDRESS) fail(`/register?q=: the field does not hold the address looked up`);
      if (!shown) fail(`/register?q=${KNOWN_ADDRESS}: no result, so a Look up pressed before the page was ready is a silent reload`);
      await afterContext.close();
    }
  }
  if (routes.includes("/seal")) {
    const { page, context } = await openPage(browser, base, "/seal");
    let navigations = 0;
    page.on("framenavigated", (f) => f === page.mainFrame() && navigations++);
    const note = page.locator("main form textarea");
    await note.fill("An edited note.");
    const to = page.locator('main form input[name="to"]');
    await to.fill(KNOWN_ADDRESS);
    await page.locator('tr[data-state="found"]').first().waitFor({ timeout: 30_000 });
    await to.press("End");
    await to.press("Enter");
    const sealed = await page.getByText("Sealed to key").waitFor({ timeout: 20_000 }).then(() => true, () => false);
    if (navigations || !page.url().endsWith("/seal")) fail(`/seal: Enter in the To field navigated to ${page.url()}`);
    if ((await note.inputValue()) !== "An edited note.") fail(`/seal: Enter in the To field threw away the edited note`);
    if (!sealed) fail(`/seal: Enter in the To field did not seal the note`);
    await context.close();
  }
}
