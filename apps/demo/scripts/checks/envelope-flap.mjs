// An open envelope folds its flap back above the pocket. The flap must stay inside the envelope's own figure, so it
// never lies over the text above it, whatever the length of the letter standing in front of it, while it rests and
// while it swings; and the letter must still stand in the pocket. Checked
//   - on every open envelope qa.mjs loads, and on /seal (the letter being written stands in the open envelope) with
//     the letter cut to one short line (a real note can be that short);
//   - frame by frame through the swing: every transition in the figure is paused and stepped from 0 to 900 ms, in
//     the kit's replay (sealed and opened with its own buttons), and on the /seal letter and a letterless kit
//     envelope switched the way the component switches them (the letter is mounted as the flap opens and kept while
//     it closes). At each step the flap is also drawn in the right order: in front of the letter once it lies over
//     the pocket, behind it while it is folded back and the letter stands out. (/open shows a letter only once a
//     passkey has opened it; it is the same component.)
import { openPage } from "./_lib.mjs";

export const name = "envelope-flap";
export const about = "an envelope's flap stays inside its figure at rest and all through its swing; the letter stays in the pocket";

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

/**
 * Runs in the page. Pauses every transition running in `figure` and steps them together from 0 to 900 ms, measuring
 * how far the flap (both faces) and the letter stand above the figure's top at each step; then lets them finish.
 */
const STEP = () => {
  window.__scrub = (figure) => {
    const anims = document.getAnimations().filter((a) => {
      const t = a.effect?.target;
      return t instanceof Element && (t === figure || figure.contains(t));
    });
    for (const a of anims) a.pause();
    const worst = { flap: { by: -Infinity, at: 0 }, letter: { by: -Infinity, at: 0 } };
    const layering = [];
    const flapEl = figure.querySelector('[class*="Envelope_flap__"]');
    const row = figure.querySelector('[class*="Envelope_letterRow__"]');
    for (let t = 0; t <= 900; t += 10) {
      for (const a of anims) a.currentTime = t;
      const top = figure.getBoundingClientRect().top;
      const flap = Math.min(...[...flapEl.querySelectorAll("svg")].map((s) => s.getBoundingClientRect().top));
      if (top - flap > worst.flap.by) worst.flap = { by: top - flap, at: t };
      const letter = figure.querySelector('[class*="Envelope_letter__"]');
      if (letter && top - letter.getBoundingClientRect().top > worst.letter.by) worst.letter = { by: top - letter.getBoundingClientRect().top, at: t };
      // painting order: a flap over the pocket (its tip below the hinge: cos a > 0, the transform's m22) is drawn in
      // front of the letter; a flap folded back is drawn behind a letter that stands out of the pocket
      if (letter && row) {
        const m = getComputedStyle(flapEl).transform.match(/matrix3d\(([^)]+)\)/);
        const cos = m ? parseFloat(m[1].split(",")[5]) : 1;
        const zFlap = Number(getComputedStyle(flapEl).zIndex);
        const zLetter = Number(getComputedStyle(row).zIndex);
        const out = row.getBoundingClientRect().height > 1;
        if (cos > 0.05 && zFlap < zLetter) layering.push(`${t} ms: the flap lies over the pocket but is drawn behind the letter`);
        if (cos < -0.05 && out && zFlap > zLetter) layering.push(`${t} ms: the flap is folded back but is drawn over the letter standing out`);
      }
    }
    for (const a of anims) a.finish();
    return { transitions: anims.map((a) => a.transitionProperty ?? a.animationName).sort(), worst, layering };
  };
};

const judgeSwing = (r, fail, where) => {
  if (!r.transitions.length) return fail(`${where}: nothing moved (no transition ran in the figure)`);
  if (r.worst.flap.by > 1) fail(`${where}: the flap stands ${Math.round(r.worst.flap.by)}px above its figure at ${r.worst.flap.at} ms`);
  if (r.worst.letter.by > 1) fail(`${where}: the letter stands ${Math.round(r.worst.letter.by)}px above its figure at ${r.worst.letter.at} ms`);
  if (r.layering.length) fail(`${where}: ${r.layering[0]}${r.layering.length > 1 ? ` (and ${r.layering.length - 1} more steps, to ${r.layering.at(-1).split(" ")[0]} ms)` : ""}`);
};

