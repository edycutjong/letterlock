// Day-1 spike. Exposes window.spike for the automated Chromium run (run-spike.mjs) and buttons for the
// human run on Safari + iPad. Every result is appended to #log as JSON.
import { createEncryptionAddress, deriveFromPasskey, fingerprint, open, seal, toHex, type Envelope } from "letterlock";
import { p256BindingCheck } from "./p256.ts";

// Spike only: rpId follows the host. Production pins ONE rpId (docs/SPEC.md §6) — keys derived under
// localhost or a preview domain can never be re-derived on the production domain.
const rp = { id: location.hostname, name: "Letterlock" };
const BIND = { chainId: 143, directory: "0x00000000000000000000000000000000000000aa", owner: "0x0000000000000000000000000000000000000001" } as const;
const logEl = document.getElementById("log")!;
const log = (o: unknown) => { logEl.textContent += "\n" + JSON.stringify(o, null, 1); return o; };

const create = async () => {
  const { keys, credential } = await createEncryptionAddress({ rp, user: { name: "maya", displayName: "Maya" } });
  localStorage.setItem("ll.cred", JSON.stringify(credential));
  // seal a note to our own key and keep only the envelope — the second device must open it
  const env = await seal({ chainId: 10143, directory: "0x00000000000000000000000000000000000000aa",
    to: { recipient: "0x0000000000000000000000000000000000000001", publicKey: keys.publicKey, epoch: 1 },
    plaintext: new TextEncoder().encode("the dentist moved to Thursday 10:40") });
  localStorage.setItem("ll.env", JSON.stringify(env));
  return log({ step: "create", fingerprint: fingerprint(keys.publicKey), pk: toHex(keys.publicKey), credentialId: credential.credentialId, envelope: env });
};

/** Uses the stored credential as an allowCredentials hint when present; discoverable lookup otherwise. */
const derive = async (envJson?: string) => {
  const stored = localStorage.getItem("ll.cred");
  const t0 = performance.now();
  const keys = await deriveFromPasskey({ rpId: rp.id, epoch: 1, ...(stored ? { credential: JSON.parse(stored) } : {}) });
  const ms = Math.round(performance.now() - t0);
  const raw = envJson ?? localStorage.getItem("ll.env");
  let opened: string | null = null;
  if (raw) opened = new TextDecoder().decode(await open(JSON.parse(raw) as Envelope, keys));
  return log({ step: "derive", path: stored ? "credential-hint" : "discoverable", fingerprint: fingerprint(keys.publicKey), pk: toHex(keys.publicKey), ceremonyMs: ms, opened });
};

const guard = (f: () => Promise<unknown>) => () => f().catch((e: unknown) => log({ error: String(e), cause: String((e as { cause?: unknown })?.cause ?? "") }));
document.getElementById("create")!.onclick = guard(create);
document.getElementById("derive")!.onclick = guard(() => derive());
document.getElementById("p256")!.onclick = guard(async () => log(await p256BindingCheck(rp, BIND)));

Object.assign(window, { spike: { create, derive, p256: () => p256BindingCheck(rp, BIND) } });
