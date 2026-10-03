# Benchmark: resolve + seal on Monad mainnet

Measured 2026-10-03 08:23 UTC with `pnpm bench` (scripts/bench.ts). Every number below is
copied from [results.json](results.json), which also holds all 4,005 raw samples.

**resolve + seal: p50 27.876 ms · p95 34.928 ms · p99 166.123 ms** over N = 1,000
(5 runs of 200), against the public RPC https://rpc.monad.xyz. Sealing alone takes p50 6.981 ms on this machine; the rest is one
`keyOf` read over the network. From run to run, the resolve + seal p50 ranged 26.717–28.795 ms,
and the p99 37.123–174.049 ms.

## Latency (milliseconds, every run pooled)

| Operation | What is timed | n | p50 | p95 | p99 | min | max | mean |
|---|---|---|---|---|---|---|---|---|
| resolve | `ll.resolve(address)`: one `keyOf` eth_call | 1000 | **20.443** | 22.942 | 157.04 | 18.51 | 175.997 | 22.869 |
| seal | `seal()`: HPKE to the resolved key, no network | 1000 | **6.981** | 11.634 | 15.374 | 1.899 | 44.656 | 6.968 |
| resolve + seal | `ll.sealTo(address, note)`, as one call | 1000 | **27.876** | 34.928 | 166.123 | 20.51 | 201.023 | 30.943 |
| rpc round trip | `eth_blockNumber` on the same RPC (context) | 1000 | **18.689** | 20.371 | 22.957 | 16.377 | 25.623 | 18.818 |

The first resolve of a new client also runs its one-time checks (`eth_chainId`, `eth_getCode` and `NO_AGENT()`, in
parallel with the `keyOf` read). Each run starts a new client, so the cold first resolve was timed once per run (the
column below): p50 90.996 ms over 5 runs, min 80.447 ms, max 158.668 ms. It is not in the table.

## Run to run

| Run | Mainnet blocks | resolve + seal p50 | p95 | p99 | resolve p50 | seal p50 | rpc round trip p50 | cold first resolve | failed calls |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 110131577 to 110131630 | 26.717 | 36.339 | 164.585 | 20.275 | 5.966 | 18.605 | 158.668 | 0 |
| 2 | 110131631 to 110131683 | 27.851 | 33.528 | 37.123 | 20.45 | 6.707 | 18.731 | 90.996 | 0 |
| 3 | 110131685 to 110131740 | 28.795 | 33.781 | 166.123 | 20.668 | 7.268 | 18.827 | 80.447 | 0 |
| 4 | 110131741 to 110131795 | 28.331 | 35.405 | 174.049 | 20.562 | 7.407 | 18.694 | 88.424 | 0 |
| 5 | 110131797 to 110131848 | 27.535 | 34.797 | 164.946 | 20.185 | 7.264 | 18.518 | 96.835 | 0 |

The runs follow one another on one machine and one endpoint, so this spread is what the network and the machine did
in those minutes; another hour, place or endpoint moves it further.

## What was checked while timing

- Recipient: `0xFa72dA61400f345d85BF3d0d55395bDbebDB02b3`, the mainnet directory's deployer. Its key is the deploy smoke test's **DEMO KEY**
  (kid `db9784b7c246deb1`, epoch 1; deployments/143.json), not a passkey's.
- Every resolve (1,005, the cold ones included) was checked against the recorded key and epoch, and every
  envelope (2,000) for chain 143, the directory `0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e`, the recipient and kid `db9784b7c246deb1`:
  no mismatch.
- Every timed call had to make exactly the HTTP requests it needs (one `keyOf` read for a resolve or a resolve + seal,
  one `eth_blockNumber`, none for a seal): viem retries a failed request inside a call, and a retried call is counted as
  failed, not timed. Failed calls: 0 in the measured rounds, 0 in the warm-up, 0 cold.
- The note is 85 bytes; its envelope's wire form (what `drop` sends) is 365 bytes.

## Gas, from mainnet receipts

