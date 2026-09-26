// UI check of the human cross-device page. Taps the real buttons in Chromium with CDP virtual authenticators
// (PRF on) against the production build (vite build → vite preview) or, with --url, a deployed copy.
//   node check-page.mjs                                  # local production build
//   node check-page.mjs --url https://<host>/ [--shots <dir>]
// CDP cannot give a second virtual authenticator the passkey's hmac-secret (see run-spike.mjs), so the real
// cross-device leg stays the human Safari → iPad run. What this proves is everything around it: the link and its
// QR code, a discoverable lookup with fresh storage, the verdicts, the error states, "Copy result", the layout.
// The page's own prompt count is checked against an independent oracle: Chromium's authenticator log (the CDP
// events WebAuthn.credentialAdded / credentialAsserted), not against the page's own list of ceremonies.
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
const IPAD_SAFARI = "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

// Chromium's virtual authenticator always returns PRF at creation. To reach mera's fallback path, `simulate`
// emulates (test-only) an authenticator that enables PRF at creation without evaluating it, and can block the
// next assertion once, the way a browser may refuse a second prompt that no fresh tap started.
const simulateAuthenticator = () => {
  if (typeof CredentialsContainer === "undefined") return; // about:blank between loads
  const proto = CredentialsContainer.prototype;
  const create = proto.create;
  const get = proto.get;
  const flipFirstPrfBit = (cred) => {
    const results = cred.getClientExtensionResults.bind(cred);
    cred.getClientExtensionResults = () => {
      const r = results();
      const first = r.prf?.results?.first;
      if (first) { const b = new Uint8Array(first).slice(); b[0] ^= 1; r.prf.results.first = b.buffer; }
      return r;
    };
  };
  proto.create = async function (o) {
    if (window.__simCancelNextCreate) { window.__simCancelNextCreate = false; throw new DOMException("simulated: user cancelled", "NotAllowedError"); }
    const cred = await create.call(this, o);
    if (window.__simPrfEnabledOnly && cred) {
      const results = cred.getClientExtensionResults.bind(cred);
      cred.getClientExtensionResults = () => { const r = results(); if (r.prf) r.prf = { enabled: true }; return r; };
    }
    // an authenticator whose PRF output at creation differs from its output at sign-in, for the same salt
    if (window.__simCreatePrfDiffers && cred) { window.__simCreatePrfDiffers = false; flipFirstPrfBit(cred); }
    return cred;
  };
  proto.get = function (o) {
    if (window.__simBlockNextGet) { window.__simBlockNextGet = false; return Promise.reject(new DOMException("simulated: second prompt blocked", "NotAllowedError")); }
    const pending = get.call(this, o);
    const hybrid = window.__simHybridNextGet ? "other-prf" : window.__simHybridSamePrfNextGet ? "same-prf" : null;
    if (!hybrid) return pending;
    window.__simHybridNextGet = false;
    window.__simHybridSamePrfNextGet = false;
    // hybrid (another device over QR/Bluetooth); its PRF output may differ from on-device, as Safari 18.x has done
    return pending.then((cred) => {
      Object.defineProperty(cred, "authenticatorAttachment", { value: "cross-platform" });
      if (hybrid === "other-prf") flipFirstPrfBit(cred);
      return cred;
    });
  };
};

