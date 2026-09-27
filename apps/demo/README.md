# Letterlock app

**Live: <https://letterlock-app.vercel.app>**, on Monad mainnet (chain 143), against the directory
`0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e`. The host is the WebAuthn rpId every Letterlock key is derived under
(`LETTERLOCK_RP_ID` in the SDK): passkeys made anywhere else can never open anything here.

Every flow calls the `letterlock` SDK in the browser; nothing on these pages is simulated. The only example content
is the sample card on the home page before this device has an address, and the `/kit` gallery, and both are stamped
Example.

| Route | What it does, live |
|---|---|
| `/` | **Create my encryption address**: a passkey and its epoch-1 key (`createEncryptionAddress`, rpId pinned), the same passkey's account (`meraAccount`), the gas drip when the account holds no MON, then `publish`. The card shows the key `keyOf` returns, its epoch and the publish transaction. **Rotate** publishes epoch + 1 (`rotate`). |
| `/seal` | `resolve` as the address is typed (the register line found, or the `NO_KEY_PUBLISHED` slip), `sealTo` on this device (the wax presses), then **Post to their inbox** (`drop`, from your passkey account when it holds the gas) or copy the envelope JSON. Sealing needs no passkey. |
| `/open` | `inbox(address)`: the directory's `Dropped` events, read again every 5 seconds from the last finalized block. **Open with passkey** (`open`): the seal cracks and the text rises. **Find my inbox with my passkey** derives the address again on a device that stores nothing; **Paste an envelope** opens one handed over any other way. |
| `/register` (also `/integrations/verify`) | Every `KeyPublished` event, newest first, each linked to its transaction at every width (under its key on phones and portrait tablets), read again every 5 seconds; a live `keyOf` / `keyOfAgent` lookup; the directory's Sourcify record, fetched when the page loads. |
| `/judge` | The three steps, live: create an address; ask the reference agent (ERC-8004 agent 10260, `POST https://letterlock-agent.vercel.app/remember`) to write to it; open it here or on another device (a QR code of the inbox). |
| `/kit` | The design system, every component in every state. |

Every SDK error code has a returned-to-sender slip (`lib/error-copy.ts`), the chain client's included
(`INSUFFICIENT_FUNDS`, `CHAIN_UNAVAILABLE`, `NOT_AGENT_OWNER`); `INPUT_INVALID` is shown beside its field. The pages'
own chain reads (postage, a drop's gas, the register's scans) fail the way the SDK's do: an RPC that does not answer
is the `CHAIN_UNAVAILABLE` slip with its "Try again", never the RPC client's report (`lib/failure.ts`,
`test/failure.test.ts`).

**What this device keeps:** `localStorage["letterlock:v1:<chainId>:<rpId>"]` holds the passkey's credential id and
transports and, once known, its account address. No PRF output, key or seed is ever stored or sent. Clear it and the
passkey finds the address again. A tab opened with the judges' link keeps its pass in
`sessionStorage["letterlock:judge-pass"]` and drops it from the address bar (below, the gas drip).

## The gas drip (`POST /api/drip`)

A passkey account is new and holds no MON, and `publish()` must be sent by that account, so nobody else can pay for
its first key. The drip sends it enough for **one publish**, once. The rules are pure functions in `lib/drip.ts`
(24 unit tests with real viem signatures in `test/drip.test.ts`, 4 more for the page's side in
`test/drip-client.test.ts`); `lib/drip-server.ts` reads the chain and sends.

Anyone can make a fresh key, and a fresh key passes every per-account rule, so what bounds a script that asks with
new accounts in a loop is what the chain shows of the drip wallet: its spend over the last hour and the last day.
`test/drip.test.ts` runs such a script for a whole simulated day against the wallet's real history: it gets at most 5
drips an hour and 20 in the day, and a judge then still gets a drip, and 8 more after it.

