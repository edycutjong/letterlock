// A software WebAuthn authenticator implementing mera's WebAuthnClient, used to drive the REAL mera
// functions in Node. PRF follows WebAuthn L3 §10.1.4 over CTAP2 hmac-secret:
//   evalSalt = SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt);  output = HMAC-SHA256(credRandom, evalSalt)
// `syncedTo()` returns a second device sharing the same credential store — what iCloud Keychain does.
import type { WebAuthnClient } from "@category-labs/mera";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

type Cred = { id: Uint8Array; rpId: string; credRandom: Uint8Array };
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const prf = (c: Cred, salt: Uint8Array) =>
  hmac(sha256, c.credRandom, sha256(new Uint8Array([...new TextEncoder().encode("WebAuthn PRF"), 0, ...salt])));

export type SoftAuthenticator = WebAuthnClient & {
  readonly calls: { create: number; get: number };
  syncedTo(): SoftAuthenticator;
};

/** An authenticator whose PRF answers every salt with the same bytes and records the salts asked for: for fixed vectors. */
export const fixedPrfAuthenticator = (prfOutput: Uint8Array): WebAuthnClient & { readonly salts: Uint8Array[] } => {
  const salts: Uint8Array[] = [];
  return {
    salts,
    async createCredential() { throw new Error("fixedPrfAuthenticator only answers assertions"); },
    async getCredential(req) {
      salts.push(req.prfSalt.slice());
      return { credentialId: new Uint8Array(16).fill(1), prfOutput: prfOutput.slice() };
    },
  };
};

/**
 * Every Uint8Array zeroed whole (fill(0) with no range) while `f` runs, as hex of its bytes before the fill: how a test
 * sees the SDK wipe its copy of a secret. Uint8Array.prototype.fill is replaced for the duration of `f` only.
 */
export const zeroedDuring = async (f: () => Promise<unknown>): Promise<string[]> => {
  const zeroed: string[] = [];
  const own = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "fill");
  const fill = Uint8Array.prototype.fill;
  Object.defineProperty(Uint8Array.prototype, "fill", {
    configurable: true,
    writable: true,
    value: function (this: Uint8Array, value: number, ...range: number[]) {
      if (value === 0 && range.length === 0) zeroed.push(Array.from(this, (x) => x.toString(16).padStart(2, "0")).join(""));
      return fill.call(this, value, ...range);
    },
  });
  try { await f(); }
  finally {
    if (own) Object.defineProperty(Uint8Array.prototype, "fill", own);
    else delete (Uint8Array.prototype as { fill?: unknown }).fill;
  }
  return zeroed;
};

export const softAuthenticator = (
  opts: { prfAtCreate?: boolean; supportsPrf?: boolean } = {},
  store: Cred[] = [],
): SoftAuthenticator => {
  const { prfAtCreate = true, supportsPrf = true } = opts;
  const calls = { create: 0, get: 0 };
  return {
    calls,
    syncedTo: () => softAuthenticator(opts, store),
    async createCredential(req) {
      calls.create++;
      if (req.userVerification !== "required" || req.residentKey !== "required") throw new Error("mera must require UV + resident key");
      const c: Cred = { id: randomBytes(16), rpId: req.rp.id, credRandom: randomBytes(32) };
      store.push(c);
      return {
        credentialId: c.id,
        transports: ["internal", "hybrid"],
        prfEnabled: supportsPrf,
        ...(supportsPrf && prfAtCreate ? { prfOutput: prf(c, req.prfSalt) } : {}),
      };
    },
    async getCredential(req) {
      calls.get++;
      const c = store.find((x) => x.rpId === req.rpId && (!req.allowCredential || eq(x.id, req.allowCredential.credentialId)));
      if (!c) throw new Error("NotAllowedError: no credential for rp");
      return { credentialId: c.id, ...(supportsPrf ? { prfOutput: prf(c, req.prfSalt) } : {}) };
    },
  };
};