const device = async ({ hasPrf = true, viewport = { width: 1280, height: 900 }, label, simulate = false, userAgent, clock }) => {
  const ctx = await browser.newContext({ viewport, ...(userAgent ? { userAgent, hasTouch: true } : {}) });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  if (simulate) await ctx.addInitScript(simulateAuthenticator);
  const page = await ctx.newPage();
  if (clock) await page.clock.setFixedTime(clock);
  const cdp = await ctx.newCDPSession(page);
  // the oracle: Chromium's own record of every ceremony its virtual authenticator answered
  const authLog = [];
  cdp.on("WebAuthn.credentialAdded", () => authLog.push("create"));
  cdp.on("WebAuthn.credentialAsserted", () => authLog.push("get"));
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, hasPrf, automaticPresenceSimulation: true } });
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${label} console: ${m.text()}`); });
  return { ctx, page, cdp, authenticatorId, authLog };
};
const load = async (page, url) => {
  const res = await page.goto(url);
  await page.waitForFunction(() => "spike" in window && document.getElementById("prfcap")?.textContent !== "checking…");
  return res;
};
const fpOf = (page) => page.evaluate(() => [...document.querySelectorAll("#fp span")].map((s) => s.textContent).join(""));
// missing elements read as "" (a FAIL line), not a 30 s timeout: an old or broken build still gets a full report
const text = (page, sel) => page.locator(sel).innerText({ timeout: 3000 }).catch(() => "");
const raw = (page, sel) => page.locator(sel).textContent({ timeout: 3000 }).then((t) => t ?? "", () => ""); // DOM text, before CSS text-transform
const attr = (page, sel, name) => page.locator(sel).getAttribute(name, { timeout: 3000 }).catch(() => null);
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
/** Decodes the hand-off QR code from the canvas pixels. */
const qrOf = async (page) => {
  const px = await page.evaluate(() => {
    const c = document.getElementById("qr");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let s = "";
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height, b64: btoa(s), cssW: c.getBoundingClientRect().width };
  });
  const qr = jsQR(new Uint8ClampedArray(Buffer.from(px.b64, "base64")), px.w, px.h);
  return { data: qr?.data ?? null, version: qr?.version, drawnPx: px.w, shownCssPx: Math.round(px.cssW) };
};
/** Waits (bounded, so a missing panel is a FAIL, not a timeout) until the hand-off panel shows a drawn QR code. */
const handoffShown = (page) => page.waitForFunction(
  () => !document.getElementById("handoff").hidden && document.getElementById("qr").width > 300, null, { timeout: 5000 },
).then(() => true, () => false);
/** Waits until the authenticator log has at least n entries (CDP events arrive asynchronously), then returns it. */
const authLogAt = async (dev, n) => {
  for (let i = 0; i < 40 && dev.authLog.length < n; i++) await new Promise((r) => setTimeout(r, 50));
  return dev.authLog.slice();
};
/** The page's successful ceremonies, as kinds, against the authenticator's log since `mark`. */
const oracle = async (dev, mark, pageCeremonies) => {
  const pageKinds = pageCeremonies.filter((c) => c.ok).map((c) => c.kind);
  const log = (await authLogAt(dev, mark + pageKinds.length)).slice(mark);
  return { ok: JSON.stringify(pageKinds) === JSON.stringify(log), page: pageKinds, authenticator: log };
};

try {
  // ---------- device A ("Mac"): a fresh page ----------
  const mac = await device({ label: "A" });
  const res = await load(mac.page, PAGE);
  check("page loads over " + new URL(PAGE).protocol.replace(":", "") + " and its JS runs", res.ok() && (await mac.page.evaluate(() => typeof window.spike.create)) === "function",
    { status: res.status(), build: await raw(mac.page, "#build") });
  if (PAGE.startsWith("https:")) check("deployed page sends a Content-Security-Policy", !!res.headers()["content-security-policy"], res.headers()["content-security-policy"]);
  check("page states the rpId = location.hostname", (await text(mac.page, "#rpid")) === host, host);
  const rpidNote = await text(mac.page, "#rpid-note");
  check("page says on screen that a hostname rpId is acceptable only for this test (production pins one rpId)",
    rpidNote.includes("acceptable only for this test") && rpidNote.includes("production app pins one fixed rpId"), rpidNote.slice(0, 90));
  check("page shows browser/OS and the PRF support line", !(await text(mac.page, "#device")).includes("…") && (await text(mac.page, "#prfcap")) !== "", `${await text(mac.page, "#device")} · PRF ${await text(mac.page, "#prfcap")}`);
  check("no note in the link → step 1 is the highlighted step", await mac.page.locator("#step-create.is-next").count() === 1);

  // ---------- 1 · Create ----------
  const note = "iPad test note " + Date.now().toString(36);
  await mac.page.fill("#note", note);
  const markA = mac.authLog.length;
  await tap(mac.page, "#create");
  const fpA = await fpOf(mac.page);
  const link = await mac.page.locator("#link").getAttribute("href");
  const frag = new URLSearchParams(new URL(link).hash.slice(1));
  const env = b64urlJson(frag.get("env"));
  const cA = await copied(mac.page);
  const whereAfterCreate = { where: await raw(mac.page, "#where-derive"), help: await raw(mac.page, "#derive-help") };
  check("1 · Create → a 16-hex fingerprint on screen, equal to the kid of the note in the link",
    /^[0-9a-f]{16}$/.test(fpA) && env.kid === fpA && env.v === 1 && env.epoch === 1, group(fpA));
  check("the hand-off link is this origin + #env=<base64url JSON> (+ cid, who); the address bar carries it too",
    link.startsWith(origin + "/#env=") && frag.get("cid") === cA.json.credentialId && (await mac.page.evaluate(() => location.href)) === link,
    { chars: link.length, who: frag.get("who") });
  const fpPx = await mac.page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("fp")).fontSize));
  check("fingerprint is LARGE (≥ 32 px)", fpPx >= 32, fpPx + "px");
  const oA = await oracle(mac, markA, cA.json.ceremonies);
  check("prompt count = Chromium's authenticator log (CDP credentialAdded/credentialAsserted), PRF arrival named (create | fallback)",
    oA.ok && cA.json.prompts === oA.authenticator.length && cA.json.prompts >= 1 && ["create", "fallback"].includes(cA.json.prfAt),
    { page: cA.json.prompts, ...oA, line: await fact(mac.page, "Passkey prompts") });
  check("Copy result: fingerprint, verdict, rpId and navigator.userAgent are in the copied text",
    cA.text.includes(group(fpA)) && cA.text.includes("Result: INFO") && cA.text.includes(host) && cA.text.includes(await mac.page.evaluate(() => navigator.userAgent)), cA.text.split("\n")[0]);

  // ---------- the QR code must decode to exactly the link ----------
  const qr = await qrOf(mac.page);
  check("QR code decodes (jsQR) to exactly the hand-off link", qr.data === link, { version: qr.version, drawnPx: qr.drawnPx, shownCssPx: qr.shownCssPx });

  // ---------- 2 · Use my passkey on the same device: credential hint = the self-check ----------
  const markA2 = mac.authLog.length;
  await tap(mac.page, "#derive");
  const cA2 = await copied(mac.page);
  check("A, same device: credential-hint lookup, same fingerprint, the note opens (PASS verdict)",
    cA2.json.path === "credential-hint" && cA2.json.ceremonies[0]?.lookup === "credential-hint" && (await fpOf(mac.page)) === fpA
      && (await text(mac.page, "#opened")) === note && cA2.json.verdict === "pass", cA2.json.ceremonies.map((c) => `${c.kind}:${c.lookup}:${c.prf}`));
  const oA2 = await oracle(mac, markA2, cA2.json.ceremonies);
  const qrA2 = await qrOf(mac.page);
  check("A, self-check: the verdict says so, 1 prompt = 1 authenticator assertion, and the hand-off QR code stays on screen",
    (await text(mac.page, "#verdict")).startsWith("Self-check passed") && oA2.ok && cA2.json.prompts === 1
      && (await mac.page.locator("#handoff").isVisible()) && qrA2.data === link, { ...oA2, handoff: await mac.page.locator("#handoff").isVisible() });

  // ---------- A, reloaded with its own link: the QR comes back without another passkey ----------
  const markReload = mac.authLog.length;
  await mac.page.reload();
  await mac.page.waitForFunction(() => "spike" in window);
  const shownAfterReload = await handoffShown(mac.page);
  const qrReload = await qrOf(mac.page);
  const { credentials: credsA } = await mac.cdp.send("WebAuthn.getCredentials", { authenticatorId: mac.authenticatorId });
  check("A, reloaded with its own link: the hand-off panel and a QR code of the same link are back, with no prompt and no new passkey",
    shownAfterReload && qrReload.data === link && (await text(mac.page, "#handoff-fp")) === group(fpA)
      && (await authLogAt(mac, markReload)).length === markReload && credsA.length === 1,
    { handoff: await mac.page.locator("#handoff").isVisible(), banner: await mac.page.locator("#incoming").isVisible(), passkeys: credsA.length });
  const ownReload = { where: await raw(mac.page, "#where-derive"), help: await raw(mac.page, "#derive-help"), title: await raw(mac.page, "#incoming-title"), action: await raw(mac.page, "#incoming-action") };
  check("A, its own note (after 1 · Create and after a reload): step 2 reads 'On this Mac: self-check' with self-check help, and the banner says the note is this device's own, not the iPad's",
    [whereAfterCreate, ownReload].every((o) => o.where === "On this Mac: self-check" && o.help.includes("Tap once as a self-check") && !o.help.includes("Nothing from the other device"))
      && ownReload.title === "This device's own note is in this link" && ownReload.action.includes("as the self-check") && ownReload.action.includes("iPad camera"),
    { whereAfterCreate, ownReload });

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
  const lookup = await fact(mac.page, "Lookup");
  const usedFrom = await fact(mac.page, "Passkey used from");
  check("A', discoverable: the Lookup line says no hint is saved in this browser, without contradicting 'Passkey used from: this device'",
    lookup?.includes("no passkey hint saved in this browser") && !lookup.includes("on this device") && usedFrom?.startsWith("this device")
      && !(await mac.page.locator("#handoff").isVisible()), { lookup, usedFrom });

  // ---------- note field: the limit is in bytes, shown live, enforced before any prompt ----------
  const dash = await device({ label: "D", hasPrf: false });
  await load(dash.page, PAGE);
  const cjk = "字".repeat(70);
  await dash.page.fill("#note", cjk);
  const over = { label: await text(dash.page, "label[for=note]"), maxlength: await attr(dash.page, "#note", "maxlength"), count: await text(dash.page, "#note-bytes"),
    flagged: await dash.page.locator("#note-bytes.over").count(), invalid: await attr(dash.page, "#note", "aria-invalid") };
  const markD = dash.authLog.length;
  await dash.page.click("#create");
  await dash.page.locator("#error").waitFor({ state: "visible" });
  const tooLong = { title: await text(dash.page, "#error-title"), help: await text(dash.page, "#error-text") };
  await dash.page.click("#derive");                         // no note in the link or in storage: 2 seals the field's note
  await dash.page.locator("#error").waitFor({ state: "visible" });
  const tooLong2 = await copied(dash.page, "#copy-error");
  check("2 · Use my passkey with no note to open: the same 200-byte limit is enforced before any prompt",
    tooLong2.text.split("\n")[0].endsWith("2 · Use my passkey failed") && tooLong2.text.includes("NOTE_TOO_LONG: 210 bytes")
      && (await text(dash.page, "#error-text")).includes("200 bytes or fewer") && (await authLogAt(dash, markD)).length === markD && (await dash.page.locator("#handoff").isHidden()),
    tooLong2.text.split("\n")[1]);
  await dash.page.fill("#note", "a".repeat(200));
  const at200 = { value: (await dash.page.inputValue("#note")).length, count: await text(dash.page, "#note-bytes"), flagged: await dash.page.locator("#note-bytes.over").count() };
  check("note field: limit stated in bytes (200) with a live count; 70 CJK characters = 210 bytes are flagged before tapping and refused with no prompt; 200 Latin letters fit",
    over.label.includes("up to 200 bytes") && over.maxlength === "200" && over.count.startsWith("210 / 200 bytes: too long") && over.flagged === 1 && over.invalid === "true"
      && tooLong.title.includes("NOTE_TOO_LONG") && tooLong.help.includes("200 bytes or fewer") && (await authLogAt(dash, markD)).length === markD
      && at200.value === 200 && at200.count === "200 / 200 bytes" && at200.flagged === 0, { over, tooLong: tooLong.title, at200 });

  // ---------- layout: iPad portrait/landscape and phone, with the densest note (200 bytes) on screen ----------
  await mac.page.goto("about:blank");
  await load(mac.page, PAGE);
  await mac.page.fill("#note", "Q".repeat(200));
  await tap(mac.page, "#create");
  const dense = { link: await mac.page.locator("#link").getAttribute("href"), qr: await qrOf(mac.page) };
  check("a 200-byte note (the maximum) still seals, and its denser QR code decodes to exactly the link",
    dense.qr.data === dense.link, { linkChars: dense.link.length, version: dense.qr.version });
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

  // ---------- two passkeys made in the same second must not share a name ----------
  const twice = await device({ label: "N", clock: new Date("2026-09-26T13:48:05Z") });
  await load(twice.page, PAGE);
  await tap(twice.page, "#create");
  await tap(twice.page, "#create");
  const { credentials: made2 } = await twice.cdp.send("WebAuthn.getCredentials", { authenticatorId: twice.authenticatorId });
  const names = made2.map((c) => c.userName);
  const linkN = await twice.page.locator("#link").getAttribute("href");
  const whoN = new URLSearchParams(new URL(linkN).hash.slice(1)).get("who");
  const qrN = await qrOf(twice.page);
  const defaultNote = { linkChars: linkN.length, cidChars: new URLSearchParams(new URL(linkN).hash.slice(1)).get("cid")?.length, version: qrN.version };
  check("the default note (field left as is) seals, and its QR code decodes to exactly the link", qrN.data === linkN
    && (await twice.page.inputValue("#note")) === "the dentist moved to Thursday 10:40", defaultNote);
  check("two 1 · Create taps at the same instant → two passkeys with different names; the link names the newer one",
    names.length === 2 && new Set(names).size === 2 && names.every((n) => /^maya \d\d:\d\d · [a-z2-9]{3}$/.test(n)) && names.includes(whoN), { names, who: whoN });

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
  await load(dash.page, PAGE);
  await dash.page.click("#create");
  await dash.page.locator("#error").waitFor({ state: "visible" });
  check("no-PRF authenticator: 1 · Create explains PRF_UNSUPPORTED and names the passkey left behind",
    (await text(dash.page, "#error-text")).includes("was still saved"), await text(dash.page, "#error-title"));

  // ---------- an iPad (Safari user agent) without a link: the reverse run is allowed and hands off to the Mac ----------
  const tablet = await device({ label: "I", viewport: { width: 820, height: 1180 }, userAgent: IPAD_SAFARI });
  await load(tablet.page, PAGE);
  const tabletIdle = { device: await text(tablet.page, "#device"), saved: await text(tablet.page, "#saved"), where: await raw(tablet.page, "#where-create") };
  await tap(tablet.page, "#create");
  const tabletLink = await tablet.page.locator("#link").getAttribute("href");
  const toMac = { h2: await text(tablet.page, "#handoff h2"), scan: await tablet.page.locator("#handoff-scan").isVisible(), send: await tablet.page.locator("#handoff-send").isVisible(),
    targets: await tablet.page.evaluate(() => [...document.querySelectorAll("#handoff .handoff-target")].map((e) => e.textContent)) };
  await load(other.page, tabletLink);                       // the Mac opens the iPad's link (reverse run)
  const macWhere = await raw(other.page, "#where-derive");
  check("iPad, no link: the optional reverse run is offered (no 'Don't create a passkey here'); its hand-off targets the Mac (send the link, no camera); the Mac labels step 2 'On your Mac'",
    tabletIdle.device.endsWith("on iPad") && tabletIdle.saved.includes("optional reverse run") && !tabletIdle.saved.includes("Don't create") && tabletIdle.where.includes("reverse run")
      && toMac.h2 === "Now take the note to your Mac" && !toMac.scan && toMac.send && toMac.targets.every((t) => t === "Mac") && macWhere === "On your Mac",
    { ...tabletIdle, ...toMac, macWhere });

  // ---------- a device that holds its own hint opens another passkey's link (the reverse run's Mac, mirrored) ----------
  await tablet.page.goto("about:blank");
  await load(tablet.page, link);                            // Mac A's link; the tablet still stores its own hint
  const foreignBefore = { saved: await text(tablet.page, "#saved"), where: await raw(tablet.page, "#where-derive"), title: await raw(tablet.page, "#incoming-title") };
  await tap(tablet.page, "#derive");
  const cI = await copied(tablet.page);
  const foreignAfter = { lookup: await fact(tablet.page, "Lookup"), saved: await text(tablet.page, "#saved"), stored: await tablet.page.evaluate(() => localStorage.getItem("ll.cred") !== null) };
  check("a stored hint for another passkey: before and after 2, the page says the note is sealed to another key and the lookup is by name, never 're-checks it here'",
    foreignBefore.saved.includes("also holds a hint for its own passkey") && foreignBefore.saved.includes("sealed to another key") && !foreignBefore.saved.includes("re-checks")
      && foreignBefore.where === "On your iPad" && foreignBefore.title === "A sealed note is in this link"
      && cI.json.path === "discoverable" && foreignAfter.stored && foreignAfter.lookup === "discoverable — this browser's saved passkey hint does not match this note's key; you picked the passkey by name"
      && !foreignAfter.saved.includes("re-checks"), { ...foreignBefore, ...foreignAfter, verdict: cI.json.verdict });

  // ---------- simulated: PRF enabled at creation but not evaluated → mera's fallback assertion (2 prompts) ----------
  const late = await device({ label: "E", simulate: true });
  await load(late.page, PAGE);
  await late.page.evaluate(() => { window.__simPrfEnabledOnly = true; });
  await tap(late.page, "#create");
  const cE = await copied(late.page);
  const fpE = await fpOf(late.page);
  const promptsE = await fact(late.page, "Passkey prompts");
  const oE = await oracle(late, 0, cE.json.ceremonies);
  await tap(late.page, "#derive");
  const cE2 = await copied(late.page);
  check("simulated late PRF: 2 prompts (create, then a credential-hint assertion) = 2 authenticator events, reported as 'fallback'; the key re-derives",
    cE.json.prompts === 2 && oE.ok && oE.authenticator.join() === "create,get" && cE.json.prfAt === "fallback"
      && cE.json.ceremonies.map((c) => `${c.kind}:${c.lookup ?? "-"}:${c.prf}`).join() === "create:-:enabled-only,get:credential-hint:output"
      && (await fpOf(late.page)) === fpE && cE2.json.verdict === "pass", { line: promptsE, authenticator: oE.authenticator });

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

  // ---------- simulated: hybrid use that DOES open the note → still not a PASS (the synced copy was not tested) ----------
  await late.page.goto("about:blank");
  await load(late.page, linkE);
  await late.page.evaluate(() => { window.__simHybridSamePrfNextGet = true; });
  await tap(late.page, "#derive");
  const cH2 = await copied(late.page);
  check("simulated hybrid use with the SAME PRF value → the note opens but the verdict is RETRY ('does not test the sync'), never PASS",
    cH2.json.verdict === "retry" && cH2.json.opened !== null && cH2.text.split("\n")[1].startsWith("Result: RETRY — The note opened, but through ANOTHER device")
      && (await text(late.page, "#verdict")).includes("does not test the sync") && (await late.page.locator("#verdict.pass").count()) === 0, cH2.text.split("\n")[1]);

  // ---------- simulated: ...and the second prompt is blocked → the passkey is kept, one more tap finishes ----------
  const blocked = await device({ label: "F", simulate: true });
  await load(blocked.page, PAGE);
  await blocked.page.evaluate(() => { window.__simPrfEnabledOnly = true; window.__simBlockNextGet = true; });
  await blocked.page.click("#create");
  await blocked.page.locator("#error").waitFor({ state: "visible" });
  const stuck = { title: await text(blocked.page, "#error-title"), next: await blocked.page.locator("#step-derive.is-next").count(), where: await raw(blocked.page, "#where-derive") };
  await tap(blocked.page, "#derive");
  const cF = await copied(blocked.page);
  const sealedF = { verdict: await text(blocked.page, "#verdict"), line: await fact(blocked.page, "Note sealed"), handoff: await blocked.page.locator("#handoff").isVisible() };
  check("recovered path: step 2 reads 'On this Mac: one more tap', and the tap that seals a new note says so (not 'No note in this link')",
    stuck.where === "On this Mac: one more tap" && sealedF.verdict.startsWith("No note came with this link, so a new note was sealed") && !sealedF.verdict.includes("No note in this link")
      && sealedF.line?.includes("the dentist moved to Thursday 10:40") && sealedF.handoff, { where: stuck.where, ...sealedF });
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

  // ---------- simulated: creation and sign-in give different PRF outputs on the creating device ----------
  const drift = await device({ label: "H", simulate: true });
  await load(drift.page, PAGE);
  await drift.page.evaluate(() => { window.__simCreatePrfDiffers = true; });
  await tap(drift.page, "#create");
  const linkH = await drift.page.locator("#link").getAttribute("href");
  await tap(drift.page, "#derive");
  const cD = await copied(drift.page);
  const driftVerdict = await text(drift.page, "#verdict");
  check("simulated creation-vs-sign-in PRF mismatch on the creating device → FAIL 'not a sync problem' (not 'across devices'), and its QR code stays",
    cD.json.verdict === "fail" && cD.json.path === "credential-hint" && driftVerdict.includes("on the device that made it") && driftVerdict.includes("not a sync problem")
      && !driftVerdict.includes("across devices") && (await drift.page.locator("#handoff").isVisible()) && (await qrOf(drift.page)).data === linkH, driftVerdict);

  // ---------- the Mac tester cancels Touch ID during 1 · Create → a Mac-side message ----------
  const cancel = await device({ label: "G", simulate: true });
  await load(cancel.page, PAGE);
  await cancel.page.evaluate(() => { window.__simCancelNextCreate = true; });
  await cancel.page.click("#create");
  await cancel.page.locator("#error").waitFor({ state: "visible" });
  check("simulated cancel of 1 · Create → 'tap 1 · Create to try again', not iPad sync advice",
    (await text(cancel.page, "#error-text")).includes("Tap “1 · Create” to try again") && !(await text(cancel.page, "#error-text")).includes("iPad"),
    await text(cancel.page, "#error-text"));

  // ---------- damaged links ----------
  await load(dash.page, PAGE + "#env=bm90LWpzb24");
  const damaged1 = (await dash.page.locator("#error").isVisible()) && (await text(dash.page, "#error-title")).includes("DAMAGED_LINK") && (await dash.page.locator("#incoming").isHidden());
  await dash.page.goto("about:blank");
  await load(dash.page, link.slice(0, link.indexOf("&cid=") - 12) + "&cid=" + frag.get("cid"));
  const damaged2 = (await dash.page.locator("#error").isVisible()) && (await text(dash.page, "#error-title")).includes("DAMAGED_LINK");
  check("a garbage or truncated #env link → 'damaged link' message, no banner, no prompt", damaged1 && damaged2);

  check("no uncaught page errors or console errors (incl. CSP violations)", errors.length === 0, errors);
  writeFileSync(join(here, "page-check-result.json"), JSON.stringify({ page: PAGE, chromium: browser.version(), when: new Date().toISOString(), checks, fingerprint: fpA, linkChars: link.length, qrVersion: qr.version, denseNote: { linkChars: dense.link.length, qrVersion: dense.qr.version }, defaultNote }, null, 1));
} finally {
  await browser.close();
  if (server) await (typeof server.close === "function" ? server.close() : new Promise((r) => server.httpServer.close(r)));
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} page checks passed · ${failed.length} failed · ${PAGE}`);
process.exit(failed.length ? 1 : 0);
