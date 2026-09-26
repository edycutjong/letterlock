// Human cross-device test (Mac → iPad) and window.spike for the automated Chromium runs (run-spike.mjs,
// check-page.mjs). No passkey prompt ever starts by itself: each ceremony starts from a tap, and nothing is awaited
// between the tap and the WebAuthn call, because Safari needs the tap's user activation.
import QRCode from "qrcode";
import {
  createEncryptionAddress, deriveFromPasskey, fingerprint, isLetterlockError, open, parseEnvelope, seal, toHex,
  type Envelope,
} from "letterlock";
import { ceremonies, observeCeremonies, prfArrival, type Ceremony } from "./ceremonies.ts";
import { KID, handoffUrl, readHandoff, type Handoff } from "./link.ts";
import { p256BindingCheck } from "./p256.ts";

declare const __LL_BUILD__: string;
const BUILD = typeof __LL_BUILD__ === "string" ? __LL_BUILD__ : "dev";

// Spike only: rpId follows the host. Production pins ONE rpId (docs/SPEC.md §6) — keys derived under
// localhost or a preview domain can never be re-derived on the production domain.
const rp = { id: location.hostname, name: "Letterlock" };
const BIND = { chainId: 143, directory: "0x00000000000000000000000000000000000000aa", owner: "0x0000000000000000000000000000000000000001" } as const;
// Placeholder header for the self-addressed test note. This page reads nothing from and writes nothing to Monad.
const NOTE_TO = { chainId: 10143, directory: "0x00000000000000000000000000000000000000aa", recipient: "0x0000000000000000000000000000000000000001" } as const;
const DEFAULT_NOTE = "the dentist moved to Thursday 10:40";
const MAX_NOTE_BYTES = 200; // keeps the hand-off QR code small enough to scan off a laptop screen

const observing = observeCeremonies();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const utf8 = (s: string) => new TextEncoder().encode(s);
const group = (fp: string) => (fp.match(/.{1,4}/g) ?? [fp]).join(" ");
const pageBase = () => location.origin + location.pathname;
const hhmm = () => new Date().toTimeString().slice(0, 5);

// ---------- per-device storage (a convenience only: the link carries the note, the passkey carries the key) ----------
type StoreKey = "ll.cred" | "ll.fp" | "ll.env" | "ll.name";
const store = {
  get: (k: StoreKey) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: StoreKey, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off: the link still works */ } },
  remove: (...ks: StoreKey[]) => { try { for (const k of ks) localStorage.removeItem(k); } catch { /* nothing stored */ } },
};
const json = <T>(raw: string | null): T | null => { try { return raw === null ? null : (JSON.parse(raw) as T); } catch { return null; } };
const storedCredential = () => {
  const c = json<{ credentialId?: unknown; transports?: unknown }>(store.get("ll.cred"));
  return c && typeof c.credentialId === "string"
    ? { credentialId: c.credentialId, ...(Array.isArray(c.transports) ? { transports: c.transports as string[] } : {}) }
    : null;
};

// ---------- device + browser facts ----------
const BROWSERS: [string, RegExp][] = [["Edge", /EdgA?\/([\d.]+)/], ["Chrome", /(?:CriOS|Chrome)\/([\d.]+)/], ["Firefox", /(?:FxiOS|Firefox)\/([\d.]+)/], ["Safari", /Version\/([\d.]+).*Safari/]];
const deviceLabel = (): string => {
  const ua = navigator.userAgent;
  // iPadOS Safari sends a Mac user agent by default; touch support gives it away
  const os = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
    : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "unknown OS";
  const hit = BROWSERS.map(([name, re]) => [name, ua.match(re)?.[1]] as const).find(([, v]) => v);
  return `${hit ? `${hit[0]} ${hit[1]}` : "unknown browser"} on ${os}`;
};
const isTablet = () => /iPad|iPhone|Android/.test(deviceLabel());

