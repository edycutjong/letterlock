# Letterlock memory agent

The reference agent for Letterlock: ERC-8004 agent **#10260** on Monad mainnet, live at
<https://letterlock-agent.vercel.app>. It uses the `letterlock` SDK from this repository the way any app or agent
would, with no passkey of its own:

- **`POST /remember`** seals a note to a person's (or an agent's) Letterlock address and drops it on the directory.
  Only the recipient's passkey can open it. Once the note is sent, the agent cannot open it either.
- **`POST /task`** opens a task another party sealed to `agent:10260`, using the agent's own key (the one
  `keyOfAgent(10260)` returns), and drops an answer sealed to the sender. This is `keyOfAgent` used end to end,
  agent to agent.
- **`GET /health`** shows the chain, the directory, the agent's wallet and balance, the key it holds against the key
  published for it, and the limits.

Its ERC-8004 registration file (the agent's `tokenURI`) is
[`/.well-known/agent-card.json`](https://letterlock-agent.vercel.app/.well-known/agent-card.json), served from
`public/`: `"active": true`, the endpoints, and two A2A-style skills (`seal-a-memory`, `answer-a-sealed-task`).

## Live on mainnet

| What | Transaction | Block | Gas | Result |
|---|---|---|---|---|
| The agent's epoch-2 key, `publishForAgent(10260, …, 2)` from its owner `0xFa72…02b3` | [`0x072dc08d…294b`](https://monadvision.com/tx/0x072dc08d72aefacbe3fe05fedd2296c857c1181fbfa9f548c7ed9322594c294b) | 108,354,286 | 74,652 | `keyOfAgent(10260)` returns `0xa38ed883…4806` at epoch 2, kid `e5b30e2e52ec0dec`, the key `/health` says the agent holds |
| `POST /remember` to `0xFa72…02b3` (its epoch-1 DEMO KEY) | [`0x00fdfadc…fbcd`](https://monadvision.com/tx/0x00fdfadca4afca918ac9ef3a648c491c407e945c2a949041cb24bfe65a4dfbcd) | 108,355,044 | 45,248 | a 478-byte envelope, read back from the recipient's inbox, identical to the one the agent returned; opened with the demo key's stand-in, the text matched |
| `POST /task` from `0xFa72…02b3`: the task sealed to `agent:10260` through `resolve()` → `keyOfAgent`, epoch 2 | [`0x59d435ff…2640`](https://monadvision.com/tx/0x59d435ff0295a3e64af43ad9ab2454bca985fb37571bbd194fae7c29d83e2640) (the answer's drop) | 108,355,072 | 68,543 | a 1,102-byte answer in the sender's inbox; opened, it names the task's nonce (`62b87a52786381027af838949c070585`), quotes the task in full and names the key it was sealed to (`e5b30e2e52ec0dec`) |

Both drops came from the agent's wallet, [`0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4`](https://monadvision.com/address/0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4),
at 102 gwei: 0.004615296 and 0.006991386 MON. After them it held 0.988393318 MON at nonce 2, and `/health` counted
2 of the day's 150 drops. The recipient, the deployer's address, holds the deploy smoke test's DEMO KEY
(`deployments/143.json`), whose stand-in the deployer's operator keeps outside this repository; that is what made
both envelopes openable for this check.

The checks were `scripts/call.ts` against the production URL: each answer is read back with the SDK's `inbox()` over
the drop's block and must be byte-for-byte the envelope the agent returned, then opened.

## Testnet integration run

`scripts/testnet-run.ts` serves the built Vercel function (the same file production runs) on `node:http` against the
Monad **testnet** directory, with the testnet deployer paying for gas, and sends real testnet drops. On
2026-09-27 (testnet, chain 10143):

| Check | Result |
|---|---|
| `POST /remember` to the testnet deployer's TEST KEY | drop [`0x0b28216f…009f`](https://testnet.monadvision.com/tx/0x0b28216f8343d0edc00776d087bbb1630d3be121edbe1903cc34c7026811009f), block 66,020,933, 42,904 gas, 380 bytes: in the inbox, opened, text matched |
| `POST /task`, answer to the testnet deployer | drop [`0xe173f008…8599`](https://testnet.monadvision.com/tx/0xe173f008552af29584f9783ff6e601212e92fbb91578bebb3c209179cb9e8599), block 66,020,941, 67,199 gas, 1,071 bytes: opened, nonce, quote and key matched |
| The same task again | 409 `REPLAYED` |
| A fresh task posted with another `from` | 403 `REPLY_TO_MISMATCH` |
| `/remember` to an address with no key | 422 `NO_KEY_PUBLISHED` |
| 1,001 characters | 400 `TEXT_TOO_LONG` |
| Nonce across the four refusals | 11 before, 11 after: nothing sent |
| The same bundle loaded without `AGENT_ENABLED` | 503 `AGENT_DISABLED` |

The testnet directory has no ERC-8004 registry, so no agent key can be published there: the run gives the agent a
fresh random seed and seals its task to the key `/health` reports. The mainnet path, where the task is sealed to the
key `keyOfAgent` returns, is the table above and `test/chain.test.ts`.

## API

Every answer is JSON, with `access-control-allow-origin: *` and `cache-control: no-store`. An error is
`{ "error": { "code", "message" } }`.

### `POST /remember`

```sh
curl -X POST https://letterlock-agent.vercel.app/remember \
  -H 'content-type: application/json' \
  -d '{"to":"0x…","text":"the dentist moved to Thursday 10:40"}'
```

- `to`: `0x` + 40 hex digits (a mixed-case address must carry a valid EIP-55 checksum), or `agent:<decimal id>`.
- `text`: 1 to 1,000 characters (Unicode code points), well-formed, not blank. It is sealed as UTF-8, exactly.

The agent reads the recipient's key with one `keyOf` / `keyOfAgent` read, seals to it with the SDK's `seal()` and
sends `drop()` from its wallet. `200` carries `envelope`, `dropTx`, `kid`, `epoch`, `directory`, and also `chainId`,
`recipient`, `bytes`, `blockNumber`, `gasUsed` and an `explorer` link.

### `POST /task`

```json
{ "from": "0x… or agent:<id>", "envelope": { "v": 1, "chainId": 143, "recipient": "agent:10260", "epoch": 2, "…": "…" } }
```

The envelope (the protocol's §3 JSON, as an object or a string) must be sealed to `agent:10260` on chain 143 and the
mainnet directory. Seal it to the key `keyOfAgent(10260)` returns, as `letterlock({ chain: "monad" }).sealTo("agent:10260", …)`
does. Inside the seal is UTF-8 JSON:

```json
{ "v": 1, "replyTo": "<the same as from>", "nonce": "<32 lower-case hex digits>", "issuedAt": 1790478831, "text": "<1 to 1,000 characters>" }
```

The agent opens it with its own key, then drops a reply sealed to `from`, as the key `resolve(from)` returns. The
reply is UTF-8 JSON: `{ v, from: "agent:10260", inReplyTo: <nonce>, openedAt, task: { sha256, chars, sealedTo }, text }`,
and its `text` quotes the task in full. `200` carries `reply` (the envelope), `dropTx`, `kid`, `epoch`, `directory`,
`inReplyTo` and `task`. `node scripts/call.ts task --from 0x… --text "…"` does all of this and checks the answer.

Why the reply address is sealed inside the task: HPKE base mode is anonymous (`docs/SPEC.md` §6), so the agent cannot
know who sealed a task, and a copied envelope opens again. If the agent answered the request's `from`, anyone who saw
a task sealed to `agent:10260` could post it with their own address and get the answer. It answers only the address
sealed inside the task. The nonce and `issuedAt`, also sealed, let it refuse replays, as §6 recommends.

### `GET /health`

This answers `200` when the agent can send: it is switched on, it has a wallet above its reserve, and the key
published for it is the key it holds. Otherwise it answers `503` with the same body. Answers are reused for 5 seconds.

### Errors

| Status | Code | When (nothing is sent) |
|---|---|---|
| 400 | `INPUT_INVALID`, `TEXT_TOO_LONG` | a malformed body, recipient, text or envelope |
| 403 | `REPLY_TO_MISMATCH` | the task names another reply address inside its seal |
| 405, 404 | `METHOD_NOT_ALLOWED`, `NOT_FOUND` | another method or path |
| 409 | `REPLAYED` | the agent has answered this nonce |
| 413, 415 | `BODY_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | over 16 KiB, or not `application/json` |
| 422 | `NO_KEY_PUBLISHED` | the recipient (or `from`) has no key in the directory |
| 422 | `TAMPERED`, `WRONG_KEY`, `EPOCH_NOT_HELD`, `NOT_FOR_THIS_AGENT`, `WRONG_DIRECTORY`, `TASK_INVALID`, `TASK_STALE`, `TASK_TOO_LONG` | the task does not open, or is not a task for this agent now |
| 429 | `RATE_LIMITED`, `DAILY_CAP` | a limit below (with `Retry-After`) |
| 502 | `CHAIN_UNAVAILABLE` | the RPC did not answer |
| 503 | `AGENT_DISABLED`, `NOT_CONFIGURED`, `GAS_RESERVE`, `MISCONFIGURED` | the kill switch, missing or malformed secrets, the reserve |

## Limits

The wallet held 1 MON. A drop's gas grows with its envelope, and Monad charges the gas limit: the drops above used
45,248 gas for 478 bytes and 68,543 for 1,102. `eth_estimateGas` for a drop from the agent's wallet on 2026-09-27
gave 87,769 gas for 1,000 ASCII characters (a 1,585-byte envelope, 0.00895 MON at 102 gwei) and 248,600 for 1,000
four-byte emoji (5,585 bytes, 0.0254 MON), the most one note can cost. So:

| Limit | Value | Where it is kept |
|---|---|---|
| Text | 1,000 characters per note or task, 16 KiB per request | every request |
| Drops per IP | 5 per 10 minutes, 20 per day | the function instance's memory: a Vercel instance serves many requests, but instances do not share it |
| Requests per IP | 60 per minute | the same |
| Drops per day | 150, from 00:00 UTC | onchain: the wallet's nonce now minus its nonce before the day's first block, so every instance counts the same drops |
| Gas reserve | the wallet keeps 0.1 MON | onchain balance, read before every drop |
| Recipient | must have a published key | one `keyOf` / `keyOfAgent` read before sealing |
| Kill switch | `AGENT_ENABLED` must be exactly `true` | environment |

A request refused before the drop does not count against its IP. Drops from one instance are sent one at a time, so
two requests never race for a nonce. When another instance takes the nonce first, the drop is resent with a fresh one.

**Switching it off:** `vercel env rm AGENT_ENABLED production`, then redeploy (`node scripts/build.mjs && vercel deploy --prebuilt --prod`).
The page and the card stay up, `/health` says `"enabled": false`, and both POST endpoints answer 503.

## The agent's key

`docs/SPEC.md` §2 derives an ERC-8004 agent's key from its owner's passkey, with the agent id in the PRF salt and the
HKDF info. This agent runs on a server, so a 32-byte secret seed (`LETTERLOCK_AGENT_KEY_SEED`) takes the place of
the passkey's credential secret. It goes through the computation a WebAuthn PRF performs over CTAP2 hmac-secret:

```
prf = HMAC-SHA256(seed, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ agentSalt(10260, epoch)))
key = deriveAgentKeyPair(prf, 10260, epoch)          (the SDK's §2 agent derivation, unchanged)
```

`test/agent-key.test.ts` recomputes it with Node's own crypto (OpenSSL). Every epoch gives an unrelated key, and
every epoch can be derived again from the seed, so tasks sealed to an earlier epoch keep opening after a rotation.
The seed lives only in the host's environment and in the operator's credential store, never in this repository.
Whoever holds it can open everything sealed to the agent from epoch 2 on.

Epoch 1 of agent 10260 is the deploy smoke test's DEMO KEY (`deployments/143.json`): random bytes put through the
address formula, published before the protocol required the agent formula. This agent does not hold it, and it
answers a task sealed to epoch 1 with 422 `EPOCH_NOT_HELD`. The epoch-2 key was published once, by the agent's
owner, with `scripts/publish-agent-key.ts`. That script simulates unless given `--send`, and does nothing if the
seed's key already resolves. It publishes through the SDK's `publishForAgent`, from a client made with
`unsafeAllowAnyRpId`, because a seed-derived key has no passkey and so no rpId. That flag lifts only the rpId check:
the SDK still refuses a key not derived for this agent, and the owner's own key, and the directory still requires
the agent's owner. To rotate, the owner runs the script again (epoch 3); the agent derives whatever epoch a task
names.

## What the agent never keeps

- **What it seals.** `/remember` and `/task` answers are sealed to the recipient's published key; the plaintext
  buffers are zeroed after sealing (best effort in JS), and nothing is stored. The only envelopes it opens are
  tasks sealed to `agent:10260`, with the key zeroed after use.
- **Logs.** One JSON line per request: route, status, milliseconds, error code, the drop's transaction hash and its
  size. No text, task, envelope, address or IP, and never a secret (`test/app.test.ts`, "logs").

## Run it

```sh
pnpm install                 # at the repository root
pnpm --filter letterlock-agent-memory test        # 61 tests: unit, HTTP with a fake chain, and anvil end to end
pnpm --filter letterlock-agent-memory typecheck
```

`test/chain.test.ts` runs the agent against the real directory bytecode on a local anvil (chain id 143, with the
SDK's test-double ERC-8004 registry at the mainnet address): an owner publishes the agent's epoch-1 stand-in and its
epoch-2 seed key, `/remember` lands in an address's inbox, a second agent seals a task through `keyOfAgent` and finds
the answer in its own inbox, and the daily cap reads the wallet's nonce. It needs Foundry (`forge`, `anvil`) and skips
without it.

Locally, on testnet, with a funded testnet key:

```sh
AGENT_WALLET_KEY=0x… node scripts/testnet-run.ts --open-with <TEST KEY file>     # the run above
AGENT_ENABLED=true LETTERLOCK_CHAIN=monad-testnet LETTERLOCK_AGENT_PRIVATE_KEY=0x… LETTERLOCK_AGENT_KEY_SEED=0x… \
  node scripts/serve.ts --port 8787                                              # the agent on :8787
```

### Environment

| Variable | Default | |
|---|---|---|
| `AGENT_ENABLED` | off | the kill switch: `true` to send |
| `LETTERLOCK_AGENT_PRIVATE_KEY` | none | the wallet that pays for drops, and nothing else |
| `LETTERLOCK_AGENT_KEY_SEED` | none | 32 bytes, hex: the agent's keys |
| `LETTERLOCK_AGENT_ID` | `10260` | |
| `LETTERLOCK_AGENT_KEY_FIRST_EPOCH` | `2` | the first epoch derived from the seed |
| `LETTERLOCK_CHAIN` | `monad` | or `monad-testnet` |
| `MONAD_RPC_URL` | the chain's public RPC | |
| `AGENT_DAILY_DROP_CAP`, `AGENT_PER_IP_DROPS_10MIN`, `AGENT_PER_IP_DROPS_DAY`, `AGENT_MIN_BALANCE_MON` | 150, 5, 20, 0.1 | the limits |

A malformed secret makes every request answer 503 `MISCONFIGURED`; the message names the variable, never its value.

### Deploy

The Vercel project `letterlock-agent` serves this package. `scripts/build.mjs` writes a Build Output API directory:
one Node.js function bundled with esbuild (the agent, this repository's SDK, viem, noble), `public/` as static
files, and routes that send `/remember`, `/task` and `/health` to the function. Nothing is installed or built on
Vercel, so the package deploys from here alone:

```sh
cd examples/agent-memory
vercel link --yes --project letterlock-agent
printf %s "$KEY"  | vercel env add LETTERLOCK_AGENT_PRIVATE_KEY production --sensitive
printf %s "$SEED" | vercel env add LETTERLOCK_AGENT_KEY_SEED production --sensitive
printf %s true    | vercel env add AGENT_ENABLED production
node scripts/build.mjs && vercel deploy --prebuilt --prod
```

The card's URL is the agent's `tokenURI` in the IdentityRegistry, so its content changes in place. A new URL would
take a `setAgentURI` transaction from the agent's owner. Preview deployments get none of the production variables
(`AGENT_ENABLED` included), so their POST endpoints answer 503 `AGENT_DISABLED`.
