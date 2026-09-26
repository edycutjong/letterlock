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
forge test -vvv          # includes the Monad mainnet fork test (network); set MONAD_MAINNET_RPC to override
forge coverage --no-match-path test/LetterlockGas.t.sol --no-match-coverage "test/" --report summary
forge snapshot --check --match-path test/LetterlockGas.t.sol
```

Measured on 2026-09-26 (Foundry 1.8.3, `network = "monad"`):

- `forge test -vvv`: 88 tests passed, 0 failed, 0 skipped. That is 65 unit and fuzz tests (10 fuzz tests,
  1,024 runs each), 7 mainnet-fork tests, 6 deploy-script tests, 8 gas benchmarks, and 2 in the invariant suite:
  5 invariants over 256 runs × 128 calls (32,768 calls), plus a fixed-seed 3,000-call walk that reaches every
  accept and reject path.
- Coverage of `src/Letterlock.sol`: 100% of lines (60/60), statements (84/84), branches (20/20) and functions (10/10).
- Mutation check (34 hand-written mutants of `Letterlock.sol`): 33 killed. The survivor turns `>= 0xed` into
  `> 0xed` in the u ≥ p check, and it is equivalent: u = p is already rejected as a libsodium small-order entry.
- The fork test deploys on the latest mainnet block and reads the live registry's `ownerOf` for agent 10259
  (registered in tx `0x0b11de186c6bf57d53300239086398712d17e01967844e701be72a287f7d8f77`) and for agent 0. It is
  skipped, with the RPC error, when the RPC is unreachable.

## Gas

Execution gas per call under Monad execution, from `snapshots/Letterlock.json` (`test/LetterlockGas.t.sol`,
storage cooled first). This excludes the 21,000 intrinsic cost and calldata. The agent rows use the test-double
registry.

| Call | Gas |
|---|---|
| `publish`, first key | 69,893 |
| `publish`, rotation | 35,893 |
| `publishForAgent`, first key | 89,089 |
| `keyOf` | 8,756 |
| `keyOfAgent` | 28,011 |
| `drop`, 1 KiB, to an address | 65,020 |
| `drop`, 1 KiB, to an agent | 76,569 |
| `drop`, 16 KiB, to an address | 679,420 |

Testnet receipts, which are charged at the gas limit: deploy 1,098,346 · `publish` 70,753 · `drop` (484-byte
envelope) 45,708.

## Scripts

- `script/Deploy.s.sol`: deploy (testnet: registry `address(0)`; mainnet: the ERC-8004 registry is enforced).
- `script/DeployMainnet.md`: exact mainnet steps. Not run yet.
- `script/export-abi.mjs`: forge artifact → `abi/Letterlock.json` + `packages/letterlock/src/abi.ts` (`--check`).
- `script/testnet-smoke.mjs`: derives a TEST KEY and seals a note with the SDK (`prepare`), then after
  `cast send publish` / `cast send drop` it reads both back from the chain and opens the envelope (`verify`).
