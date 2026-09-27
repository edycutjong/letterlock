# Deploy Letterlock to Monad mainnet (chain 143)

**Status: deployed on 2026-09-27** with these steps (step 0 by way of (b)) at
`0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e`, block 108289180: step 3 printed `sent the compiled source`, and
Sourcify returned `exact_match` for the creation and the runtime code. The record is `deployments/143.json`. Testnet
(`deployments/10143.json`) was redeployed from the same commit first, with the same step-3 checks.

On mainnet the directory is deployed with the real ERC-8004 IdentityRegistry
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, so the agent path is enabled. `script/Deploy.s.sol` picks that
registry on chain 143 by default and refuses any other one there.

## Source changes since the testnet deployment (applied)

The earlier testnet deployment, `0x4DE866601eA5eA35Eb142394Df12bFA936A4b5D4`, was built from commit `10e95d1`. The
changes to `src/Letterlock.sol` below came after it; none could go to that deployment without breaking its Sourcify
exact match. All are in commit `b3bdff4`, which this deploy shipped (as did the testnet redeploy of 2026-09-27), and
nothing else is held back:

1. Registry-call rule (commit `b834302`). `_ownerOf` reads only the registry's `ERC721NonexistentToken(uint256)`
   revert (selector `0x7e273289`, the one the live registry uses) as "no owner", and reverts
   `RegistryCallFailed(agentId)` on any other failure, so a caller that forwards too little gas gets a revert
   instead of all zeros from `keyOfAgent`. This adds `RegistryCallFailed` to the ABI (25 entries;
   `abi/Letterlock.json` and the SDK's `letterlockAbi` are regenerated) and changes no gas snapshot entry. The fork
   regression test `test_fork_gasStarvedReaderNeverReadsZeros` (commit `b1db21d`) reads `keyOfAgent` for agent
   10259 at every gas budget from 5,000 to 80,000 (step 20), each read cold: 0 of 3,751 budgets returned zeros
   (block 108228758; again at block 108279356). Under the previous rule the same test fails: 527 budgets, 35,920 to
   46,440 gas, returned zeros for the live key (block 108228931).
2. `drop` NatSpec: it says only that the envelope format is the docs/SPEC.md §3 UTF-8 JSON, no longer that the SDK
   drops it (the SDK had no drop helper then; it has since gained `drop()` and `inbox()`, and the CLI `letterlock drop`).
3. `keyOfAgent` NatSpec on starved reads (commit `b3bdff4`): a read given too little gas reverts
   `RegistryCallFailed`, or reverts with no data when it runs out of gas in Letterlock itself, as when the 1/64 of
   the gas kept back from a starved registry call cannot pay for the `RegistryCallFailed` revert. Any revert means
   "unknown", never "no key". Comments only: the executable code and every gas snapshot entry are unchanged.

NatSpec is part of the metadata whose hash ends the bytecode, so no wording in `src/Letterlock.sol` can change after
this deploy without losing the exact match.

## Build: never deploy a cached artifact

`forge script` deploys the Letterlock creation code compiled into the script's own artifact
(`out/Deploy.s.sol/Deploy.json`), not the `src/` artifact. With the dynamic test linking that Foundry 1.8 turns on by
default, an edit inside a function body of `src/Letterlock.sol` (code or comment) recompiled only that file and left
the script artifact as it was. The mainnet dry runs of 2026-09-26 carried the metadata hash of a source text that is
in no commit, so Sourcify could not have matched the deployed contract exactly; a logic edit would have deployed the
old logic. Three guards, all part of the steps below:

- `foundry.toml` sets `dynamic_test_linking = false` (commit `b9a8613`), so the script recompiles whenever the
  source does. It is not a compiler input, so it changes no bytecode.
- Step 1 rebuilds every artifact (`forge build --force`) and runs `test_scriptArtifactDeploysTheCurrentSource`
  (`test/Deploy.t.sol`), which fails when the script artifact deploys other code than the current source.
- Step 2 compares the dry run's transaction input with `forge inspect Letterlock bytecode` plus the constructor
  argument before anything is sent. Step 3 repeats every check in the same command as the broadcast, because
  `forge script --broadcast` recompiles from the working tree (see step 3), then compares the transaction that was
  sent.

## 0. Deployer (once)

Use a dedicated mainnet key, separate from the testnet deployer, in Foundry's encrypted keystore
(`~/.foundry/keystores/letterlock-mainnet`). No command here puts the key on a command line, where the process list
and shell history would show it (CI fails on a private-key flag in this folder).

The environment file lives outside the repository (`chmod 600`):

```sh
# ~/.config/monad/mainnet-deployer.env
MONAD_MAINNET_ADDRESS=0x...
MONAD_MAINNET_RPC=https://rpc.monad.xyz
# MONAD_MAINNET_PRIVATE_KEY=0x...   only for (b) below; no later step reads it
```

Import the key once, in one of two ways:

- **(a) At a terminal.** The command prompts for the key and a password:

  ```sh
  cast wallet import letterlock-mainnet --interactive
  ```

- **(b) Without a terminal** (an automated run: `--interactive` needs one), from `MONAD_MAINNET_PRIVATE_KEY` in the
  environment file. The keystore password is a random string in a file of its own, created once (`set -C` refuses
  to overwrite an existing one). From the repository root:

  ```sh
  (umask 077; set -C; openssl rand -hex 32 > ~/.config/monad/letterlock-mainnet.password)
  set -a; source ~/.config/monad/mainnet-deployer.env; set +a
  node contracts/script/keystore-from-env.mjs --key-env MONAD_MAINNET_PRIVATE_KEY --name letterlock-mainnet \
    --password-file ~/.config/monad/letterlock-mainnet.password --expect-address "$MONAD_MAINNET_ADDRESS"
  ```

  The script reads the key from the variable that `--key-env` names, so only the name is on the command line, and
  never prints it. It writes the keystore format that `cast wallet import` writes (mode 600, never over an existing
  file) and keeps the file only if Foundry opens it with the password file and derives `MONAD_MAINNET_ADDRESS`;
  `node --test contracts/script/keystore-from-env.test.mjs` checks this with random keys. Afterwards the
  `MONAD_MAINNET_PRIVATE_KEY` line can be deleted from the environment file.

Fund `MONAD_MAINNET_ADDRESS` with MON. On 2026-09-27, after `forge build --force`, a read-only simulation of this
script (step 2) estimated 1,201,505 gas (the deploy transaction's gas limit) and 0.24270401 MON at a 202 gwei max
fee. The stale dry runs of 2026-09-26 set the same limit; only their metadata hash differed. Monad charges the full
gas limit, not the gas used, so keep a margin (about 0.3 MON), plus gas for the first `publish` / `drop`
transactions.

Run every step below from `contracts/`, in one shell. After (a), leave `--password-file "$PASSWORD_FILE"` out of
steps 1 and 3 and type the password at the prompt instead:

```sh
cd contracts
set -a; source ~/.config/monad/mainnet-deployer.env; set +a
PASSWORD_FILE=~/.config/monad/letterlock-mainnet.password
```

## 1. Pre-flight (read-only)

```sh
git diff --quiet HEAD -- src/Letterlock.sol foundry.toml && echo "source committed"   # Sourcify matches this text
echo $(git rev-parse HEAD:./src/Letterlock.sol HEAD:./foundry.toml)   # PINNED for step 3: copy this line
forge build --force   # rebuild every artifact: never deploy from the cache
test "$(cast chain-id --rpc-url "$MONAD_MAINNET_RPC")" = 143 && echo "chain ok"
test "$(cast wallet address --account letterlock-mainnet --password-file "$PASSWORD_FILE" | tr A-F a-f)" = \
     "$(echo "$MONAD_MAINNET_ADDRESS" | tr A-F a-f)" && echo "key matches address"
cast balance "$MONAD_MAINNET_ADDRESS" --rpc-url "$MONAD_MAINNET_RPC" --ether
cast code 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 --rpc-url "$MONAD_MAINNET_RPC" | head -c 12; echo   # not 0x
LETTERLOCK_REQUIRE_FORK=true forge test
LETTERLOCK_REQUIRE_FORK=true forge test --match-contract LetterlockMainnetForkTest \
  | grep -F "9 passed; 0 failed; 0 skipped" && echo "mainnet fork tests ran"
```

Every check must print its message (and the balance must cover the deploy), and the first `forge test` must exit 0.
It runs every suite, including `test_scriptArtifactDeploysTheCurrentSource` and `test/LetterlockFork.t.sol` against
the live IdentityRegistry. Without `LETTERLOCK_REQUIRE_FORK=true` an unreachable RPC only skips the 9 fork tests,
and `forge test` still exits 0; with it they fail. The last command proves they ran: it prints nothing if any
was skipped.

## 2. Simulate (nothing is sent)

```sh
forge script script/Deploy.s.sol:Deploy --rpc-url "$MONAD_MAINNET_RPC" --sender "$MONAD_MAINNET_ADDRESS"
```

Expect `Agent path enabled: identityRegistry = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and `chain id: 143`.
Then check that the transaction is the source as compiled now, byte for byte, and read its gas limit:

```sh
ARGS=$(cast abi-encode 'constructor(address)' 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)
CODE=$(forge inspect Letterlock bytecode)
EXPECTED="$CODE${ARGS#0x}"
DRY=broadcast/Deploy.s.sol/143/dry-run/run-latest.json
test -n "$ARGS" && test -n "$CODE" && test "$CODE" != 0x &&
  test "$(jq -r '.transactions[0].transaction.input' "$DRY")" = "$EXPECTED" &&
  echo "dry run deploys the compiled source"
jq -r '.transactions[0].transaction.gas' "$DRY" | cast to-dec   # the gas limit
```

Do not broadcast unless it prints `dry run deploys the compiled source`. (On a copy of the tree holding the stale
script artifact of 2026-09-26, this check fails.)

## 3. Broadcast

`forge script --broadcast` recompiles from the working tree, so step 2 alone does not cover what is sent: an edit
to `src/Letterlock.sol` or `foundry.toml` after step 2, committed or not, would be compiled and deployed, and only
the check after the send would notice. Other agents commit in this tree while a deploy runs. So the broadcast is
one `&&` chain that relies on no earlier shell state and sends only when every check passes in that same command:
the source is committed and is the text step 1 tested (`PINNED`), `forge build` compiles nothing, a fresh dry run
sends exactly `EXPECTED`, which must not be empty, and the send follows at once. Paste the line step 1 printed
between the quotes:

```sh
PINNED="<the two ids step 1 printed>" &&
test -f script/Deploy.s.sol && test -n "$PINNED" &&
set -a && . ~/.config/monad/mainnet-deployer.env && set +a &&
PASSWORD_FILE=~/.config/monad/letterlock-mainnet.password &&
REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 &&
git diff --quiet HEAD -- src/Letterlock.sol foundry.toml &&
test "$(echo $(git rev-parse HEAD:./src/Letterlock.sol HEAD:./foundry.toml))" = "$PINNED" &&
forge build | grep -F "No files changed" &&
ARGS=$(cast abi-encode 'constructor(address)' "$REGISTRY") &&
CODE=$(forge inspect Letterlock bytecode) &&
EXPECTED="$CODE${ARGS#0x}" &&
test -n "$ARGS" && test -n "$CODE" && test "$CODE" != 0x &&
forge script script/Deploy.s.sol:Deploy --rpc-url "$MONAD_MAINNET_RPC" --sender "$MONAD_MAINNET_ADDRESS" \
  > /dev/null &&
test "$(jq -r '.transactions[0].transaction.input' broadcast/Deploy.s.sol/143/dry-run/run-latest.json)" \
  = "$EXPECTED" &&
echo "checks passed; sending" &&
forge script script/Deploy.s.sol:Deploy --rpc-url "$MONAD_MAINNET_RPC" \
  --account letterlock-mainnet --password-file "$PASSWORD_FILE" --sender "$MONAD_MAINNET_ADDRESS" --broadcast &&
test -n "$EXPECTED" &&
test "$(jq -r '.transactions[0].transaction.input' broadcast/Deploy.s.sol/143/run-latest.json)" = "$EXPECTED" &&
echo "sent the compiled source"
```

It sends only after `checks passed; sending`, and the deploy is good only if it ends with
`sent the compiled source`. The one gap left is the few seconds between the fresh dry run and the broadcast's own
compile; the last check covers it, after the fact. After (a), drop `--password-file "$PASSWORD_FILE"` as above.

The address, tx hash and block are in `broadcast/Deploy.s.sol/143/run-latest.json` (safe to commit; the RPC
URL and other sensitive values go to `cache/`, which is git-ignored).

```sh
RUN=broadcast/Deploy.s.sol/143/run-latest.json
ADDR=$(jq -r '.transactions[0].contractAddress' "$RUN")
TX=$(jq -r '.transactions[0].hash' "$RUN")
cast receipt "$TX" --rpc-url "$MONAD_MAINNET_RPC" --json | jq '{status, blockNumber, gasUsed}'
```

To repeat the sent-code check in another shell, recompute `ARGS`, `CODE` and `EXPECTED` as in step 2 and keep the
guard, so that an empty `EXPECTED` cannot pass against a missing run file:

```sh
test -n "$ARGS" && test -n "$CODE" && test "$CODE" != 0x &&
  test "$(jq -r '.transactions[0].transaction.input' "$RUN")" = "$EXPECTED" && echo "sent the compiled source"
```

The non-interactive path was run end to end on 2026-09-27 against a local `anvil` chain (31337, so the registry
argument is `address(0)`) with a random test key imported through (b): the key-matches-address check, the broadcast
with `--account` and `--password-file`, and `sent the compiled source` all passed, and the receipt had status 1.
The step-3 chain above was then run as written, in a committed copy of `contracts/` against `anvil` (the only
substitutions: environment and password files, registry `address(0)`, `31337` in the broadcast paths, and
`--keystore` for `--account`). Clean, it sent (status 1) and printed `sent the compiled source`, under both bash
and zsh. It sent nothing (the nonce did not move) after each of: changing `+ 1` to `+ 2` in `_checkNextEpoch`
without committing; committing that change; and pinning the new commit without rebuilding. The earlier post-send
check, run with `EXPECTED` unset and no run file, printed `sent the compiled source`; the guarded one prints nothing.

## 4. Verify the source (MonadVision, through Sourcify)

This is the command that returned `exact_match` for the testnet deployment:

```sh
forge verify-contract "$ADDR" src/Letterlock.sol:Letterlock --chain 143 \
  --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/ \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)" \
  --watch
curl -s "https://sourcify-api-monad.blockvision.org/v2/contract/143/$ADDR"   # expect "match":"exact_match"
```

Monadscan as well (optional; needs an Etherscan API key):

```sh
forge verify-contract "$ADDR" src/Letterlock.sol:Letterlock --chain 143 \
  --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)" \
  --watch
