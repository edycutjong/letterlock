// A frame made focusable (tabindex="0") only so a keyboard can scroll it must actually scroll; one that does not is a
// Tab stop with nothing to do. And every frame that does scroll must be reachable by keyboard.
export const name = "tab-stops";
export const about = "tabindex frames are Tab stops only while they scroll; every scrolling frame is reachable";

const scan = () => {
  const NATIVE = "a[href], button, input, select, textarea, summary, iframe, [contenteditable]";
  const scrolls = (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  const hits = [];
  for (const el of document.querySelectorAll('[tabindex]:not([tabindex^="-"])')) {
    if (el.matches(NATIVE) || window.__qa.hiddenByStyle(el)) continue;
    if (!scrolls(el)) hits.push(`${window.__qa.describe(el)} "${el.getAttribute("aria-label") ?? ""}" is a Tab stop but does not scroll`);
  }
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    const canScroll = /auto|scroll/.test(cs.overflowX + cs.overflowY);
    if (!canScroll || !scrolls(el) || window.__qa.hiddenByStyle(el)) continue;
    const reachable = el.tabIndex >= 0 || el.querySelector(NATIVE);
    if (!reachable) hits.push(`${window.__qa.describe(el)} scrolls but no key reaches it`);
  }
  return hits;
};

export async function page(page, { fail }) {
  for (const hit of await page.evaluate(scan)) fail(hit);
}
