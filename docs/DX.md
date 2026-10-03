# Developer experience

What it takes for another app or agent to use Letterlock, and what was hard to build on Monad and mera.

What was run, and where: the published package, [`letterlock@0.1.0` on npm](https://www.npmjs.com/package/letterlock),
ran the seal snippet below and the CLI's `resolve`, `seal`, `verify` and `inbox` against Monad mainnet on 2026-09-27;
they only read the chain. `drop` (the CLI's, and `ll.drop` below) sends a transaction: the same package ran it on
Monad testnet that day and read the envelope back from the inbox
([tx](https://testnet.monadvision.com/tx/0xcecdaf3d786ecfd73f94c017a08369ccc9e9559b43760f47fb634d7684dc36b8)), and the
SDK's anvil tests cover it. The mainnet drops of that day came from the deploy smoke test and the reference agent. The
receive snippet runs in a browser on the app's origin: the app makes the same calls
([apps/demo/lib/actions.ts](../apps/demo/lib/actions.ts)) with the SDK in this repository, end to end on testnet, and
on mainnet at each host the rpId has had ([apps/demo/e2e-results](../apps/demo/e2e-results)). SDK 0.1.1 differs from
0.1.0 only in the rpId it pins ([CHANGELOG](../packages/letterlock/CHANGELOG.md)).

## Seal to anyone, in five lines

```ts
import { letterlock } from "letterlock";

const ll = letterlock({ chain: "monad" });                  // the mainnet directory, over the public RPC
const key = await ll.resolve("agent:10260");                // one keyOf / keyOfAgent read: { publicKey, epoch, kid, updatedAt }
const envelope = await ll.sealTo("agent:10260", new TextEncoder().encode("the dentist moved to Thursday 10:40"));
// envelope is plain JSON: store it, post it, or drop() it on the directory. Only the recipient's passkey opens it.
```

Run as it stands (Node 22, `npm i letterlock`), it printed epoch 2 and kid `e5b30e2e52ec0dec` for the reference
agent, the key `/health` on the agent says it holds, and a 267-character envelope. The sender needs no passkey, no
key material, no wallet and no transaction. `resolve` and `sealTo` throw `NO_KEY_PUBLISHED` when the recipient has no
key. Any `0x` address that has published one works the same way.

To send the envelope on chain, `drop()` needs an account that pays gas:

```ts
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(process.env.SENDER_KEY as `0x${string}`); // any viem account
const { transactionHash } = await ll.drop({ account, envelope });              // a Dropped event for the recipient
```

## Receive: publish a key and open

Receiving needs a passkey, and a passkey is bound to the site that made it (its rpId). Letterlock pins one rpId,
`app.letterlock.edycu.dev`, so recipients create and open their address on [the Letterlock
app](https://app.letterlock.edycu.dev), and every other app only seals to them. In the browser, on that origin:

```ts
import { LETTERLOCK_RP_ID, createEncryptionAddress, letterlock, meraAccount } from "letterlock";

const ll = letterlock({ chain: "monad" });
const { keys, credential } = await createEncryptionAddress({ rp: { id: LETTERLOCK_RP_ID, name: "Letterlock" }, user: { name: "maya", displayName: "Maya" } });
const account = await meraAccount({ rpId: LETTERLOCK_RP_ID, credential }); // the same passkey's EVM account
await ll.publish({ account, keys });                                        // msg.sender is the passkey account (it needs gas)
const { envelopes } = await ll.inbox(account.address);                      // Dropped events, up to the finalized block
const bytes = await ll.open(envelopes[0].envelope, { credential });         // one prompt, on any synced device
```

`rotate({ account })` publishes the next epoch; notes sealed to earlier epochs keep opening.

## Agents

An ERC-8004 agent gets its own key, published by the agent's owner with `publishForAgent` and read with
`keyOfAgent(id)`; senders write `agent:<id>` wherever they would write an address. `keyOfAgent` returns zeros once
the agent's NFT moves to another owner, so nothing is sealed to a previous owner's key. An agent served from a server
has no passkey: it derives its key from a 32-byte seed, as [SPEC §2](SPEC.md#2-derivation) specifies.
[`examples/agent-memory`](../examples/agent-memory) is a complete one to copy (agent #10260, live): its `/task` route
opens tasks sealed to it and answers sealed to the sender.

## The CLI

```sh
npx letterlock resolve agent:10260                  # the key an address or an agent published
npx letterlock seal 0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3 note.txt --out envelope.json
npx letterlock verify 0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3   # seal a random nonce: whoever reads it back holds the passkey
npx letterlock inbox 0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3 --from-block 108289180
set -a; source ~/.config/sender.env; set +a        # SENDER_KEY=0x…, kept outside the repository
npx letterlock drop envelope.json --private-key-env SENDER_KEY   # names the variable; a key on the command line is refused
```

`resolve agent:10260` printed:

```text
agent:10260 has a key on Monad mainnet (143)
  key        0xa38ed883578ddcf912a3d20f2f698ea3f15c00339c1656714402594db6324806
  kid        e5b30e2e52ec0dec
  epoch      2
  published  2026-09-27T03:09:53.000Z (block time)
  directory  0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e
```

Every command takes `--testnet`, `--rpc <url>` and `--directory <address>`; `resolve`, `verify` and `inbox` take
`--json`. The exit code is 0 on success, 1 on an error (its message names the error code) and 2 on a usage error.
A 64-hex-digit value that reaches an error message, such as a key typed where an address belongs, is printed as
`[redacted]`.

## Error codes

Every failure is a `LetterlockError` with a `code` (`isLetterlockError(e, "NO_KEY_PUBLISHED")` narrows it):

| Code | When | What to do |
|---|---|---|
| `NO_KEY_PUBLISHED` | the recipient has no key that resolves now | ask them to create their address; never fall back to sending in the clear |
| `EPOCH_MISMATCH` | an envelope and a key name different epochs, or a publish skipped an epoch | derive the key for `envelope.epoch` (`open` does this) |
| `WRONG_KEY` | decryption failed and the `kid` names another key | the wrong passkey answered: try the passkey that made the address |
| `TAMPERED` | authentication failed | the envelope was altered, or re-addressed to another chain, directory or recipient (an edited epoch shows as `EPOCH_MISMATCH`, or as `WRONG_KEY` through `openWithPasskey`) |
| `PRF_UNSUPPORTED` | the authenticator returns no PRF output | use a passkey provider with the WebAuthn PRF extension: not every password manager has it |
| `PASSKEY_FAILED` | the prompt was cancelled, timed out, or found no passkey for this site | ask again |
| `NOT_AGENT_OWNER` | the account is not the agent's ERC-8004 owner | publish from the owner |
| `INSUFFICIENT_FUNDS` | the account cannot pay for gas | send it MON |
| `CHAIN_UNAVAILABLE` | the RPC or the registry did not answer | retry: the answer is unknown, never "no key" |
| `INPUT_INVALID` | a malformed recipient, key, envelope or option; the wrong chain behind `rpcUrl`; no directory at `directory`; a publish under another rpId or from another passkey | fix the input: nothing was sent |

The contract's custom errors map onto these codes ([chain-errors.ts](../packages/letterlock/src/chain-errors.ts)),
and the agent's HTTP errors are listed in [its README](../examples/agent-memory/README.md#errors).

## Numbers to plan with

- **Latency.** resolve + seal, measured with `pnpm bench` against the public RPC from one machine: p50 25.578 ms,
  p95 29.636 ms, p99 32.436 ms over N = 1,000. Sealing alone is local CPU: p50 3.534 ms. The rest is one `eth_call`,
  so another location or RPC moves it by the network's round trip ([bench/RESULTS.md](../bench/RESULTS.md)).
- **Gas**, from mainnet receipts at 102 gwei: a first `publish` 70,863 (0.007228026 MON); a `drop` of a 490-byte
  envelope 45,780 (0.00466956 MON); `publishForAgent` 108,799 for an agent's first key and 74,652 for a rotation.
  Monad charges the gas limit, and these receipts' gas used equals it.
- **Size.** An 85-byte note makes a 365-byte envelope; `drop` takes at most 16 KiB.

## What was hard on Monad and mera, and what the code does about it

1. **One PRF salt per ceremony.** mera 0.2 evaluates one salt per prompt, and the key and the account use different
   salts (Letterlock's and mera's own), so a first publish takes two prompts, three when the authenticator skips PRF
   at creation. The app says so under the button, before the first prompt.
2. **Several passkeys for one site.** mera adds a passkey on every creation, and an unpinned prompt lets any of them
   answer. A key from one passkey published under another passkey's account would take every note with it. The SDK
   pins each prompt to one credential, records which passkey answered, and `publish` / `rotate` refuse a key that
   does not name the account's passkey (`client.test.ts`, "a WebAuthn client that ignores the pin").
3. **A PRF output is bound to the rpId.** Keys made on `localhost` or a preview deploy can never be re-derived in
   production. The SDK pins `LETTERLOCK_RP_ID` and refuses to publish under another rpId; the end-to-end tests run a
   testnet build on `localhost`, where a build flag allows its own host. Moving the rpId costs every key made under
   the old one, so it had to move early: 0.1.0 pinned `letterlock-app.vercel.app`, a Vercel project name anyone could
   claim once the project was gone, and 0.1.1 pins `app.letterlock.edycu.dev` on the owner's own domain, while the
   only keys under the old name were the app's own test keys. The old host now answers 308, so nobody makes another.
4. **Monad charges the gas limit, and checks the fee cap up front.** The first version's drip sent
   1.5 × gas × gas price ([tx](https://monadvision.com/tx/0x256047f0073ec3b15656509491b7b433b9b12b75ec4012ed86f68d8dfc4397f1)),
   and mainnet's RPC refused the publish that followed ("Signer had insufficient balance"):
   viem bids 1.2 × the node's filled fee (182.4 gwei), and the account must hold gas limit × fee cap. The drip now
   pays `max(1.5 × 70,863 × gas price, 1.1 × 70,863 × fee cap)`, and the testnet end-to-end run asserts the drip
   covers the fee cap of the publish it funds.
5. **Monad's reserve balance.** Below a 10 MON reserve a value transfer must be its sender's only transaction in 3
   blocks, so the drip sends one transfer at a time, with the nonce it read, and answers `DRIP_BUSY` meanwhile. The
   node's "reserve balance violation" wording maps to `INSUFFICIENT_FUNDS`.
6. **`eth_getLogs` ranges.** `rpc.monad.xyz` serves 100 blocks per request, so a scan from the deploy block grows by
   thousands of requests a day. With no `rpcUrl`, `inbox()` on mainnet reads logs from `rpc1.monad.xyz`, a million
   blocks per request (`DEPLOYMENTS.monad.scanRpcUrl`); with your own `rpcUrl` it starts wide and narrows to the limit
   the error names, with 4 requests in flight.
7. **No batches.** One of the public RPCs in Monad's docs answers any JSON-RPC batch with HTTP 403, so the client sends
   one request per HTTP request.
8. **Finality.** On Monad `latest` is a proposed block and `safe` a voted one; either can still change. `inbox()`
   reads to `finalized` by default and returns `finalizedBlock`, so a poll that resumes from there misses nothing.
9. **ERC-8004 lives on mainnet only.** The testnet directory is deployed with no registry and refuses agent calls
   (`AgentPathDisabled`); the SDK refuses them before any call.
10. **A registry read that fails is not "no owner".** Only the registry's `ERC721NonexistentToken` means the agent
    has no owner. Any other failure, gas starvation included, reverts `RegistryCallFailed`, so `keyOfAgent` never
    returns a false "no key"; the fork tests measured the gas a reading contract must forward (SPEC §8).
11. **An ERC-8004 index refreshes on events only.** trust8004 fetched the agent's card at registration and fetches
    it again only after an onchain `URIUpdated`, `MetadataSet` or `Registered` event, so for a day it showed the
    card as it was then ("not live yet"). A card edited in place at the same URL needs one `setAgentURI` from the
    agent's owner with that same URL (`examples/agent-memory/scripts/set-agent-uri.ts`); after
    [that transaction](https://monadvision.com/tx/0x9278901488bb444d7b09ebaf9746d02fd49568d6298dc7d2c8106e6b56a65719)
    trust8004 showed the card of that day. The card edited since for the new hosts shows there once the owner's move
    of the `tokenURI` emits the next such event (`deployments/143.json`, `agent.indexStatus`).
12. **A preview SDK.** mera 0.2.0 declares Node 24 or later; the CLI never touches a passkey and runs on Node 20.19
    or later. mera's types use `Symbol.dispose`, so TypeScript needs `lib: esnext` or `skipLibCheck`.

## Where to read next

- [SPEC.md](SPEC.md): the derivation, the envelope, the contract rules and the threat model.
- [ARCHITECTURE.md](ARCHITECTURE.md): the parts, one note end to end, the trust boundaries.
- [packages/letterlock/README.md](../packages/letterlock/README.md): the SDK's full API.
- [examples/agent-memory/README.md](../examples/agent-memory/README.md): the reference agent's API and limits.
- [apps/demo/README.md](../apps/demo/README.md): the app, the gas drip and its limits, the security headers.
