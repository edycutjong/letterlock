// Wrapped text keeps a line pitch that suits its own size. Small text that inherits the line box of a larger
// parent (an inline span in a 19 px line) wraps with gaps far wider than its size; flag any run whose lines sit
// more than 1.75 × its font size apart.
export const name = "line-pitch";
export const about = "wrapped text keeps a line pitch of at most 1.75 × its font size";

const MAX = 1.75;

const scan = (MAX) => {
  const hits = [];
  for (const run of window.__qa.textRuns()) {
    const ls = window.__qa.lines(run.rects);
    if (ls.length < 2) continue;
    const size = parseFloat(getComputedStyle(run.el).fontSize);
    const pitches = ls.slice(1).map((l, i) => l.top - ls[i].top);
    const pitch = Math.min(...pitches);
    if (pitch / size > MAX) hits.push(`${window.__qa.describe(run.el)} "${window.__qa.snippet(run.text)}": ${pitch.toFixed(1)}px lines for ${size}px text (${(pitch / size).toFixed(2)})`);
  }
  return hits;
};

export async function page(page, { width, fail }) {
  if (![1280, 820, 390].includes(width)) return;
  for (const hit of await page.evaluate(scan, MAX)) fail(hit);
}
