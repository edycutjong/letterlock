# Deploy Letterlock to Monad mainnet (chain 143)

**Status: not deployed yet.** The live deployment is on testnet: `deployments/10143.json`.

On mainnet the directory is deployed with the real ERC-8004 IdentityRegistry
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, so the agent path is enabled. `script/Deploy.s.sol` picks that
registry on chain 143 by default and refuses any other one there.

## Source changes since the testnet deployment (applied)

The testnet deployment was built from commit `d15fe63`. Two changes to `src/Letterlock.sol` were held back from it,
because they would have broken its Sourcify exact match. Both are in the source now, so this deploy ships them, and
nothing else is held back:

1. Registry-call rule (commit `f6f80fa`). `_ownerOf` reads only the registry's `ERC721NonexistentToken(uint256)`
   revert (selector `0x7e273289`, the one the live registry uses) as "no owner", and reverts
   `RegistryCallFailed(agentId)` on any other failure, so a caller that forwards too little gas gets a revert
   instead of all zeros from `keyOfAgent`. This adds `RegistryCallFailed` to the ABI (25 entries;
   `abi/Letterlock.json` and the SDK's `letterlockAbi` are regenerated) and changes no gas snapshot entry. The fork
   regression test `test_fork_gasStarvedReaderNeverReadsZeros` (commit `306fa5d`) reads `keyOfAgent` for agent
   10259 at every gas budget from 5,000 to 80,000 (step 20), each read cold: 0 of 3,751 budgets returned zeros
   (block 108228758). Under the previous rule the same test fails: 527 budgets, 35,920 to 46,440 gas, returned
   zeros for the live key (block 108228931).
2. `drop` NatSpec: it says only that the envelope format is the docs/SPEC.md §3 UTF-8 JSON, no longer that the SDK
   drops it (the SDK has no drop helper yet).

## 0. Deployer (once)

Use a dedicated mainnet key, separate from the testnet deployer. Import it into Foundry's encrypted keystore
(`~/.foundry/keystores/`). The command prompts for the private key and a password, so the key never appears on a
command line, in shell history, or in a plain-text file:

```sh
cast wallet import letterlock-mainnet --interactive
```

The environment file holds no key, only the address and the RPC. It lives outside the repository:

```sh
# ~/.config/monad/mainnet-deployer.env   (chmod 600)
MONAD_MAINNET_ADDRESS=0x...
MONAD_MAINNET_RPC=https://rpc.monad.xyz
```

Fund `MONAD_MAINNET_ADDRESS` with MON. On 2026-09-26 a read-only simulation of this script (step 2) with the
current source estimated 1,201,505 gas (the deploy transaction's gas limit) and 0.2427 MON at a 202 gwei max fee.
Monad charges the full gas limit, not the gas used, so keep a margin (about 0.3 MON), plus gas for the first
`publish` / `drop` transactions.

Run every step below from `contracts/`, in one shell:

```sh
cd contracts
set -a; source ~/.config/monad/mainnet-deployer.env; set +a
```

## 1. Pre-flight (read-only)

```sh
test "$(cast chain-id --rpc-url "$MONAD_MAINNET_RPC")" = 143 && echo "chain ok"
test "$(cast wallet address --account letterlock-mainnet | tr A-F a-f)" = \
     "$(echo "$MONAD_MAINNET_ADDRESS" | tr A-F a-f)" && echo "key matches address"   # asks for the keystore password
cast balance "$MONAD_MAINNET_ADDRESS" --rpc-url "$MONAD_MAINNET_RPC" --ether
cast code 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 --rpc-url "$MONAD_MAINNET_RPC" | head -c 12; echo   # not 0x
forge test   # includes test/LetterlockFork.t.sol against the live IdentityRegistry
```

## 2. Simulate (nothing is sent)

```sh
forge script script/Deploy.s.sol:Deploy --rpc-url "$MONAD_MAINNET_RPC" --sender "$MONAD_MAINNET_ADDRESS"
```

Expect `Agent path enabled: identityRegistry = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and `chain id: 143`.

## 3. Broadcast

```sh
forge script script/Deploy.s.sol:Deploy --rpc-url "$MONAD_MAINNET_RPC" \
  --account letterlock-mainnet --sender "$MONAD_MAINNET_ADDRESS" --broadcast   # asks for the keystore password
```

The address, tx hash and block are in `broadcast/Deploy.s.sol/143/run-latest.json` (safe to commit; the RPC
URL and other sensitive values go to `cache/`, which is git-ignored).

```sh
ADDR=$(jq -r '.transactions[0].contractAddress' broadcast/Deploy.s.sol/143/run-latest.json)
TX=$(jq -r '.transactions[0].hash' broadcast/Deploy.s.sol/143/run-latest.json)
cast receipt "$TX" --rpc-url "$MONAD_MAINNET_RPC" --json | jq '{status, blockNumber, gasUsed}'
```

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

The first real `publish` comes from a passkey-derived account through the SDK, not from this deployer.
