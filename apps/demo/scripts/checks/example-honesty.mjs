// Until the pages are wired to the SDK and the chain they show examples, and every example must say so where it is
// shown. No caption may claim a passkey was used, a lookup ran or an envelope was sent when none was.
import { openPage } from "./_lib.mjs";

export const name = "example-honesty";
export const about = "example content is stamped where it is shown, and no caption claims an action that did not happen";

const BADGE = '[class*="ExampleBadge_badge__"]';

const CASES = [
  {
    route: "/open",
    scope: 'section[aria-labelledby="reader-title"]',
    stamped: true,
    claims: [/with your passkey/i, /opened on this device/i],
    what: "the opened letter",
  },
  {
    // the sheet itself, not only the caption: below 960 px the letter comes before the intro note and the caption
    route: "/open",
    scope: 'section[aria-labelledby="reader-title"] figure [class*="Envelope_note__"]',
    stamped: true,
    claims: [],
    what: "the opened letter's sheet",
  },
  {
    route: "/seal",
    scope: 'tr[data-state="found"]',
    stamped: true,
    claims: [],
    what: "the register line on the seal page",
  },
  {
    route: "/seal",
    scope: "main",
    stamped: true,
    claims: [/\bkeyOf found\b/i, /\bas sent\b/i],
    what: "the seal page",
  },
];

export async function run({ browser, base, routes, fail }) {
  for (const route of [...new Set(CASES.map((c) => c.route))]) {
    if (!routes.includes(route)) continue;
    const { page, context } = await openPage(browser, base, route, { width: 1280 });
    for (const c of CASES.filter((c) => c.route === route)) {
      const got = await page.evaluate(
        ({ scope, BADGE }) => {
          const el = document.querySelector(scope);
          if (!el) return null;
          const badge = [...el.querySelectorAll(BADGE)].some((b) => b.getClientRects().length > 0 && /example/i.test(b.textContent));
          return { badge, text: el.innerText };
        },
        { scope: c.scope, BADGE },
      );
      if (!got) {
        fail(`${route}: nothing matches ${c.scope}`);
        continue;
      }
      if (c.stamped && !got.badge) fail(`${route}: ${c.what} shows example content without an Example stamp`);
      for (const re of c.claims) {
        const m = got.text.match(re);
        if (m) fail(`${route}: ${c.what} claims "${m[0]}" on example content`);
      }
    }
    await context.close();
  }
}
