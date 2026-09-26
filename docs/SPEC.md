# Letterlock protocol — v1

A passkey becomes an **encryption address**. The owner's device derives an X25519 key from the passkey's
WebAuthn PRF output and publishes only the public half on Monad. Anyone resolves `keyOf(address)` and seals
with HPKE; only the same passkey — on any device it syncs to — can open.

Status: SDK core implemented in `packages/letterlock` (tested). Contract: Day 2. This document is normative
for the code; tests pin the derivation and envelope formats (§2–§3). The §7 binding layout is spike-only and
gets its pinned test when it is ported.

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
