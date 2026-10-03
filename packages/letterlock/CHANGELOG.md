# Changelog

## 0.1.2 (2026-10-03)

**Fixes**

- wipe the PRF output mera hands back once the key is derived, in createEncryptionAddress, deriveFromPasskey and deriveForAgent (a2a r01) ([ffd2657](https://github.com/edycutjong/letterlock/commit/ffd26579635e5b0e917d4f17fa67bf3ae3038be4))
- inbox() reads Dropped logs over the deployment's scan RPC (rpc1.monad.xyz, 1,000,000 blocks a request) when no rpcUrl is given, instead of 100 blocks a request from the deploy block (a2a r01) ([f5f56c6](https://github.com/edycutjong/letterlock/commit/f5f56c64ac855bf9418799dccf9eea9b9dfd5220))
- an rpcUrl that names the deployment's scan RPC gets its block range too (a2a r02) ([7f1a547](https://github.com/edycutjong/letterlock/commit/7f1a5479bcc9e4f2e07d98343e7d9c7eab816481))

## 0.1.1 (2026-09-28)

- **The rpId moves to the owner's own domain.** `LETTERLOCK_RP_ID` is now `app.letterlock.edycu.dev`, a subdomain of
  edycu.dev, where the Letterlock app is served. 0.1.0 pinned `letterlock-app.vercel.app`, a Vercel project name,
  which now answers every request for the app with a 308 to the new host, so no key is made under it. The
  directories, the envelope format and every API are unchanged.
- **Keys derived under `letterlock-app.vercel.app` cannot be re-derived under the new rpId**: a PRF output is bound to
  its rpId. The only ones are test keys from the app's live checks, made with virtual passkeys that were deleted after
  each run: the key `0x4f48fbc6ea52aeB96e93EfB2464798d18F84463C` published on mainnet, and the passkey accounts of
  those runs. The directory's demo keys came from random stand-ins and the reference agent's key from a seed, so no
  rpId is involved in them.
- 0.1.0 cannot make or publish a key at the new host (the browser refuses its rpId there, and its client refuses any
  other): upgrade to 0.1.1 to publish. Resolving, sealing and reading an inbox work the same in both.

## 0.1.0 (2026-09-27)

- The first release: the SDK and the `letterlock` CLI, with the Monad mainnet and testnet directories built in.
