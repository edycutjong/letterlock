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
| `POST /task` from `0xFa72…02b3`: the task sealed to `agent:10260` through `resolve()` → `keyOfAgent`, epoch 2 | [`0x59d435ff…2640`](https://monadvision.com/tx/0x59d435ff0295a3e64af43ad9ab2454bca985fb37571bbd194fae7c29d83e2640) (the answer's drop) | 108,355,072 | 68,543 | a 1,102-byte answer in the sender's inbox; opened, it names the task's nonce (`62b87a52786381027af838949c070585`), quotes the task in full (the answer quoted whole tasks then) and names the key it was sealed to (`e5b30e2e52ec0dec`) |
| `POST /remember` to `0xFa72…02b3`, after the wallet began to check each drop as it signs it (`src/spend.ts`) | [`0x7d349cf0…2177`](https://monadvision.com/tx/0x7d349cf09186f503dba730b06dbdfef182ff643114de0a00cb1a957ad1862177) | 108,371,264 | 44,162 | a 420-byte envelope, read back from the recipient's inbox, identical to the one the agent returned; opened, the text matched. It paid 102 gwei under a 182.4 gwei fee cap: 0.004504524 MON |

The first two drops came from the agent's wallet, [`0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4`](https://monadvision.com/address/0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4),
at 102 gwei: 0.004615296 and 0.006991386 MON. After them it held 0.988393318 MON at nonce 2, and `/health` counted
2 of the day's 150 drops. After the last row it held 0.975091804 MON at nonce 5, and `/health` counted 5 of the 10
drops the wallet allowed itself that day. The recipient, the deployer's address, holds the deploy smoke test's DEMO KEY
(`deployments/143.json`), whose stand-in the deployer's operator keeps outside this repository; that is what made
both envelopes openable for this check.

The checks were `scripts/call.ts` against the production URL: each answer is read back with the SDK's `inbox()` over
the drop's block and must be byte-for-byte the envelope the agent returned, then opened.

## Testnet integration run

`scripts/testnet-run.ts` serves the built Vercel function (the same file production runs) on `node:http` against the
Monad **testnet** directory, with the testnet deployer paying for gas, and sends real testnet drops. The run with
the wallet's signing checks (`src/spend.ts`), on 2026-09-27 (testnet, chain 10143):

| Check | Result |
|---|---|
| `/health` | the wallet's day on testnet: 19 transactions sent, 81 allowed (a quarter of 9.344 testnet MON at the most a drop can cost, 250,000 gas at the fee cap) |
| `POST /remember` to the testnet deployer's TEST KEY | drop [`0x5b404d37…b909`](https://testnet.monadvision.com/tx/0x5b404d375b0ee3ef59b05e410a1324149d715c34436b76578e9c6ceaf0b8b909), block 66,035,461, 42,904 gas, 380 bytes: in the inbox, opened, text matched |
| `POST /task`, answer to the testnet deployer | drop [`0x3b083a78…ea5c`](https://testnet.monadvision.com/tx/0x3b083a7859b65fb3804b0c0288c749fe49fd2c9ae565edeeac392dbbb877ea5c), block 66,035,469, 67,199 gas, 1,071 bytes: opened; nonce, SHA-256, quote and key matched |
| The same task again | 422 `TASK_REFUSED` |
| A fresh task posted with another `from` (an address with no key) | 422 `NO_KEY_PUBLISHED`, before the task is opened |
| `/remember` to an address with no key | 422 `NO_KEY_PUBLISHED` |
| 1,001 characters | 400 `TEXT_TOO_LONG` |
| Nonce across the four refusals | 30 before, 30 after: nothing sent |
| The same bundle loaded without `AGENT_ENABLED` | 503 `AGENT_DISABLED` |

The testnet directory has no ERC-8004 registry, so no agent key can be published there: the run gives the agent a
fresh random seed and seals its task to the key `/health` reports. The mainnet path, where the task is sealed to the
key `keyOfAgent` returns, is the table above and `test/chain.test.ts`.

## API

Every answer is JSON, with `cache-control: no-store`. An error is `{ "error": { "code", "message" } }`.

A web page may ask the agent to send only from the Letterlock app (`https://letterlock-app.vercel.app`, whose
`/judge` route asks it from the page) or from the agent's own page: a POST, or its CORS preflight, from any other
origin answers 403 `ORIGIN_NOT_ALLOWED`, so no site can make its visitors' browsers spend the agent's gas. Requests
with no `Origin` header (servers, other agents, curl) are not affected, and `GET /health` answers any origin.
`AGENT_ALLOWED_ORIGINS` replaces the list.

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
reply is UTF-8 JSON: `{ v, from: "agent:10260", inReplyTo: <nonce>, openedAt, task: { sha256, chars, sealedTo }, text }`.
Its `text` quotes the task's first 80 characters (control characters and line separators as spaces, then `…`), and
`task.sha256` names all of it: however the task is written, the answer stays small (below, "Limits"). `200` carries
`reply` (the envelope), `dropTx`, `kid`, `epoch`, `directory`, `inReplyTo` and `task`.
`node scripts/call.ts task --from 0x… --text "…"` does all of this and checks the answer.

Why the reply address is sealed inside the task: HPKE base mode is anonymous (`docs/SPEC.md` §6), so the agent cannot
know who sealed a task, and a copied envelope opens again. If the agent answered the request's `from`, anyone who saw
a task sealed to `agent:10260` could post it with their own address and get the answer. It answers only the address
sealed inside the task. The nonce and `issuedAt`, also sealed, let it refuse replays, as §6 recommends.

Every refusal of a task that opened is one answer, 422 `TASK_REFUSED`, whatever the reason: sealed JSON that is not a
task, a task sealed more than 600 s ago (or over 60 s ahead), more than 1,000 characters, a nonce answered already,
or a sealed `replyTo` that is not the request's `from`. A reason would tell whoever posts a copy of a task what is
sealed in it (its time, its length, whether a guessed `from` is right). The checks before the envelope is opened
(the chain, the directory, the agent, the epoch, and a key for `from`) read only what the request shows in the clear,
and say what failed. A caller who wants the reason checks its own task with `parseTask` (`src/task.ts`).

Each nonce is answered once per server instance, for 12 minutes: the nonces live in each instance's memory, so a
copy that reaches another instance is answered again, to the same sealed address, and counts in the day's drops.

### `GET /health`

This answers `200` when the agent can send: it is switched on, it has a wallet above its reserve, the key published
for it is the key it holds, and it has not sent the drops it allows itself today. Otherwise it answers `503` with the
same body. `limits.dailyDrops` shows the day (`used` of `allowedToday`, until `resetsAt`), and `limits.maxDropCost`
the most a drop can cost at the current fee cap. Answers are reused for 5 seconds.

### Errors

| Status | Code | When (nothing is sent) |
|---|---|---|
| 400 | `INPUT_INVALID`, `TEXT_TOO_LONG` | a malformed body, recipient, text or envelope |
| 403 | `ORIGIN_NOT_ALLOWED` | a POST, or its preflight, from a web page of another origin than the Letterlock app's or the agent's |
| 405, 404 | `METHOD_NOT_ALLOWED`, `NOT_FOUND` | another method or path |
| 413, 415 | `BODY_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | over 16 KiB, or not `application/json` |
| 422 | `NO_KEY_PUBLISHED` | the recipient (or `from`) has no key in the directory |
| 422 | `TAMPERED`, `WRONG_KEY`, `EPOCH_NOT_HELD`, `NOT_FOR_THIS_AGENT`, `WRONG_DIRECTORY` | the task does not open, or is not sealed for this agent |
| 422 | `TASK_REFUSED` | the task opened, but the agent does not answer it (above: the reason is not said) |
| 422 | `DROP_TOO_COSTLY` | the drop would take more than 250,000 gas |
| 429 | `RATE_LIMITED`, `DAILY_CAP` | a limit below (with `Retry-After`) |
| 429 | Vercel's own `{"error":{"code":"429","message":"Too Many Requests"}}`, without CORS headers | the firewall's limit of POST requests per IP |
| 502 | `CHAIN_UNAVAILABLE` | the RPC did not answer |
| 503 | `AGENT_DISABLED`, `NOT_CONFIGURED`, `GAS_RESERVE`, `MISCONFIGURED` | the kill switch, missing or malformed secrets, the reserve |

## Limits

Anyone can ask the agent to send, and each drop is paid from its wallet, so what bounds the spend is checked on the
transaction itself, when the wallet signs it (`src/spend.ts`), inside the instance's one-at-a-time send queue. The
checks made when a request arrives only refuse early: concurrent requests all read the same balance and count, and
each server instance counts only its own. The firewall counts POST requests per IP for every instance: on
2026-09-27, 12 concurrent POSTs from one IP (each refused by the agent before it read anything) got 5 answers from
the agent and 7 `429`s from the firewall.

A drop's gas grows with its envelope, and Monad charges the whole gas limit at the base fee plus the priority fee.
viem signs each drop with a higher fee cap, which the wallet must hold: on Monad mainnet the node's
`eth_fillTransaction` answers 152 gwei, and viem multiplies it by 1.2. `node scripts/cost.ts` measures all of it
with `eth_estimateGas` from the agent's wallet and signs nothing. On 2026-09-27 (Monad mainnet, block 108,370,909:
base fee 100 gwei and priority fee 2, so 102 gwei paid, under a 182.4 gwei fee cap):

| Drop | Envelope | Gas | Paid at 102 gwei | At the 182.4 gwei fee cap |
|---|---|---|---|---|
| `/remember`, 1,000 ASCII characters | 1,585 bytes | 87,769 | 0.008952438 MON | 0.0160090656 MON |
| `/remember`, 1,000 four-byte characters: the largest note | 5,585 bytes | 248,600 | 0.0253572 MON | 0.04534464 MON |
| `/task`, the answer to 1,000 control characters: the largest answer | 1,201 bytes | 72,646 | 0.007409892 MON | 0.0132506304 MON |

Until the answer quoted 80 characters, it quoted the whole task, and JSON writes a control character as a 6-byte
escape: that answer was 8,981 bytes, 384,237 gas, 0.0391922 MON at 102 gwei, more than the largest note.

| Limit | Value | Where it is kept |
|---|---|---|
| Text | 1,000 characters per note or task, 16 KiB per request | every request |
| POST requests per IP | 5 per 10 minutes, fixed window | Vercel's firewall (`vercel-firewall.json`), counted per region: every instance shares it |
| Drops per IP | 5 per 10 minutes, 20 per day | each server instance's memory, best effort: a burst that reaches three instances meets three fresh limiters |
| Requests per IP | 60 per minute | each server instance's memory, best effort |
| Gas per drop | at most 250,000 | the wallet signs no drop with a higher gas limit (422 `DROP_TOO_COSTLY`) |
| Gas reserve | the wallet keeps 0.1 MON | checked when each drop is signed, counting the most that drop can cost: its gas × its fee cap |
| Drops per day (UTC) | at most 150, and no more than 25% of the wallet pays for at the most a drop can cost | checked when each drop is signed, by the nonce it is signed with, at 250,000 gas and the price the drop pays. The chain takes one transaction per nonce, so two instances cannot both take the last drop: the loser is signed again with the next nonce, and checked again |
| Replayed tasks | each nonce answered once per server instance, for 12 minutes | each instance's memory |
| Web pages | the Letterlock app's and the agent's own | CORS on POST (above, "API") |
| Recipient | must have a published key | one `keyOf` / `keyOfAgent` read before sealing |
| Kill switch | `AGENT_ENABLED` must be exactly `true` | environment |

At 102 gwei a drop costs at most 250,000 × 102 gwei = 0.0255 MON. Before its top-up on 2026-09-27 the wallet held
under 1 MON and allowed 10 drops that day. After it, `/health` at 08:50 UTC showed 10.970719268 MON with 6 drops sent
that day, and allowed 109: a quarter of 11.123719268 MON (the balance, plus the day's 6 drops counted as held) at
0.0255 MON a drop. However many IPs ask, a day's drops cost at most a quarter of what the wallet held. Counting the
day's drops as held keeps the allowance from shrinking as they go out, and a refill raises it at once. 150 drops a
day would take a wallet of 15.3 MON. `/health` reports the figures of the moment (`limits.dailyDrops`: `used` of
`allowedToday`). A request refused before anything is signed does not count against its IP.

## Running it during judging

- **Check it:** `curl -s https://letterlock-agent.vercel.app/health`. `ok` is `false`, and the page says so, when the
  agent is switched off, its wallet is at its reserve, its key does not match, or it has sent the drops it allows
  itself today (`limits.dailyDrops`: `used` of `allowedToday`, until `resetsAt`).
- **Refill:** send MON to the wallet, `0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4`. The day's allowance rises at
  once: a quarter of the wallet at 0.0255 MON a drop (at 102 gwei). `node scripts/cost.ts` prints what the wallet
  allows now, and what the drops cost at the current fee.
- **When someone spends the day's allowance:** POST answers 429 `DAILY_CAP` until 00:00 UTC, and the Letterlock app's
  `/judge` step shows that the agent did not deliver. A refill lifts it at once. To spend less instead, lower
  `AGENT_DAILY_SPEND_PERCENT` or `AGENT_DAILY_DROP_CAP` and redeploy.
- **The firewall:** `vercel firewall rules list` (in this folder) shows the rule `vercel-firewall.json` holds. Tighten
  or loosen it by editing `vercel-firewall.json`, then
  `vercel firewall rules edit "agent POSTs per IP" --json "$(node -e 'console.log(JSON.stringify(require("./vercel-firewall.json").rules[0]))')" --yes`
  and `vercel firewall publish --yes`. The Hobby plan allows one rate-limit rule per project, with windows of up to 10
  minutes.
- **Switching it off:** `vercel env rm AGENT_ENABLED production`, then redeploy (`node scripts/build.mjs && vercel deploy --prebuilt --prod`).
  The page and the card stay up, `/health` says `"enabled": false`, and both POST endpoints answer 503.
- **After a redeploy:** every production deployment carries the wallet's key, and an older one keeps its older
  limits. Delete the superseded ones (`vercel rm <deployment URL> --yes`), and keep no automation bypass secret for
  the project unless a check needs one (it opens every protected deployment URL).

## The agent's key

`docs/SPEC.md` §2 derives an ERC-8004 agent's key from a PRF at the agent's own salt, with the agent id in the PRF
salt and the HKDF info. This agent runs on a server, with no passkey, so it takes the PRF from a 32-byte secret seed
(`LETTERLOCK_AGENT_KEY_SEED`), as §2's "Server-hosted agents" allows, through the computation a WebAuthn PRF performs
over CTAP2 hmac-secret:

```
prf = HMAC-SHA256(seed, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ agentSalt(10260, epoch)))
key = deriveAgentKeyPair(prf, 10260, epoch)          (the SDK's §2 agent derivation, unchanged)
```

`test/agent-key.test.ts` recomputes it with Node's own crypto (OpenSSL). Every epoch gives an unrelated key, and
every epoch can be derived again from the seed, so tasks sealed to an earlier epoch keep opening after a rotation.
The seed lives only in the host's environment and in the operator's credential store, never in this repository.
Whoever holds it can open everything sealed to the agent from epoch 2 on, and it is the only way back to these keys:
no passkey, the owner's included, re-derives them.

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
pnpm --filter letterlock-agent-memory test        # 95 tests: unit, HTTP with a fake chain, and anvil end to end
pnpm --filter letterlock-agent-memory typecheck
```

`test/chain.test.ts` runs the agent against the real directory bytecode on a local anvil (chain id 143, with the
SDK's test-double ERC-8004 registry at the mainnet address): an owner publishes the agent's epoch-1 stand-in and its
epoch-2 seed key, `/remember` lands in an address's inbox, a second agent seals a task through `keyOfAgent` and finds
the answer in its own inbox, and the daily cap reads the wallet's nonce. `test/spend-race.test.ts` sends concurrent
notes through one and two instances on a chain of its own: they stop at the reserve and at the day's cap, and no drop
above the gas cap is signed. Both need Foundry (`forge`, `anvil`) and skip without it.

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
| `AGENT_DAILY_DROP_CAP`, `AGENT_DAILY_SPEND_PERCENT`, `AGENT_MAX_DROP_GAS`, `AGENT_MIN_BALANCE_MON` | 150, 25, 250000, 0.1 | the limits the wallet checks when it signs |
| `AGENT_PER_IP_DROPS_10MIN`, `AGENT_PER_IP_DROPS_DAY` | 5, 20 | per server instance |
| `AGENT_ALLOWED_ORIGINS` | the Letterlock app and the agent's page | the web origins that may POST, comma-separated |

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
vercel firewall rules add --json "$(node -e 'console.log(JSON.stringify(require("./vercel-firewall.json").rules[0]))')" --yes
vercel firewall publish --yes
node scripts/build.mjs && vercel deploy --prebuilt --prod
```

The card's URL is the agent's `tokenURI` in the IdentityRegistry, so its content changes in place. A new URL would
take a `setAgentURI` transaction from the agent's owner. Preview deployments get none of the production variables
(`AGENT_ENABLED` included), so their POST endpoints answer 503 `AGENT_DISABLED`.
