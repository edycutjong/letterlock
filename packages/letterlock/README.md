# letterlock

A passkey becomes an **encryption address** on Monad. The owner's device derives an X25519 key from the passkey's
WebAuthn PRF output (through [mera](https://mera.category.xyz)) and publishes only the public half in the Letterlock
directory contract. Anyone resolves `keyOf(address)` or `keyOfAgent(id)` and seals bytes to it with HPKE (RFC 9180);
only the same passkey, on any device it syncs to, opens them.

## Quickstart: seal to someone

```ts
import { letterlock } from "letterlock";

const ll = letterlock({ chain: "monad" }); // the mainnet directory, over the public RPC
const envelope = await ll.sealTo("0x…recipient", new TextEncoder().encode("only you can read this"));
// store or send the envelope JSON anywhere; only the recipient's passkey opens it
```

No passkey, no key material and no transaction: `sealTo` is one contract read and one HPKE seal. It throws
`NO_KEY_PUBLISHED` when the recipient has no key. From a terminal:

```sh
npx letterlock resolve agent:10260            # the key an address or an ERC-8004 agent published
npx letterlock seal 0x…recipient note.txt --out envelope.json
npx letterlock verify 0x…recipient            # seal a random nonce: whoever reads it back holds the passkey
npx letterlock inbox 0x…recipient --from-block 108289180
```

## Receive: publish a key and open (browser)

```ts
import { LETTERLOCK_RP_ID, createEncryptionAddress, letterlock, meraAccount } from "letterlock";

const ll = letterlock({ chain: "monad" });
const rp = { id: LETTERLOCK_RP_ID, name: "Letterlock" };
const { keys, credential } = await createEncryptionAddress({ rp, user: { name: "maya", displayName: "Maya" } });
const account = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential }); // the same passkey's EVM account
await ll.publish({ account, keys }); // msg.sender is the passkey account; it needs MON for gas
const { envelopes } = await ll.inbox(account.address);
const bytes = await ll.open(envelopes[0].envelope, { credential }); // one prompt, on any synced device
```

`rotate({ account, credential })` publishes the next epoch's key; envelopes sealed to earlier epochs still open.

## API

| Call | Passkey prompts | What it does |
|---|---|---|
| `letterlock({ chain, rpcUrl?, directory?, rpId? })` | 0 | client for `"monad"` (143) or `"monad-testnet"` (10143); the directory addresses are built in, and a `directory` you pass is checked once (EIP-55 checksum, code, `NO_AGENT()`) before anything is read or sent |
| `resolve(to)` | 0 | one `keyOf` / `keyOfAgent` read → `{ recipient, publicKey, epoch, kid, updatedAt }` |
| `sealTo(to, bytes)` | 0 | `resolve` + `seal`: an envelope bound to this chain, directory, recipient and epoch |
| `inbox(to, { fromBlock?, toBlock? })` | 0 | the envelopes dropped for a recipient (`Dropped` logs), in pages the RPC accepts, up to the finalized block by default (two blocks behind the head on Monad): a poll resumed from `toBlock + 1` misses nothing. `toBlock: "latest"` reads to the head, where a block can still be replaced |
| `drop({ account, envelope })` | 0 | a transaction that emits the envelope for its recipient (the demo transport; ≤ 16 KiB) |
| `publish({ account, keys })` | 0 | a transaction that publishes the account's key; `keys.epoch` must be the current epoch + 1 |
| `publishForAgent({ account, agentId, keys })` | 0 | the same for an ERC-8004 agent the account owns (mainnet only) |
| `rotate({ account, credential? })` | 1 | derives the next epoch's key and publishes it |
| `open(envelope, { credential? })` | 1 | re-derives the key for the envelope's epoch and opens it |
| `meraAccount({ rpId, credential? })` | 1 | the passkey's EVM account as a viem account, signing through a mera session |
| `createEncryptionAddress`, `deriveFromPasskey`, `seal`, `open(envelope, keys)`, `encodeEnvelope`, `decodeEnvelope` | | the protocol functions the client is built on |

`account` is any viem account: `meraAccount()`, or `privateKeyToAccount()` for a server. Every failure is a
`LetterlockError` with a `code`:

| Code | Meaning |
|---|---|
| `NO_KEY_PUBLISHED` | the recipient has no key that resolves now |
| `EPOCH_MISMATCH` | an envelope and a key name different epochs, or a publish named an epoch other than the current + 1 |
| `WRONG_KEY` / `TAMPERED` | the wrong passkey was chosen / the envelope was altered |
| `PRF_UNSUPPORTED` / `PASSKEY_FAILED` | the authenticator returns no PRF output / the prompt was cancelled or found no passkey |
| `NOT_AGENT_OWNER` | the account does not own that ERC-8004 agent |
| `INSUFFICIENT_FUNDS` | the account cannot pay for gas |
| `CHAIN_UNAVAILABLE` | the RPC or the ERC-8004 registry gave no answer: unknown, never "no key" |
| `INPUT_INVALID` | a malformed recipient, key, envelope or option, the wrong chain behind `rpcUrl`, a `directory` with a bad checksum or no Letterlock directory at it, or a publish under another rpId |

## Honest limits

- **One rpId.** PRF output is bound to the WebAuthn rpId, so Letterlock pins one: `LETTERLOCK_RP_ID`
  (`letterlock-app.vercel.app`). `publish`, `rotate` and `publishForAgent` refuse any other rpId (a key derived on
  localhost could never be re-derived in production), and a key that does not carry its rpId: publish the key object
  `createEncryptionAddress` or `deriveFromPasskey` returned, not `{ publicKey, epoch }` rebuilt from it.
  `unsafeAllowAnyRpId: true` lifts this, for tests only. Browsers
  let a page use only its own domain as the rpId, so people publish their key on the Letterlock app itself, and other
  apps only seal to them. **The Letterlock app is not deployed at that host yet.**
- **What is in the directory.** On Monad mainnet (`0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e`) the only keys so far
  are two DEMO KEYs from the deploy smoke test (the deployer and agent 10260), derived from random bytes with no
  passkey; the testnet key is a TEST KEY of the same kind. Whoever holds their stand-ins can open anything sealed to
  them: do not seal real notes to them.
- **Not hidden:** who sent an envelope (HPKE base mode is anonymous, and a copied envelope can be dropped again),
  and the recipient, epoch and timing of every `drop`, which are public onchain.
- **No recovery.** If every synced copy of the passkey is lost, so is the key.
- **Gas.** On mainnet the smoke test's `publish` used 70,863 gas and its 490-byte `drop` 45,780 (receipts in
  `deployments/143.json`). Monad charges the gas limit, and a new passkey account holds no MON until someone sends it
  some.
- **Two prompts to publish.** One for the key (Letterlock's PRF salt), one for the account (mera's salt): mera 0.2
  evaluates one salt per ceremony.
- **Agent keys.** A key an owner derives for an agent with `deriveFromPasskey(epoch)` equals the owner's own key of that
  epoch (the derivation does not include the recipient), so publishing both links them publicly.
- **Inbox reads logs.** `rpc.monad.xyz` serves `eth_getLogs` 100 blocks at a time (checked 2026-09-27; `rpc1.monad.xyz`
  answered a 1,000,000-block range the same day). `inbox` narrows its pages to what the RPC accepts, so a scan from
  the directory's deploy block grows with the chain: on 2026-09-27 its 23,218 blocks took 234 requests and 34 s on
  `rpc.monad.xyz` (4 in flight), and 3 requests and 1 s with `rpcUrl: "https://rpc1.monad.xyz"`. Pass `fromBlock`, a
  wider RPC, or index `Dropped` yourself.
- **Runtimes.** Passkeys need WebAuthn (a browser) or a mera `WebAuthnClient`. mera 0.2.0 is a preview and declares
  Node ≥ 24; the CLI never touches a passkey and runs on Node ≥ 20.19. mera's type declarations use
  `Symbol.dispose`: TypeScript needs `lib` `esnext` (or `skipLibCheck`).
- **The CLI handles no key material,** except `drop`'s signing key, read from the environment variable that
  `--private-key-env` names; a key typed on the command line is refused and never echoed.

## Development

```sh
pnpm --filter letterlock test        # unit and chain tests; the chain tests need Foundry's forge and anvil
pnpm --filter letterlock test:live   # read-only checks against Monad mainnet and testnet
pnpm --filter letterlock build       # tsup, then scripts/stage.mjs: dist/ is the npm package
cd packages/letterlock && npm publish ./dist   # the workspace manifest is private; dist/package.json is the one published
```

Protocol (derivation, envelope format, contract rules): `docs/SPEC.md` in the
[repository](https://github.com/edycutjong/letterlock). MIT licensed.
