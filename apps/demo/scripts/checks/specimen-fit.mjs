// A component keeps its own size wherever it is laid out: the kit's plates show each one "as the pages use it", and
// a plate as tall as its row must not stretch what it holds. A text input is the 48 px tap height; a register frame
// closes (its double rule) right under its table.
export const name = "specimen-fit";
export const about = "text inputs are 48 px tall and register frames close right under their table, on every page";

const measure = () => {
  const out = [];
  for (const i of document.querySelectorAll('input[class*="Field_input__"]')) {
    const h = i.getBoundingClientRect().height;
    if (h && Math.abs(h - 48) > 0.5) out.push(`the input labelled "${i.labels?.[0]?.textContent.trim() ?? "?"}" is ${h.toFixed(1)}px tall, not 48`);
  }
  for (const f of document.querySelectorAll('[class*="RegisterTable_wrap__"]')) {
    const table = f.querySelector("table").getBoundingClientRect();
    const frame = f.getBoundingClientRect();
    // 3 px of padding and a 1.5 px rule above and below the table
    if (frame.height && frame.height - table.height > 10)
      out.push(`the register frame "${f.querySelector("caption").textContent.trim()}" is ${Math.round(frame.height)}px tall around a ${Math.round(table.height)}px table`);
  }
  return out;
};

export async function page(page, { fail }) {
  for (const m of await page.evaluate(measure)) fail(m);
}
