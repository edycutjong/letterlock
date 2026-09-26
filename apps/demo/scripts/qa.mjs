// Visual and accessibility QA of the production build, written to qa/ (git-ignored):
//   - a full-page and an above-the-fold screenshot of every route at 1280, 1024 (iPad landscape), 820 (iPad Air
//     portrait), 768 (iPad and iPad mini portrait) and 390 (phone) px;
//   - axe-core on every route at 1280 and 390 px (fails on any serious or critical violation);
//   - no horizontal overflow at any width;
//   - the colour law, measured in the browser: no element outside the wax (the seal, the wordmark's "lock") may
//     paint text, background, border, outline, fill or stroke in a wax colour;
//   - frames of the seal-and-open replay on /kit, and the reduced-motion path (the seal state changes at once);
//   - each route's HTML with its CSS inlined, for linting;
//   - the layout and behaviour checks in scripts/checks/ (one file per check; each names what it guards).
//
//   pnpm build && node scripts/qa.mjs [--port 3217] [--only /kit] [--check header-fit,hover-feedback] [--fast]
//   --check runs only the named checks (and loads only the pages they need); --fast skips screenshots and axe.
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { installHelpers } from "./checks/_lib.mjs";

const here = join(import.meta.dirname, "..");
const out = join(here, "qa");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("--port") ?? 3217);
const only = arg("--only");
const base = `http://127.0.0.1:${port}`;
const selected = arg("--check")?.split(",").filter(Boolean);
// the page-level QA (screenshots, axe, overflow, colour law, replay) runs unless only named checks were asked for
const full = !selected;
const captures = full && !process.argv.includes("--fast");

const ROUTES = ["/", "/seal", "/open", "/register", "/judge", "/kit"].filter((r) => !only || r === only);
const WIDTHS = [
  { w: 1280, h: 800 },
  { w: 1024, h: 768 },
  { w: 820, h: 1180 },
  { w: 768, h: 1024 },
  { w: 390, h: 844 },
];

const checksDir = join(import.meta.dirname, "checks");
const CHECKS = [];
for (const f of readdirSync(checksDir).filter((f) => f.endsWith(".mjs") && !f.startsWith("_")).sort()) {
  const check = await import(join(checksDir, f));
  if (!selected || selected.includes(check.name)) CHECKS.push(check);
}
if (selected && CHECKS.length !== selected.length) {
  console.error(`unknown check in --check ${selected.join(",")}; known: ${readdirSync(checksDir).filter((f) => !f.startsWith("_")).map((f) => f.replace(/\.mjs$/, "")).join(", ")}`);
  process.exit(2);
}
const slug = (r) => (r === "/" ? "home" : r.slice(1));
mkdirSync(join(out, "html"), { recursive: true });

// A server already answering on the port (an earlier `next start`, possibly of an older build) would be checked in
// place of this build, and a build replaced under a running server serves pages whose stylesheets no longer exist.
try {
  await fetch(base, { signal: AbortSignal.timeout(1500) });
  console.error(`something already answers on ${base}: stop it, or pass --port to check this build on a free port`);
  process.exit(2);
} catch {
  // nothing there: start this build's server below
}

const server = spawn(join(here, "node_modules/.bin/next"), ["start", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: here,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const waitForServer = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start:\n${serverLog}`);
};

const report = { base, routes: {}, replay: [], reducedMotion: null, checks: {}, failures: [] };
const fail = (msg) => {
  report.failures.push(msg);
  console.log(`FAIL ${msg}`);
};

// runs in the page: every painted colour outside [data-wax] that equals a wax colour
const colourLawScan = () => {
  const WAX = ["rgb(163, 38, 30)", "rgb(122, 27, 21)", "rgb(196, 72, 60)"];
  const props = ["color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "outlineColor", "fill", "stroke", "textDecorationColor", "caretColor"];
  const hits = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("[data-wax]")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    for (const p of props) {
      const v = cs[p];
      if (WAX.some((w) => v.includes(w))) {
        // borders and outlines only count where they are drawn
        if (/^border(\w+)Color$/.test(p) && parseFloat(cs[p.replace("Color", "Width")]) === 0) continue;
        if (p === "outlineColor" && cs.outlineStyle === "none") continue;
        if (p === "textDecorationColor" && cs.textDecorationLine === "none") continue;
        if (p === "caretColor" && !el.matches("input, textarea, [contenteditable]")) continue;
        hits.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className?.baseVal ?? el.className).split(" ")[0]} ${p}=${v}`);
      }
    }
    for (const ps of ["::before", "::after"]) {
      const pc = getComputedStyle(el, ps);
      if (pc.content === "none" || pc.content === "normal") continue;
      for (const p of ["color", "backgroundColor", "borderTopColor"]) if (WAX.some((w) => pc[p].includes(w))) hits.push(`${el.tagName.toLowerCase()}${ps} ${p}=${pc[p]}`);
    }
  }
  return hits;
};

const inlineCss = async (html) => {
  const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
  for (const [tag, href] of links) {
    const css = await (await fetch(new URL(href, base))).text();
    html = html.replace(tag, `<style data-href="${href}">${css}</style>`);
  }
  return html;
};

