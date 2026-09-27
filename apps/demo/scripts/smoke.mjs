// Read-only smoke of a running build: every route loads, carries the security headers and its per-request CSP, and
// logs no console error, page error or CSP violation; /register shows the directory's real KeyPublished lines (the
// deploy smoke test's publish transaction among them), each with its transaction link on a phone too, and a live
// keyOf lookup finds the deployer's key; with the RPCs unreachable the register shows the CHAIN_UNAVAILABLE slip, not
// the RPC client's report; /seal names the accepted forms for a malformed recipient; the drip refuses an unsigned
// request and a stale signed one, and names the lane of a request for chain 1 (refused before any chain read): the
// public's without a pass, the judges' with LETTERLOCK_DRIP_JUDGE_PASS set in the environment (never printed); a slip
// under /seal's h1 keeps axe's heading order. On the production host also: with the register unreadable, the home page offers
// "Post my key" and "Read the register again", none of a posted key's actions; /judge, when the agent's answer leaves
// it open whether a letter went out, says so (the agent's POST is answered inside the browser, never sent); and the
// host SDK 0.1.0 pinned (letterlock-app.vercel.app) answers every route, a query and a POST with a 308 to this host.
// Sends no transaction and makes no passkey. It POSTs to the drip four times, and on the production host a fifth time
// through the retired host: run it at most once in 10 minutes from one IP, or the firewall's per-IP limit (six)
// answers first.
//
//   set -a; source ~/.config/monad/drip-judge-pass.env; set +a; node scripts/smoke.mjs https://app.letterlock.edycu.dev
//                                                                  (also confirms the deployment's judges' pass)
//   node scripts/smoke.mjs https://app.letterlock.edycu.dev       (production, Monad mainnet)
//   node scripts/smoke.mjs http://127.0.0.1:3217                   (a local build)
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// the app's own endpoints (lib/endpoints.ts imports the deployment records as JSON modules) and the SDK's pinned rpId
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});
const { AGENT_URL } = await import("../lib/endpoints.ts");
const { LETTERLOCK_RP_ID } = await import("letterlock");
const { RETIRED_HOST } = await import("../next.config.ts");

const base = (process.argv[2] ?? "http://127.0.0.1:3217").replace(/\/+$/, "");
const chain = process.env.NEXT_PUBLIC_LETTERLOCK_CHAIN === "monad-testnet" ? "10143" : "143";
const record = JSON.parse(readFileSync(new URL(`../../../deployments/${chain}.json`, import.meta.url), "utf8"));
const failures = [];
const fail = (m) => {
  failures.push(m);
  console.log(`FAIL ${m}`);
};
const pass = (m) => console.log(`ok   ${m}`);
/** axe's heading-order on the page as it is now: a slip's heading never skips a level below the page's h1 */
const headingOrder = async (page, what) => {
  const { violations } = await new AxeBuilder({ page }).withRules(["heading-order"]).analyze();
  const levels = await page.evaluate(() => [...document.querySelectorAll("main h1, main h2, main h3, main h4")].map((h) => h.tagName).join(" "));
  if (violations.length) fail(`${what}: axe heading-order (${levels})`);
  else pass(`${what}: headings in order (${levels})`);
};

