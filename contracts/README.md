# Letterlock contract

`src/Letterlock.sol` is the onchain half of Letterlock: a public directory of passkey-derived X25519 encryption
keys. A device derives the key from its passkey's PRF output (`docs/SPEC.md` §2) and publishes only the public
half. Anyone reads `keyOf` / `keyOfAgent` and seals to it with HPKE. The contract has no owner, no admin and no
upgrade path, and no function accepts value.

## Deployments

| Network | Address | Registry | Source |
|---|---|---|---|
| Monad mainnet (143) | [`0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e`](https://monadvision.com/address/0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e) | ERC-8004 `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | commit `b3bdff4`, Sourcify `exact_match` (creation and runtime) |
| Monad testnet (10143) | [`0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a`](https://testnet.monadvision.com/address/0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a) | none: agent path disabled | commit `b3bdff4`, Sourcify `exact_match` |

Both deploy transactions carry the same creation code; only the constructor argument, the registry, differs. The
mainnet record, [`deployments/143.json`](../deployments/143.json), was made with [script/DeployMainnet.md](script/DeployMainnet.md)
and holds the deploy and the first real mainnet transactions, all from the deployer: it registered ERC-8004 agent
**#10260** in the IdentityRegistry (its agent card: <https://letterlock-agent.vercel.app/.well-known/agent-card.json>,
source in `examples/agent-memory`), then sent a `publish`, a `publishForAgent` for agent 10260 and a `drop` of a 490-byte
envelope sealed with the SDK's `seal()`. Both published keys are DEMO KEYs: the SDK's `deriveKeyPair()` over 32
random bytes standing in for a passkey PRF output, with no passkey behind them. The stand-ins are kept outside the
repository by the deployer's operator, so the drop can be opened again, and whoever holds them can open anything
sealed to these keys: never seal a real note to them. `keyOf(deployer)` and `keyOfAgent(10260)` returned them, and
the dropped envelope opened with the re-derived key. Agent 10260 has since published epoch 2, the reference agent's
own key (`examples/agent-memory`, `publishForAgent` transaction `0x072dc08d72aefacbe3fe05fedd2296c857c1181fbfa9f548c7ed9322594c294b`),
so `keyOfAgent(10260)` now returns that key; the record is `agent.keys` in `deployments/143.json`.

The testnet record, including a real `publish` and a real `drop`, is in [`deployments/10143.json`](../deployments/10143.json).
The published key there is a TEST KEY: the SDK's `deriveKeyPair()` over 32 random bytes standing in for a
passkey PRF output, its stand-in kept the same way. The ERC-8004 IdentityRegistry exists only on mainnet, so
testnet runs with the agent path disabled. Two earlier testnet deployments are superseded (both listed under
`previous` in the record):
`0x311921118F2D40f37e554516069A918bA290e75C` predates the epoch rule below (it accepted any higher epoch), and
`0x4DE866601eA5eA35Eb142394Df12bFA936A4b5D4` (commit `10e95d1`) predates the registry-call rule and the current
`drop` and `keyOfAgent` NatSpec. The current testnet directory is the current `src/Letterlock.sol` (commit
`b3bdff4`), deployed with the same checks as the mainnet runbook: its deploy transaction's input was compared with
`forge inspect Letterlock bytecode` plus the constructor argument before and after sending.

## Interface

| Function | Who | What |
|---|---|---|
| `publish(bytes32 pub, uint32 epoch)` | anyone, for themselves | writes `msg.sender`'s key; `epoch` must be the current one + 1 (the first is 1) |
| `publishForAgent(uint256 agentId, bytes32 pub, uint32 epoch)` | `identityRegistry.ownerOf(agentId)` | same rules, for an ERC-8004 agent; the epoch sequence continues across owners |
| `keyOf(address)` → `(pub, epoch, updatedAt)` | view | zeros when none |
| `keyOfAgent(uint256)` → `(pub, epoch, updatedAt)` | view | zeros when none, or when the agent's current owner is not the key's publisher; reverts when the registry cannot answer (`RegistryCallFailed`, or no data when the read runs out of gas): any revert means unknown, never no key |
| `agentKeyRecord(uint256)` → `(pub, epoch, updatedAt, publisher)` | view | the raw record, for indexers and new owners |
| `drop(address to, uint256 toAgent, bytes envelope)` | anyone | demo transport: emits `Dropped`, stores nothing |

Events: `KeyPublished(address indexed who, uint256 indexed agentId, bytes32 pub, uint32 epoch)`,
`Dropped(address indexed to, uint256 indexed toAgent, bytes envelope)`. ABI: `abi/Letterlock.json`, and
`letterlockAbi` for viem, exported by the `letterlock` package from `packages/letterlock/src/abi.ts` (regenerate
both with `node script/export-abi.mjs`).

## Design decisions

- **Key rules.** `pub` must be non-zero (`ZeroKey`), must not be one of libsodium's small-order encodings
  (`LowOrderKey`; all 14, since libsodium ignores bit 255), and must be canonical: bit 255 clear and u < 2^255 − 19
  (`NonCanonicalKey`). A non-canonical spelling of a valid key still seals, but the envelope can never be opened,
  because HPKE binds the sender's copy of the key bytes and the recipient re-derives the canonical ones.
- **Epochs** go 1, 2, 3, ...: the first key is epoch 1 and every publish is exactly the current epoch + 1
  (`EpochNotNext`), so an (address or agent, epoch) pair names at most one key, ever. Old epochs stay derivable
  off-chain, so old envelopes still open. Reaching epoch n takes n publishes, so no single call (a mistaken or
  phished one, or a seller's just before an agent transfer) can use up the epochs and freeze a slot.
- **`NO_AGENT = type(uint256).max`** marks the address path in `KeyPublished.agentId` and in `drop` / `Dropped`
  `toAgent`. It cannot be 0, because agent 0 exists on mainnet. `publishForAgent` rejects `NO_AGENT`
  (`AgentIdReserved`), so the marker is unambiguous.
- **Drop recipients.** Exactly one kind: `(to, NO_AGENT)` for an address, or `(address(0), agentId)` for an
  agent (`InvalidRecipient` otherwise). The envelope is 1 to 16,384 bytes (`EmptyEnvelope`, `EnvelopeTooLarge`).
  The recipient must have a key that resolves now (`NoKeyPublished`), so no drop can target a recipient without a
  live key. The contract does not validate the envelope: any 1 to 16,384 bytes are accepted. The format is the
  `docs/SPEC.md` §3 UTF-8 JSON, which the SDK's `drop()` sends and its `inbox()` reads back from `Dropped` logs (from a
  terminal: `letterlock drop`, `letterlock inbox`). The smoke-test drops on mainnet and testnet were sent with `cast send`.
- **Agent keys follow the NFT.** After a transfer or burn, `keyOfAgent` returns zeros, because the previous owner
  holds the passkey. The new owner publishes the stored epoch + 1 (read it with `agentKeyRecord`). A drop to an
  agent is sealed to the key that resolves at that moment, so after a transfer only the previous owner can open it.
- **Indexers.** A `KeyPublished` log is history, not liveness: no Letterlock event marks the registry transfer or
  burn that stops an agent key from resolving. Confirm an agent key with `keyOfAgent` when sealing (or join the
  registry's `Transfer` events). Never seal from indexed events alone, or the note can go to the previous owner.
- **Registry calls fail closed.** `keyOfAgent`, `publishForAgent` and a drop to an agent call the registry's `ownerOf`
  in a `try`. Only its `ERC721NonexistentToken(uint256)` revert (selector `0x7e273289`: the agent was never minted, or
  was burned) reads as "no owner". Any other failure (no revert data, which is what running out of gas returns;
  another error; a panic) reverts `RegistryCallFailed(agentId)`, unless the read then runs out of gas in Letterlock
  itself, which reverts with no data: after a starved registry call only 1/64 of the gas available at the call is left
  (the call got the other 63/64), which may not pay for the `RegistryCallFailed` revert. So zeros from `keyOfAgent`
  always mean that no key resolves, never that the call was starved of gas, and a contract reading it needs no
  workaround beyond forwarding enough gas and reading any revert, not only `RegistryCallFailed`, as "unknown". On a
  Monad mainnet fork (block 108279356, agent 10259), a contract read `keyOfAgent` at every gas budget from 5,000 to
  80,000 (step 20), each read cold: every budget from 46,620 up returned the key, every smaller one reverted (767 with
  `RegistryCallFailed`, 1,314 with no data, out of gas inside Letterlock), and none returned zeros (the same counts as
  at block 108228758). Under the rule the testnet deployment was built with, which read any failure as "no owner", the
  same sweep returned zeros at 527 budgets (35,920 to 46,440 gas; block 108228931). An `eth_call` from an app is never
  starved.
- **Trust.** The agent path is only as trustworthy as the ERC-8004 registry, which is an upgradeable proxy on
  mainnet. If an upgrade changed its revert for a missing agent, reads and drops for such an agent would revert
  `RegistryCallFailed` instead of returning zeros or `NoKeyPublished`: they fail closed. Anyone may `drop` (HPKE
  base mode is anonymous), so recipients can be spammed and envelopes replayed: see the threat model in
  `docs/SPEC.md` §6.

## Build and test

```sh
git submodule update --init --recursive   # forge-std v1.16.2
cd contracts
forge build
forge test -vvv          # includes the Monad mainnet fork tests (network); set MONAD_MAINNET_RPC to override
LETTERLOCK_REQUIRE_FORK=true forge test -vvv   # the same, but an unreachable RPC fails the fork tests, never skips them
forge test --match-path test/LetterlockGas.t.sol --gas-snapshot-check true   # exits 1 if a gas number moved
git diff --exit-code -- snapshots/   # exits 1 if an entry was added, removed or rewritten
forge coverage --no-match-path test/LetterlockGas.t.sol --no-match-coverage "test/" --report summary
node script/mutate.mjs   # mutation check; exits 1 if a mutant not marked equivalent survives
node script/export-abi.mjs --check
node --test script/keystore-from-env.test.mjs   # the keystore import for a deploy without a terminal
node --test script/outside-repo.test.mjs   # smoke.mjs never writes its key file inside the repository
node --test script/records.test.mjs   # this README's deploy numbers and key notes match deployments/*.json
```

`foundry.toml` sets `dynamic_test_linking = false`: with Foundry 1.8's default, an edit inside a function body of
`src/Letterlock.sol` recompiled only that file, and `script/Deploy.s.sol`, which compiles in the Letterlock creation
code, kept deploying the previous code (`script/DeployMainnet.md`, "Build").

Measured on 2026-09-27 (Foundry 1.8.3, `network = "monad"`):

- `LETTERLOCK_REQUIRE_FORK=true forge test -vvv`: 111 tests passed, 0 failed, 0 skipped. That is 72 unit and fuzz
  tests (11 fuzz tests, 1,024 runs each), 10 registry-call tests, 9 mainnet-fork tests, 3 fork-gate tests, 7
  deploy-script tests, 8 gas benchmarks, and 2 in the invariant suite: 5 invariants over 256 runs × 128 calls
  (32,768 calls), plus a fixed-seed 3,000-call walk that reaches every accept and reject path.
- The deploy-script tests include `test_scriptArtifactDeploysTheCurrentSource`: the script artifact that
  `forge script` runs must deploy exactly the runtime code of the current `src/Letterlock.sol` artifact, metadata
  hash included. On a copy of the tree holding the stale script artifact of 2026-09-26 it fails.
- The registry-call tests (`test/LetterlockRegistryCall.t.sol`) run all three agent paths against a test-double
  registry whose `ownerOf` fails in one chosen way (no revert data, a real out-of-gas, an error string, another
  custom error, a panic, 3 bytes of the right selector), and `keyOfAgent` against an answer that does not decode.
  They check that `ERC721NonexistentToken` alone reads as "no owner", and repeat the gas-budget sweep offline
  through a proxy test double (the live registry is a proxy): 0 of 3,751 budgets return zeros, against 512 under
  the previous rule. With `ownerOf` out of gas, a read given 20,000 gas reverts with no data (too little is left
  for the `RegistryCallFailed` revert) and one given 1,000,000 reverts `RegistryCallFailed`; both sweeps must
  reach both kinds of revert.
- Coverage of `src/Letterlock.sol`: 100% of lines (64/64), statements (89/89), branches (20/20) and functions (11/11).
- Mutation check (`node script/mutate.mjs`): 46 hand-written mutants of `src/Letterlock.sol`, each run against the
  unit, fuzz (256 runs), invariant (32 runs), registry-call, fork-gate and deploy tests in a scratch copy; the fork
  and gas tests are left out. 44 killed. Both survivors are equivalent: #20 drops the length check before the selector
  comparison, but `bytes4()` zero-pads revert data shorter than 4 bytes and the selector ends in `0x89`, so it
  never matches; #44 turns `>= 0xed` into `> 0xed` in the u ≥ p check, but u = p is already rejected as a libsodium
  small-order entry.
- The fork tests deploy on the latest mainnet block and read the live registry's `ownerOf` for agent 10259
  (registered in tx `0x0b11de186c6bf57d53300239086398712d17e01967844e701be72a287f7d8f77`) and for agent 0. One moves
  agent 10259 with the registry's own `transferFrom` and checks that the buyer publishes the stored epoch + 1. One
  checks that the live registry reverts `ERC721NonexistentToken` for an unregistered id. One is the gas-budget sweep
  of the registry-call rule above, which fails if any budget returns zeros. When the RPC is unreachable they are
  skipped, with the RPC error, unless `LETTERLOCK_REQUIRE_FORK=true` is set: then they fail (the mainnet deploy
  pre-flight sets it). The flag is parsed strictly: `true`, `1` and `false`, `0` in any case; any other value (`yes`,
  `on`, a typo, empty) fails setUp rather than reading as false and skipping. The 3 fork-gate tests
  (`test/MainnetForkGate.t.sol`) check both behaviours offline, against a refused connection, and the strict parse.

## Gas

From `snapshots/Letterlock.json`, written by `test/LetterlockGas.t.sol` under Foundry's Monad execution environment
(`network = "monad"`, `isolate = true`). The agent rows use the test-double registry; the live ERC-8004 registry is a
proxy and costs more.

| Call | Transaction gas | Execution gas |
|---|---|---|
| `publish`, first key | 70,002 | 48,286 |
| `publish`, rotation | 36,002 | 14,286 |
| `publishForAgent`, first key | 89,198 | 67,330 |
| `drop`, 1 KiB envelope, to an address | 65,020 (calldata floor) | 19,387 |
| `drop`, 1 KiB envelope, to an agent | 76,573 | 38,565 |
| `drop`, 16 KiB envelope, to an address | 679,420 (calldata floor) | 143,947 |
| `keyOf` (view) | none | 8,756 |
| `keyOfAgent` (view) | none | 28,015 |

- **Transaction gas** is the whole transaction, as its receipt reports it. Each write runs isolated, as its own
  transaction with cold storage, so the number includes the 21,000 base cost and the calldata. Under EIP-7623,
  calldata and execution are charged together as max(4 × tokens + execution, 10 × tokens); a zero byte is 1 token,
  any other byte 4. Monad charges the gas limit rather than the gas used, so set the limit to at least this number.
- **Execution gas** of a write is derived as transaction − 21,000 − 4 × tokens. A drop of a JSON envelope (every
  byte non-zero) pays exactly the 10-per-token floor, which hides its execution, so drop execution is measured on a
  zero-filled envelope of the same length: `drop` reads only the length. Each drop benchmark asserts that both
  measurements fit the formula above.
- A view is a static call, which Foundry does not isolate: its number is execution only, with Letterlock's storage
  cold, as when another contract reads a key in its own transaction. An `eth_call` from an app costs nothing.
- At both measured sizes, a drop to an address pays exactly the floor, 24,060 + 40 gas per envelope byte: the
  envelope's size, not the contract's execution, sets the price.
- The registry-call rule left every entry unchanged: its extra code runs only when `ownerOf` fails. Turning dynamic
  test linking off left every entry unchanged too.

Mainnet receipts (commit `b3bdff4`), each equal to its transaction's gas limit: deploy 1,201,505 · `publish` 70,863 ·
`publishForAgent` 108,799 against the live registry (89,198 against the test double above) · `drop` (490-byte
envelope) 45,780; registering the agent (the registry's `register(string)`) took 224,739. At the 102 gwei every one of
them paid, the five cost 0.168471972 MON, exactly the deployer's balance change. Testnet receipts (same commit): deploy
1,187,921 · `publish` 70,863 · `drop` (492-byte envelope) 45,804.

Both deploy limits were set by `forge script`, whose default margin is 1.3 × `eth_estimateGas`, rounded down:
1.3 × 924,235 = 1,201,505 on mainnet and 1.3 × 913,786 = 1,187,921 on testnet (both creation transactions estimated
again on 2026-09-27, each on its own network and from its deployer). The registry argument adds 10,449 gas to the
estimate: 10,100 is the constructor's `registry.code.length` check, a cold `EXTCODESIZE` that `address(0)` skips
(Monad prices a cold account access at 10,100 gas, Ethereum at 2,600), and 240 is calldata (the address's 20
non-zero bytes cost 16 gas each, a zero byte 4); the other 109 is not broken down here. Monad charges the gas limit,
so the margin cost 277,270 gas of the mainnet deploy, 0.02828154 MON at 102 gwei (`--gas-estimate-multiplier` sets
it). `records.test.mjs` checks these numbers against the records.

Check that no number moved:

```sh
forge test --match-path test/LetterlockGas.t.sol --gas-snapshot-check true
git diff --exit-code -- snapshots/
```

`--gas-snapshot-check true` exits 1 only when an entry that is both in the file and produced by the run has a
different value. It rewrites the file with exit 0 when the run adds an entry or does not produce one, so a run
filtered to part of `LetterlockGas.t.sol` (`--match-test`) cuts the committed file down, and a deleted or renamed
benchmark passes. The `git diff` catches both; CI runs it after the tests.

## Scripts

- `script/Deploy.s.sol`: deploy (testnet: registry `address(0)`; mainnet: the ERC-8004 registry is enforced).
- `script/DeployMainnet.md`: exact mainnet steps, run on 2026-09-27 (`deployments/143.json`).
- `script/keystore-from-env.mjs`: imports a deployer key from an environment variable into a Foundry keystore
  without a terminal (the variable's name, not its value, is on the command line); `keystore-from-env.test.mjs`
  checks it with random keys.
- `script/export-abi.mjs`: forge artifact → `abi/Letterlock.json` + `packages/letterlock/src/abi.ts` (`--check`).
- `script/mutate.mjs`: the mutation check. It holds the mutant list, and runs each mutant in a scratch copy of
  `contracts/`, never in this tree (`--only 1,4`, `--jobs 8`, `--verbose`).
- `script/smoke.mjs`: derives a key with no passkey behind it (the SDK's `deriveKeyPair()` over 32 random bytes in
  place of a passkey PRF output; labelled TEST KEY, or DEMO KEY on mainnet) and seals a note to it with `seal()`
  (`prepare`). The stand-in goes to `--out`, outside the repository; whoever keeps it can open what is sealed to
  the key. After `cast send publish` / `publishForAgent` / `drop` it reads the key back with `keyOf` or
  `keyOfAgent`, and with `--drop-tx` reads the `Dropped` envelope from the receipt, checks its chain, directory and
  recipient, and opens it (`verify`).
- `script/outside-repo.mjs`: the check behind `smoke.mjs --out`. It decides by file identity, not path text: after
  symlinks are resolved on the part of the path that exists, the path is inside when that folder or any folder above
  it has the repository root's device and inode. So `./..keys`, a link into the tree, another letter case and macOS's
  `/System/Volumes/Data/...` name for the repository are all refused, and so is a dangling link. `prepare` also
  refuses an `--out` that already holds `key.json` or `envelope.json` (or a symlink by that name), so an earlier
  stand-in is never replaced, and writes both exclusively with mode 600 (`outside-repo.test.mjs`).
