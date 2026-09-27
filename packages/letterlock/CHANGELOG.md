# Changelog

## 0.1.1 (2026-09-28)

- **The rpId moves to the owner's own domain.** `LETTERLOCK_RP_ID` is now `app.letterlock.edycu.dev`, a subdomain of
  edycu.dev, where the Letterlock app is served. 0.1.0 pinned `letterlock-app.vercel.app`, a Vercel project name,
  which now answers every request with a 308 to the new host, so no key is made under it. The directories, the
  envelope format and every API are unchanged.
- **Keys derived under `letterlock-app.vercel.app` cannot be re-derived under the new rpId**: a PRF output is bound to
  its rpId. The only ones are test keys from the app's live checks, made with virtual passkeys that were deleted after
  each run: the key `0x4f48fbc6ea52aeB96e93EfB2464798d18F84463C` published on mainnet, and the passkey accounts of
  those runs. The directory's demo keys came from random stand-ins and the reference agent's key from a seed, so no
  rpId is involved in them.
- 0.1.0 cannot make or publish a key at the new host (the browser refuses its rpId there, and its client refuses any
  other): upgrade to 0.1.1 to publish. Resolving, sealing and reading an inbox work the same in both.

## 0.1.0 (2026-09-27)

- The first release: the SDK and the `letterlock` CLI, with the Monad mainnet and testnet directories built in.