```

## 5. Post-deploy checks (read-only)

```sh
cast call "$ADDR" "identityRegistry()(address)" --rpc-url "$MONAD_MAINNET_RPC"   # 0x8004A169...a432
cast call "$ADDR" "NO_AGENT()(uint256)" --rpc-url "$MONAD_MAINNET_RPC"           # 2^256 - 1
cast call "$ADDR" "keyOfAgent(uint256)(bytes32,uint32,uint64)" 0 --rpc-url "$MONAD_MAINNET_RPC"   # zeros
```

## 6. Record

- Write `deployments/143.json` with the same fields as `deployments/10143.json` (links:
  `https://monadvision.com/address/$ADDR`, `https://monadscan.com/address/$ADDR`).
- `node script/export-abi.mjs --check` must print `ABI up to date` (the ABI does not change per chain).
- Commit `deployments/143.json` and `broadcast/Deploy.s.sol/143/run-latest.json`. Never commit `cache/` or `.env`.

The first mainnet `publish`, `publishForAgent` and `drop` were smoke tests from this deployer with DEMO KEYs (random
bytes in place of a passkey; `script/smoke.mjs`), after it registered ERC-8004 agent 10260: see
`deployments/143.json`. A person's key comes from a passkey-derived account through the SDK, never from this deployer.