let prfSupport = "checking…";
const checkPrfSupport = async (): Promise<string> => {
  if (!window.isSecureContext) return "blocked: this page is not on HTTPS";
  if (typeof PublicKeyCredential === "undefined") return "none: this browser has no passkeys";
  const gcc = (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities;
  if (typeof gcc !== "function") return "not reported by this browser (the test will tell)";
  try {
    const v = (await gcc.call(PublicKeyCredential))["extension:prf"];
    return v === true ? "reported: yes" : v === false ? "reported: no" : "not reported (the test will tell)";
  } catch { return "not reported (the test will tell)"; }
};

// ---------- reports: the same lines feed the on-screen list and the copied text ----------
type Verdict = { level: "pass" | "fail" | "retry" | "info"; text: string };
type Report = { title: string; verdict?: Verdict; fingerprint?: string; lines: [string, string][]; data: Record<string, unknown> };
let lastReport: Report | null = null;

const commonLines = (): [string, string][] => [
  ["Passkey address (rpId)", rp.id],
  ["Device", deviceLabel()],
  ["PRF support", prfSupport],
  ["User agent", navigator.userAgent],
  ["Page", `${pageBase()} · build ${BUILD}`],
  ["Time", new Date().toISOString()],
];
const reportText = (r: Report) => [
  `Letterlock cross-device passkey test — ${r.title}`,
  ...(r.verdict ? [`Result: ${r.verdict.level.toUpperCase()} — ${r.verdict.text}`] : []),
  ...(r.fingerprint ? [`Fingerprint: ${group(r.fingerprint)}`] : []),
  ...r.lines.map(([k, v]) => `${k}: ${v}`),
  "",
  JSON.stringify({ ...r.data, userAgent: navigator.userAgent, rpId: rp.id, build: BUILD }),
].join("\n");

const promptLine = (cs: readonly Ceremony[]) => {
  const n = cs.length;
  const arrival = prfArrival(cs);
  const how = arrival === "create" ? "the PRF output came with the creation"
    : arrival === "fallback" ? "the PRF output needed a second prompt (mera's fallback assertion)" : "no PRF output";
  return `${n}${cs.some((c) => c.kind === "create") ? ` — ${how}` : ""}${n ? ` (${cs.map((c) => `${c.kind} ${c.ms} ms${c.attachment ? `, ${c.attachment}` : ""}`).join("; ")})` : ""}`;
};
const attachmentLine = (a: string | undefined) =>
  a === "platform" ? "this device (a passkey stored here, e.g. synced by iCloud Keychain)"
    : a === "cross-platform" ? "ANOTHER device over hybrid (QR / Bluetooth) or a security key — not the synced copy"
    : "not reported by this browser";

// ---------- rendering ----------
const log = <T>(o: T): T => { $("log").textContent += "\n" + JSON.stringify(o, null, 1); return o; };

const showFingerprint = (el: HTMLElement, fp: string) => {
  el.replaceChildren(...group(fp).split(" ").map((g) => Object.assign(document.createElement("span"), { textContent: g })));
  el.setAttribute("aria-label", `Key fingerprint ${group(fp)}`);
};

const reveal = (el: HTMLElement) => {
  const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
};

const setNext = (step: "create" | "derive" | null) => {
  $("step-create").classList.toggle("is-next", step === "create");
  $("step-derive").classList.toggle("is-next", step === "derive");
};

const renderReport = (r: Report, opened?: string | null) => {
  lastReport = r;
  $("result").hidden = false;
  $("result-title").textContent = r.title;
  if (r.fingerprint) showFingerprint($("fp"), r.fingerprint);
  const v = $("verdict");
  v.hidden = !r.verdict;
  if (r.verdict) { v.className = `verdict ${r.verdict.level}`; v.textContent = r.verdict.text; }
  $("letter").hidden = opened == null;
  $("opened").textContent = opened ?? "";
  $("facts").replaceChildren(...r.lines.flatMap(([k, val]) => [
    Object.assign(document.createElement("dt"), { textContent: k }),
    Object.assign(document.createElement("dd"), { textContent: val }),
  ]));
  $("copy-status").textContent = "";
  $<HTMLTextAreaElement>("copy-fallback").hidden = true;
};

const renderSaved = () => {
  const cred = storedCredential();
  const fp = store.get("ll.fp");
  const name = store.get("ll.name");
  const el = $("saved");
  if (cred) {
    el.textContent = `This device made the passkey “${name ?? "maya"}”${fp ? ` (key ${group(fp)})` : ""}. “2 · Use my passkey” re-checks it here with a credential hint.`;
  } else if (isTablet() && !handoff) {
    el.textContent = "On the iPad? Don't create a passkey here. Open this page from the Mac's QR code, then tap “2 · Use my passkey”.";
  } else {
    el.textContent = "";
  }
  el.hidden = el.textContent === "";
};

const renderHandoff = async (link: string, fp: string, who: string, forIpad: boolean) => {
  $("handoff").hidden = false;
  $("handoff").querySelector("h2")!.textContent = forIpad ? "Now take the note to your iPad" : "Take this note to your other device";
  $("handoff-host").textContent = rp.id;
  $("handoff-who").textContent = `“${who}”`;
  $("handoff-fp").textContent = group(fp);
  const a = $<HTMLAnchorElement>("link");
  a.href = link;
  const env = new URLSearchParams(new URL(link).hash.slice(1)).get("env") ?? "";
  a.textContent = `${pageBase()}#env=${env.slice(0, 12)}… (${link.length} characters)`;
  $("link-status").textContent = "";
  $("share-link").hidden = typeof navigator.share !== "function";
  const canvas = $<HTMLCanvasElement>("qr");
  await QRCode.toCanvas(canvas, link, { errorCorrectionLevel: "M", margin: 4, width: 720, color: { dark: "#000000", light: "#ffffff" } });
  canvas.style.removeProperty("width"); // qrcode pins the drawing size; the stylesheet sizes it for the screen
  canvas.style.removeProperty("height");
};

// ---------- errors ----------
const codeOf = (e: unknown): string =>
  isLetterlockError(e) ? e.code : (/^([A-Z_]{3,}):/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? "UNEXPECTED");
const causeChain = (e: unknown): string => {
  const parts: string[] = [];
  for (let c: unknown = e, i = 0; c != null && i < 5; c = (c as { cause?: unknown }).cause, i++) {
    parts.push(c instanceof Error || (typeof c === "object" && "message" in (c as object)) ? `${(c as Error).name}: ${(c as Error).message}` : String(c));
  }
  return parts.join(" ← ");
};
const HYBRID_HINT = "The passkey was used from ANOTHER device (hybrid / QR), and Safari 18.x can return no PRF output or a different one that way. Wait until the passkey shows in this device's Passwords app, then tap 2 again and pick it here.";
const friendly = (code: string, ctx: { savedName?: string; recovered?: boolean; hybrid?: boolean; creating?: boolean }) => {
  if (ctx.hybrid && (code === "PRF_UNSUPPORTED" || code === "WRONG_KEY")) return HYBRID_HINT;
  switch (code) {
    case "PRF_UNSUPPORTED":
      return "This browser or passkey provider does not return the passkey's PRF output, so no key can be made. Use Safari 18 or newer with iCloud Keychain, not a third-party password manager."
        + (ctx.savedName ? ` A passkey named “${ctx.savedName}” was still saved; you can delete it in the Passwords app.` : "");
    case "PASSKEY_FAILED":
      return ctx.recovered
        ? `The passkey “${ctx.savedName}” was saved, but the browser stopped before it returned the key. Tap “2 · Use my passkey” on this device to finish (one more prompt).`
        : ctx.creating
          ? "The passkey prompt was cancelled or timed out. Tap “1 · Create” to try again."
          : `The passkey prompt was cancelled or timed out, or this device has no passkey for ${rp.id} yet. On the iPad, wait a minute for iCloud Keychain to sync, then tap again.`;
    case "DAMAGED_LINK": return "The link is incomplete or was changed. Scan the Mac's QR code again.";
    case "TAMPERED": return "The note in this link was changed or cut off. Open the link from the Mac again.";
    case "INPUT_INVALID": return "The note in this link is not a valid Letterlock note.";
    case "NOTE_TOO_LONG": return `Keep the note under ${MAX_NOTE_BYTES} bytes so the QR code stays easy to scan.`;
    default: return "An unexpected error happened. Tap “Copy result” (or “Copy details”) and send it along.";
  }
};

const showError = (e: unknown, ctx: { step: string; ceremonies?: readonly Ceremony[]; savedName?: string; recovered?: boolean; hybrid?: boolean; creating?: boolean }) => {
  const code = codeOf(e);
  $("error").hidden = false;
  $("error-title").textContent = ctx.recovered ? "Almost there: one more tap" : `That didn't work (${code})`;
  $("error-text").textContent = friendly(code, ctx);
  $("error-raw").textContent = causeChain(e);
  $("copy-error-status").textContent = "";
  $<HTMLTextAreaElement>("copy-error-fallback").hidden = true;
  lastReport = {
    title: `${ctx.step} failed`,
    verdict: { level: ctx.recovered ? "retry" : "fail", text: `${code}: ${friendly(code, ctx)}` },
    lines: [["Error", causeChain(e)], ...(ctx.ceremonies ? [["Passkey prompts", promptLine(ctx.ceremonies)] as [string, string]] : []), ...commonLines()],
    data: { step: ctx.step, error: causeChain(e), ceremonies: ctx.ceremonies ?? [] },
  };
  $("error").scrollIntoView({ block: "nearest" });
};
const clearError = () => { $("error").hidden = true; };

// ---------- the link that brought this page (if any) ----------
let handoff: Handoff | null = null;
const loadHandoff = () => {
  clearError();
  try { handoff = readHandoff(location.hash); } catch (e) { handoff = null; showError(e, { step: "open link" }); }
  $("incoming").hidden = !handoff;
  if (handoff) {
    $("incoming-kid").textContent = KID.test(handoff.env.kid) ? group(handoff.env.kid) : "(unknown)";
    $("incoming-who-wrap").hidden = !handoff.who;
    $("incoming-who").textContent = handoff.who ? `“${handoff.who}”` : "";
  }
  setNext(handoff ? "derive" : "create");
  $("step-create").classList.toggle("is-quiet", !!handoff);
  renderSaved();
};

// ---------- actions ----------
const ACTIONS = ["create", "derive", "p256"] as const;
const busy = (on: boolean, which?: (typeof ACTIONS)[number]) => {
  for (const id of ACTIONS) {
    const b = $<HTMLButtonElement>(id);
    b.disabled = on;
    if (on && id === which) { b.dataset.label = b.textContent ?? ""; b.textContent = "Waiting for your passkey…"; b.setAttribute("aria-busy", "true"); }
    if (!on && b.dataset.label !== undefined) { b.textContent = b.dataset.label; delete b.dataset.label; b.removeAttribute("aria-busy"); }
  }
};

const noteText = () => $<HTMLInputElement>("note").value.trim() || DEFAULT_NOTE;

const sealNote = (publicKey: Uint8Array, epoch: number, text: string) =>
  seal({ chainId: NOTE_TO.chainId, directory: NOTE_TO.directory, to: { recipient: NOTE_TO.recipient, publicKey, epoch }, plaintext: utf8(text) });

/** 1 · Create: new passkey → epoch-1 key → a note sealed to it → the hand-off link + QR code. */
const create = async (text: string = noteText()) => {
  clearError();
  const plaintext = utf8(text);
  if (plaintext.length > MAX_NOTE_BYTES) {
    const e = new Error(`NOTE_TOO_LONG: ${plaintext.length} bytes`);
    showError(e, { step: "1 · Create" });
    throw e;
  }
  const name = `maya ${hhmm()}`;
  const mark = ceremonies.length;
  busy(true, "create");
  try {
    const { keys, credential } = await createEncryptionAddress({ rp, user: { name, displayName: name } });
    const fp = fingerprint(keys.publicKey);
    const pk = toHex(keys.publicKey);
    const env = await sealNote(keys.publicKey, keys.epoch, text);
    keys.secretKey.fill(0); // sealing needs only the public key
    store.set("ll.cred", JSON.stringify(credential));
    store.set("ll.fp", fp);
    store.set("ll.name", name);
    store.set("ll.env", JSON.stringify(env));
    handoff = { env, cid: credential.credentialId, who: name };
    const link = handoffUrl(handoff, pageBase());
    history.replaceState(null, "", link); // the address bar now carries the note too
    const cs = ceremonies.slice(mark);
    const result = { step: "create", fingerprint: fp, pk, credentialId: credential.credentialId, passkeyName: name, envelope: env, link, prompts: cs.length, prfAt: prfArrival(cs), ceremonies: cs };
    $("incoming").hidden = true;
    $("step-create").classList.remove("is-quiet");
    setNext(null);
    renderSaved();
    renderReport({
      title: "Passkey created — its key's fingerprint",
      verdict: { level: "info", text: "Now open the link on the iPad. It must show this same fingerprint." },
      fingerprint: fp,
      lines: [
        ["Passkey prompts", promptLine(cs)],
        ["Passkey name", name],
        ["Credential ID", credential.credentialId],
        ["Note sealed", `“${text}” (${plaintext.length} bytes) → ${env.ct.length}-character ciphertext in the link`],
        ...commonLines(),
      ],
      data: { step: "create", fingerprint: fp, pk, credentialId: credential.credentialId, prompts: cs.length, prfAt: result.prfAt, ceremonies: cs },
    }, null);
    await renderHandoff(link, fp, name, !isTablet());
    reveal($("result"));
    return log(result);
  } catch (e) {
    const cs = ceremonies.slice(mark);
    const made = cs.find((c) => c.kind === "create" && c.ok);
    // mera's fallback assertion failed AFTER the passkey was saved: keep it as this device's hint so
    // "2 · Use my passkey" can finish here, and drop any older run's note so the hint is the one used
    const recovered = !!made?.credentialId && made.prf === "enabled-only" && !isLetterlockError(e, "PRF_UNSUPPORTED");
    if (recovered) {
      store.set("ll.cred", JSON.stringify({ credentialId: made!.credentialId, ...(made!.transports ? { transports: made!.transports } : {}) }));
      store.set("ll.name", name);
      store.remove("ll.fp", "ll.env");
      handoff = null;
      history.replaceState(null, "", pageBase());
      $("incoming").hidden = true;
      setNext("derive");
      renderSaved();
    }
    showError(e, { step: "1 · Create", ceremonies: cs, ...(made ? { savedName: name } : {}), recovered, creating: true });
    log({ step: "create", error: causeChain(e), ceremonies: cs });
    throw e;
  } finally {
    busy(false);
  }
};

/**
 * 2 · Use my passkey: derive the key (credential hint only when THIS device created the passkey that sealed the
 * note; otherwise a discoverable lookup), then open the note. With no note, seal a fresh one for the other device.
 */
const derive = async (envJson?: string) => {
  clearError();
  // --- synchronous until deriveFromPasskey: keeps the tap's user activation for Safari ---
  let env: Envelope | null;
  try {
    env = envJson !== undefined ? (JSON.parse(envJson) as Envelope) : handoff?.env ?? json<Envelope>(store.get("ll.env"));
    if (env) parseEnvelope(env); // a malformed note must not cost a passkey prompt
  } catch (e) { showError(e, { step: "2 · Use my passkey" }); throw e; }
  const hint = storedCredential();
  const useHint = hint !== null && (env === null || env.kid === store.get("ll.fp"));
  const path = useHint ? "credential-hint" : "discoverable";
  const link = handoff;
  // the link's cid describes the link's note only
  const linkCid = link?.cid && env && env.enc === link.env.enc && env.ct === link.env.ct ? link.cid : null;
  const mark = ceremonies.length;
  busy(true, "derive");
  const t0 = performance.now();
  try {
    const keys = await deriveFromPasskey({ rpId: rp.id, epoch: env?.epoch ?? 1, ...(useHint ? { credential: hint } : {}) });
    const ceremonyMs = Math.round(performance.now() - t0);
    const fp = fingerprint(keys.publicKey);
    const pk = toHex(keys.publicKey);
    let opened: string | null = null;
    let openError: unknown = null;
    let sealed: Envelope | null = null;
    try {
      if (env) opened = new TextDecoder().decode(await open(env, keys));
      else sealed = await sealNote(keys.publicKey, keys.epoch, noteText());
    } catch (e) { openError = e; } finally { keys.secretKey.fill(0); }
    const cs = ceremonies.slice(mark);
    const sameCredential = linkCid === null ? null : linkCid === keys.credentialId;
    const attachment = cs.find((c) => c.kind === "get" && c.ok)?.attachment;
    const hybrid = attachment === "cross-platform";
    const verdict: Verdict = !env
      ? { level: "info", text: "No note in this link. Compare this fingerprint with your other device by eye." }
      : opened !== null
        ? { level: "pass", text: hybrid ? "Same key — the note opened, but through ANOTHER device (hybrid), not the passkey synced to this one." : "Same key — the note opened on this device." }
      : hybrid ? { level: "retry", text: HYBRID_HINT }
      : isLetterlockError(openError, "WRONG_KEY")
        ? sameCredential === true
          ? { level: "fail", text: "Same passkey as the other device, but a DIFFERENT key: its PRF output did not match across devices. Please send this result." }
          : sameCredential === false
            ? { level: "retry", text: `A different passkey was chosen. Tap 2 again and choose ${link?.who ? `“${link.who}”` : "the passkey the Mac made"}.` }
            : { level: "fail", text: "Different key: either another passkey was chosen, or the PRF output differs across devices." }
        : { level: "fail", text: `The note did not open (${codeOf(openError)}). ${friendly(codeOf(openError), {})}` };
    const result = {
      step: "derive", path, attachment: attachment ?? null, fingerprint: fp, pk, credentialId: keys.credentialId, ceremonyMs, opened,
      openError: openError ? causeChain(openError) : null, noteSealedTo: env?.kid ?? null, sameCredential,
      prompts: cs.length, ceremonies: cs, verdict: verdict.level,
    };
    if (sealed) {
      if (useHint) { store.set("ll.fp", fp); store.set("ll.env", JSON.stringify(sealed)); }
      handoff = { env: sealed, cid: keys.credentialId, ...(store.get("ll.name") && useHint ? { who: store.get("ll.name")! } : {}) };
      history.replaceState(null, "", handoffUrl(handoff, pageBase()));
    }
    renderReport({
      title: "This device's key fingerprint",
      verdict,
      fingerprint: fp,
      lines: [
        ...(env ? [["Note was sealed to", KID.test(env.kid) ? group(env.kid) : "(unknown)"] as [string, string]] : []),
        ["Lookup", path === "discoverable" ? "discoverable — no saved passkey on this device; the passkey was found by name" : "credential hint — this device created the passkey"],
        ["Passkey prompts", promptLine(cs)],
        ["Passkey used from", attachmentLine(attachment)],
        ["Same passkey as the link", sameCredential === null ? "unknown" : sameCredential ? "yes" : "no"],
        ["Credential ID", keys.credentialId],
        ...(openError ? [["Open error", causeChain(openError)] as [string, string]] : []),
        ...commonLines(),
      ],
      data: { step: "derive", verdict: verdict.level, path, attachment: attachment ?? null, fingerprint: fp, pk, noteSealedTo: env?.kid ?? null, opened, sameCredential, credentialId: keys.credentialId, prompts: cs.length, ceremonies: cs },
    }, opened);
    if (sealed) await renderHandoff(location.href, fp, handoff?.who ?? "your passkey", false);
    else $("handoff").hidden = true;
    setNext(null);
    reveal($("result"));
    return log(result);
  } catch (e) {
    const cs = ceremonies.slice(mark);
    showError(e, { step: "2 · Use my passkey", ceremonies: cs, hybrid: cs.some((c) => c.kind === "get" && c.attachment === "cross-platform") });
    log({ step: "derive", path, error: causeChain(e), ceremonies: cs });
    throw e;
  } finally {
    busy(false);
  }
};

const p256 = async () => {
  clearError();
  busy(true, "p256");
  try { return log(await p256BindingCheck(rp, BIND)); }
  catch (e) { showError(e, { step: "3 · P256 binding check" }); throw e; }
  finally { busy(false); }
};

// ---------- clipboard ----------
const copy = async (text: string, status: HTMLElement, fallback?: HTMLTextAreaElement) => {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = "Copied.";
    return;
  } catch { /* fall through: older browsers, denied permission */ }
  if (fallback) {
    fallback.hidden = false;
    fallback.value = text;
    fallback.focus();
    fallback.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    status.textContent = ok ? "Copied." : "Select the text below and copy it.";
  } else {
    status.textContent = "Copy failed — press and hold the link to copy it.";
  }
};

