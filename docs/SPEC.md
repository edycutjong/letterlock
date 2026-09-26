# Letterlock protocol — v1

A passkey becomes an **encryption address**. The owner's device derives an X25519 key from the passkey's
WebAuthn PRF output and publishes only the public half on Monad. Anyone resolves `keyOf(address)` and seals
with HPKE; only the same passkey — on any device it syncs to — can open.

Status: SDK core implemented in `packages/letterlock` (tested). Contract implemented in `contracts/` and deployed on
Monad testnet (§8). This document is normative for the code; tests pin the derivation and envelope formats (§2–§3)
and the contract rules (§8). The §7 binding layout is spike-only and gets its pinned test when it is ported.

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
fingerprint    = hex(SHA-256(pk)[0..8])
```
- Letterlock's salt namespace is disjoint from mera's account salt `SHA-256("mera.prf.salt.v1")`: the
  encryption key and the passkey wallet key are unrelated.
- Rotation is `epoch + 1`: a new salt gives an unrelated PRF output. Every earlier epoch stays re-derivable, so
  old envelopes keep opening.
- Nothing secret is persisted by Letterlock. `openWithPasskey` zeroes its copy of `sk` after use (best effort:
  copies inside the crypto libraries and mera's PRF output are out of reach, and JS cannot guarantee erasure).
  `deriveFromPasskey` returns `sk` to the caller, who owns wiping it.

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
  single `keyOf` read: an epoch-1 key labelled epoch 2 produces an envelope nobody can open. The Day-3
  `resolve()` builds this value from one contract read so callers never assemble it by hand.

## 4. Operations
| Call | Passkey prompt | Notes |
|---|---|---|
| `createEncryptionAddress` | 1 (2 if the authenticator skips PRF at creation) | returns epoch-1 key + credential metadata |
| `deriveFromPasskey(epoch)` | 1 | pass the stored credential to pin the passkey |
| `seal(to, plaintext)` | none | anyone may seal to a published key |
| `open(envelope, keys)` | none | with an already-derived key |
| `openWithPasskey(envelope)` | 1 | validates the envelope first (no prompt wasted), derives `envelope.epoch`, opens, wipes its `sk` copy |

## 5. Errors
| Code | Meaning |
|---|---|
| `PRF_UNSUPPORTED` | the authenticator returns no PRF output (e.g. Dashlane, some Chrome profiles) |
| `PASSKEY_FAILED` | ceremony cancelled, timed out, or no passkey for this site |
| `NO_KEY_PUBLISHED` | the recipient has no key in the directory |
| `EPOCH_MISMATCH` | the envelope names another epoch than the key supplied (pre-auth hint) |
| `WRONG_KEY` | decryption failed and `kid` names another key — the wrong passkey was chosen |
| `TAMPERED` | authentication failed: the envelope was altered in transit |
| `INPUT_INVALID` | malformed recipient, directory, epoch, key length, non-byte plaintext, or a low-order X25519 key |

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
- **Domain change.** PRF output is bound to the WebAuthn rpId. Letterlock pins ONE production rpId. Keys
  derived on another origin (localhost, preview deploys) cannot be re-derived in production. Planned (Day 2+,
  not yet implemented): the SDK config pins the rpId and `publish` refuses any other.
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

Until that ships, the binding is `msg.sender` = the passkey-derived mera account.

## 8. Contract
`contracts/src/Letterlock.sol`. ABI: `contracts/abi/Letterlock.json`, and `letterlockAbi`, exported by the
`letterlock` package (`packages/letterlock/src/abi.ts`); both are generated by `contracts/script/export-abi.mjs`.

| Network | Directory | Agent path |
|---|---|---|
| Monad testnet (10143) | `0x4DE866601eA5eA35Eb142394Df12bFA936A4b5D4` | disabled: ERC-8004 has no registry on testnet |
| Monad mainnet (143) | not deployed yet | ERC-8004 IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

The testnet directory was built from commit `d15fe63`, before the registry-call rule below. That rule is on the
agent path only, which the testnet directory disables, so it never calls a registry.

**Reading keys**
- `keyOf(address)` and `keyOfAgent(agentId)` return `(pub, epoch, updatedAt)`. All zeros means no key
  (`NO_KEY_PUBLISHED`, §5); nothing is ever sealed to a zero key.
- `keyOfAgent` resolves only while the agent's current `ownerOf` is the address that published the key. After a
  transfer or a burn it returns zeros, because the previous owner holds the passkey: the key follows the NFT.
- Registry-call rule: only the registry's `ERC721NonexistentToken(uint256)` revert (selector `0x7e273289`: the
  agent was never minted, or was burned) means "no owner". Any other failure of its `ownerOf`, running out of gas
  included, reverts `RegistryCallFailed(agentId)`, unless the read then runs out of gas in Letterlock itself, which
  reverts with no data (after a starved registry call only 1/64 of the gas it was given is left). Zeros from
  `keyOfAgent` therefore always mean that no key resolves, never that the read was starved of gas, and any revert
  means "unknown", never "no key": a contract must not treat only `RegistryCallFailed` as unknown. `publishForAgent`
  and a drop to an agent follow the same rule. A contract that reads `keyOfAgent` must forward enough gas to get an
  answer: on a mainnet fork, read cold, every budget from 46,620 gas up returned the key and every smaller one
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
  from its own passkey (§2).
- `NO_AGENT = 2^256 − 1` marks "no agent": it is `KeyPublished.agentId` for an address key and `toAgent` in `drop`
  for an address recipient. Agent id 0 is a real ERC-8004 id, so the marker cannot be 0; `publishForAgent` rejects
  `NO_AGENT` (`AgentIdReserved`).

**Dropping envelopes** (demo transport; nothing is stored)
- `drop(to, toAgent, envelope)` names exactly one recipient: `(address, NO_AGENT)` for §3's `"0x…"` recipient, or
  `(address(0), agentId)` for `"agent:<id>"`. Anything else reverts `InvalidRecipient`.
- The envelope is the §3 JSON as UTF-8, 1 to 16,384 bytes (`EmptyEnvelope`, `EnvelopeTooLarge`). The recipient must
  have a key that resolves at that moment (`NoKeyPublished`).
- The SDK has no drop helper yet (planned); the testnet drop was sent with `cast send`.
- The contract does not validate the envelope: a successful drop says nothing about whether it opens. An envelope
  dropped to an agent is sealed to the key that resolves at that moment, so after a transfer only the previous owner
  can open it.
