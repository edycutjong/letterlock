// The inbox's open letter and its cracked seal are the demo's last beat. On a laptop, an iPad either way up and a
// phone the whole seal must be in the first screen without scrolling, with room left for browser chrome: the
// heights below are what a browser leaves of the screen (Safari's bars on an iPhone take 185 px of 844-852).
import { openPage } from "./_lib.mjs";

export const name = "open-fold";
export const about = "on laptops, iPads and phones the opened letter's cracked seal is fully in the first screen";

const VIEWPORTS = [
  { width: 1024, height: 700 }, // iPad landscape, Safari
  { width: 1180, height: 750 }, // iPad Air landscape
  { width: 1280, height: 712 }, // 13-inch laptop, browser toolbar
  { width: 1366, height: 680 },
  { width: 1440, height: 812 },
  { width: 1920, height: 960 },
  { width: 768, height: 954 }, // iPad and iPad mini portrait, Safari
  { width: 820, height: 1106 }, // iPad Air portrait
  { width: 393, height: 659 }, // iPhone 15, Safari
  { width: 390, height: 664 }, // iPhone 13 and 14
  { width: 375, height: 629 }, // iPhone 13 mini
  { width: 412, height: 839 }, // Pixel 7, Chrome
  { width: 360, height: 640 }, // small Android, Chrome
];

export async function run({ browser, base, routes, fail }) {
  if (!routes.includes("/open")) return;
  for (const vp of VIEWPORTS) {
    const { page, context } = await openPage(browser, base, "/open", vp);
    const r = await page.evaluate(() => {
      const seal = document.querySelector('section[aria-labelledby="reader-title"] [data-wax]').getBoundingClientRect();
      return { top: seal.top, bottom: seal.bottom, fold: window.innerHeight };
    });
    if (r.bottom > r.fold) {
      const seen = Math.max(0, Math.min(r.bottom, r.fold) - r.top) / (r.bottom - r.top);
      fail(`/open ${vp.width}×${vp.height}: the cracked seal ends at ${Math.round(r.bottom)}px, below the fold at ${r.fold}px (${Math.round(seen * 100)}% visible)`);
    }
    await context.close();
  }
}
