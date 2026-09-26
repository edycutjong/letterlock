// The hand-off link that carries a sealed note from one device to another:
//   <origin>/#env=<base64url(JSON envelope)>&cid=<credential id>&who=<passkey name>
// Everything after "#" stays in the browser — it is never sent to the server that hosts this page.
// `env` is the note. `cid` and `who` only help diagnose a failed open (same passkey or another one?); neither is
// needed to open the note, and the second device still looks the passkey up discoverably.
import { fromB64url, parseEnvelope, toB64url, type Envelope } from "letterlock";

export type Handoff = { readonly env: Envelope; readonly cid?: string; readonly who?: string };

const CID = /^[A-Za-z0-9_-]{1,1400}$/;
export const KID = /^[0-9a-f]{16}$/;

export const handoffUrl = (h: Handoff, base: string): string => {
  const p = new URLSearchParams();
  p.set("env", toB64url(new TextEncoder().encode(JSON.stringify(h.env))));
  if (h.cid) p.set("cid", h.cid);
  if (h.who) p.set("who", h.who);
  return `${base}#${p.toString()}`;
};

/** null when the fragment carries no note; throws when it carries a damaged one (truncated or edited link). */
export const readHandoff = (hash: string): Handoff | null => {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const raw = p.get("env");
  if (raw === null) return null;
  let env: Envelope;
  try {
    env = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64url(raw))) as Envelope;
    parseEnvelope(env); // header + canonical base64url checks, no crypto
  } catch (cause) {
    throw new Error("DAMAGED_LINK: the note in this link is incomplete or altered", { cause });
  }
  const cid = p.get("cid");
  const who = p.get("who");
  return { env, ...(cid && CID.test(cid) ? { cid } : {}), ...(who ? { who: who.slice(0, 40) } : {}) };
};
