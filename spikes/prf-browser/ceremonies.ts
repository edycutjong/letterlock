// Counts WebAuthn ceremonies (= passkey prompts) so the page can say whether the PRF output arrived with the
// creation (1 prompt) or needed mera's fallback assertion (2 prompts).
//
// Why not a wrapping WebAuthnClient: mera 0.2.0 does not export its built-in browser client, so a wrapper would
// have to REPLACE mera's client with a copy, and the human Safari run would then test the copy instead of mera.
// Observing the two browser calls keeps mera's own client — and its create → fallback-assertion logic — under
// test unchanged. The observer never alters a request or a result, and it calls the original synchronously, so
// the tap's user activation still reaches the passkey prompt.

export type Ceremony = {
  readonly kind: "create" | "get";
  /** get only: an allowCredentials entry was sent ("credential-hint") or none was ("discoverable"). */
  readonly lookup?: "credential-hint" | "discoverable";
  /** What the PRF extension returned: an output, `enabled` without an output (create only), or nothing. */
  readonly prf: "output" | "enabled-only" | "none";
  readonly ok: boolean;
  readonly ms: number;
  /** Credential that answered, canonical unpadded base64url. */
  readonly credentialId?: string;
  readonly transports?: readonly string[];
  /**
   * PublicKeyCredential.authenticatorAttachment: "platform" = a passkey stored on this device (iCloud Keychain),
   * "cross-platform" = another device over hybrid (QR / Bluetooth) or a security key. Safari 18.x has returned a
   * different PRF value over hybrid than on-device, so the cross-device test must stay on "platform".
   */
  readonly attachment?: string;
  /** DOMException name and message when the ceremony failed. */
  readonly error?: string;
};

type PrfResults = { enabled?: boolean; results?: { first?: unknown } };

/** Every ceremony since page load, oldest first. Callers slice from a mark taken before their action. */
export const ceremonies: Ceremony[] = [];

const b64url = (buf: ArrayBuffer): string => {
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const elapsed = (t0: number) => Math.round(performance.now() - t0);
const errorText = (e: unknown) =>
  e instanceof Error || (typeof e === "object" && e !== null && "name" in e) ? `${(e as Error).name}: ${(e as Error).message}` : String(e);

const describe = (kind: Ceremony["kind"], cred: Credential | null, t0: number, lookup?: Ceremony["lookup"]): Ceremony => {
  const pkc = cred as PublicKeyCredential | null;
  const prf = pkc?.getClientExtensionResults?.()?.prf as PrfResults | undefined;
  const transports = kind === "create" ? (pkc?.response as AuthenticatorAttestationResponse | undefined)?.getTransports?.() : undefined;
  return {
    kind,
    ...(lookup ? { lookup } : {}),
    prf: prf?.results?.first ? "output" : prf?.enabled === true ? "enabled-only" : "none",
    ok: true,
    ms: elapsed(t0),
    ...(pkc?.rawId ? { credentialId: b64url(pkc.rawId) } : {}),
    ...(transports ? { transports } : {}),
    ...(typeof pkc?.authenticatorAttachment === "string" ? { attachment: pkc.authenticatorAttachment } : {}),
  };
};

/** Installs the observer once. Returns false when this browser has no navigator.credentials at all. */
export const observeCeremonies = (): boolean => {
  const c = globalThis.navigator?.credentials as (CredentialsContainer & { __letterlockObserved?: true }) | undefined;
  if (!c || typeof c.create !== "function" || typeof c.get !== "function") return false;
  if (c.__letterlockObserved) return true;
  const create = c.create.bind(c);
  const get = c.get.bind(c);
  const define = (name: string, value: unknown) => Object.defineProperty(c, name, { configurable: true, writable: true, value });

  define("create", (options?: CredentialCreationOptions) => {
    const t0 = performance.now();
    return create(options).then(
      (cred) => { ceremonies.push(describe("create", cred, t0)); return cred; },
      (e: unknown) => { ceremonies.push({ kind: "create", prf: "none", ok: false, ms: elapsed(t0), error: errorText(e) }); throw e; },
    );
  });
  define("get", (options?: CredentialRequestOptions) => {
    const t0 = performance.now();
    const lookup = options?.publicKey?.allowCredentials?.length ? "credential-hint" : "discoverable";
    return get(options).then(
      (cred) => { ceremonies.push(describe("get", cred, t0, lookup)); return cred; },
      (e: unknown) => { ceremonies.push({ kind: "get", lookup, prf: "none", ok: false, ms: elapsed(t0), error: errorText(e) }); throw e; },
    );
  });
  define("__letterlockObserved", true);
  return true;
};

/** "create" when the creation ceremony itself returned the PRF output, "fallback" when a later assertion did. */
export const prfArrival = (cs: readonly Ceremony[]): "create" | "fallback" | "none" => {
  const made = cs.find((c) => c.kind === "create" && c.ok);
  if (made?.prf === "output") return "create";
  return cs.some((c) => c.kind === "get" && c.ok && c.prf === "output") ? "fallback" : "none";
};
