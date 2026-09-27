// Read-only smoke of a running build: every route loads, carries the security headers and its per-request CSP, and
// logs no console error, page error or CSP violation; /register shows the directory's real KeyPublished lines (the
// deploy smoke test's publish transaction among them), each with its transaction link on a phone too, and a live
// keyOf lookup finds the deployer's key; with the RPCs unreachable the register shows the CHAIN_UNAVAILABLE slip, not
// the RPC client's report; /seal names the accepted forms for a malformed recipient. Sends no transaction and makes no
// passkey.
//
//   node scripts/smoke.mjs https://letterlock-app.vercel.app      (production, Monad mainnet)
//   node scripts/smoke.mjs http://127.0.0.1:3217                   (a local build)
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://127.0.0.1:3217").replace(/\/+$/, "");
const chain = process.env.NEXT_PUBLIC_LETTERLOCK_CHAIN === "monad-testnet" ? "10143" : "143";
const record = JSON.parse(readFileSync(new URL(`../../../deployments/${chain}.json`, import.meta.url), "utf8"));
const failures = [];
const fail = (m) => {
  failures.push(m);
  console.log(`FAIL ${m}`);
};
const pass = (m) => console.log(`ok   ${m}`);

const ROUTES = ["/", "/seal", "/open", "/register", "/judge", "/kit"];
const HEADERS = ["x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy", "strict-transport-security", "cross-origin-opener-policy"];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
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
    await cut.close();
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
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
