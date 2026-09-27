// A component's own rule must beat the shared utility class it is combined with (.label-caps, .data), whatever
// order the build happens to emit the stylesheets in. Each case below is a component rule that restyles a utility
// class; the computed value must be the component's.
import { lookUpKnown, openPage, registerRead } from "./_lib.mjs";

export const name = "module-overrides";
export const about = "component rules win over the shared utility classes they restyle";

const INK = "rgb(30, 27, 22)";
const BLUE = "rgb(47, 93, 158)";
const PENCIL = "rgb(110, 101, 86)";

const CASES = [
  { route: "/register", sel: 'tr[data-state="found"] [class*="RegisterTable_found__"]', want: { color: BLUE, fontSize: "11px" }, what: "register: the found line's label is inked blue at 11 px" },
  { route: "/seal", sel: 'tr[data-state="found"] [class*="RegisterTable_found__"]', want: { color: BLUE, fontSize: "11px" }, what: "seal: the found line's label is inked blue at 11 px" },
  { route: "/kit", sel: 'tr[data-state="superseded"] [class*="RegisterTable_superseded__"]', want: { color: PENCIL, fontSize: "11px" }, what: "register: the superseded label is pencil at 11 px, like the found label" },
  { route: "/kit", sel: '[class*="ErrorSlip_todo__"]', want: { color: INK }, what: "ErrorSlip: 'What to do' is ink" },
  { route: "/judge", sel: '[class*="judge_markLabel__"]', want: { fontSize: "11px" }, what: "judge: the tick labels are 11 px" },
  { route: "/", sel: '[class*="AddressCard_full__"]', want: { fontSize: "14px" }, what: "AddressCard: the full address is 14 px" },
  { route: "/", sel: '[class*="SiteFooter_addr__"]', want: { fontSize: "14px" }, what: "footer: the directory address is 14 px" },
  // the epoch column is centred, head and numbers alike (.table td, a later and heavier rule, set the numbers left)
  ...["/register", "/seal", "/kit"].flatMap((route) => [
    { route, sel: 'th[class*="RegisterTable_colEpoch__"]', want: { textAlign: "center" }, what: "register: the epoch head is centred" },
    { route, sel: 'td[class*="RegisterTable_epoch__"]', want: { textAlign: "center" }, what: "register: the epoch numbers are centred under their head" },
  ]),
];

// the envelope's epoch scales with the envelope: max(9.5px, 2.35cqi), tracked 0.2em, set solid
const envelopeEpoch = () =>
  [...document.querySelectorAll('[class*="Envelope_epoch__"]')].map((el) => {
    const cs = getComputedStyle(el);
    const stage = el.closest('[class*="Envelope_stage__"]').clientWidth;
    const size = Math.max(9.5, 0.0235 * stage);
    return {
      size: parseFloat(cs.fontSize),
      want: size,
      tracking: parseFloat(cs.letterSpacing),
      wantTracking: 0.2 * size,
      lineHeight: parseFloat(cs.lineHeight),
    };
  });

export async function run({ browser, base, routes, fail }) {
  for (const width of [1280, 390]) {
    for (const route of [...new Set(CASES.map((c) => c.route))]) {
      if (!routes.includes(route)) continue;
      const { page, context } = await openPage(browser, base, route, { width });
      // the live pages: the register read, and a line found by keyOf (the found label, the epoch column)
      if (route === "/register") await registerRead(page).catch(() => fail(`@${width} /register: the register was not read`));
      if (route === "/register" || route === "/seal") await lookUpKnown(page, route).catch(() => fail(`@${width} ${route}: the keyOf lookup found no line`));
      for (const c of CASES.filter((c) => c.route === route)) {
        const got = await page.$$eval(c.sel, (els, keys) => els.map((el) => Object.fromEntries(keys.map((k) => [k, getComputedStyle(el)[k]]))), Object.keys(c.want));
        if (!got.length) fail(`@${width} ${c.what}: nothing matches ${c.sel}`);
        for (const g of got)
          for (const [k, v] of Object.entries(c.want)) if (g[k] !== v) fail(`@${width} ${c.what}: ${k} is ${g[k]}, want ${v}`);
      }
      if (route === "/open" || route === "/seal")
        for (const e of await page.evaluate(envelopeEpoch)) {
          if (Math.abs(e.size - e.want) > 0.3) fail(`@${width} ${route} envelope epoch: ${e.size}px, want ${e.want.toFixed(2)}px (2.35% of the envelope)`);
          if (Math.abs(e.tracking - e.wantTracking) > 0.1) fail(`@${width} ${route} envelope epoch tracking ${e.tracking}px, want ${e.wantTracking.toFixed(2)}px`);
          if (Math.abs(e.lineHeight - e.size) > 0.3) fail(`@${width} ${route} envelope epoch line height ${e.lineHeight}px, want ${e.size}px`);
        }
      await context.close();
    }
  }
}
