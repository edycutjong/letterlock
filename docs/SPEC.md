# Letterlock protocol — v1

A passkey becomes an **encryption address**. The owner's device derives an X25519 key from the passkey's
WebAuthn PRF output and publishes only the public half on Monad. Anyone resolves `keyOf(address)` and seals
with HPKE; only the same passkey — on any device it syncs to — can open.

Status: SDK implemented in `packages/letterlock` (tested): the core (§2–§3), the chain client and a CLI (§4), with the
rpId pin of §6. Contract implemented in `contracts/` and deployed on Monad mainnet and testnet from the same source
(§8), Sourcify-verified. The mainnet directory's first keys are demo keys from the deploy smoke test (random bytes in
place of a passkey), one for the deployer and one for ERC-8004 agent #10260. This document is normative for the code;
tests pin the derivation and envelope formats (§2–§3) and the contract rules (§8). The §7 binding layout is
spike-only and gets its pinned test when it is ported.

## 1. Primitives
| Role | Choice |
|---|---|
| Passkey + PRF | `@category-labs/mera` `createPasskeyWithPrfOutput` / `getPasskeyPrfOutput` (WebAuthn PRF, user verification required) |
| KDF | HKDF-SHA256 (`@noble/hashes`) |
| Key agreement | X25519 (`@noble/curves`) |
| Encryption | HPKE RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256) · HKDF-SHA256 · ChaCha20-Poly1305 (`@hpke/*`), verified against RFC 9180 A.2.1 vectors |

## 2. Derivation
```
prfSalt(epoch) = SHA-256("letterlock/hpke/v1/" ‖ decimal(epoch))            epoch ∈ [1, 2^32 − 1]
prf            = PRF(passkey, prfSalt(epoch))                                 32 bytes, via mera
sk             = HKDF-SHA256(ikm = prf, salt = "letterlock/v1",
                             info = "letterlock/v1/x25519/" ‖ decimal(epoch), L = 32)
pk             = X25519(sk, 9)                                                published as bytes32
fingerprint    = lower-case hex(SHA-256(pk)[0..8])                            16 hex digits
```
An ERC-8004 agent's key (§8) comes from a PRF evaluated at the agent's own salt, with the agent id in both labels. The
PRF is the owner's passkey's, or, for an agent hosted on a server, a seed's (below):
```
agentSalt(id, epoch) = SHA-256("letterlock/hpke/v1/agent:" ‖ decimal(id) ‖ "/" ‖ decimal(epoch))    id ∈ [0, 2^256 − 2]
prf                  = PRF(passkey, agentSalt(id, epoch))
sk                   = HKDF-SHA256(ikm = prf, salt = "letterlock/v1",
                                   info = "letterlock/v1/x25519/agent:" ‖ decimal(id) ‖ "/" ‖ decimal(epoch), L = 32)
```
- Letterlock's salt namespace is disjoint from mera's account salt `SHA-256("mera.prf.salt.v1")`: the
  encryption key and the passkey wallet key are unrelated.
- An agent's key is unrelated to its owner's own key and to the owner's other agents' keys, so the agent's server
  can hold its `sk` without being able to open anything sealed to the owner. A key from the owner's passkey is
  re-derived by that passkey on any device. An address label has only digits after the prefix and an agent label
  starts with `agent:`, so the two never collide. The owner of an agent is public anyway (the registry's `ownerOf`,
  the publishing transaction): distinct keys stop key sharing, not that link.
- Rotation is `epoch + 1`: a new salt gives an unrelated PRF output. Every earlier epoch stays re-derivable, so
  old envelopes keep opening.
