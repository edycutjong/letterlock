// The token sheet's own values, for the few places that must hand a colour over as text rather than as a CSS
// variable: the kit's swatch labels and the browser's theme colour. Read from app/tokens.css when a page is built,
// so they always print what the sheet says. Server-only: it reads a file. The path is taken from the working
// directory, which is this app's folder for next build, next start and the tests alike (the bundler would turn a
// path relative to this module into an asset URL).
import { readFileSync } from "node:fs";
import { join } from "node:path";

let sheet: string | undefined;

/** The value a token is set to in app/tokens.css, e.g. tokenValue("--bg") is the manila stock's hex value. */
export const tokenValue = (name: `--${string}`): string => {
  sheet ??= readFileSync(join(process.cwd(), "app", "tokens.css"), "utf8");
  const m = sheet.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  if (!m?.[1]) throw new Error(`no ${name} in app/tokens.css`);
  return m[1].trim();
};
