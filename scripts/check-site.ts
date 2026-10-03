// The static site (site/: the landing and the deck) as Vercel will serve it, checked before it deploys: every inline
// script is allowed by its sha256 in site/vercel.json's Content-Security-Policy (a script edited without its hash is
// blocked in the browser, silently), and every file the pages name on this site exists. Run by ci.yml's build job.
//
//   node scripts/check-site.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const PAGES = ["index.html", "pitch/index.html"];

type Header = { key: string; value: string };
const config = JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8")) as { headers: { headers: Header[] }[] };
const csp = config.headers.flatMap((r) => r.headers).find((h) => h.key === "Content-Security-Policy")?.value ?? "";
const allowed = new Set([...csp.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]));

const failures: string[] = [];
let scripts = 0;
let files = 0;
for (const page of PAGES) {
  const html = readFileSync(join(SITE, page), "utf8");
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    scripts++;
    const hash = `sha256-${createHash("sha256").update(m[1]!).digest("base64")}`;
    if (!allowed.has(hash)) failures.push(`${page}: an inline script is not in the CSP (${hash})`);
  }
  // href/src naming a file on this site: relative to the page, or from the site's root
  for (const m of html.matchAll(/\b(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
    const ref = m[1]!;
    if (/^(?:[a-z]+:|\/\/)/i.test(ref) || ref.endsWith("/")) continue;
    files++;
    const path = ref.startsWith("/") ? join(SITE, ref) : join(SITE, dirname(page), ref);
    if (!existsSync(path)) failures.push(`${page}: ${ref} does not exist (${path.slice(ROOT.length + 1)})`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`site: ${scripts} inline scripts allowed by hash, ${files} local files present, in ${PAGES.length} pages`);