// ---------- wiring ----------
const quiet = (f: () => Promise<unknown>) => () => { f().catch(() => { /* already shown on the page */ }); };
$("create").addEventListener("click", quiet(() => create()));
$("derive").addEventListener("click", quiet(() => derive()));
$("p256").addEventListener("click", quiet(p256));
$("copy").addEventListener("click", quiet(async () => {
  if (lastReport) await copy(reportText(lastReport), $("copy-status"), $<HTMLTextAreaElement>("copy-fallback"));
}));
$("copy-error").addEventListener("click", quiet(async () => {
  if (lastReport) await copy(reportText(lastReport), $("copy-error-status"), $<HTMLTextAreaElement>("copy-error-fallback"));
}));
$("copy-link").addEventListener("click", quiet(() => copy($<HTMLAnchorElement>("link").href, $("link-status"))));
$("share-link").addEventListener("click", quiet(async () => {
  try { await navigator.share({ title: "Letterlock note", url: $<HTMLAnchorElement>("link").href }); }
  catch (e) { if ((e as Error)?.name !== "AbortError") $("link-status").textContent = "Sharing failed — copy the link instead."; }
}));
$("forget").addEventListener("click", () => {
  store.remove("ll.cred", "ll.fp", "ll.env", "ll.name");
  renderSaved();
  log({ step: "forget", note: "saved passkey hint removed: the next “2 · Use my passkey” is a discoverable lookup" });
});
$("reset").addEventListener("click", () => {
  store.remove("ll.cred", "ll.fp", "ll.env", "ll.name");
  location.replace(pageBase());
});
window.addEventListener("hashchange", () => { loadHandoff(); $("result").hidden = true; $("handoff").hidden = true; });

$("rpid").textContent = rp.id;
$("device").textContent = deviceLabel();
$("build").textContent = BUILD;
if (!observing) log({ warning: "navigator.credentials missing: passkeys are unavailable in this browser" });
loadHandoff();
void checkPrfSupport().then((s) => { prfSupport = s; $("prfcap").textContent = s; });

Object.assign(window, { spike: { create, derive, p256: () => p256BindingCheck(rp, BIND) } });
