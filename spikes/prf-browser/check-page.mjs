// UI check of the human cross-device page. Taps the real buttons in Chromium with CDP virtual authenticators
// (PRF on) against the production build (vite build → vite preview) or, with --url, a deployed copy.
//   node check-page.mjs                                  # local production build
//   node check-page.mjs --url https://<host>/ [--shots <dir>]
// CDP cannot give a second virtual authenticator the passkey's hmac-secret (see run-spike.mjs), so the real
// cross-device leg stays the human Safari → iPad run. What this proves is everything around it: the link and its
// QR code, a discoverable lookup with fresh storage, the verdicts, the error states, "Copy result", the layout.
import { build, preview } from "vite";
import { chromium } from "playwright";
import jsQR from "jsqr";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const shots = arg("--shots");
if (shots) mkdirSync(shots, { recursive: true });

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); };
const b64urlJson = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const group = (fp) => fp.match(/.{1,4}/g).join(" ");

let server;
let PAGE = arg("--url");
if (!PAGE) {
  await build({ root: here, logLevel: "error" });
  server = await preview({ root: here, logLevel: "error" });
  PAGE = server.resolvedUrls.local[0];
}
const origin = new URL(PAGE).origin;
const host = new URL(PAGE).hostname;
const browser = await chromium.launch();
const errors = [];

// Chromium's virtual authenticator always returns PRF at creation. To reach mera's fallback path, `simulate`
// emulates (test-only) an authenticator that enables PRF at creation without evaluating it, and can block the
// next assertion once, the way a browser may refuse a second prompt that no fresh tap started.
const simulateAuthenticator = () => {
  if (typeof CredentialsContainer === "undefined") return; // about:blank between loads
  const proto = CredentialsContainer.prototype;
  const create = proto.create;
  const get = proto.get;
  proto.create = async function (o) {
    const cred = await create.call(this, o);
    if (window.__simPrfEnabledOnly && cred) {
      const results = cred.getClientExtensionResults.bind(cred);
      cred.getClientExtensionResults = () => { const r = results(); if (r.prf) r.prf = { enabled: true }; return r; };
    }
    return cred;
  };
  proto.get = function (o) {
    if (window.__simBlockNextGet) { window.__simBlockNextGet = false; return Promise.reject(new DOMException("simulated: second prompt blocked", "NotAllowedError")); }
    const pending = get.call(this, o);
    if (!window.__simHybridNextGet) return pending;
    window.__simHybridNextGet = false;
    // hybrid (another device over QR/Bluetooth) whose PRF output differs from on-device, as Safari 18.x has done
    return pending.then((cred) => {
      Object.defineProperty(cred, "authenticatorAttachment", { value: "cross-platform" });
      const results = cred.getClientExtensionResults.bind(cred);
      cred.getClientExtensionResults = () => {
        const r = results();
        const first = r.prf?.results?.first;
        if (first) { const b = new Uint8Array(first).slice(); b[0] ^= 1; r.prf.results.first = b.buffer; }
        return r;
      };
      return cred;
    });
  };
};

