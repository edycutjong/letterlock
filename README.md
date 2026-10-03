<div align="center">
  <img src="docs/assets/icon-animated.svg" alt="Letterlock icon" width="144">
  <h1>Letterlock ✉️</h1>
  <p><em>Any app can seal data only you can open: a passkey becomes an encryption address on Monad.</em></p>
  <img src="docs/assets/readme-hero-animated.svg" alt="Letterlock: an app looks up your address in the register and seals a note to your key; a wax seal presses shut over the address line, and only your passkey breaks it." width="100%">

  <p>One passkey, one encryption address, on every device the passkey syncs to.</p>

  <p><strong>Live on Monad mainnet.</strong> The directory is Sourcify-verified, resolve + seal p50 28.199 ms over N = 1,000 (<code>pnpm bench</code>), and 747 tests pass in a fresh clone (<code>pnpm verify</code>).</p>

  <br/>

  [![Landing page](https://img.shields.io/badge/%E2%9C%89%EF%B8%8F_Landing-Page-1E1B16?style=for-the-badge)](https://letterlock.edycu.dev)
  [![Pitch deck](https://img.shields.io/badge/%F0%9F%97%82%EF%B8%8F_Pitch-Deck-6E6556?style=for-the-badge)](https://letterlock.edycu.dev/pitch/)
  [![Demo video](https://img.shields.io/badge/%E2%96%B6%EF%B8%8F_Demo-Video,_2:32-A3261E?style=for-the-badge)](https://youtu.be/2tx9jVs7tbY)
  [![Pitch video](https://img.shields.io/badge/%F0%9F%8E%AC_Pitch-Video-A3261E?style=for-the-badge)](https://youtu.be/gSGjlJyhs2M)
  [![Live App](https://img.shields.io/badge/%F0%9F%9A%80_Live-App-2F5D9E?style=for-the-badge)](https://app.letterlock.edycu.dev)
  [![Judge Path](https://img.shields.io/badge/%E2%9A%96%EF%B8%8F_Judge-Path,_2_min-A3261E?style=for-the-badge)](DEMO.md)
  [![npm](https://img.shields.io/badge/%F0%9F%93%A6_npm-letterlock-CB3837?style=for-the-badge)](https://www.npmjs.com/package/letterlock)
  [![Agent](https://img.shields.io/badge/%F0%9F%A4%96_ERC--8004-Agent_10260-1B1A17?style=for-the-badge)](https://agent.letterlock.edycu.dev)
  [![Built for Monad Metropolis](https://img.shields.io/badge/Monad-Metropolis_2026-836EF9?style=for-the-badge)](https://monad.xyz/developers/hackathons/metropolis)

  <br/>

  <a href="https://youtu.be/2tx9jVs7tbY"><img src="docs/assets/letterlock-in-action.gif" alt="The live app on Monad mainnet, recorded in Safari on a Mac: Create my encryption address and the passkey prompt; the key posted to the register; agent 10260 seals a note to the new address and drops it; Open with passkey, and the wax seal breaks as the note rises. Sped-up stretches are labelled on screen." width="100%"></a>
  <p><sub>The live app on Monad mainnet with a real passkey, 18 s, silent; sped-up stretches say so on screen. Click for the full 2:32 demo.</sub></p>

  ![Monad](https://img.shields.io/badge/Monad-mainnet_143-836EF9?style=flat)
  ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
  ![Solidity](https://img.shields.io/badge/Solidity-0.8.33-363636?style=flat&logo=solidity)
  ![Next.js](https://img.shields.io/badge/Next.js_15-black?style=flat&logo=next.js)
  ![Foundry](https://img.shields.io/badge/Foundry-forge_1.8-DEA584?style=flat)
  ![HPKE](https://img.shields.io/badge/HPKE-RFC_9180-555?style=flat)
  ![Passkeys](https://img.shields.io/badge/WebAuthn-PRF_passkeys-555?style=flat)
  [![npm version](https://img.shields.io/npm/v/letterlock?style=flat)](https://www.npmjs.com/package/letterlock)
  [![License](https://img.shields.io/badge/License-MIT-yellow?style=flat)](LICENSE)
  [![CI](https://github.com/edycutjong/letterlock/actions/workflows/ci.yml/badge.svg)](https://github.com/edycutjong/letterlock/actions/workflows/ci.yml)
  [![Contracts](https://github.com/edycutjong/letterlock/actions/workflows/contracts.yml/badge.svg)](https://github.com/edycutjong/letterlock/actions/workflows/contracts.yml)
  [![CodeQL](https://github.com/edycutjong/letterlock/actions/workflows/codeql.yml/badge.svg)](https://github.com/edycutjong/letterlock/actions/workflows/codeql.yml)
  [![gitleaks](https://github.com/edycutjong/letterlock/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/edycutjong/letterlock/actions/workflows/gitleaks.yml)
  [![Release](https://img.shields.io/github/v/release/edycutjong/letterlock?style=flat)](https://github.com/edycutjong/letterlock/releases)

</div>

---

## 📸 See it in Action

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screens/home.webp" alt="Home: one passkey, one encryption address, and the Create my encryption address button"><br/><sub><b>Address.</b> One button: a passkey, its key, its account, a gas drip, and the key posted to the register.</sub></td>
    <td width="50%"><img src="docs/assets/screens/seal.webp" alt="Seal: agent:10260 found by keyOf at epoch 2, and an envelope sealed to it with a red wax seal"><br/><sub><b>Seal.</b> Type an address or <code>agent:&lt;id&gt;</code>; one <code>keyOf</code> read, then HPKE in the page. No passkey, no transaction.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/screens/open.webp" alt="Open: an inbox read from Dropped events on mainnet, one sealed letter and Open with passkey"><br/><sub><b>Open.</b> The inbox is the directory's <code>Dropped</code> events. One passkey tap cracks the seal, on any synced device.</sub></td>
    <td width="50%"><img src="docs/assets/screens/register.webp" alt="Register: every key published on Monad mainnet, newest first, each with its transaction"><br/><sub><b>Register.</b> Every <code>KeyPublished</code> event on mainnet, each linked to its transaction and labelled for what it is.</sub></td>
  </tr>
</table>

Screenshots of the production app at app.letterlock.edycu.dev on Monad mainnet, 2026-09-27, 21:33 UTC. The note in the
second one was sealed in the page to the reference agent's published key and never sent.

## 💡 The Problem & Solution

### The Problem

Every app that holds something private (a note, a medical record, an agent's memory of you) asks you to trust its
server with it, because there is no way to encrypt to a person without first exchanging keys with them. PGP asked
people to manage keys, and they did not. Wallet addresses name a person on chain, but a wallet key is for signing:
nobody can encrypt to it, and it does not follow you from your laptop to the phone you just picked up.

### The Solution

Letterlock turns the passkey you already have into an **encryption address**. Your device derives an X25519 key from
the passkey's WebAuthn PRF output and publishes only the public half to a directory contract on Monad. Anyone (an
app, a server, an AI agent) looks your address up with one `keyOf` read and seals data to it with HPKE (RFC 9180).
Only your passkey opens it, on any device the passkey syncs to ([Mac → iPad, recorded](spikes/prf-browser/README.md)). No secret of yours is stored anywhere (a server-hosted agent keeps its own seed, as any server keeps its own key), the sender needs no
key exchange with you, and ERC-8004 agents get addresses of their own (`agent:<id>`).

## 🏗️ Architecture & Tech Stack

```mermaid
flowchart LR
  P["Your passkey<br/>(any synced device)"] -- "PRF, Letterlock salt" --> K["X25519 key"]
  P -- "PRF, mera salt" --> A["Passkey account<br/>(meraAccount)"]
  A -- "publish(pub, epoch)" --> D[("Letterlock directory<br/>Monad mainnet")]
  S["Any sender:<br/>app, agent, CLI"] -- "keyOf(address)<br/>keyOfAgent(id)" --> D
  S -- "sealTo: HPKE<br/>no passkey, no tx" --> E["Envelope JSON"]
  E -- "drop(), or any channel" --> I["Your inbox"]
  I -- "one passkey tap" --> O["Plaintext"]
  K -. "re-derived to open" .-> O
```

The directory stores public keys only; `drop` emits an envelope as an event and stores nothing. The parts, one note
end to end, and every trust boundary are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the normative protocol
(derivation, envelope format, contract rules, threat model) is [docs/SPEC.md](docs/SPEC.md).

| Layer | Technology |
|---|---|
| Chain | Monad mainnet (chain 143) and testnet (10143): the Letterlock directory contract, and the ERC-8004 IdentityRegistry for agent keys |
| Contract | Solidity 0.8.33, Foundry (forge 1.8.3): unit, fuzz, invariant and mainnet-fork tests |
| Passkeys | WebAuthn PRF through [mera](https://mera.category.xyz) (`@category-labs/mera` 0.2.0): the key and the passkey's own EVM account |
| Crypto | HPKE RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305 (`@hpke/*`), HKDF and X25519 from `@noble` |
| SDK and CLI | TypeScript on viem, published as [`letterlock`](https://www.npmjs.com/package/letterlock) on npm |
| App | Next.js 15, React 19, a nonce CSP, no analytics and no third-party script, on Vercel |
| Agent | A Vercel function: ERC-8004 agent #10260 with a key derived from a seed |

## 🏆 Monad Integration

**Track: Trust, Identity & AI Infrastructure.** Letterlock is identity infrastructure: a public, verifiable map from
an address or an ERC-8004 agent to the key that seals to it, which any app or agent on Monad can read.

What runs on Monad, in the code:

- **The directory contract** ([contracts/src/Letterlock.sol](contracts/src/Letterlock.sol)): `publish`, `publishForAgent`,
  `keyOf`, `keyOfAgent`, `agentKeyRecord`, `drop`, and the `KeyPublished` and `Dropped` events the register and every
  inbox read.
- **The ERC-8004 IdentityRegistry** on Monad mainnet (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`): only an agent's
  current `ownerOf` publishes its key, and `keyOfAgent` returns zeros after a transfer or burn, so a note never goes
  to a previous owner. The reference agent is registered there as agent 10260, and its `tokenURI` is the live agent
  card.
- **mera's passkeys**: the same passkey derives the encryption key and, with mera's own salt, the EVM account that
  signs the publish, so `msg.sender` of a key is the passkey itself. The SDK calls `createPasskeyWithPrfOutput`,
  `getPasskeyPrfOutput`, `createSecp256k1SigningSession` and `toViemAccount`. mera already encrypts to yourself:
  its secret vault seals with an AES-256-GCM key derived from the passkey's PRF output, so sealing needs the
  passkey. Letterlock is the other direction: it publishes an X25519 public key, so any app, server or agent seals to
  you without your passkey, and you open with one tap.
- **The SDK's chain client** ([packages/letterlock/src/client.ts](packages/letterlock/src/client.ts)): `resolve`,
  `sealTo`, `publish`, `rotate`, `publishForAgent`, `drop` and `inbox`, over viem, with the mainnet and testnet
  directories built in.

Why Monad: a key directory is read on every seal and written once per person per rotation, so it needs reads that
cost nothing and writes that cost little. On mainnet a first publish charged 70,863 gas (0.007228026 MON) and a drop
of a 490-byte envelope 45,780 gas (0.00466956 MON), at 102 gwei. mera gives every passkey a Monad account without a
wallet extension, and the ERC-8004 registry on Monad gives agents an identity to publish keys under. A spike also
verified a passkey's P256 signature with Monad's `0x0100` precompile, the road to an onchain proof that a passkey
vouches for its key (SPEC §7).

**One honest limitation:** a passkey is bound to the site that made it, so people publish and open on the Letterlock
app (`app.letterlock.edycu.dev`, the SDK's pinned rpId), and every other app only seals to them.

## ⛓️ Live Deployment

No wallet extension anywhere: looking up a key and sealing are read-only calls, and a new address is posted by its
own passkey account, which a one-time gas drip funds.

| What | Where |
|---|---|
| Directory, Monad mainnet | [`0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e`](https://monadvision.com/address/0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e), deployed in block 108,289,180 ([tx](https://monadvision.com/tx/0x9766a31cb8910e2d1f953176454230e51388acd91fc78dc589b406d15b8f0a03)); Sourcify [exact match](https://sourcify-api-monad.blockvision.org/v2/contract/143/0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e) of the creation and runtime bytecode |
| Directory, Monad testnet | [`0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a`](https://testnet.monadvision.com/address/0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a), the same creation code, agent path disabled (no registry on testnet) |
| App | <https://app.letterlock.edycu.dev>, the WebAuthn rpId every Letterlock key is derived under, on the owner's own domain since SDK 0.1.1. The rpId 0.1.0 pinned, `letterlock-app.vercel.app`, answers every request for the app, its build's files included, with a 308 there |
| Reference agent | <https://agent.letterlock.edycu.dev>: ERC-8004 agent 10260 ([card](https://agent.letterlock.edycu.dev/.well-known/agent-card.json), `GET /health`). Its `tokenURI` still names the card at its first host, `letterlock-agent.vercel.app`, which serves the same deployment |
| Landing page and deck | <https://letterlock.edycu.dev> and <https://letterlock.edycu.dev/pitch/> |
| SDK and CLI | [`letterlock`](https://www.npmjs.com/package/letterlock) on npm: 0.1.0, published 2026-09-27, pins `letterlock-app.vercel.app`. 0.1.1 (tag `v0.1.1`) pins `app.letterlock.edycu.dev` and was tagged, never published to npm; the next release (`release.yml`) publishes this repository's SDK with provenance ([CHANGELOG](packages/letterlock/CHANGELOG.md)) |
| Records | [deployments/143.json](deployments/143.json) and [deployments/10143.json](deployments/10143.json): every transaction, the verification, the gas |

Transactions a judge can open:

- A passkey account, made by the app's live check at app.letterlock.edycu.dev in Chromium with a virtual
  authenticator (not a real passkey), publishes its own key under the new rpId:
  [gas drip](https://monadvision.com/tx/0xbb56739007c7a575ec6c2a3f1085b51c84d50e06b207d76bec9934da71b49a7a),
  [publish from the passkey account](https://monadvision.com/tx/0x28f3f506813f6f3992a87892bd44c422614990749699b12a1c65467fa6b3312c),
  and [the agent's letter to it](https://monadvision.com/tx/0x760ea678082271d53ecf404621a6b95bad1f742c020061699366c3644f80eec7),
  asked from `/judge` and listed in its inbox.
- The same at letterlock-app.vercel.app, the rpId SDK 0.1.0 pinned, on 2026-09-27:
  [gas drip](https://monadvision.com/tx/0x2d9646ea1c6d9833ae2642f184016dda9b1dbb0e93ab723eb08318c480a62acb),
  [publish from the passkey account](https://monadvision.com/tx/0xd49f881173dc3d3c2ab9cb8bb50b58dd090b3e13300715169d171844f2187ddf),
  and [the agent's letter to it](https://monadvision.com/tx/0x44428957ac2831cc02792d212e5adc802310e73f7b989b7822eb2c793d0602d9),
  opened from the inbox.
- The agent's own key at epoch 2, [`publishForAgent`](https://monadvision.com/tx/0x072dc08d72aefacbe3fe05fedd2296c857c1181fbfa9f548c7ed9322594c294b),
  and a task sealed to `agent:10260`, opened by the agent and [answered sealed to its sender](https://monadvision.com/tx/0x59d435ff0295a3e64af43ad9ab2454bca985fb37571bbd194fae7c29d83e2640).

The transactions behind each claim, with what each proves, are in [DEMO.md](DEMO.md#what-happened-on-mainnet),
every one that emitted a directory event up to block 108,575,659 among them.

## 📊 Engineering Rigor

| Metric | Value |
|---|---|
| Tests | `pnpm verify` in a fresh clone on 2026-10-03: 747 passed, 0 failed, 15 skipped, in 8 suites (SDK 227, contracts 111, PRF spike 27, app 124, agent 97, offline 73, scripts 37, readiness 51). Skipped: the SDK's 12 live checks, which run with `LIVE=1`, and 3 checks that no file, commit or message names one of the author's private planning notes, which run only next to that folder (there: 750 passed, 12 skipped) |
| Latency | resolve + seal p50 28.199 ms, p95 36.122 ms, p99 167.399 ms against Monad mainnet's public RPC, N = 1,000, 0 failed calls ([bench/RESULTS.md](bench/RESULTS.md)) |
| Sealing cost | seal alone (HPKE, local CPU) p50 4.956 ms |
| Gas, mainnet receipts | publish 70,863 · drop of 490 bytes 45,780 · `publishForAgent` 108,799 (first key) and 74,652 (rotation) |
| Offline proof | seal and open with the network taken away by the OS (`sandbox-exec` on macOS, a network namespace in CI): 73 checks, 14 envelope fixtures replayed |
| Contract | 111 forge tests: unit, fuzz, invariant, mainnet fork against the live registry, gas snapshots |
| End to end | the whole flow on testnet in Chromium with a PRF-capable virtual authenticator, and live checks on mainnet in which a passkey account published its own key, at each host the rpId has had ([records](apps/demo/e2e-results)) |
| Design QA | 25 checks and axe on 6 routes at 1280 and 390 px: 0 failures, 0 violations |
| Secrets | gitleaks over every commit's patch and every commit message ([.gitleaks.toml](.gitleaks.toml); `pnpm readiness` runs both): no leaks. The drip's and the agent's keys live in Vercel's sensitive environment variables and with the operator, never in the repository or a page's bundle: the 8 page loads of the production app on 2026-09-27 (the judges' link among them), their 18 scripts and 4 stylesheets held no secret's value or name, and none of their 95 strings of 64 hex digits is a project wallet's key |

### Attacks defeated

| Attack | Control | Test |
|---|---|---|
| Re-address an envelope to another chain, directory or recipient | HPKE `info` binds chain id, directory, recipient and epoch | [envelope.test.ts:95](packages/letterlock/test/envelope.test.ts#L95) |
| Edit the unauthenticated `kid` so the right key fails | decrypt first; the `kid` only explains a failure | [envelope.test.ts:71](packages/letterlock/test/envelope.test.ts#L71) |
| Publish a small-order or non-canonical X25519 key | the contract refuses 14 small-order encodings and any u at or above 2^255 − 19 | [Letterlock.t.sol:305](contracts/test/Letterlock.t.sol#L305), [:343](contracts/test/Letterlock.t.sol#L343) |
| Use up an address's epochs, or brick a buyer's agent slot | every epoch is the current one + 1 | [Letterlock.t.sol:246](contracts/test/Letterlock.t.sol#L246), [:450](contracts/test/Letterlock.t.sol#L450) |
| Seal to an agent's previous owner after a transfer | `keyOfAgent` resolves only for the current `ownerOf` | [Letterlock.t.sol:495](contracts/test/Letterlock.t.sol#L495), [invariant](contracts/test/LetterlockInvariant.t.sol#L334) |
| Starve the registry call so "no owner" reads as "no key" | only `ERC721NonexistentToken` means no owner; anything else reverts | [LetterlockRegistryCall.t.sol:66](contracts/test/LetterlockRegistryCall.t.sol#L66), [:135](contracts/test/LetterlockRegistryCall.t.sol#L135) |
| Publish another passkey's key under a passkey account | the client refuses a key that does not name the account's passkey, before signing | [client.test.ts:333](packages/letterlock/test/client.test.ts#L333), [:382](packages/letterlock/test/client.test.ts#L382) |
| Publish a key derived on another origin (localhost, a preview) | one pinned rpId; a key from another rpId is refused | [client.test.ts:483](packages/letterlock/test/client.test.ts#L483) |
| Make a key under the rpId 0.1.0 pinned, `letterlock-app.vercel.app` | every request for the app there, the build's `/_next/` files included, is a 308 to the app's host: no page or file of the app is served | [hosts.test.ts:21](apps/demo/test/hosts.test.ts#L21) |
| Hand an agent's server the owner's own key | `publishForAgent` takes only a key derived for that agent | [client.test.ts:601](packages/letterlock/test/client.test.ts#L601) |
| Drain the gas drip with fresh accounts, or shut the judges' lane by sending it MON | hourly and daily caps counted from the wallet's own history on chain | [drip.test.ts:334](apps/demo/test/drip.test.ts#L334), [:382](apps/demo/test/drip.test.ts#L382) |
| Drain the agent's wallet with concurrent requests across instances | each drop checked when it is signed, one at a time, counted by nonce | [spend-race.test.ts:105](examples/agent-memory/test/spend-race.test.ts#L105) |
| Replay a task sealed to the agent with your own reply address | the reply address, a nonce and a time are sealed inside the task | [app.test.ts:289](examples/agent-memory/test/app.test.ts#L289) |
| Pass the offline proof with the network still reachable | an OS-level block, and a guard that counts every way out | [no-network.test.ts:78](scripts/test/no-network.test.ts#L78), [os-sandbox.test.ts:92](scripts/test/os-sandbox.test.ts#L92) |

### Honest limits (14)

1. **Anyone can seal to anyone.** HPKE base mode is anonymous, and a copied envelope can be dropped again. The app
   never shows a sender; the agent seals a nonce and a time inside each task.
2. **Metadata is public.** The recipient, the epoch and the timing of every `drop` are on chain.
3. **No recovery.** If every synced copy of the passkey is lost, so is the key.
4. **The rpId's host can derive every key.** Whoever serves `app.letterlock.edycu.dev`, or a subdomain of it, can run
   passkey ceremonies for it. It is on the owner's own domain, which must stay registered and pointed at the app for
   as long as keys derived under it are in use; moving again takes an SDK release, as 0.1.1's move from
   `letterlock-app.vercel.app`, a Vercel project name, did.
5. **Opening happens on the Letterlock app.** A browser lets a page use only its own domain as the rpId, so other
   apps seal and recipients open there.
6. **The RPC is trusted for reads.** The client checks the chain id and the directory's code, but a `keyOf` answer
   carries no state proof: a lying RPC could substitute a key.
7. **A compromised device during an open** exposes that epoch's key. Rotating protects new notes.
8. **The passkey-to-key binding is `msg.sender`.** The P256 proof through `0x0100` worked in a spike and is not
   adopted in the contract.
9. **Two passkey prompts to publish**, three on some browsers: mera 0.2 evaluates one PRF salt per ceremony.
10. **Per-IP limits are per server instance.** The drip's and the agent's in-memory limits are best effort; the
    Vercel firewall limits POSTs per IP for every instance, and the caps that bound spending are read from the chain.
11. **The agent's day is bounded by its wallet.** It spends at most a quarter of its balance a day at the costliest
    drop, and anyone can use that allowance up.
12. **Inbox scans read every `Dropped` log from the deploy block.** On mainnet the SDK after 0.1.1 reads them from
    `rpc1.monad.xyz` a million blocks per request (npm's 0.1.0 reads 100 a request unless given `--rpc`); with your own RPC (`rpc.monad.xyz` serves 100 blocks per request)
    pass `fromBlock`, or index `Dropped` yourself. The log RPC is trusted too: it can leave a letter out, or list one
    that was never dropped under a made-up transaction (it opens, since anyone can seal to a published key, and no
    letter names a sender). It cannot read one.
13. **The first keys in the directory are this project's own**: demo keys from the deploy smoke test (random bytes
    in place of a passkey) and test keys from the app's live checks (virtual passkeys, deleted after each run). The
    register labels each; do not seal real notes to them.
14. **Agent keys trust the ERC-8004 registry's upgrader.** The IdentityRegistry is an upgradeable (UUPS) proxy whose
    `owner()` was `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603` on 2026-10-03, a single key (an account with no contract
    code: `cast code` returns `0x`, so no multisig). Whoever can upgrade it can rewrite `ownerOf`, and so publish a key for any agent
    or make every agent key stop resolving. Address keys never read the registry.

## 🚀 Getting Started

### Prerequisites

Node.js 22.18 or later and pnpm 10. [Foundry](https://getfoundry.sh) for the contract tests and the SDK's chain tests
on anvil. A browser with passkeys that support PRF (iCloud Keychain, Google Password Manager) to publish and open.

### Installation

```sh
git clone --recurse-submodules https://github.com/edycutjong/letterlock && cd letterlock
pnpm install
pnpm verify
```

To seal from your own app, `npm i letterlock`:

```ts
import { letterlock } from "letterlock";
const ll = letterlock({ chain: "monad" });
const envelope = await ll.sealTo("agent:10260", new TextEncoder().encode("only its key opens this"));
```

The developer guide, with the CLI, every error code and what was hard on Monad, is [docs/DX.md](docs/DX.md). The app
runs locally with `pnpm --filter letterlock-demo dev`: looking up and sealing work anywhere, while creating and
opening an address happen on the production host, the pinned rpId (a testnet build may make passkeys for `localhost`,
for the end-to-end tests). The agent runs on testnet with the steps in [its README](examples/agent-memory/README.md).

## 🧪 Testing & CI

```sh
pnpm verify                            # every suite, then one screen of exact counts (exit 1 if any fails)
pnpm bench                             # resolve + seal latency against Monad mainnet; gas from receipts
pnpm readiness                         # the submission checklist
pnpm --filter letterlock test:live     # the SDK's read-only checks against Monad mainnet and testnet
```

[CI](.github/workflows/ci.yml) runs `pnpm typecheck` and `pnpm verify` on every push, with Foundry installed and the
offline proof inside a network namespace, and in a parallel job builds every deployable thing as its deploy does (the
npm package, the app's `next build`, the agent's Vercel output, the site's CSP hashes and files:
`node scripts/check-site.ts`), so a broken build fails the push, not the deploy; [a second workflow](.github/workflows/contracts.yml) checks the contract's
format, gas snapshots, ABI exports and deployment records. [gitleaks](.github/workflows/gitleaks.yml) scans every
patch and every commit message in the history on each push, [CodeQL](.github/workflows/codeql.yml) analyzes the
TypeScript and the workflows, and [Dependabot](.github/dependabot.yml) proposes grouped monthly updates (no major
versions). Security reports: [SECURITY.md](.github/SECURITY.md).

**Releases and deploys.** The npm package is what the repository versions: one version names the git tag, the
[GitHub Release](https://github.com/edycutjong/letterlock/releases), `letterlock` on npm (published from CI with
provenance), and every surface that shows a version (the deck, the landing's release link, the agent card), which
`node scripts/version-sync.ts --check` holds equal in CI. After `ci` passes on main,
[release](.github/workflows/release.yml) reads the Conventional Commits that changed the SDK since the last tag
(below 1.0.0: `feat` or a breaking change is minor, `fix` or `perf` is patch; docs, tests and tooling release nothing),
commits the version and its CHANGELOG section, tags it, and publishes the Release and the package
(`scripts/release.ts`). [deploy](.github/workflows/deploy.yml) then ships the app, the agent and the site to Vercel,
each only when a path it is built from changed since its production deployment, checks the production domain, and
rolls back on a failed check.

## 📁 Project Structure

```text
contracts/            the directory contract, its tests, the deploy script and runbook
packages/letterlock/  the SDK and CLI (npm: letterlock)
apps/demo/            the app at app.letterlock.edycu.dev, with the gas drip
examples/agent-memory/ the reference agent at agent.letterlock.edycu.dev (ERC-8004 #10260)
spikes/prf-browser/   the day-one spike: real WebAuthn PRF, and the P256 check against 0x0100
scripts/              verify, bench, the offline proof, seed, readiness
deployments/          the mainnet and testnet records
bench/                results.json (every sample) and RESULTS.md
docs/                 SPEC.md, ARCHITECTURE.md, DX.md
site/                 the landing page and the pitch deck, at letterlock.edycu.dev
```

## 🗺️ Roadmap

- [x] The protocol, the SDK and the CLI, published to npm
- [x] The directory on Monad mainnet and testnet, verified on Sourcify
- [x] The app on the pinned rpId, every flow live on mainnet, with a gas drip
- [x] The reference agent, ERC-8004 #10260, sealing notes and answering sealed tasks
- [x] Reproducible proof: `pnpm verify`, `pnpm bench`, the offline proof, CI
- [x] The rpId on a domain the owner registered: `app.letterlock.edycu.dev` (SDK 0.1.1)
- [ ] The P256 binding in the contract, so a key proves which passkey vouches for it
- [ ] Recovery: a second passkey, or a social rotation
- [ ] An indexer for `Dropped`, so an inbox is one request
- [ ] Sender authentication for apps that need it (HPKE auth mode)

## 📽️ Demo Materials

- **Demo video (2:32):** <https://youtu.be/2tx9jVs7tbY>: a real passkey on a Mac creates the address, agent 10260 seals a note to it, one passkey tap opens it, and again in a private window
- **Pitch video (1:53):** <https://youtu.be/gSGjlJyhs2M>
- **Product ad (0:24):** <https://youtu.be/fbd-ot-X80E>: the animated promo, made in code; its figures (resolve + seal p50 28.199 ms over N = 1,000; agent 10260) are the ones above
- **Landing page:** <https://letterlock.edycu.dev>, and the pitch deck at <https://letterlock.edycu.dev/pitch/> (both in [site/](site))
- **Live app:** <https://app.letterlock.edycu.dev>, and the judges' route at <https://app.letterlock.edycu.dev/judge>
- **The judge's script:** [DEMO.md](DEMO.md): two paths, the mainnet transactions behind each claim (every directory event among them), and how to reproduce the numbers
- **Reference agent:** <https://agent.letterlock.edycu.dev>
- **Benchmark:** [bench/RESULTS.md](bench/RESULTS.md)

## 📄 License

[MIT](LICENSE).

## 🙏 Acknowledgments

[mera](https://mera.category.xyz) by Category Labs for passkey PRF and passkey accounts; the HPKE implementation of
[hpke-js](https://github.com/dajiaji/hpke-js); [@noble](https://paulmillr.com/noble/) curves and hashes;
[viem](https://viem.sh); [Foundry](https://getfoundry.sh); the authors of
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004); and the Monad team for the chain and the Metropolis hackathon.
