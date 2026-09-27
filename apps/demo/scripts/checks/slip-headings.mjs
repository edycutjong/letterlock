// A returned-to-sender slip that sits directly under the page's h1 (no h2 between) must carry an h2, or the outline
// skips a level (axe heading-order). The page-level axe run never shows a slip, so this brings the slips about the way
// a person would: a recipient without a key on /seal and /register, and the RPCs cut off on /, /seal and /register.
import AxeBuilder from "@axe-core/playwright";
import { KNOWN_ADDRESS } from "./_lib.mjs";

export const name = "slip-headings";
export const about = "every slip a page shows under its h1 keeps the heading order (axe heading-order), at 1280 and 390 px";

const NO_KEY = "0x0000000000000000000000000000000000000001";
const RPC = /rpc1?\.monad\.xyz|testnet-rpc\.monad\.xyz/;

const STATES = [
  { what: "/seal, a recipient without a key", route: `/seal?to=${NO_KEY}`, code: "NO_KEY_PUBLISHED" },
  { what: "/seal, the RPCs cut off", route: `/seal?to=${KNOWN_ADDRESS}`, code: "CHAIN_UNAVAILABLE", cut: true },
  { what: "/register, a lookup of an address without a key", route: "/register", code: "NO_KEY_PUBLISHED", lookup: NO_KEY },
  { what: "/register, the RPCs cut off", route: "/register", code: "CHAIN_UNAVAILABLE", cut: true },
  { what: "/, the RPCs cut off", route: "/", cut: true, optional: true },
];

export async function run({ browser, base, routes, fail }) {
  for (const s of STATES) {
    if (!routes.includes(s.route.split("?")[0])) continue;
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      if (s.cut) await context.route(RPC, (r) => r.abort());
      const page = await context.newPage();
      await page.goto(base + s.route, { waitUntil: "domcontentloaded" });
      if (s.lookup) {
        await page.locator('form[role="search"] input[name="q"]').fill(s.lookup);
        await page.locator('form[role="search"] input[name="q"]').press("Enter");
      }
      const sel = s.code ? `[data-code="${s.code}"]` : "[data-code]";
      const shown = await page.locator(sel).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
      if (!shown) {
        // the home page on a host that is not the passkey's shows no register state to fail: nothing to check there
        if (!s.optional) fail(`${s.what} @${width}: no ${s.code} slip appeared`);
        await context.close();
        continue;
      }
      const { violations } = await new AxeBuilder({ page }).withRules(["heading-order"]).analyze();
      if (violations.length) {
        const levels = await page.evaluate(() => [...document.querySelectorAll("main h1, main h2, main h3, main h4")].map((h) => h.tagName).join(" "));
        fail(`${s.what} @${width}: axe heading-order (${levels})`);
      }
      await context.close();
    }
  }
}