- **Proof of the account:** an EIP-191 signature by the account over `letterlock-drip:<address, lower-case>:<chainId>:<unix minute>`,
  taken for 5 minutes either side of the server's clock, on this chain only. The passkey account's session signs it
  (no extra prompt).
- **Only a new, empty account:** no key in the directory, nonce 0, balance 0. One drip per account, ever: checked on
  chain, plus a per-instance LRU of funded addresses.
- **Amount:** `max(1.5 x 70,863 x gas price, 1.1 x 70,863 x the fee cap the wallet will bid)`, capped at 0.02 MON.
  70,863 is the gas a mainnet publish used. The second term exists because viem prepares the publish with
  `eth_fillTransaction` and multiplies the filled fee by 1.2, and Monad mainnet's RPC takes a transaction only when
  its sender holds gas limit x fee cap: at a 100 gwei base fee the fill is 152 gwei, the bid 182.4 gwei, the account
  must hold 0.0129254112 MON, and the drip is 0.01421795232 MON (measured 2026-09-27).
- **Per IP, for every instance:** Vercel's firewall answers a seventh `POST /api/drip` from one IP within 10 minutes
  with its own 429 (`vercel-firewall.json`: fixed window, counted per region; six is one create's request and its
  five `DRIP_BUSY` retries). The page reads that 429 as "too many drip requests from this network".
- **Per IP, per instance:** 12 requests in 10 minutes, 3 drips a day. **Serverless memory is per instance**: Vercel
  runs several, and a new one starts empty, so these limits and the LRU only slow a caller down. What cannot be
  bypassed is read from the chain on every request.
- **Hourly cap: 0.1 MON** in any hour for requests without the judges' pass (about 5 drips at today's fees), counted
  like the daily cap from the wallet's balance and nonce an hour ago. A burst from any number of IPs cannot spend the
  day in minutes, and what an hour spent is free again an hour later (`HOURLY_CAP`).
- **Daily cap: 0.5 MON** in any 24 hours, drips and their fees together, counted from the drip wallet's own balance
  and nonce a day ago (historical state). A top-up inside the window is caught by the nonce and then counted at the
  most a drip can cost. If the RPC no longer holds that state, the drip refuses (`CAP_UNVERIFIABLE`).
- **The judges' reserve:** while `DRIP_JUDGE_PASS` is set (it is, in production), a request without the pass stops
  once the day's spend would pass 70% of the cap (0.35 MON); the last 30% (0.15 MON, 8 to 9 drips) is spent only by
  requests that carry it, and those are not held to the hour. The pass travels in the judges' link
  (`/judge?pass=…` or `/?pass=…`, given with the submission, never in this repository); the page moves it from the
  address bar to the tab's `sessionStorage` and sends it with the drip request. A wrong pass is simply the public's
  lane.
- **One at a time:** under Monad's 10 MON reserve a value transfer must be its sender's only transaction in 3 blocks,
  so the drip refuses (`DRIP_BUSY`, the page asks again) when the wallet has anything pending or sent in the last 4
  blocks, and sends with the nonce it read, so two instances can never both spend.
- **A sent drip is never reported as not sent:** the transfer is broadcast, then its receipt is awaited for 30 s. If
  that wait fails, the answer is 202 with the transaction's hash and the page waits for the MON as after a 200;
  "nothing was sent" is said only when the broadcast itself failed.
- **Kill switch:** `DRIP_ENABLED=true` turns it on; anything else, or no key, turns it off.
- **The key** is the Vercel environment variable `LETTERLOCK_DRIP_PRIVATE_KEY` (production, sensitive), read in the
  route handler only, as is `DRIP_JUDGE_PASS`. No client module imports `lib/drip-server.ts` (a test checks), and a
  scan of 7 production pages and the 19 scripts they load (1,935,271 bytes, deployment `dpl_8cqyaknmxH3kuaUyDimQEtgQFwhQ`)
  found neither value nor either name.

