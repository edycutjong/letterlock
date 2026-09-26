// An open envelope folds its flap back above the pocket. The flap must stay inside the envelope's own figure, so it
// never lies over the text above it, whatever the length of the letter standing in front of it; and the letter
// must still stand in the pocket. Checked on every open envelope qa.mjs loads, and on /open with the letter cut to
// one short line (a real decrypted note can be that short).
import { openPage } from "./_lib.mjs";

export const name = "envelope-flap";
export const about = "an open envelope's folded-back flap stays inside its figure; the letter stays in the pocket";

const measure = () =>
  [...document.querySelectorAll('figure[data-flap="open"]')].map((fig) => {
    const f = fig.getBoundingClientRect();
    const flap = fig.querySelector('[class*="Envelope_flap__"]').getBoundingClientRect();
    const body = fig.querySelector('[class*="Envelope_body__"]').getBoundingClientRect();
    const letter = fig.querySelector('[class*="Envelope_letter__"]')?.getBoundingClientRect();
    return {
      label: fig.getAttribute("aria-label") ?? "decorative envelope",
      above: Math.round(f.top - flap.top),
      // how deep the letter sits in the pocket, as a share of the envelope's width
      inPocket: letter ? (letter.bottom - body.top) / body.width : null,
    };
  });

const judge = (rows, fail, where) => {
  for (const r of rows) {
    if (r.above > 1) fail(`${where}: the flap of "${r.label}" rises ${r.above}px above its figure`);
    if (r.inPocket !== null && r.inPocket < 0.2) fail(`${where}: the letter of "${r.label}" is not standing in the pocket (${(r.inPocket * 100).toFixed(1)}% of the width inside)`);
  }
};

export async function page(page, { fail }) {
  judge(await page.evaluate(measure), fail, "as rendered");
}

export async function run({ browser, base, routes, fail }) {
  if (!routes.includes("/open")) return;
  for (const width of [390, 820, 1024, 1280]) {
    const { page, context } = await openPage(browser, base, "/open", { width });
    await page.evaluate(() => {
      const p = document.querySelector('figure[data-flap="open"][data-letter] [class*="Envelope_note__"] p');
      p.textContent = "Your code is 4412.";
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    judge(await page.evaluate(measure), fail, `/open @${width} with a one-line letter`);
    await context.close();
  }
}