eth_getTransactionReceipt and eth_getTransactionByHash on https://rpc.monad.xyz for the hashes in deployments/143.json. Cost is the receipt's gas used times its effective gas price. Monad charges a transaction for its
gas limit, not for the gas its execution uses ([Monad docs: differences from Ethereum](https://docs.monad.xyz/developer-essentials/differences)),
and in every receipt below the gas used equals the transaction's gas limit: these are the gas charged, not the gas executed.

| Transaction | Gas used | Gas limit | Price (gwei) | Cost (MON) | Recorded | Tx |
|---|---|---|---|---|---|---|
| Letterlock deploy (creation code + registry argument) | 1,201,505 | 1,201,505 | 102 | 0.12255351 | matches | [0x9766a31c…](https://monadvision.com/tx/0x9766a31cb8910e2d1f953176454230e51388acd91fc78dc589b406d15b8f0a03) |
| ERC-8004 register() of agent 10260 (the registry's gas, not Letterlock's) | 224,739 | 224,739 | 102 | 0.022923378 | matches | [0xb6b41dd5…](https://monadvision.com/tx/0xb6b41dd5800042005b96b46d8245f0311b6461bc5cdbc90347952c3393896cf1) |
| publish(pub, 1): an address's first key | 70,863 | 70,863 | 102 | 0.007228026 | matches | [0x35b8330e…](https://monadvision.com/tx/0x35b8330e768a6c7529c0c9c4151d945ed83e3ef596c0c6ddca3486efe11ae233) |
| publishForAgent(10260, pub, 1): an agent's first key (reads the live registry) | 108,799 | 108,799 | 102 | 0.011097498 | matches | [0x3a5be1d8…](https://monadvision.com/tx/0x3a5be1d8643029ded9158bf36d73cd1cac4f4a9f24296ac55518539237e80c26) |
| drop() of a 490-byte envelope | 45,780 | 45,780 | 102 | 0.00466956 | matches | [0x616fe1a9…](https://monadvision.com/tx/0x616fe1a946d1b90461ffd8284be4881f8650799166526c2d22523053bff93659) |
| publishForAgent(10260, pub, 2): the agent's key rotated to epoch 2 | 74,652 | 74,652 | 102 | 0.007614504 | matches | [0x072dc08d…](https://monadvision.com/tx/0x072dc08d72aefacbe3fe05fedd2296c857c1181fbfa9f548c7ed9322594c294b) |

An agent key has been rotated on mainnet (above); no address key has been yet, so there is no receipt for an address's rotation. For scale only, forge's gas snapshot
(contracts/snapshots/Letterlock.json, a local EVM run of each call as its own transaction: gas executed, not a Monad
charge, and not a receipt): first publish 70,002, rotation 36,002, drop of a 1 KiB envelope
65,020, of a 16 KiB one 679,420.

## Context

| | |
|---|---|
| Date | 2026-10-03T08:23:31.613Z to 2026-10-03T08:24:54.063Z |
| Machine | MacBookPro18,2, Apple M1 Max, 10 cores, 32 GiB, macOS 26.5.2 (arm64) |
| Load average (1, 5, 15 min) | 6.96 / 7.49 / 7.95 at the start, 4.49 / 6.53 / 7.53 at the end (10 cores) |
| Node.js | v22.22.0 |
| Time zone of the machine | Asia/Jakarta |
| SDK | letterlock 0.1.1, runtime code at `f5f56c6` (2026-10-03T15:17:22+07:00) |
| Benchmark code | scripts/bench.ts and scripts/lib as of `3401d21`, no uncommitted changes; checkout `8e89b35` |
| RPC | https://rpc.monad.xyz (Monad's public endpoint), mainnet blocks 110131577 to 110131848 |
| N | 5 runs of 200 rounds, each after 5 warm-up rounds; each round times resolve, seal, resolve + seal and an rpc round trip, in that order in even rounds and reversed in odd ones |
| Percentiles | nearest-rank (every value is a measured sample) |

The network dominates `resolve`: it tracks the plain `eth_blockNumber` round trip from this machine to the RPC, so
another location or endpoint moves it by that difference. `seal` is local CPU (HPKE in JavaScript: an X25519 key
generation and agreement, HKDF and ChaCha20-Poly1305) and does not depend on the chain; it varies with what else the
machine runs, hence the load average above. Nothing in the run is random except HPKE's ephemeral key, which the
protocol requires to be fresh for every seal: the note, the recipient and the order of operations are fixed.

## Reproduce

```sh
pnpm install
pnpm bench            # 5 runs of N = 200; rewrites bench/results.json and bench/RESULTS.md
```
