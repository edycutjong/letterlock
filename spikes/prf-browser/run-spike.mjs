// Automated day-1 spike run: real Chromium WebAuthn (CDP virtual authenticators with PRF), real mera, real
// Monad RPC. Writes spike-result.json. Exit 0 only when every core check passes.
import { createServer } from "vite";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const RPC = { testnet: "https://testnet-rpc.monad.xyz", mainnet: "https://rpc.monad.xyz" };
const checks = [];
const skip = (name, why) => { checks.push({ name, ok: null, detail: why }); console.log(`SKIP ${name}  ${why}`); };
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); };

const server = await createServer({ root: import.meta.dirname, server: { port: 5178, strictPort: true }, logLevel: "error" });
await server.listen();
const PAGE = "http://localhost:5178/";
const browser = await chromium.launch();

const device = async ({ hasPrf = true } = {}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, hasPrf, automaticPresenceSimulation: true } });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(PAGE); await page.waitForFunction(() => "spike" in window);
  return { ctx, page, cdp, authenticatorId, errors };
};
const ethCall = async (rpc, data) => {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000100", data }, "latest"] }) });
  return (await r.json()).result ?? null;
};

try {
  // ---- device A ("Mac"): create passkey → key, seal a note to it ----
  const mac = await device();
  const a = await mac.page.evaluate(() => window.spike.create());
  check("A: passkey created, PRF → 32-byte X25519 pk", a.pk?.length === 64, a.fingerprint);
  const again = await mac.page.evaluate(() => window.spike.derive());
  check("A: same device, stored credential as allowCredentials hint → same key, note opens",
    again.path === "credential-hint" && again.pk === a.pk && again.opened === "the dentist moved to Thursday 10:40", again.ceremonyMs + "ms");

  // ---- fresh browser state, same passkey (the demo's "clear Safari storage" path) ----
  await mac.page.evaluate(() => localStorage.clear());
  await mac.page.reload(); await mac.page.waitForFunction(() => "spike" in window);
  const fresh = await mac.page.evaluate((env) => window.spike.derive(env), JSON.stringify(a.envelope));
  check("A': storage cleared → discoverable lookup (no hint) re-derives the key and opens the note",
    fresh.path === "discoverable" && fresh.pk === a.pk && fresh.opened === "the dentist moved to Thursday 10:40", fresh.fingerprint);

  // ---- device B ("iPad"): CDP cannot move a credential's hmac-secret between virtual authenticators ----
  const { credentials } = await mac.cdp.send("WebAuthn.getCredentials", { authenticatorId: mac.authenticatorId });
  check("A: exactly one resident credential on the authenticator", credentials.length === 1, credentials.length);
  const ipad = await device();
  for (const c of credentials) await ipad.cdp.send("WebAuthn.addCredential", { authenticatorId: ipad.authenticatorId, credential: c });
  const b = await ipad.page.evaluate((env) => window.spike.derive(env).catch((e) => ({ error: String(e) })), JSON.stringify(a.envelope));
  if (b.pk === a.pk) check("B: synced passkey on a second device re-derives the identical key", true, b.fingerprint);
  else skip("B: cross-device re-derivation", "CDP credential export omits hmac-secret (copied credential has no PRF: " + (b.error ?? "different key").slice(0, 60) + ") — NOT verified on real hardware: only the Node synced-store model covers it; the human Safari→iPad run is PENDING");

  // ---- authenticator without PRF → named error, no silent downgrade ----
  const dash = await device({ hasPrf: false });
  const d = await dash.page.evaluate(() => window.spike.create().then(() => "no error", (e) => String(e)));
  check("no-PRF authenticator surfaces PRF_UNSUPPORTED", /PRF_UNSUPPORTED/.test(d), d.slice(0, 120));

  // ---- P256 binding: same passkey signs a Letterlock challenge; Monad's 0x0100 verifies it ----
  const p = await device();
  const bind = await p.page.evaluate(() => window.spike.p256().catch((e) => ({ verdict: "ERROR", error: String(e) })));
  check("P256: ES256 key captured through a mera WebAuthnClient + assertion over the bound challenge", bind.verdict === "PENDING_ONCHAIN", bind.verdict + (bind.error ?? bind.reason ?? ""));
  let onchain = {};
  if (bind.verdict === "PENDING_ONCHAIN") {
    check("P256: clientDataJSON type/challenge/origin, rpIdHash, UP+UV flags all match", bind.clientDataOk && bind.rpIdHashOk && bind.upFlag && bind.uvFlag);
    check("P256: WebCrypto verifies the signature", bind.webcryptoOk);
    for (const [net, rpc] of Object.entries(RPC)) {
      const good = await ethCall(rpc, bind.precompileInput), bad = await ethCall(rpc, bind.tamperedInput);
      onchain[net] = { good, bad };
      check(`P256: Monad ${net} 0x0100 verifies the passkey's signature over h (signature only — not yet an ownership proof)`, good === "0x" + "0".repeat(63) + "1", good);
      check(`P256: Monad ${net} 0x0100 rejects a 1-bit-tampered hash`, bad === "0x" || bad === "0x" + "0".repeat(64), bad);
    }
  }
  const pageErrors = [mac, ipad, dash, p].flatMap((d) => d.errors);
  check("no uncaught page errors", pageErrors.length === 0, pageErrors);
  writeFileSync(new globalThis.URL("./spike-result.json", import.meta.url), JSON.stringify({
    chromium: browser.version(), when: new Date().toISOString(), checks,
    deviceA: { fingerprint: a.fingerprint, credentialId: a.credentialId }, deviceB: { fingerprint: b.fingerprint ?? null, error: b.error ?? null },
    p256: { ...bind, onchain },
  }, null, 1));
} finally {
  await browser.close(); await server.close();
}
const failed = checks.filter((c) => c.ok === false), skipped = checks.filter((c) => c.ok === null);
console.log(`\n${checks.length - failed.length - skipped.length}/${checks.length} checks passed · ${skipped.length} skipped · ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
