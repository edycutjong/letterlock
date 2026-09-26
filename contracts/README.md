# Letterlock contract

`src/Letterlock.sol` is the onchain half of Letterlock: a public directory of passkey-derived X25519 encryption
keys. A device derives the key from its passkey's PRF output (`docs/SPEC.md` §2) and publishes only the public
half. Anyone reads `keyOf` / `keyOfAgent` and seals to it with HPKE. The contract has no owner, no admin, no
upgrade path, and holds no funds.

## Deployments

| Network | Address | Registry | Source |
|---|---|---|---|
| Monad testnet (10143) | [`0x311921118F2D40f37e554516069A918bA290e75C`](https://testnet.monadvision.com/address/0x311921118F2D40f37e554516069A918bA290e75C) | none: agent path disabled | Sourcify `exact_match` |
| Monad mainnet (143) | not deployed yet ([script/DeployMainnet.md](script/DeployMainnet.md)) | ERC-8004 `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | |

The testnet record, including a real `publish` and a real `drop`, is in [`deployments/10143.json`](../deployments/10143.json).
The published key there is a TEST KEY: the SDK's `deriveKeyPair()` over 32 random bytes standing in for a
passkey PRF output. The ERC-8004 IdentityRegistry exists only on mainnet, so testnet runs with the agent path
disabled.

## Interface

| Function | Who | What |
|---|---|---|
| `publish(bytes32 pub, uint32 epoch)` | anyone, for themselves | writes `msg.sender`'s key; `epoch` must exceed the current one (the first may be any value >= 1) |
| `publishForAgent(uint256 agentId, bytes32 pub, uint32 epoch)` | `identityRegistry.ownerOf(agentId)` | same rules, for an ERC-8004 agent |
| `keyOf(address)` → `(pub, epoch, updatedAt)` | view | zeros when none |
| `keyOfAgent(uint256)` → `(pub, epoch, updatedAt)` | view | zeros when none, or when the agent's current owner is not the key's publisher |
| `agentKeyRecord(uint256)` → `(pub, epoch, updatedAt, publisher)` | view | the raw record, for indexers and new owners |
| `drop(address to, uint256 toAgent, bytes envelope)` | anyone | demo transport: emits `Dropped`, stores nothing |

Events: `KeyPublished(address indexed who, uint256 indexed agentId, bytes32 pub, uint32 epoch)`,
`Dropped(address indexed to, uint256 indexed toAgent, bytes envelope)`. ABI: `abi/Letterlock.json`, and
`packages/letterlock/src/abi.ts` for viem (regenerate with `node script/export-abi.mjs`).

## Design decisions

- **Key rules.** `pub` must be non-zero (`ZeroKey`), must not be one of libsodium's small-order encodings
  (`LowOrderKey`; all 14, since libsodium ignores bit 255), and must be canonical: bit 255 clear and u < 2^255 − 19
  (`NonCanonicalKey`). A non-canonical spelling of a valid key still seals, but the envelope can never be opened,
  because HPKE binds the sender's copy of the key bytes and the recipient re-derives the canonical ones.
- **Epochs** strictly increase per slot, so an (address or agent, epoch) pair names at most one key, ever.
  Rotation is a higher epoch; old epochs stay derivable off-chain, so old envelopes still open.
- **`NO_AGENT = type(uint256).max`** marks the address path in `KeyPublished.agentId` and in `drop` / `Dropped`
  `toAgent`. It cannot be 0, because agent 0 exists on mainnet. `publishForAgent` rejects `NO_AGENT`
  (`AgentIdReserved`), so the marker is unambiguous.
- **Drop recipients.** Exactly one kind: `(to, NO_AGENT)` for an address, or `(address(0), agentId)` for an
  agent (`InvalidRecipient` otherwise). The envelope is 1 to 16,384 bytes (`EmptyEnvelope`, `EnvelopeTooLarge`).
  The recipient must have a key that resolves now (`NoKeyPublished`), so no drop is unopenable by design.
- **Agent keys follow the NFT.** After a transfer or burn, `keyOfAgent` returns zeros, because the previous owner
  holds the passkey. The new owner publishes an epoch above the stored one.
- **Trust.** The agent path is only as trustworthy as the ERC-8004 registry, which is an upgradeable proxy on
  mainnet. Anyone may `drop` (HPKE base mode is anonymous), so recipients can be spammed and envelopes replayed:
  see the threat model in `docs/SPEC.md` §6.

## Build and test

```sh
git submodule update --init --recursive   # forge-std v1.16.2
cd contracts
forge build
forge test -vvv          # includes the Monad mainnet fork tests (network); set MONAD_MAINNET_RPC to override
forge test --match-path test/LetterlockGas.t.sol --gas-snapshot-check true   # exits 1 if a gas number moved
forge coverage --no-match-path test/LetterlockGas.t.sol --no-match-coverage "test/" --report summary
node script/mutate.mjs   # mutation check; exits 1 if a mutant not marked equivalent survives
node script/export-abi.mjs --check
```

Measured on 2026-09-26 (Foundry 1.8.3, `network = "monad"`):

- `forge test -vvv`: 96 tests passed, 0 failed, 0 skipped. That is 72 unit and fuzz tests (11 fuzz tests,
  1,024 runs each), 8 mainnet-fork tests, 6 deploy-script tests, 8 gas benchmarks, and 2 in the invariant suite:
  5 invariants over 256 runs × 128 calls (32,768 calls), plus a fixed-seed 3,000-call walk that reaches every
  accept and reject path.
- Coverage of `src/Letterlock.sol`: 100% of lines (62/62), statements (85/85), branches (19/19) and functions (11/11).
- Mutation check (`node script/mutate.mjs`): 41 hand-written mutants of `src/Letterlock.sol`, each run against the
  unit, fuzz (256 runs), invariant (32 runs) and deploy tests in a scratch copy; the fork and gas tests are left out.
  40 killed. The survivor (#39) turns `>= 0xed` into `> 0xed` in the u ≥ p check, and it is equivalent: u = p is
  already rejected as a libsodium small-order entry.
- The fork test deploys on the latest mainnet block and reads the live registry's `ownerOf` for agent 10259
  (registered in tx `0x0b11de186c6bf57d53300239086398712d17e01967844e701be72a287f7d8f77`) and for agent 0. It is
  skipped, with the RPC error, when the RPC is unreachable.

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

Check that no number moved (exits 1 on any change):

```sh
forge test --match-path test/LetterlockGas.t.sol --gas-snapshot-check true
```

## Scripts

- `script/Deploy.s.sol`: deploy (testnet: registry `address(0)`; mainnet: the ERC-8004 registry is enforced).
- `script/DeployMainnet.md`: exact mainnet steps. Not run yet.
- `script/export-abi.mjs`: forge artifact → `abi/Letterlock.json` + `packages/letterlock/src/abi.ts` (`--check`).
- `script/testnet-smoke.mjs`: derives a TEST KEY and seals a note with the SDK (`prepare`), then after
  `cast send publish` / `cast send drop` it reads both back from the chain and opens the envelope (`verify`).