/** The kit's replay, driven by its own buttons: React switches the flap, and the swing is stepped from that moment. */
async function replay(page, fail, width) {
  const press = (label, flapTo) =>
    page.evaluate(
      ({ label, flapTo }) =>
        new Promise((resolve) => {
          const figure = document.querySelector('[class*="replayStage"] figure');
          const mo = new MutationObserver(() => {
            if (figure.dataset.flap !== flapTo) return;
            mo.disconnect();
            resolve(window.__scrub(figure));
          });
          mo.observe(figure, { attributes: true, attributeFilter: ["data-flap"] });
          [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label).click();
        }),
      { label, flapTo },
    );
  judgeSwing(await press("Seal it", "closed"), fail, `/kit @${width} replay, sealing`);
  await page.getByRole("status").filter({ hasText: "Sealed." }).waitFor({ timeout: 5000 });
  judgeSwing(await press("Open it", "open"), fail, `/kit @${width} replay, opening`);
}

/**
 * Switches a rendered envelope the way the component does, then steps the swing. `opening`: from sealed (flap down,
 * no letter) to opened (the letter mounted as the flap opens); otherwise from open to closed with the letter kept.
 */
const SWITCH = ({ sel, opening, text }) => {
  const figure = document.querySelector(sel);
  // the element React mounts for the letter (inside the letter's track, or the track itself in older markup)
  const holder = figure.querySelector('[class*="Envelope_letterSlot__"]') ?? figure.querySelector('[class*="Envelope_letterRow__"]');
  const hasLetter = figure.hasAttribute("data-letter") && holder;
  if (text && hasLetter) holder.querySelector('[class*="Envelope_note__"] p').textContent = text;
  const quiet = (on) => {
    for (const el of [figure, ...figure.querySelectorAll("*")]) el.style.transition = on ? "none" : "";
    figure.getBoundingClientRect();
  };
  const set = (flap, letter) => {
    figure.dataset.flap = flap;
    if (!hasLetter) return;
    if (letter) {
      figure.dataset.letter = "";
      if (!holder.isConnected) window.__holderParent.insertBefore(holder, window.__holderNext);
    } else {
      delete figure.dataset.letter;
      window.__holderParent = holder.parentElement;
      window.__holderNext = holder.nextSibling;
      holder.remove();
    }
  };
  // the starting state, set with transitions off and flushed before they are back on
  quiet(true);
  if (opening) set("closed", false);
  else set("open", true);
  figure.getBoundingClientRect();
  quiet(false);
  if (opening) set("open", true);
  else set("closed", true);
  return window.__scrub(figure);
};

export async function page(page, { fail }) {
  judge(await page.evaluate(measure), fail, "as rendered");
}

export async function run({ browser, base, routes, fail }) {
  if (routes.includes("/seal")) {
    for (const width of [390, 820, 1024, 1280]) {
      const { page, context } = await openPage(browser, base, "/seal", { width });
      await page.evaluate(() => {
        const p = document.querySelector('figure[data-flap="open"][data-letter] [class*="Envelope_note__"] p');
        p.textContent = "Your code is 4412.";
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      judge(await page.evaluate(measure), fail, `/seal @${width} with a one-line letter`);
      await context.close();
    }

    const reader = 'section[aria-labelledby="sealed-title"] figure';
    for (const width of [390, 820, 1280])
      for (const text of [undefined, "Your code is 4412."])
        for (const opening of [true, false]) {
          const { page, context } = await openPage(browser, base, "/seal", { width });
          await page.evaluate(STEP);
          const where = `/seal @${width} letter${text ? " (one line)" : ""}, ${opening ? "opening" : "closing"}`;
          judgeSwing(await page.evaluate(SWITCH, { sel: reader, opening, text }), fail, where);
          await context.close();
        }
  }

  if (routes.includes("/kit")) {
    for (const width of [390, 1280]) {
      const { page, context } = await openPage(browser, base, "/kit", { width });
      await page.evaluate(STEP);
      await page.locator('[class*="replayStage"] figure').scrollIntoViewIfNeeded();
      await replay(page, fail, width);
      // a letterless envelope ("closed, sealed"): the flap alone swings open and shut
      await page.evaluate(() => document.querySelector('figure[data-flap="closed"][data-variant="full"]:not([data-letter])').setAttribute("data-probe", ""));
      judgeSwing(await page.evaluate(SWITCH, { sel: "figure[data-probe]", opening: true }), fail, `/kit @${width} letterless envelope, opening`);
      judgeSwing(await page.evaluate(SWITCH, { sel: "figure[data-probe]", opening: false }), fail, `/kit @${width} letterless envelope, closing`);
      await context.close();
    }
  }
}