const ROUTES = ["/", "/seal", "/open", "/register", "/judge", "/kit"];
const HEADERS = ["x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy", "strict-transport-security", "cross-origin-opener-policy"];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
});
// every script of the build the pages load, as the browser received it
const scripts = new Map();
context.on("response", (r) => {
  if (r.request().resourceType() === "script" && r.url().startsWith(`${base}/_next/static/`)) scripts.set(new URL(r.url()).pathname, r.text().catch(() => ""));
});
try {
  for (const route of [...ROUTES, "/no-such-page"]) {
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => {
      // the missing page's own 404 is the answer expected, not an error of the page
      if (route === "/no-such-page" && /status of 404/.test(m.text())) return;
      if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
    const res = await page.goto(base + route, { waitUntil: "networkidle", timeout: 45_000 });
    const status = res?.status();
    const want = route === "/no-such-page" ? 404 : 200;
    if (status !== want) fail(`${route}: HTTP ${status}, expected ${want}`);
    const h = res?.headers() ?? {};
    const missing = HEADERS.filter((k) => !h[k]);
    if (missing.length) fail(`${route}: missing headers ${missing.join(", ")}`);
    const csp = h["content-security-policy"] ?? "";
    if (!/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/.test(csp) || /unsafe-eval/.test(csp)) fail(`${route}: CSP is not the nonce policy: ${csp.slice(0, 120)}`);
    if (route === "/register") {
      // the page reads the chain itself: wait for its first scan
      await page.waitForFunction(() => document.querySelectorAll("section[aria-labelledby=live-title] tbody tr").length > 0, null, { timeout: 45_000 }).catch(() => {});
      const rows = await page.locator("section[aria-labelledby=live-title] tbody tr").count();
      const html = await page.content();
      if (rows < 1) fail(`/register: no register lines`);
      else if (!html.includes(record.publishTx.slice(0, 10))) fail(`/register: the smoke test's publish ${record.publishTx} is not among ${rows} lines`);
      else pass(`/register: ${rows} real lines, the smoke test's publish ${record.publishTx.slice(0, 10)}… among them`);
      await page.getByRole("textbox", { name: "Look up" }).fill(record.deployer);
      await page.getByRole("button", { name: "Look up" }).click();
      const found = await page.getByText("Found by keyOf").first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
      if (!found) fail("/register: the keyOf lookup of the deployer found nothing");
      else pass(`/register: keyOf(${record.deployer.slice(0, 10)}…) found its key live`);
    }
    if (route === "/seal") {
      // a malformed recipient (a truncated paste) is named beside the field, not met with a silently disabled button
      const typo = await context.newPage();
      await typo.goto(`${base}/seal?to=0x1234`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const named = await typo.getByText("An address is 0x and 40 hex digits; an agent is agent:").first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      if (!named) fail("/seal?to=0x1234: no error beside the To field");
      else pass("/seal?to=0x1234: the field names the two accepted forms");
      await typo.close();
      // a recipient without a key: the NO_KEY_PUBLISHED slip sits under the page's h1, so its heading is an h2
      const nokey = await context.newPage();
      await nokey.goto(`${base}/seal?to=0x0000000000000000000000000000000000000001`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const slip = await nokey.locator('[data-code="NO_KEY_PUBLISHED"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
      if (!slip) fail("/seal?to=0x…0001: no NO_KEY_PUBLISHED slip");
      else await headingOrder(nokey, "/seal with the NO_KEY_PUBLISHED slip");
      await nokey.close();
      // sealing is local: a keyOf read and HPKE in the page; nothing is sent
      await page.locator('main form input[name="to"]').fill(record.deployer);
      await page.locator('tr[data-state="found"]').first().waitFor({ timeout: 30_000 });
      await page.getByRole("textbox", { name: "Note" }).fill("smoke: sealed in the page, never sent");
      await page.getByRole("button", { name: "Seal", exact: true }).click();
      const sealed = await page.getByText("Sealed to key").waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const env = sealed ? JSON.parse((await page.locator("details pre").textContent()) ?? "{}") : {};
      if (!sealed || env.chainId !== record.chainId || env.directory !== record.address.toLowerCase() || env.recipient !== record.deployer.toLowerCase())
        fail(`/seal: sealing to ${record.deployer} did not give an envelope for chain ${record.chainId}, this directory and that address`);
      else pass(`/seal: sealed to ${record.deployer.slice(0, 10)}… in the page (epoch ${env.epoch}, key ${env.kid}); nothing sent`);
    }
    if (route === "/open") {
      await page.goto(`${base}/open?to=${record.deployer}`, { waitUntil: "networkidle", timeout: 45_000 });
      const ok = await page
        .waitForSelector('section[aria-labelledby="reader-title"] [data-wax][data-state="pressed"]', { timeout: 45_000 })
        .then(() => true, () => false);
      const letters = await page.locator('section[aria-labelledby="inbox-title"] li[data-state="sealed"]').count();
      if (!ok || letters < 1) fail(`/open: the inbox of ${record.deployer} shows no sealed letter`);
      else pass(`/open: the inbox of ${record.deployer.slice(0, 10)}… lists ${letters} sealed letters, read from Dropped events`);
    }
    await page.waitForTimeout(500);
    if (errors.length) fail(`${route}: ${errors.join(" | ").slice(0, 400)}`);
    else pass(`${route}: HTTP ${status}, headers and nonce CSP, no console errors`);
    await page.close();
  }
  {
    // on a phone the register has no Posted column: each line still links the transaction that posted its key
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await phone.newPage();
    await page.goto(`${base}/register`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForFunction(() => document.querySelectorAll("section[aria-labelledby=live-title] tbody tr").length > 0, null, { timeout: 45_000 }).catch(() => {});
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll("section[aria-labelledby=live-title] tbody tr")].map(
        (tr) => [...tr.querySelectorAll('a[href*="/tx/"]')].filter((a) => a.getBoundingClientRect().width > 0 && getComputedStyle(a).visibility !== "hidden").length,
      ),
    );
    if (!lines.length || lines.some((n) => n !== 1)) fail(`/register at 390 px: transaction links shown per line ${JSON.stringify(lines)}, want 1 each`);
    else pass(`/register at 390 px: each of ${lines.length} lines shows its transaction link`);
    await phone.close();
  }
  {
    // the RPCs unreachable: the register's own reads fail as the CHAIN_UNAVAILABLE slip, never as viem's report
    // (which names the RPC URL, the request body and viem's version)
    const cut = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await cut.route(/rpc1?\.monad\.xyz|testnet-rpc\.monad\.xyz/, (r) => r.abort());
    const page = await cut.newPage();
    await page.goto(`${base}/register`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const slip = await page.locator('[data-code="CHAIN_UNAVAILABLE"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const text = await page.locator("main").innerText();
    if (!slip || /viem@|Request body|HTTP request failed/.test(text)) fail(`/register with the RPCs unreachable: ${slip ? "viem's report is on the page" : "no CHAIN_UNAVAILABLE slip"}`);
    else pass("/register with the RPCs unreachable: the CHAIN_UNAVAILABLE slip, and none of the RPC client's report");
    // and /seal's lookup, cut off the same way: its slip is under the page's h1
    const seal = await cut.newPage();
    await seal.goto(`${base}/seal?to=${record.deployer}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (await seal.locator('[data-code="CHAIN_UNAVAILABLE"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false))
      await headingOrder(seal, "/seal with the CHAIN_UNAVAILABLE slip");
    else fail("/seal with the RPCs unreachable: no CHAIN_UNAVAILABLE slip");
    await cut.close();
  }
  // Two checks that need the passkey host (production): this device "remembers" the deployer's address, which is public
  // metadata (a made-up credential id, never used: no passkey is made or asked for), and nothing is sent.
  const onHost = new URL(base).hostname === LETTERLOCK_RP_ID;
  const remembering = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const stored = { v: 1, chainId: record.chainId, rpId: LETTERLOCK_RP_ID, credentialId: "AAAAAAAAAAAAAAAAAAAAAA", address: record.deployer };
    await ctx.addInitScript(([k, v]) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    }, [`letterlock:v1:${record.chainId}:${LETTERLOCK_RP_ID}`, JSON.stringify(stored)]);
    return ctx;
  };
  if (onHost) {
    // the register unreadable: the home page cannot tell whether the key is posted, so it offers "Post my key" and
    // "Read the register again", never the actions of a posted key (they lead to NO_KEY_PUBLISHED on /seal)
    const ctx = await remembering();
    await ctx.route(/rpc1?\.monad\.xyz/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const again = await page.getByRole("button", { name: "Read the register again" }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const post = await page.getByRole("button", { name: "Post my key" }).count();
    const posted = await page.getByRole("link", { name: /Seal a note to yourself|Open your inbox/ }).count();
    if (!again || post !== 1 || posted) fail(`/ with the register unreadable: "Read the register again" ${again}, "Post my key" ${post}, a posted key's actions ${posted}`);
    else pass("/ with the register unreadable: \"Post my key\" and \"Read the register again\", none of a posted key's actions");
    if (await page.locator("[data-code]").first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) await headingOrder(page, "/ with the register unreadable, its slip shown");
    else fail("/ with the register unreadable: no slip says why");
    await ctx.close();
  }
  if (onHost) {
    // /judge step 2 when the agent's answer leaves it open whether a letter went out: the page says so and points to the
    // inbox, never "Nothing was sent". Every request to the agent's host is answered or refused inside this browser:
    // POST /remember gets the agent's own 500 body, and nothing reaches the agent, so nothing is sent
    const ctx = await remembering();
    let reached = 0;
    const agentHost = new URL(AGENT_URL).host;
    await ctx.route((url) => url.host === agentHost, (r) => {
      if (r.request().method() === "POST" && new URL(r.request().url()).pathname === "/remember")
        return r.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "access-control-allow-origin": base },
          body: JSON.stringify({ error: { code: "INTERNAL", message: "the agent failed unexpectedly; nothing more is known" } }),
        });
      reached++;
      return r.abort();
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/judge`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const ask = page.getByRole("button", { name: "Ask the agent" });
    const ready = await ask.and(page.locator(":not([disabled])")).waitFor({ timeout: 45_000 }).then(() => true, () => false);
    if (ready) await ask.click();
    const open = ready && (await page.getByText("Whether a letter went out is not known").first().waitFor({ timeout: 20_000 }).then(() => true, () => false));
    const text = await page.locator("main").innerText();
    if (!open || /nothing was sent/i.test(text)) fail(`/judge step 2 after an agent's 500: ${!ready ? "the button never enabled" : open ? "the page says nothing was sent" : "no word that it is not known"}`);
    else pass(`/judge step 2 after an agent's 500: "not known", and the inbox to look at; nothing reached the agent (${reached} other requests refused)`);
    await ctx.close();
  }
  if (onHost) {
    // the host SDK 0.1.0 pinned serves nothing: every route, a query and a POST reach this host by a 308, which keeps
    // the method and the body (the POST is answered by the redirect, before the drip's route runs: nothing is sent);
    // and so do the build's own files, a script the pages just loaded among them, and any other path under /_next/
    // (Next.js leaves /_next/ out of its own redirects: vercel.json's redirect answers there)
    const moved = [];
    const built = [...scripts.keys()][0];
    if (!built) fail(`${RETIRED_HOST}: no script of the build to ask for there`);
    for (const path of [...ROUTES, "/judge?pass=smoke", "/api/drip", ...(built ? [built] : []), "/_next/data/smoke.json", "/_next/image?url=%2Ficon.svg&w=64&q=75"]) {
      const post = path === "/api/drip";
      const r = await fetch(`https://${RETIRED_HOST}${path}`, {
        method: post ? "POST" : "GET",
        redirect: "manual",
        ...(post ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      });
      if (r.status !== 308 || r.headers.get("location") !== `${base}${path}`) moved.push(`${post ? "POST" : "GET"} ${path}: HTTP ${r.status} ${r.headers.get("location")}`);
    }
    if (moved.length) fail(`${RETIRED_HOST} does not send everything here: ${moved.join("; ")}`);
    else pass(`${RETIRED_HOST}: ${ROUTES.length} routes, a query, a POST to /api/drip, a script of the build and two other paths under /_next/ answer 308 to the same path on ${LETTERLOCK_RP_ID}`);
  }
  for (const [path, type] of [["/og-image.png", "image/png"], ["/icon.svg", "image/svg+xml"]]) {
    const r = await fetch(base + path);
    const t = r.headers.get("content-type") ?? "";
    if (r.status !== 200 || !t.startsWith(type)) fail(`${path}: HTTP ${r.status} ${t}`);
    else pass(`${path}: ${t}, ${(await r.arrayBuffer()).byteLength} bytes`);
  }
  const verify = await fetch(base + "/integrations/verify", { redirect: "manual" });
  if (![307, 308].includes(verify.status) || !(verify.headers.get("location") ?? "").endsWith("/register")) fail(`/integrations/verify: HTTP ${verify.status} to ${verify.headers.get("location")}`);
  else pass("/integrations/verify: redirects to /register");
  const home = await (await fetch(base + "/")).text();
  for (const m of ['property="og:image"', 'name="twitter:card"', 'property="og:title"', "<title>"]) if (!home.includes(m)) fail(`/: no ${m}`);
  const drip = await fetch(base + "/api/drip", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const dripBody = await drip.json().catch(() => ({}));
  // the firewall's per-IP limit may answer first, with its own 429, when this IP has just posted to the drip
  if (drip.status === 429 && typeof dripBody.error === "object") pass("/api/drip: an unsigned request is refused (the firewall's 429 for this IP), nothing sent");
  else if (drip.status !== 400 || dripBody.error !== "BAD_REQUEST") fail(`/api/drip: an empty request answered ${drip.status} ${JSON.stringify(dripBody)}`);
  else pass("/api/drip: an unsigned request is refused (400 BAD_REQUEST), nothing sent");
  {
    // a request signed by a new account for a minute an hour gone: the route's admission (the switch, the judges'
    // lane, the signature's minute) refuses it before any chain read, so nothing is read or sent
    const a = privateKeyToAccount(generatePrivateKey());
    const minute = Math.floor(Date.now() / 60_000) - 60;
    const signature = await a.signMessage({ message: `letterlock-drip:${a.address.toLowerCase()}:${record.chainId}:${minute}` });
    const r = await fetch(base + "/api/drip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: a.address, chainId: record.chainId, minute, signature }),
    });
    const b = await r.json().catch(() => ({}));
    if (r.status === 429 && typeof b.error === "object") pass("/api/drip: a stale signed request is refused (the firewall's 429 for this IP), nothing sent");
    else if (r.status === 401 && b.error === "STALE_SIGNATURE") pass("/api/drip: a stale signed request passes the drip's admission to STALE_SIGNATURE (401), nothing read or sent");
    else if (r.status === 503 && b.error === "DRIP_DISABLED" && !onHost) pass("/api/drip: this build's drip is switched off (503 DRIP_DISABLED)");
    else fail(`/api/drip: a stale signed request answered ${r.status} ${JSON.stringify(b)}`);
  }
  {
    // the lane a request was admitted to, confirmed without spending: a request for chain 1 is refused WRONG_CHAIN by the
    // admission, before any chain read, and the answer names its lane. Without a pass it is the public's lane; with
    // LETTERLOCK_DRIP_JUDGE_PASS in the environment (sourced from where it is kept, never typed on a command line and
    // never printed here) it must be the judges' lane, or the deployment holds a different pass than the judges' link
    const wrongChain = async (pass) => {
      const a = privateKeyToAccount(generatePrivateKey());
      const minute = Math.floor(Date.now() / 60_000);
      const signature = await a.signMessage({ message: `letterlock-drip:${a.address.toLowerCase()}:1:${minute}` });
      const r = await fetch(base + "/api/drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: a.address, chainId: 1, minute, signature, ...(pass === undefined ? {} : { pass }) }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const judgePass = process.env.LETTERLOCK_DRIP_JUDGE_PASS?.trim();
    for (const [lane, given] of [["public", undefined], ...(judgePass ? [["judge", judgePass]] : [])]) {
      const what = lane === "judge" ? "a request with the judges' pass" : "a request without a pass";
      const { status, body } = await wrongChain(given);
      if (status === 429 && typeof body.error === "object") fail(`/api/drip: ${what} met the firewall's 429 for this IP; run the smoke again in 10 minutes`);
      else if (status === 503 && body.error === "DRIP_DISABLED" && !onHost && body.lane === lane) pass(`/api/drip: ${what} is in the ${lane} lane (this build's drip is switched off)`);
      else if (status === 400 && body.error === "WRONG_CHAIN" && body.lane === lane) pass(`/api/drip: ${what} is admitted to the ${lane} lane (400 WRONG_CHAIN, nothing read or sent)`);
      else fail(`/api/drip: ${what} answered ${status} ${body.error} in lane ${body.lane}, want 400 WRONG_CHAIN in lane ${lane}`);
    }
    if (!judgePass) console.log("skip /api/drip: the judges' lane (set LETTERLOCK_DRIP_JUDGE_PASS in the environment to confirm the deployment's pass)");
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