const device = async ({ hasPrf = true, viewport = { width: 1280, height: 900 }, label, simulate = false }) => {
  const ctx = await browser.newContext({ viewport });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  if (simulate) await ctx.addInitScript(simulateAuthenticator);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, hasPrf, automaticPresenceSimulation: true } });
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${label} console: ${m.text()}`); });
  return { ctx, page, cdp, authenticatorId };
};
const load = async (page, url) => {
  const res = await page.goto(url);
  await page.waitForFunction(() => "spike" in window && document.getElementById("prfcap")?.textContent !== "checking…");
  return res;
};
const fpOf = (page) => page.evaluate(() => [...document.querySelectorAll("#fp span")].map((s) => s.textContent).join(""));
const text = (page, sel) => page.locator(sel).innerText();
const fact = (page, label) => page.evaluate((l) => {
  const dt = [...document.querySelectorAll("#facts dt")].find((d) => d.textContent === l);
  return dt?.nextElementSibling?.textContent ?? null;
}, label);
/** Taps "Copy result" (or "Copy details") and returns the copied text plus the JSON on its last line. */
const copied = async (page, button = "#copy") => {
  await page.click(button);
  const status = button === "#copy" ? "#copy-status" : "#copy-error-status";
  await page.waitForFunction((s) => document.querySelector(s)?.textContent !== "", status);
  const t = await page.evaluate(() => navigator.clipboard.readText());
  return { text: t, json: JSON.parse(t.trim().split("\n").at(-1)) };
};
const tap = async (page, id) => {
  await page.click(id);
  await page.waitForFunction((b) => !document.querySelector(b).disabled, id); // busy state ends
};

try {
  // ---------- device A ("Mac"): a fresh page ----------
  const mac = await device({ label: "A" });
  const res = await load(mac.page, PAGE);
  check("page loads over " + new URL(PAGE).protocol.replace(":", "") + " and its JS runs", res.ok() && (await mac.page.evaluate(() => typeof window.spike.create)) === "function",
    { status: res.status(), build: await mac.page.locator("#build").textContent() });
  if (PAGE.startsWith("https:")) check("deployed page sends a Content-Security-Policy", !!res.headers()["content-security-policy"], res.headers()["content-security-policy"]);
  check("page states the rpId = location.hostname", (await text(mac.page, "#rpid")) === host, host);
  check("page shows browser/OS and the PRF support line", !(await text(mac.page, "#device")).includes("…") && (await text(mac.page, "#prfcap")) !== "", `${await text(mac.page, "#device")} · PRF ${await text(mac.page, "#prfcap")}`);
  check("no note in the link → step 1 is the highlighted step", await mac.page.locator("#step-create.is-next").count() === 1);

  // ---------- 1 · Create ----------
  const note = "iPad test note " + Date.now().toString(36);
  await mac.page.fill("#note", note);
  await tap(mac.page, "#create");
  const fpA = await fpOf(mac.page);
  const link = await mac.page.locator("#link").getAttribute("href");
  const frag = new URLSearchParams(new URL(link).hash.slice(1));
  const env = b64urlJson(frag.get("env"));
  const cA = await copied(mac.page);
  check("1 · Create → a 16-hex fingerprint on screen, equal to the kid of the note in the link",
    /^[0-9a-f]{16}$/.test(fpA) && env.kid === fpA && env.v === 1 && env.epoch === 1, group(fpA));
  check("the hand-off link is this origin + #env=<base64url JSON> (+ cid, who); the address bar carries it too",
    link.startsWith(origin + "/#env=") && frag.get("cid") === cA.json.credentialId && (await mac.page.evaluate(() => location.href)) === link,
    { chars: link.length, who: frag.get("who") });
  const fpPx = await mac.page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("fp")).fontSize));
  check("fingerprint is LARGE (≥ 32 px)", fpPx >= 32, fpPx + "px");
  const prompts = await fact(mac.page, "Passkey prompts");
  check("ceremonies counted: prompts = ceremonies observed, PRF arrival named (create | fallback)",
    cA.json.prompts === cA.json.ceremonies.length && cA.json.prompts >= 1 && ["create", "fallback"].includes(cA.json.prfAt), prompts);
  check("Copy result: fingerprint, verdict, rpId and navigator.userAgent are in the copied text",
    cA.text.includes(group(fpA)) && cA.text.includes("Result: INFO") && cA.text.includes(host) && cA.text.includes(await mac.page.evaluate(() => navigator.userAgent)), cA.text.split("\n")[0]);

  // ---------- the QR code must decode to exactly the link ----------
  const px = await mac.page.evaluate(() => {
    const c = document.getElementById("qr");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let s = "";
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height, b64: btoa(s), cssW: c.getBoundingClientRect().width };
  });
  const qr = jsQR(new Uint8ClampedArray(Buffer.from(px.b64, "base64")), px.w, px.h);
  check("QR code decodes (jsQR) to exactly the hand-off link", qr?.data === link, { version: qr?.version, drawnPx: px.w, shownCssPx: Math.round(px.cssW) });

  // ---------- 2 · Use my passkey on the same device: credential hint ----------
  await tap(mac.page, "#derive");
  const cA2 = await copied(mac.page);
  check("A, same device: credential-hint lookup, same fingerprint, the note opens (PASS verdict)",
    cA2.json.path === "credential-hint" && cA2.json.ceremonies[0]?.lookup === "credential-hint" && (await fpOf(mac.page)) === fpA
      && (await text(mac.page, "#opened")) === note && cA2.json.verdict === "pass", cA2.json.ceremonies.map((c) => `${c.kind}:${c.lookup}:${c.prf}`));

  // ---------- A': storage wiped, page opened from the link (what the iPad does) ----------
  await mac.page.evaluate(() => localStorage.clear());
  await mac.page.goto("about:blank");
  await load(mac.page, link);
  check("opened from the link → the sealed-note banner names the key and the passkey, step 2 highlighted",
    (await mac.page.locator("#incoming").isVisible()) && (await text(mac.page, "#incoming-kid")) === group(fpA)
      && (await text(mac.page, "#incoming-who")) === `“${frag.get("who")}”` && await mac.page.locator("#step-derive.is-next").count() === 1);
  await tap(mac.page, "#derive");
  const cA3 = await copied(mac.page);
  check("A', no storage: discoverable lookup → same fingerprint, same passkey as the link, the note opens (PASS)",
    cA3.json.path === "discoverable" && cA3.json.ceremonies[0]?.lookup === "discoverable" && cA3.json.attachment === "platform" && (await fpOf(mac.page)) === fpA
      && cA3.json.sameCredential === true && (await text(mac.page, "#opened")) === note && (await mac.page.locator("#verdict.pass").count()) === 1,
    await text(mac.page, "#verdict"));

  // ---------- layout: iPad portrait/landscape and phone, with the result + hand-off on screen ----------
  await mac.page.goto("about:blank");
  await load(mac.page, PAGE);
  await tap(mac.page, "#create");
  for (const [name, vp] of [["ipad-portrait", { width: 820, height: 1180 }], ["ipad-landscape", { width: 1180, height: 820 }], ["phone", { width: 390, height: 844 }]]) {
    await mac.page.setViewportSize(vp);
    const m = await mac.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      create: document.getElementById("create").getBoundingClientRect().height,
      derive: document.getElementById("derive").getBoundingClientRect().height,
      fp: parseFloat(getComputedStyle(document.getElementById("fp")).fontSize),
      qr: document.getElementById("qr").getBoundingClientRect().width,
    }));
    check(`layout ${name} ${vp.width}×${vp.height}: no sideways scroll, buttons ≥ 56 px, fingerprint ≥ 32 px, QR ≥ 240 px`,
      m.overflow <= 0 && m.create >= 56 && m.derive >= 56 && m.fp >= 32 && m.qr >= 240, m);
    if (shots) await mac.page.screenshot({ path: join(shots, `page-${name}.png`), fullPage: true });
  }

  // ---------- wrong passkey: another device's passkey opens the link → "choose the other passkey" ----------
  const other = await device({ label: "C" });
  await load(other.page, PAGE);
  await tap(other.page, "#create");                        // this device's own, different passkey
  await other.page.evaluate(() => localStorage.clear());
  await other.page.goto("about:blank");
  await load(other.page, link);
  await tap(other.page, "#derive");
  const cC = await copied(other.page);
  check("wrong passkey chosen → WRONG_KEY diagnosed as 'a different passkey' (retry), its own fingerprint shown",
    cC.json.verdict === "retry" && cC.json.sameCredential === false && (await fpOf(other.page)) !== fpA && (await other.page.locator("#letter").isHidden()),
    await text(other.page, "#verdict"));
  if (shots) await other.page.screenshot({ path: join(shots, "page-wrong-passkey.png"), fullPage: true });

  // ---------- second device via CDP copy: no hmac-secret → a readable error, and it can be copied ----------
  const { credentials } = await mac.cdp.send("WebAuthn.getCredentials", { authenticatorId: mac.authenticatorId });
  const ipad = await device({ label: "B", viewport: { width: 820, height: 1180 } });
  for (const c of credentials) await ipad.cdp.send("WebAuthn.addCredential", { authenticatorId: ipad.authenticatorId, credential: c });
  await load(ipad.page, link);
  await ipad.page.click("#derive");
  await ipad.page.locator("#error").waitFor({ state: "visible" });
  const cB = await copied(ipad.page, "#copy-error");
  check("B (CDP copy, no hmac-secret): PRF_UNSUPPORTED is shown in words, and Copy details carries it",
    (await text(ipad.page, "#error-title")).includes("PRF_UNSUPPORTED") && (await text(ipad.page, "#error-text")).includes("Safari 18") && cB.text.includes("PRF_UNSUPPORTED"),
    await text(ipad.page, "#error-title"));
  if (shots) await ipad.page.screenshot({ path: join(shots, "page-error.png"), fullPage: true });

  // ---------- authenticator without PRF: 1 · Create fails in words ----------
  const dash = await device({ label: "D", hasPrf: false });
  await load(dash.page, PAGE);
  await dash.page.click("#create");
  await dash.page.locator("#error").waitFor({ state: "visible" });
  check("no-PRF authenticator: 1 · Create explains PRF_UNSUPPORTED and names the passkey left behind",
    (await text(dash.page, "#error-text")).includes("was still saved"), await text(dash.page, "#error-title"));

  // ---------- simulated: PRF enabled at creation but not evaluated → mera's fallback assertion (2 prompts) ----------
  const late = await device({ label: "E", simulate: true });
  await load(late.page, PAGE);
  await late.page.evaluate(() => { window.__simPrfEnabledOnly = true; });
  await tap(late.page, "#create");
  const cE = await copied(late.page);
  const fpE = await fpOf(late.page);
  const promptsE = await fact(late.page, "Passkey prompts");
  await tap(late.page, "#derive");
  const cE2 = await copied(late.page);
  check("simulated late PRF: 2 prompts (create, then a credential-hint assertion), reported as 'fallback'; the key re-derives",
    cE.json.prompts === 2 && cE.json.prfAt === "fallback" && cE.json.ceremonies.map((c) => `${c.kind}:${c.lookup ?? "-"}:${c.prf}`).join() === "create:-:enabled-only,get:credential-hint:output"
      && (await fpOf(late.page)) === fpE && cE2.json.verdict === "pass", promptsE);

  // ---------- simulated: the passkey is used over hybrid and returns another PRF value ----------
  const linkE = await late.page.locator("#link").getAttribute("href");
  await late.page.evaluate(() => localStorage.clear());
  await late.page.goto("about:blank");
  await load(late.page, linkE);
  await late.page.evaluate(() => { window.__simHybridNextGet = true; });
  await tap(late.page, "#derive");
  const cH = await copied(late.page);
  check("simulated hybrid use with a different PRF value → diagnosed as 'used from ANOTHER device', not as a same-passkey FAIL",
    cH.json.verdict === "retry" && cH.json.attachment === "cross-platform" && (await text(late.page, "#verdict")).includes("ANOTHER device")
      && (await fact(late.page, "Passkey used from"))?.startsWith("ANOTHER device"), await text(late.page, "#verdict"));

  // ---------- simulated: ...and the second prompt is blocked → the passkey is kept, one more tap finishes ----------
  const blocked = await device({ label: "F", simulate: true });
  await load(blocked.page, PAGE);
  await blocked.page.evaluate(() => { window.__simPrfEnabledOnly = true; window.__simBlockNextGet = true; });
  await blocked.page.click("#create");
  await blocked.page.locator("#error").waitFor({ state: "visible" });
  const stuck = { title: await text(blocked.page, "#error-title"), next: await blocked.page.locator("#step-derive.is-next").count() };
  await tap(blocked.page, "#derive");
  const cF = await copied(blocked.page);
  const fpF = await fpOf(blocked.page);
  const linkF = await blocked.page.locator("#link").getAttribute("href");
  await blocked.page.evaluate(() => localStorage.clear());
  await blocked.page.goto("about:blank");
  await load(blocked.page, linkF);
  await tap(blocked.page, "#derive");
  const cF2 = await copied(blocked.page);
  check("simulated blocked 2nd prompt: 'one more tap' → 2 · Use my passkey finishes with the kept credential hint, and its new link opens discoverably",
    stuck.title.includes("one more tap") && stuck.next === 1 && cF.json.path === "credential-hint" && /^[0-9a-f]{16}$/.test(fpF)
      && cF2.json.path === "discoverable" && cF2.json.verdict === "pass" && (await fpOf(blocked.page)) === fpF, stuck.title);

  // ---------- damaged links ----------
  await load(dash.page, PAGE + "#env=bm90LWpzb24");
  const damaged1 = (await dash.page.locator("#error").isVisible()) && (await text(dash.page, "#error-title")).includes("DAMAGED_LINK") && (await dash.page.locator("#incoming").isHidden());
  await dash.page.goto("about:blank");
  await load(dash.page, link.slice(0, link.indexOf("&cid=") - 12) + "&cid=" + frag.get("cid"));
  const damaged2 = (await dash.page.locator("#error").isVisible()) && (await text(dash.page, "#error-title")).includes("DAMAGED_LINK");
  check("a garbage or truncated #env link → 'damaged link' message, no banner, no prompt", damaged1 && damaged2);

  check("no uncaught page errors or console errors (incl. CSP violations)", errors.length === 0, errors);
  writeFileSync(join(here, "page-check-result.json"), JSON.stringify({ page: PAGE, chromium: browser.version(), when: new Date().toISOString(), checks, fingerprint: fpA, linkChars: link.length, qrVersion: qr?.version }, null, 1));
} finally {
  await browser.close();
  if (server) await (typeof server.close === "function" ? server.close() : new Promise((r) => server.httpServer.close(r)));
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} page checks passed · ${failed.length} failed · ${PAGE}`);
process.exit(failed.length ? 1 : 0);
