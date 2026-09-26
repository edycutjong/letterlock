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