try {
  await waitForServer();
  const browser = await chromium.launch();

  const pageChecks = CHECKS.filter((c) => c.page);
  for (const c of CHECKS) report.checks[c.name] = { about: c.about, failures: 0 };
  const checkFail = (c, msg) => {
    report.checks[c.name].failures++;
    fail(`${c.name}: ${msg}`);
  };

  for (const route of full || pageChecks.length ? ROUTES : []) {
    const r = (report.routes[route] = { screenshots: [], overflow: [], axe: {}, colourLaw: [], fonts: null });
    for (const { w, h } of WIDTHS) {
      const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(base + route, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await installHelpers(page);

      for (const c of pageChecks) await c.page(page, { route, width: w, height: h, fail: (m) => checkFail(c, `${route} @${w}: ${m}`) });
      if (!full) {
        await context.close();
        continue;
      }

      const name = `${slug(route)}-${w}`;
      if (captures) {
        await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
        await page.screenshot({ path: join(out, `${name}-fold.png`) });
        r.screenshots.push(`qa/${name}.png`, `qa/${name}-fold.png`);
      }

      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      if (overflow.scroll > overflow.client) {
        r.overflow.push({ width: w, ...overflow });
        fail(`${route} @${w}: horizontal overflow ${overflow.scroll} > ${overflow.client}`);
      }

      const law = await page.evaluate(colourLawScan);
      for (const hit of law) fail(`${route} @${w}: colour law: ${hit}`);
      r.colourLaw.push(...law.map((x) => `@${w} ${x}`));

      if (errors.length) fail(`${route} @${w}: console errors: ${errors.join(" | ")}`);

      if (captures && (w === 1280 || w === 390)) {
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
        const byImpact = {};
        for (const v of axe.violations) byImpact[v.impact] = [...(byImpact[v.impact] ?? []), `${v.id} (${v.nodes.length})`];
        r.axe[w] = { violations: axe.violations.length, passes: axe.passes.length, byImpact };
        for (const v of axe.violations)
          if (v.impact === "serious" || v.impact === "critical")
            fail(`${route} @${w}: axe ${v.impact} ${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`);
      }

      if (captures && w === 1280) {
        r.fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.style} ${f.weight}`));
        writeFileSync(join(out, "html", `${slug(route)}.html`), await inlineCss(await page.content()));
      }
      await context.close();
    }
    if (full) console.log(`${route}: ${r.screenshots.length} screenshots · axe ${JSON.stringify(r.axe)} · overflow ${r.overflow.length} · colour law ${r.colourLaw.length}`);
  }

  for (const c of CHECKS.filter((c) => c.run)) await c.run({ browser, base, routes: ROUTES, fail: (m) => checkFail(c, m) });
  for (const c of CHECKS) console.log(`check ${c.name}: ${report.checks[c.name].failures === 0 ? "pass" : `${report.checks[c.name].failures} failure(s)`}`);

  if (full && (!only || only === "/kit")) {
    // the seal-and-open replay, frame by frame, and the same controls with reduced motion
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(base + "/kit#envelope", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const stage = page.locator("figure", { has: page.getByRole("button", { name: "Seal it" }) }).first();
    await stage.scrollIntoViewIfNeeded();
    const shoot = async (tag, ms) => {
      const file = `qa/replay-${tag}-${String(ms).padStart(4, "0")}.png`;
      await stage.screenshot({ path: join(here, file) });
      report.replay.push(file);
    };
    await page.getByRole("button", { name: "Seal it" }).click();
    let t0 = Date.now();
    for (const ms of [120, 360, 600, 900, 1100, 1500]) {
      await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
      await shoot("seal", ms);
    }
    await page.getByRole("status").filter({ hasText: "Sealed." }).waitFor({ timeout: 4000 });
    await page.getByRole("button", { name: "Open it" }).click();
    t0 = Date.now();
    for (const ms of [150, 400, 700, 900, 1150, 1500]) {
      await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
      await shoot("open", ms);
    }
    await page.getByRole("status").filter({ hasText: "Opened." }).waitFor({ timeout: 4000 });
    await context.close();

    const reduced = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const rp = await reduced.newPage();
    await rp.goto(base + "/kit#wax-seal", { waitUntil: "networkidle" });
    await rp.getByRole("button", { name: "Press", exact: true }).click();
    await rp.waitForTimeout(60);
    const afterPress = await rp.locator('[class*="sealReplaySeal"] svg').getAttribute("data-state");
    await rp.getByRole("button", { name: "Crack", exact: true }).click();
    await rp.waitForTimeout(60);
    const afterCrack = await rp.locator('[class*="sealReplaySeal"] svg').getAttribute("data-state");
    const running = await rp.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest?.("[data-wax]:not([data-frozen])")).length);
    report.reducedMotion = { afterPress, afterCrack, runningSealAnimations: running };
    if (afterPress !== "pressed" || afterCrack !== "cracked" || running !== 0) fail(`reduced motion: ${JSON.stringify(report.reducedMotion)}`);
    console.log(`reduced motion: ${JSON.stringify(report.reducedMotion)}`);
    await reduced.close();
  }

  await browser.close();
} finally {
  server.kill();
}

writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.failures.length === 0 ? "PASS" : `FAIL (${report.failures.length})`} — report in qa/report.json`);
process.exit(report.failures.length === 0 ? 0 : 1);
