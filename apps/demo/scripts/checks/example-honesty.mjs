// The pages are live: an Example stamp may stand only on what is genuinely an example, and nothing real may carry one.
//   - the home page, before this device has an address, shows what the card will look like: that card is stamped,
//     says it is not on chain, and links no transaction;
//   - the kit is a gallery of examples (its real smoke-test lines say so in words) and says so under its title;
//   - /seal, /open, /register and /judge show only what the chain and this device hold: no stamp at all, the register
//     checked after its first read and a keyOf lookup.
import { lookUpKnown, openPage, registerRead } from "./_lib.mjs";

export const name = "example-honesty";
export const about = "Example stamps stand on examples only: the home page's sample card and the kit; the live pages carry none";

const BADGE = '[class*="ExampleBadge_badge__"]';
const visibleBadges = ({ scope, BADGE }) => [...document.querySelectorAll(`${scope} ${BADGE}`)].filter((b) => b.getClientRects().length > 0 && /example/i.test(b.textContent)).length;

export async function run({ browser, base, routes, fail }) {
  if (routes.includes("/")) {
    const { page, context } = await openPage(browser, base, "/", { width: 1280 });
    const card = await page.evaluate((BADGE) => {
      const el = document.querySelector("article[data-example]");
      if (!el) return null;
      return {
        stamped: [...el.querySelectorAll(BADGE)].some((b) => b.getClientRects().length > 0),
        links: el.querySelectorAll("a[href*='/tx/']").length,
        text: el.innerText,
        note: document.querySelector("main")?.innerText.includes("not on chain") ?? false,
      };
    }, BADGE);
    if (!card) fail("/: no sample card before this device has an address");
    else {
      if (!card.stamped) fail("/: the sample card carries no Example stamp");
      if (card.links) fail("/: the sample card links a transaction");
      if (!/Not posted/.test(card.text)) fail("/: the sample card does not say it is not posted");
      if (!card.note) fail("/: nothing says the sample card is not on chain");
    }
    await context.close();
  }
  if (routes.includes("/kit")) {
    const { page, context } = await openPage(browser, base, "/kit", { width: 1280 });
    if (!(await page.evaluate(visibleBadges, { scope: 'main header[class*="PageHead_head__"]', BADGE }))) fail("/kit: the gallery does not say under its title that it shows examples");
    await context.close();
  }
  for (const route of ["/seal", "/open", "/register", "/judge"]) {
    if (!routes.includes(route)) continue;
    const { page, context } = await openPage(browser, base, route, { width: 1280 });
    if (route === "/register") {
      await registerRead(page).catch(() => fail("/register: the register was not read"));
      await lookUpKnown(page, route).catch(() => fail("/register: the keyOf lookup found no line"));
    }
    const n = await page.evaluate(visibleBadges, { scope: "main", BADGE });
    if (n) fail(`${route}: ${n} Example stamps on a page that shows only real data`);
    await context.close();
  }
}