- Nothing secret is persisted by Letterlock. `openWithPasskey` zeroes its copy of `sk` after use (best effort:
  copies inside the crypto libraries and mera's PRF output are out of reach, and JS cannot guarantee erasure).
  `deriveFromPasskey` and `deriveForAgent` return `sk` to the caller, who owns wiping it.

**Server-hosted agents.** An agent that runs on a server has no passkey. It MAY take `prf` from a 32-byte secret
seed, through the computation a WebAuthn PRF performs over CTAP2 hmac-secret (WebAuthn Level 3 §10.1.4), and derive
`sk` from it exactly as above, with the same salts and labels:
```
prf = HMAC-SHA256(seed, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ agentSalt(id, epoch)))      seed: 32 secret random bytes
```
Such a key is recovered only from the seed: no passkey can re-derive it, the owner's included, and whoever holds the
seed opens everything sealed to the agent at every epoch derived from it. The directory cannot tell the two kinds of
agent key apart; the owner publishes either with `publishForAgent` (§8). The reference agent (`examples/agent-memory`,
ERC-8004 agent #10260 from epoch 2 on) derives its keys this way.

## 3. Envelope
```json
{ "v": 1, "chainId": 143, "directory": "0x…", "recipient": "0x… | agent:<id>", "epoch": 1,
  "kid": "<fingerprint>", "enc": "<base64url>", "ct": "<base64url>" }
```
HPKE `info` (authenticated through the key schedule):
```
lp("letterlock/v1") ‖ u64(chainId) ‖ lp(directory[20]) ‖ lp(utf8(recipient)) ‖ u32(epoch)
lp(x) = u16(len(x)) ‖ x;  integers big-endian;  recipient = lower-cased 0x-address or "agent:<decimal>"
```
- Changing `chainId`, `directory`, `recipient` or `epoch`, or any byte of `enc`/`ct`, fails authentication
  (reported as `TAMPERED`; a changed `epoch` is caught first as `EPOCH_MISMATCH` when the caller's key is for
  the original epoch).
- `enc`/`ct` must be **canonical** unpadded base64url, so one envelope has exactly one spelling.
- `kid` is **not** authenticated. It is consulted only AFTER decryption fails, to report `WRONG_KEY` instead of
  `TAMPERED`; editing it can never make the right key fail, and never decrypts anything.
- `seal` takes the recipient key as one value `{ recipient, publicKey, epoch }`. That value must come from a
  single `keyOf` read: an epoch-1 key labelled epoch 2 produces an envelope nobody can open. `resolve()` (§4)
  builds this value from one contract read so callers never assemble it by hand.
- Wire form (`encodeEnvelope`, what `drop` sends): the JSON above as UTF-8, fields in the order shown, no
  whitespace, `kid` exactly 16 lower-case hex digits (the §2 fingerprint). `decodeEnvelope` keeps only these
  fields and validates them as `encodeEnvelope` does (`open`'s header and base64url checks plus the `kid` format),
  without decrypting. Both refuse any other `kid` spelling with `INPUT_INVALID`, so an envelope `drop` accepts is
  one `inbox` lists; `open` itself never checks the `kid` format.

## 4. Operations
| Call | Passkey prompt | Notes |
|---|---|---|
| `createEncryptionAddress` | 1 (2 if the authenticator skips PRF at creation) | returns epoch-1 key + credential metadata |
| `deriveFromPasskey(epoch)` | 1 | the passkey's own key; pass the stored credential to pin the passkey |
| `deriveForAgent(agentId, epoch)` | 1 | an agent's key (§2), from its owner's passkey; the key carries `agentId` |
| `seal(to, plaintext)` | none | anyone may seal to a published key |
| `open(envelope, keys)` | none | with an already-derived key |
| `openWithPasskey(envelope)` | 1 | validates the envelope first (no prompt wasted), derives the key for `envelope.recipient` (an agent's for `agent:<id>`) and `envelope.epoch`, opens, wipes its `sk` copy |

The chain client, `letterlock({ chain: "monad" | "monad-testnet", rpcUrl?, directory?, rpId? })`, carries the §8
directory addresses as constants. A `directory` passed in must carry a valid EIP-55 checksum (or be all lower-case).
Once per client, before its first read, write or inbox scan, it checks that the RPC serves the chain it names
(`eth_chainId`) and that the directory address holds a Letterlock directory: code, and `NO_AGENT()` returning
2^256 − 1. A failed chain check is reported first, a failed directory check next, and nothing is signed or sent after
either. It sends one JSON-RPC request per HTTP request, never a batch: some Monad RPCs refuse batches.

| Call | Passkey prompt | Notes |
|---|---|---|
| `resolve(to)` | none | ONE `keyOf` / `keyOfAgent` read → `{ recipient, publicKey, epoch, kid, updatedAt }`; zeros → `NO_KEY_PUBLISHED` |
| `sealTo(to, plaintext)` | none | `resolve` + `seal` |
| `publish({ account, keys })` | none | `publish(pub, epoch)` from `account`; simulated first, so a refused call costs no gas. A `meraAccount` publishes only keys that name its own passkey (§7) |
| `rotate({ account, credential })` | 1 | reads the account's epoch e, derives e + 1 (§2) from the account's own passkey, publishes it, wipes `sk`. The prompt is always pinned to one passkey: `credential`, which only a `meraAccount` may leave out (it names its own). If another passkey answers, nothing is signed (§7) |
| `publishForAgent({ account, agentId, keys })` | none | `publishForAgent`; the epoch follows the agent's record across owners (§8). Takes only a key derived for that agent (`deriveForAgent`), never one derived for an address, and never the account's own key in the directory; `publish` never takes an agent's key |
| `drop({ account, envelope })` | none | sends the §3 wire form to the envelope's own recipient; chain and directory must be the client's |
| `inbox(to, { fromBlock?, toBlock? })` | none | `Dropped` logs for `(to, NO_AGENT)` or `(address(0), agentId)`, from the deploy block by default, in pages the RPC accepts; bytes that are not an envelope for `to` on this chain and directory are returned as `rejected`, never as envelopes. `toBlock` defaults to the `finalized` block: a Finalized block is never replaced, so a poll resumed from `toBlock + 1` misses nothing. `"latest"` (Monad's Proposed block) and `"safe"` (Voted) reach closer to the head, where a drop can still vanish or move; the result's `finalizedBlock` says how far a scan is final |
| `meraAccount({ rpId, credential })` | 1 | the passkey's EVM account (§7) as a viem account backed by a mera signing session |

A first publish therefore takes two prompts, one per PRF salt: the key (§2) and the account (§7).

## 5. Errors
| Code | Meaning |
|---|---|
| `PRF_UNSUPPORTED` | the authenticator returns no PRF output (e.g. Dashlane, some Chrome profiles) |
| `PASSKEY_FAILED` | ceremony cancelled, timed out, or no passkey for this site |
| `NO_KEY_PUBLISHED` | the recipient has no key in the directory |
| `EPOCH_MISMATCH` | the envelope names another epoch than the key supplied (pre-auth hint); or a publish named another epoch than the directory's current + 1 (`EpochNotNext`) |
| `WRONG_KEY` | decryption failed and `kid` names another key — the wrong passkey was chosen |
| `TAMPERED` | authentication failed: the envelope was altered in transit |
| `INPUT_INVALID` | malformed recipient, directory, epoch, key length, non-byte plaintext, or a low-order X25519 key |

Chain client (§4), in the separate union `ChainErrorCode`; the directory's custom errors map as listed:

| Code | Meaning |
|---|---|
| `NOT_AGENT_OWNER` | the account is not the agent's ERC-8004 owner (`NotAgentOwner`; also an agent nobody owns) |
| `INSUFFICIENT_FUNDS` | the account cannot pay for gas |
| `CHAIN_UNAVAILABLE` | no answer: the RPC failed, the registry call failed (`RegistryCallFailed`), or a call reverted without a known error. Unknown, never "no key" (§8) |

`ZeroKey`, `LowOrderKey`, `NonCanonicalKey`, `AgentPathDisabled`, `AgentIdReserved`, `InvalidRecipient`,
`EmptyEnvelope` and `EnvelopeTooLarge` are `INPUT_INVALID`; `EpochNotNext` is `EPOCH_MISMATCH`; `NoKeyPublished` is
`NO_KEY_PUBLISHED`. An RPC that serves another chain than the client's, a directory address with a bad checksum, an
address that holds no Letterlock directory (no code, or no `NO_AGENT()` answering 2^256 − 1), and a key that does not
name the signing `meraAccount`'s passkey (§7) are `INPUT_INVALID` too.

## 6. Threat model
**Protects:** the content of an envelope against everyone except holders of the recipient's passkey. This
includes the sender, the storage host and the chain. It also prevents re-addressing an envelope to another
recipient, epoch, directory or chain.

**Does not protect (by design, v1):**
- **Sender identity.** HPKE base mode is anonymous: anyone can seal to anyone. A copied envelope can be
  re-dropped and opens again (replay). Apps must not show a sender or treat a note as fresh based on the
  envelope alone. If that matters, put a nonce and timestamp inside the plaintext and deduplicate on it.
- **Metadata.** Recipient, epoch and timing are public on the transport the app chooses.
- **Key loss.** If every synced copy of the passkey is lost, the key is lost. v1 has no recovery.
- **Domain change.** PRF output is bound to the WebAuthn rpId. Letterlock pins ONE production rpId,
  `LETTERLOCK_RP_ID` (`letterlock-app.vercel.app`). Keys derived on another origin (localhost, preview deploys)
  cannot be re-derived in production. The chain client refuses `publish`, `rotate` and `publishForAgent` when its
  rpId is another one, unless it was created with `unsafeAllowAnyRpId: true`, for tests. It publishes a key only
  when the key carries the client's rpId: keys from `createEncryptionAddress`, `deriveFromPasskey` and
  `deriveForAgent` record theirs, and a key rebuilt from its fields (`{ publicKey, epoch }`) is refused, because it
  could come from any passkey. `unsafeAllowAnyRpId` also takes a key without an rpId, never one that names another
  rpId. Reads and seals are not pinned: sealing needs no passkey.
- **Whoever serves the rpId's host** can run passkey ceremonies for it, and so gets the PRF output of every
  Letterlock passkey: every encryption key (§2) and the passkey account's key (§7). The host must stay under the
  Letterlock owner's control for as long as keys derived under it are in use. `letterlock-app.vercel.app` is a
  Vercel project name, held only while that project exists; a domain the owner registers is sturdier. Since the SDK
  pins the rpId, moving to another host takes a new release. Since 2026-09-27 that host serves the Letterlock app
  (the Vercel project `letterlock-app`), where passkeys for the rpId are made; the directory's keys so far are demo
  and test keys (§8).
- **A compromised device during `open`** exposes that epoch's key. Rotate to recover forward secrecy for new
  notes.

## 7. Optional P256 binding (Day-1 spike: feasible, not yet adopted)
A mera-compatible `WebAuthnClient` captures the passkey's ES256 public key Q during mera's own creation
ceremony. A second assertion signs
`SHA-256("letterlock/bind/v1" ‖ u64 chainId ‖ directory ‖ owner ‖ pk ‖ u32 epoch)`, and Monad's `0x0100`
precompile verified that signature on testnet and mainnet.

The precompile only proves "Q signed h". To make this an ownership proof, the contract must do three
things:
- anchor Q to `msg.sender` (the mera account);
- recompute h from `authenticatorData` and `clientDataJSON` itself, and check the `type`, the challenge, the
  rpIdHash and the UP/UV flags;
- avoid rebuilding `clientDataJSON` from a template, because browsers add fields.

Until that ships, the binding is `msg.sender` = the passkey-derived mera account: `meraAccount` evaluates the PRF with
mera's own salt `SHA-256("mera.prf.salt.v1")`, uses the output as BIP-39 entropy, and takes the BIP-32 key at
`m/44'/60'/0'/0/0` of its seed, as mera's passkey-account recipe does. The key lives in a mera
`Secp256k1SigningSession` and signs through `toViemAccount`; the PRF output, the seed, every HD key on the path (the
master key included) and the copy of the key handed to the session are zeroed before `meraAccount` returns, and the
session keeps its own copy until `end()` (best effort, as in §2).

The SDK keeps the published key on the same passkey as the account. A device can hold several passkeys for the rpId
(mera adds one on every creation, and a creation that fails after the ceremony leaves its passkey behind), and a
prompt that pins none lets any of them answer. Notes sealed to a key from another passkey, published under the
account, would not open with the account's passkey, and would be lost with that other passkey. So a `meraAccount`
carries its passkey's credential id, and so does every key from `createEncryptionAddress`, `deriveFromPasskey` and
`deriveForAgent`. `publish` and `publishForAgent` refuse, for a `meraAccount`, a key that does not name its passkey:
one from another passkey, or one rebuilt from its fields, which could come from any passkey (as with the rpId, §6).
`rotate` pins its prompt to that passkey and refuses the key of any other passkey that answers, before anything is
signed. For any other signer the SDK sees no passkey, so `rotate` takes the passkey from `credential`, never from an
unpinned prompt.

## 8. Contract
`contracts/src/Letterlock.sol`. ABI: `contracts/abi/Letterlock.json`, and `letterlockAbi`, exported by the
`letterlock` package (`packages/letterlock/src/abi.ts`); both are generated by `contracts/script/export-abi.mjs`.

| Network | Directory | Agent path |
|---|---|---|
| Monad mainnet (143) | `0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e` | enabled: ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Monad testnet (10143) | `0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a` | disabled: ERC-8004 has no registry on testnet |

Both directories are built from commit `b3bdff4` and were deployed with the same creation code; only the constructor
argument, the registry, differs (`deployments/143.json`, `deployments/10143.json`). The registry-call rule below is on
the agent path only, which the testnet directory disables, so there it never calls a registry. The earlier testnet
directory `0x4DE866601eA5eA35Eb142394Df12bFA936A4b5D4` (commit `10e95d1`, before the rule) is superseded.

**Reading keys**
- `keyOf(address)` and `keyOfAgent(agentId)` return `(pub, epoch, updatedAt)`. All zeros means no key
  (`NO_KEY_PUBLISHED`, §5); nothing is ever sealed to a zero key.
- `keyOfAgent` resolves only while the agent's current `ownerOf` is the address that published the key. After a
  transfer or a burn it returns zeros, because the previous owner holds the passkey: the key follows the NFT.
- Registry-call rule: only the registry's `ERC721NonexistentToken(uint256)` revert (selector `0x7e273289`: the
  agent was never minted, or was burned) means "no owner". Any other failure of its `ownerOf`, running out of gas
  included, reverts `RegistryCallFailed(agentId)`, unless the read then runs out of gas in Letterlock itself, which
  reverts with no data (after a starved registry call only 1/64 of the gas available at the call is left; the call
  got the other 63/64). Zeros from `keyOfAgent` therefore always mean that no key resolves, never that the read was
  starved of gas, and any revert means "unknown", never "no key": a contract must not treat only
  `RegistryCallFailed` as unknown. `publishForAgent` and a drop to an agent follow the same rule. A contract that
  reads `keyOfAgent` must forward enough gas to get an answer: on a mainnet fork, read cold at every budget from
  5,000 to 80,000 gas in steps of 20, every budget from 46,620 gas up returned the key and every smaller one
  reverted, 767 with `RegistryCallFailed` and 1,314 with no data. An `eth_call` is never starved.
- `agentKeyRecord(agentId)` returns the raw record `(pub, epoch, updatedAt, publisher)`, whether or not it still
  resolves. It is for indexers, and for a new owner reading the next epoch. Never seal to it.
- A `KeyPublished` log is history, not liveness: no Letterlock event marks an agent transfer or burn. The §3 `seal`
  input comes from a `keyOf` / `keyOfAgent` read made when sealing (or from indexed events joined with the
  registry's `Transfer` events), never from `KeyPublished` logs alone, or a note can go to a previous owner.

**Publishing keys**
- `publish(pub, epoch)` writes `msg.sender`'s key. `publishForAgent(agentId, pub, epoch)` writes an agent's key and
  requires `msg.sender == identityRegistry.ownerOf(agentId)`.
- `pub` must be non-zero (`ZeroKey`), must not be one of libsodium's small-order encodings with bit 255 ignored
  (`LowOrderKey`; 14 encodings), and must be canonical: bit 255 clear and u < 2^255 − 19 (`NonCanonicalKey`). A key
  derived per §2 always satisfies these rules.
- `epoch` must be exactly the stored epoch + 1 (`EpochNotNext(current, given)`): the first key is epoch 1, and each
  rotation adds 1, as in §2. Reaching epoch n takes n publishes, so no single call can use up the epoch range.
- An agent has one epoch sequence across owners. A new owner publishes `agentKeyRecord(agentId).epoch + 1`, derived
  with the agent's salt (§2) from its own passkey or from the agent's seed, never its own address key.
- `NO_AGENT = 2^256 − 1` marks "no agent": it is `KeyPublished.agentId` for an address key and `toAgent` in `drop`
  for an address recipient. Agent id 0 is a real ERC-8004 id, so the marker cannot be 0; `publishForAgent` rejects
  `NO_AGENT` (`AgentIdReserved`).

**Dropping envelopes** (demo transport; nothing is stored)
- `drop(to, toAgent, envelope)` names exactly one recipient: `(address, NO_AGENT)` for §3's `"0x…"` recipient, or
  `(address(0), agentId)` for `"agent:<id>"`. Anything else reverts `InvalidRecipient`.
- The envelope is the §3 JSON as UTF-8, 1 to 16,384 bytes (`EmptyEnvelope`, `EnvelopeTooLarge`). The recipient must
  have a key that resolves at that moment (`NoKeyPublished`).
- The SDK's `drop()` sends the §3 wire form and `inbox()` reads `Dropped` logs back (§4). The smoke-test drops on
  mainnet and testnet were sent with `cast send`.
- The contract does not validate the envelope: a successful drop says nothing about whether it opens. An envelope
  dropped to an agent is sealed to the key that resolves at that moment, so after a transfer only the previous owner
  can open it.