The drip pays for a first key only: a rotation and a posted letter are paid from the account's own MON, and the page
says how much to send, before any passkey prompt, when the account holds too little.

### Running the drip during judging

- **Check it:** `node scripts/drip-status.ts` (read-only, no key) prints the wallet's balance, what one drip costs at
  today's fees, the last hour's and day's spend, and the drips left in each lane. On 2026-09-27 at block 108,383,798:
  0.987015961 MON, a drip of 0.01421795232 MON (0.01677995232 with its fee), 5 public drips left in the hour and 27
  with the judges' pass.
- **Top up:** send MON to the drip wallet, `0x679f4d96bB36fE383110E3Ef6F46daAf92fb315b`. A top-up hides the window's
  spending from the balance, so for the next 24 hours each drip is counted at its most (0.041 MON): about 12 drips a
  day and 2 an hour. Top up a day before the judging window opens, not during it.
- **The judges' link:** `https://letterlock-app.vercel.app/judge?pass=<DRIP_JUDGE_PASS>`. The pass is kept outside
  this repository, with the owner; to change it, `printf %s "$NEW" | vercel env add DRIP_JUDGE_PASS production
  --sensitive` (after `vercel env rm`), redeploy, and send the new link.
- **The firewall:** `vercel firewall rules list` (in this folder) shows the rule `vercel-firewall.json` holds; edit
  the file, then `vercel firewall rules edit "drip POSTs per IP" --json "$(node -e 'console.log(JSON.stringify(require("./vercel-firewall.json").rules[0]))')" --yes`
  and `vercel firewall publish --yes`. The Hobby plan allows one rate-limit rule per project, and windows of up to 10
  minutes.
- **Switch it off:** `vercel env rm DRIP_ENABLED production` and redeploy: the route answers 503 `DRIP_DISABLED` and
  the page shows the postage due, with the amount to send.

## Security headers

