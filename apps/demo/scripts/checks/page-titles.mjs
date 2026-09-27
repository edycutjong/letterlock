// Every page names itself in the browser tab, the history and to a screen reader (WCAG 2.4.2): each route's title
// is its own, and an address with no page says so instead of carrying the home page's title.
import { openPage } from "./_lib.mjs";

export const name = "page-titles";
export const about = "every route has its own title, and the missing-page title says the page is missing";

export async function run({ browser, base, routes, fail }) {
  const seen = new Map();
  for (const route of [...routes, "/no-page-at-this-address"]) {
    const { page, context } = await openPage(browser, base, route, { width: 1280 });
    const title = await page.title();
    const heading = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ").trim();
    await context.close();
    if (!title) fail(`${route}: no title`);
    if (seen.has(title)) fail(`${route}: has the same title as ${seen.get(title)} ("${title}")`);
    seen.set(title, route);
    if (route.startsWith("/no-page") && !/no page/i.test(title)) fail(`a missing page is titled "${title}", while its heading says "${heading}"`);
  }
}
