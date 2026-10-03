# Security policy

Letterlock is a hackathon project (Monad Metropolis, 2026), live on Monad mainnet. The directory contract is
immutable; the SDK, the app and the agent are fixed by release.

## Supported versions

| Component | Supported |
|---|---|
| `letterlock` on npm, the latest version | ✅ |
| `letterlock` 0.1.0 | ❌ pins the retired rpId `letterlock-app.vercel.app`: install the latest version |
| The directory at `0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e` (mainnet, chain 143) | ✅ (immutable: a fix is a new deploy) |
| `main` | ✅ |

## Reporting a vulnerability

Please do not open a public issue. Report it privately:

- GitHub's [private vulnerability reporting](https://github.com/edycutjong/letterlock/security/advisories/new)
  (Security → Report a vulnerability), or
- email **edy.cu@live.com**.

You will get an acknowledgment within 48 hours and a timeline after triage. Please allow a reasonable window for a fix
before disclosure.

## Known limits (not vulnerabilities)

The README's [Honest limits](../README.md#honest-limits-14) are part of the design and are stated there in full: among
them, HPKE base mode is anonymous (anyone can seal to anyone), drop metadata is public, there is no recovery if every
copy of a passkey is lost, whoever serves the rpId `app.letterlock.edycu.dev` can derive every key, and `keyOf` reads
trust the RPC. A report that one of these can be broken further than stated there is in scope.
