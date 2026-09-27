# Benchmark: resolve + seal on Monad mainnet

Measured 2026-09-27 02:55 UTC with `pnpm bench` (scripts/bench.ts). Every number below is
copied from [results.json](results.json), which also holds all 800 raw samples.

**resolve + seal: p50 29.435 ms · p95 35.605 ms · p99 61.008 ms** over N = 200, against the
public RPC https://rpc.monad.xyz. Sealing alone takes p50 7.107 ms on this machine; the rest is one `keyOf` read over the network.

## Latency (milliseconds)

| Operation | What is timed | n | p50 | p95 | p99 | min | max | mean |
|---|---|---|---|---|---|---|---|---|
| resolve | `ll.resolve(address)`: one `keyOf` eth_call | 200 | **22.869** | 25.555 | 29.215 | 20.752 | 35.238 | 23.142 |
| seal | `seal()`: HPKE to the resolved key, no network | 200 | **7.107** | 12.537 | 15.008 | 2.099 | 20.469 | 7.493 |
| resolve + seal | `ll.sealTo(address, note)`, as one call | 200 | **29.435** | 35.605 | 61.008 | 23.004 | 211.668 | 31.294 |
| rpc round trip | `eth_blockNumber` on the same RPC (context) | 200 | **20.797** | 22.29 | 23.532 | 19.575 | 31.952 | 20.993 |

The first resolve of a new client also runs its one-time checks (`eth_chainId`, `eth_getCode` and `NO_AGENT()`, in
parallel with the `keyOf` read): it took 108.592 ms here, once, and is not in the table.

## What was checked while timing

- Recipient: `0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3`, the mainnet directory's deployer. Its key is the deploy smoke test's **DEMO KEY**
  (kid `db9784b7c246deb1`, epoch 1; deployments/143.json), not a passkey's.
- Every resolve (201, the cold one included) was checked against the recorded key and epoch, and every
  envelope (400) for chain 143, the directory `0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e`, the recipient and kid `db9784b7c246deb1`:
  no mismatch.
- Failed calls: 0 in the measured rounds, 0 in the warm-up.
- The note is 85 bytes; its envelope's wire form (what `drop` sends) is 365 bytes.

## Gas, from mainnet receipts

eth_getTransactionReceipt and eth_getTransactionByHash on https://rpc.monad.xyz for the hashes in deployments/143.json. Cost is the receipt's gas used times its effective gas price. In every receipt the gas used equals the transaction's gas limit.

| Transaction | Gas used | Gas limit | Price (gwei) | Cost (MON) | Recorded | Tx |
|---|---|---|---|---|---|---|
| Letterlock deploy (creation code + registry argument) | 1,201,505 | 1,201,505 | 102 | 0.12255351 | matches | [0x9766a31c…](https://monadvision.com/tx/0x9766a31cb8910e2d1f953176454230e51388acd91fc78dc589b406d15b8f0a03) |
| ERC-8004 register() of agent 10260 (the registry's gas, not Letterlock's) | 224,739 | 224,739 | 102 | 0.022923378 | matches | [0xb6b41dd5…](https://monadvision.com/tx/0xb6b41dd5800042005b96b46d8245f0311b6461bc5cdbc90347952c3393896cf1) |
| publish(pub, 1): an address's first key | 70,863 | 70,863 | 102 | 0.007228026 | matches | [0x35b8330e…](https://monadvision.com/tx/0x35b8330e768a6c7529c0c9c4151d945ed83e3ef596c0c6ddca3486efe11ae233) |
| publishForAgent(10260, pub, 1): an agent's first key (reads the live registry) | 108,799 | 108,799 | 102 | 0.011097498 | matches | [0x3a5be1d8…](https://monadvision.com/tx/0x3a5be1d8643029ded9158bf36d73cd1cac4f4a9f24296ac55518539237e80c26) |
| drop() of a 490-byte envelope | 45,780 | 45,780 | 102 | 0.00466956 | matches | [0x616fe1a9…](https://monadvision.com/tx/0x616fe1a946d1b90461ffd8284be4881f8650799166526c2d22523053bff93659) |

No mainnet rotation has happened yet, so there is no receipt for one. For scale only, forge's gas snapshot
(contracts/snapshots/Letterlock.json, a local EVM run of each call as its own transaction; not a receipt): first publish
70,002, rotation 36,002, drop of a 1 KiB envelope 65,020, of a 16 KiB one 679,420.

## Context

| | |
|---|---|
| Date | 2026-09-27T02:55:09.436Z to 2026-09-27T02:55:26.552Z |
| Machine | MacBookPro18,2, Apple M1 Max, 10 cores, 32 GiB, macOS 26.5.2 (arm64) |
| Load average (1, 5, 15 min) | 2.75 / 6.1 / 7.24 at the start, 3.05 / 5.96 / 7.16 at the end (10 cores) |
| Node.js | v22.22.0 |
| Time zone of the machine | Asia/Jakarta |
| SDK | letterlock 0.1.0, runtime code at `7a33337` (2026-09-27T09:35:08+07:00); checkout `a5c9b03` |
| RPC | https://rpc.monad.xyz (Monad's public endpoint), mainnet blocks 108351358 to 108351413 |
| N | 200 rounds after 5 warm-up rounds; each round times resolve, seal, resolve + seal and an rpc round trip, in that order |
| Percentiles | nearest-rank (every value is a measured sample) |

The network dominates `resolve`: it tracks the plain `eth_blockNumber` round trip from this machine to the RPC, so
another location or endpoint moves it by that difference. `seal` is local CPU (HPKE in JavaScript: an X25519 key
generation and agreement, HKDF and ChaCha20-Poly1305) and does not depend on the chain; it varies with what else the
machine runs, hence the load average above. Nothing in the run is random except HPKE's ephemeral key, which the
protocol requires to be fresh for every seal: the note, the recipient and the order of operations are fixed.

## Reproduce

```sh
pnpm install
pnpm bench            # N = 200; rewrites bench/results.json and bench/RESULTS.md
```
