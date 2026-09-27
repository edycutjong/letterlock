# Benchmark: resolve + seal on Monad mainnet

Measured 2026-09-27 04:42 UTC with `pnpm bench` (scripts/bench.ts). Every number below is
copied from [results.json](results.json), which also holds all 4,005 raw samples.

**resolve + seal: p50 27.067 ms · p95 33.982 ms · p99 38.201 ms** over N = 1,000
(5 runs of 200), against the public RPC https://rpc.monad.xyz. Sealing alone takes p50 4.918 ms on this machine; the rest is one
`keyOf` read over the network. From run to run, the resolve + seal p50 ranged 24.144–28.363 ms,
and the p99 32.002–38.201 ms.

## Latency (milliseconds, every run pooled)

| Operation | What is timed | n | p50 | p95 | p99 | min | max | mean |
|---|---|---|---|---|---|---|---|---|
| resolve | `ll.resolve(address)`: one `keyOf` eth_call | 1000 | **21.929** | 24.176 | 26.256 | 20.08 | 213.384 | 22.752 |
| seal | `seal()`: HPKE to the resolved key, no network | 1000 | **4.918** | 8.885 | 11.36 | 1.782 | 17.337 | 4.993 |
| resolve + seal | `ll.sealTo(address, note)`, as one call | 1000 | **27.067** | 33.982 | 38.201 | 21.915 | 298.353 | 28.424 |
| rpc round trip | `eth_blockNumber` on the same RPC (context) | 1000 | **19.586** | 21.448 | 23.935 | 16.31 | 26.87 | 19.291 |

The first resolve of a new client also runs its one-time checks (`eth_chainId`, `eth_getCode` and `NO_AGENT()`, in
parallel with the `keyOf` read). Each run starts a new client, so the cold first resolve was timed once per run (the
column below): p50 77.545 ms over 5 runs, min 70.497 ms, max 98.911 ms. It is not in the table.

## Run to run

| Run | Mainnet blocks | resolve + seal p50 | p95 | p99 | resolve p50 | seal p50 | rpc round trip p50 | cold first resolve | failed calls |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 108372664 to 108372715 | 28.246 | 33.946 | 38.003 | 22.287 | 5.676 | 19.748 | 98.911 | 0 |
| 2 | 108372717 to 108372769 | 28.121 | 35.733 | 38.201 | 22.403 | 5.57 | 19.875 | 77.545 | 0 |
| 3 | 108372770 to 108372822 | 28.363 | 34.819 | 38.006 | 22.168 | 5.687 | 19.83 | 83.408 | 0 |
| 4 | 108372824 to 108372873 | 26.135 | 33.272 | 35.452 | 21.723 | 4.277 | 19.545 | 72.354 | 0 |
| 5 | 108372874 to 108372921 | 24.144 | 26.961 | 32.002 | 21.293 | 2.862 | 19.298 | 70.497 | 0 |

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
| Date | 2026-09-27T04:42:22.069Z to 2026-09-27T04:43:39.978Z |
| Machine | MacBookPro18,2, Apple M1 Max, 10 cores, 32 GiB, macOS 26.5.2 (arm64) |
| Load average (1, 5, 15 min) | 4.38 / 4.87 / 5.3 at the start, 10.5 / 6.36 / 5.8 at the end (10 cores) |
| Node.js | v22.22.0 |
| Time zone of the machine | Asia/Jakarta |
| SDK | letterlock 0.1.0, runtime code at `ae4a28f` (2026-09-27T09:35:08+07:00) |
| Benchmark code | scripts/bench.ts and scripts/lib as of `d805670`, no uncommitted changes; checkout `9bf2215` |
| RPC | https://rpc.monad.xyz (Monad's public endpoint), mainnet blocks 108372664 to 108372921 |
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
