// One version everywhere: the SDK's package.json is the source, and every surface that names the current version
// (the pitch deck's title, cards and slide footers, the npm line on its traction slide, the landing's release link,
// the reference agent's card) is stamped from it. Dated receipts (the landing's "as of 27 September" ledger, a
// replay of a past run) name the version they measured and are not touched.
//
//   node scripts/version-sync.ts            stamp every surface with the package version
//   node scripts/version-sync.ts --check    exit 1, naming each stale stamp, when any surface disagrees (CI runs this)
//
// Every rule must match exactly the number of times it lists: a rule that stops matching (a slide removed, markup
// changed) fails here instead of leaving an old version on the page.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/git.ts";

const V = String.raw`\d+\.\d+\.\d+`;

export type Rule = { readonly file: string; readonly what: string; readonly re: RegExp; readonly count: number };

export const RULES: readonly Rule[] = [
  { file: "site/pitch/index.html", what: "deck title and its two cards", re: new RegExp(`(pitch deck v)(${V})`, "g"), count: 3 },
  { file: "site/pitch/index.html", what: "deck header comment", re: new RegExp(`(Letterlock pitch deck, v)(${V})`, "g"), count: 1 },
  { file: "site/pitch/index.html", what: "deck header comment: git tag", re: new RegExp(`(\\(git tag v)(${V})`, "g"), count: 1 },
  { file: "site/pitch/index.html", what: "deck header comment: npm", re: new RegExp(`(, npm letterlock@)(${V})`, "g"), count: 1 },
  { file: "site/pitch/index.html", what: "slide footers", re: new RegExp(`(<span class="wm">Letter<em>lock</em></span><span>v)(${V})`, "g"), count: 10 },
  { file: "site/pitch/index.html", what: "traction slide: the version on npm", re: new RegExp(`(<b>letterlock@)(${V})(?=</b> on npm)`, "g"), count: 1 },
  { file: "site/index.html", what: "footer release link", re: new RegExp(`(releases/tag/v)(${V})(" data-release>Release v)(${V})`, "g"), count: 1 },
  { file: "examples/agent-memory/public/.well-known/agent-card.json", what: "agent card version", re: new RegExp(`(^  "version": ")(${V})`, "gm"), count: 1 },
];

export const packageVersion = (root = ROOT): string =>
  (JSON.parse(readFileSync(join(root, "packages/letterlock/package.json"), "utf8")) as { version: string }).version;

/** Stamps `version` into `text` by `rule`; returns the new text and the versions it replaced. */
export const stamp = (text: string, rule: Rule, version: string): { text: string; found: string[]; matches: number } => {
  const found: string[] = [];
  let matches = 0;
  const out = text.replace(rule.re, (...m: string[]) => {
    matches++;
    const groups = m.slice(1, -2);
    // groups alternate prefix, version, prefix, version ...
    return groups.map((g, i) => (i % 2 === 1 ? (found.push(g), version) : g)).join("");
  });
  return { text: out, found, matches };
};

export const sync = (check: boolean, root = ROOT): string[] => {
  const version = packageVersion(root);
  const problems: string[] = [];
  const files = new Map<string, string>();
  for (const rule of RULES) {
    const before = files.get(rule.file) ?? readFileSync(join(root, rule.file), "utf8");
    const r = stamp(before, rule, version);
    if (r.matches !== rule.count) problems.push(`${rule.file}: ${rule.what}: ${r.matches} match(es), expected ${rule.count}`);
    const stale = [...new Set(r.found.filter((f) => f !== version))];
    if (check && stale.length) problems.push(`${rule.file}: ${rule.what}: says ${stale.join(", ")}, the package is ${version}`);
    files.set(rule.file, r.text);
  }
  if (!check && problems.length === 0) for (const [file, text] of files) writeFileSync(join(root, file), text);
  return problems;
};

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const problems = sync(check);
  if (problems.length) {
    for (const p of problems) console.error(`version-sync: ${p}`);
    process.exit(1);
  }
  console.log(`version-sync: every surface ${check ? "says" : "now says"} ${packageVersion()}`);
}
