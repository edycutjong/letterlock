# Contributing

Thanks for looking at Letterlock.

## Setup

Node.js 22.18 or later, pnpm 10, and [Foundry](https://getfoundry.sh) for the contract tests and the SDK's chain tests.

```sh
git clone --recurse-submodules https://github.com/edycutjong/letterlock && cd letterlock
pnpm install
pnpm verify          # every suite, then one screen of exact counts
```

No key or `.env` file is needed for any test. Creating and opening an address need a passkey on the pinned rpId
(`app.letterlock.edycu.dev`); see the README's Getting Started.

## Before a pull request

- `pnpm typecheck` and `pnpm verify` pass.
- A contract change: `cd contracts && forge fmt --check && forge test`, and the gas snapshot changes on purpose only.
- A behavior change comes with a test, named for what it pins.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Never commit a key, a keystore or an `.env` file: `pnpm readiness` and the gitleaks workflow scan the history.

## Bugs and ideas

Open an issue with the templates. For a security problem, follow [SECURITY.md](SECURITY.md) instead.