`middleware.ts` gives every page a fresh nonce and the policy of `lib/csp.ts`: scripts only with that nonce
(`'strict-dynamic'`, no eval), connections only to `rpc.monad.xyz`, `rpc1.monad.xyz` (the log scans),
`letterlock-agent.vercel.app` and the Sourcify server, no frames, no plugins, no foreign forms. Every page is
rendered per request so it can carry its nonce. Every response carries `nosniff`, `no-referrer`, `DENY` framing,
HSTS, `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that allows passkeys on this origin only.
No analytics and no third-party script.

## Builds

`NEXT_PUBLIC_LETTERLOCK_CHAIN` chooses the chain when the app is built: `monad` (the default) or `monad-testnet`. A
testnet build says so above every page. `NEXT_PUBLIC_LETTERLOCK_DEV_RPID=1` lets a testnet build (never a mainnet
one) make passkeys for its own host, for the end-to-end tests on `localhost`.

## Tests

```sh
pnpm test                 # 80 unit tests: the drip's rules, the page's chain failures and agent calls, the deployment records, slips, tokens, examples
pnpm build && pnpm qa     # design checks on 6 routes at 5 widths: 24 checks, axe, overflow, the colour law
set -a; source ~/.config/monad/testnet-deployer.env; set +a; pnpm e2e   # testnet, below
pnpm smoke https://letterlock-app.vercel.app                            # read-only, below
```

- **End to end** (`scripts/e2e.mjs`, 13 tests): a testnet build on `localhost`, driven in Chromium with a WebAuthn
  virtual authenticator with PRF, so mera's own client runs every ceremony: create, drip (paid by the testnet
  deployer, never the mainnet drip wallet), publish, resolve, seal, drop, inbox, open (the seal cracks), storage
  cleared and the address found again, rotation to epoch 2 (the epoch-1 note still opens), the `TAMPERED`,
  `PASSKEY_FAILED` and `PRF_UNSUPPORTED` slips, and the drip's refusals against the chain. Each chain fact is read
  back from the RPC, and the drip is checked against the fee cap of the publish the wallet signed. Its transactions
  are in `e2e-results/testnet.json`.
- **Smoke** (`scripts/smoke.mjs`, read-only): every route's status, headers and nonce CSP, no console error or CSP
  violation, the register's real lines and a live lookup, each line's transaction link on a 390 px phone, the
  `CHAIN_UNAVAILABLE` slip (and none of the RPC client's report) with the RPCs cut off, the field error for a
  malformed recipient on `/seal`, a note sealed in the page (never sent), a live inbox, the social card, and an
  unsigned drip refused.
- **Live** (`scripts/live-mainnet.mjs`): create and publish on the production site with a virtual passkey; it
  spends a real drip, so it records every run in `e2e-results/mainnet-live.json` and needs `--again` after the first.
  The first run (2026-09-27, 03:37 UTC): the drip landed and the publish that followed was refused by the RPC for the
  reason under **Amount** above; the drip was fixed. Its account `0xceff4e8c0d9b090b36449865320a7387f7f0332f` keeps
  0.010842039 MON that nothing can spend: its virtual passkey is gone.
  The second run (2026-09-27, 05:49 UTC, deployment `dpl_8cqyaknmxH3kuaUyDimQEtgQFwhQ`) passed every step, 3.4 s
  from the click to the published key:
  - the drip, [`0x2d9646ea…2acb`](https://monadvision.com/tx/0x2d9646ea1c6d9833ae2642f184016dda9b1dbb0e93ab723eb08318c480a62acb)
    (block 108,386,048): 0.01421795232 MON from the drip wallet to the passkey account
    `0x4f48fbc6ea52aeB96e93EfB2464798d18F84463C`, more than the 0.0129254112 MON its publish needed at the 182.4 gwei
    fee cap it was signed with;
  - the publish, [`0xd49f8811…7ddf`](https://monadvision.com/tx/0xd49f881173dc3d3c2ab9cb8bb50b58dd090b3e13300715169d171844f2187ddf)
    (block 108,386,054, 70,863 gas): sent by that passkey account, `KeyPublished(who = 0x4f48…463C, epoch 1)`, the
    first key in the mainnet directory that the deployer did not post;
  - the register found it; a note sealed to it in the page opened pasted; the reference agent's drop
    [`0x44428957…02d9`](https://monadvision.com/tx/0x44428957ac2831cc02792d212e5adc802310e73f7b989b7822eb2c793d0602d9)
    (block 108,386,081, from its own wallet) opened from the inbox, and again after the storage was cleared.
  Its virtual passkey is gone too: the register marks the key as a test key (`lib/known-keys.json`), and its account
  keeps 0.00698992632 MON.

## Deploy

The Vercel project `letterlock-app` builds from the repository root with Root Directory `apps/demo` and installs
only this app's graph (`pnpm install --frozen-lockfile --filter letterlock-demo...`). Deploy a clean export of a
commit, so nothing uncommitted is uploaded:

```sh
mkdir -p /tmp/letterlock-deploy/.vercel && git archive HEAD | tar -x -C /tmp/letterlock-deploy
cp apps/demo/.vercel/project.json /tmp/letterlock-deploy/.vercel/   # after `vercel link --project letterlock-app` in apps/demo
cd /tmp/letterlock-deploy && vercel deploy --prod
```

Production environment: `LETTERLOCK_DRIP_PRIVATE_KEY` and `DRIP_JUDGE_PASS` (both sensitive) and `DRIP_ENABLED=true`,
added with `printf %s "$VALUE" | vercel env add NAME production`, never as a command-line argument. Optional:
`DRIP_DAILY_CAP_MON` and `DRIP_HOURLY_CAP_MON`, which on mainnet can only lower the caps. The firewall rule is
`vercel-firewall.json`: `vercel firewall rules add --json "$(node -e 'console.log(JSON.stringify(require("./vercel-firewall.json").rules[0]))')" --yes`
then `vercel firewall publish --yes`, from this folder.
