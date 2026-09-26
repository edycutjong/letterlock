// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The one ERC-721 read Letterlock makes on the ERC-8004 IdentityRegistry (each agent is an ERC-721 token).
interface IERC721 {
    /// @notice The owner of `tokenId` (an ERC-8004 agent id); reverts when the token does not exist.
    function ownerOf(uint256 tokenId) external view returns (address owner);
}

/// @title Letterlock: a public directory of passkey-derived X25519 encryption keys
/// @notice A passkey becomes an encryption address. The owner's device derives an X25519 key from the passkey's
///         WebAuthn PRF output and publishes only the public half here. Anyone reads `keyOf` / `keyOfAgent` and seals
///         to it with HPKE (RFC 9180); only the same passkey can open. Protocol: docs/SPEC.md.
/// @dev No owner, no admin, no upgrade path, and no function accepts value. A key slot's epochs run 1, 2, 3, ...:
///      every publish is exactly the current epoch + 1, so a (slot, epoch) pair names at most one key, ever.
contract Letterlock {
    /// @notice A published key. `pub` is the X25519 public key (RFC 7748 u-coordinate: 32 bytes, little-endian,
    ///         stored byte-for-byte, so `pub[0]` is the least significant byte of u). `epoch` is the derivation
    ///         index (>= 1). `updatedAt` is the block timestamp of the publish.
    struct Key {
        bytes32 pub;
        uint32 epoch;
        uint64 updatedAt;
    }

    /// @dev An agent key also records its publisher: the key resolves only while that address still owns the
    ///      agent, because after a transfer the previous owner, not the new one, holds the matching passkey.
    struct AgentKey {
        bytes32 pub;
        uint32 epoch;
        uint64 updatedAt;
        address publisher;
    }

    /// @notice Marks "no agent": `KeyPublished.agentId` for an address key, and `toAgent` in `drop` / `Dropped` for
    ///         an address recipient. ERC-8004 agent ids start at 0, so 0 cannot be the marker. `publishForAgent`
    ///         rejects this id, which keeps the marker unambiguous.
    uint256 public constant NO_AGENT = type(uint256).max;

    /// @notice Largest envelope `drop` accepts, in bytes (16 KiB).
    uint256 public constant MAX_ENVELOPE_BYTES = 16 * 1024;

    /// @notice The ERC-8004 IdentityRegistry that decides who may publish an agent's key. `address(0)` disables the
    ///         agent path (Monad testnet has no ERC-8004 registry; the registry exists on Monad mainnet only).
    IERC721 public immutable identityRegistry;

    // Libsodium's small-order X25519 encodings, byte-for-byte in libsodium's order (u little-endian, so the first
    // byte is the least significant). Source: libsodium 1.0.22-RELEASE,
    // src/libsodium/crypto_scalarmult/curve25519/ref10/x25519_ref10.c, has_small_order() "blacklist", which cites
    // https://eprint.iacr.org/2017/806.pdf. has_small_order() compares the last byte as (s[31] & 0x7f), i.e. it
    // ignores bit 255, so each entry below also covers its bit-255-set twin: 14 rejected encodings in all.
    bytes32 private constant SMALL_ORDER_0 = 0x0000000000000000000000000000000000000000000000000000000000000000; // 0
    bytes32 private constant SMALL_ORDER_1 = 0x0100000000000000000000000000000000000000000000000000000000000000; // 1
    bytes32 private constant SMALL_ORDER_2 = 0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800; // order 8
    bytes32 private constant SMALL_ORDER_3 = 0x5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157; // order 8
    bytes32 private constant SMALL_ORDER_4 = 0xecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f; // p - 1
    bytes32 private constant SMALL_ORDER_5 = 0xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f; // p (= 0)
    bytes32 private constant SMALL_ORDER_6 = 0xeeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f; // p + 1 (= 1)

    /// @dev Bit 255 of u: the top bit of the key's last byte, which is the lowest byte of the bytes32 word.
    uint256 private constant U_BIT_255 = 0x80;
    /// @dev Key bytes 1..31 (the low 31 bytes of the word) and their value when u >= p = 2^255 - 19:
    ///      bytes 1..30 = 0xff, byte 31 = 0x7f. Then u >= p exactly when key byte 0 >= 0xed.
    uint256 private constant KEY_BYTES_1_TO_31 = (1 << 248) - 1;
    uint256 private constant P_BYTES_1_TO_31 = ((1 << 248) - 1) ^ 0x80;

    mapping(address => Key) private _keys;
    mapping(uint256 => AgentKey) private _agentKeys;

    /// @notice A key was published. `who` is the publisher (`msg.sender`). `agentId` is `NO_AGENT` for an address
    ///         key (`publish`), otherwise the ERC-8004 agent id (`publishForAgent`; agent id 0 exists on mainnet).
    /// @dev A log is history, not liveness. An agent key stops resolving when the registry transfers or burns the
    ///      agent, and no Letterlock event marks that. An indexer must confirm an agent key with `keyOfAgent` (or
    ///      join the registry's `Transfer` events) before anyone seals to it; sealing from logs alone can leak to
    ///      the agent's previous owner.
    event KeyPublished(address indexed who, uint256 indexed agentId, bytes32 pub, uint32 epoch);

    /// @notice An envelope was dropped for a recipient (demo transport; nothing is stored). Exactly one recipient
    ///         kind is set: `to != address(0)` with `toAgent == NO_AGENT`, or `to == address(0)` with an agent id.
    event Dropped(address indexed to, uint256 indexed toAgent, bytes envelope);

    /// @notice The constructor got a non-zero registry address with no code (for example the mainnet registry
    ///         address on testnet, where nothing is deployed there).
    error RegistryHasNoCode(address registry);
    /// @notice The key is zero, which is the "no key" value.
    error ZeroKey();
    /// @notice The key is a small-order X25519 encoding: every shared secret with it is predictable.
    error LowOrderKey(bytes32 pub);
    /// @notice The key is not the canonical encoding of its u-coordinate (bit 255 set, or u >= 2^255 - 19).
    error NonCanonicalKey(bytes32 pub);
    /// @notice The epoch must be exactly the slot's current epoch + 1: the first key is epoch 1, and each rotation
    ///         adds 1.
    error EpochNotNext(uint32 current, uint32 given);
    /// @notice This deployment has no identity registry, so agent keys are disabled.
    error AgentPathDisabled();
    /// @notice `NO_AGENT` is reserved as the "no agent" marker and cannot hold a key.
    error AgentIdReserved();
    /// @notice The caller is not `identityRegistry.ownerOf(agentId)` (or the agent does not exist).
    error NotAgentOwner(uint256 agentId, address caller);
    /// @notice A drop must name exactly one recipient kind: an address with `toAgent == NO_AGENT`, or
    ///         `to == address(0)` with an agent id.
    error InvalidRecipient(address to, uint256 toAgent);
    /// @notice The envelope is empty.
    error EmptyEnvelope();
    /// @notice The envelope is longer than `MAX_ENVELOPE_BYTES`.
    error EnvelopeTooLarge(uint256 length, uint256 max);
    /// @notice The recipient has no key that resolves now (`keyOf` / `keyOfAgent` returns zeros).
    error NoKeyPublished(address to, uint256 toAgent);

    /// @param registry The ERC-8004 IdentityRegistry, or `address(0)` to disable the agent path.
    constructor(address registry) {
        if (registry != address(0) && registry.code.length == 0) revert RegistryHasNoCode(registry);
        identityRegistry = IERC721(registry);
    }

    /// @notice Publish or rotate the caller's own encryption key.
    /// @dev Only `msg.sender`'s slot is written. Rotation = the next epoch; the old epoch's key stays derivable
    ///      off-chain, so envelopes sealed to it still open.
    /// @param pub The X25519 public key: non-zero, canonical, and not a small-order point.
    /// @param epoch Exactly the caller's current epoch + 1 (`keyOf(msg.sender)`; 0 when none, so the first is 1).
    function publish(bytes32 pub, uint32 epoch) external {
        _checkKey(pub);
        Key storage k = _keys[msg.sender];
        _checkNextEpoch(k.epoch, epoch);
        k.pub = pub;
        k.epoch = epoch;
        // casting to 'uint64' is safe because block.timestamp stays below 2^64 for ~5.8e11 years
        // forge-lint: disable-next-line(unsafe-typecast)
        k.updatedAt = uint64(block.timestamp);
        emit KeyPublished(msg.sender, NO_AGENT, pub, epoch);
    }

    /// @notice Publish or rotate the encryption key of an ERC-8004 agent that the caller owns.
    /// @dev Reverts `AgentPathDisabled` when `identityRegistry == address(0)`. The caller must be
    ///      `identityRegistry.ownerOf(agentId)` at the time of the call. An agent has one epoch sequence across
    ///      owners: a new owner publishes the stored epoch + 1 (read it with `agentKeyRecord`). A previous owner
    ///      moves that sequence forward by one per publish, so it cannot use up the epochs before a transfer and
    ///      leave the next owner unable to publish.
    /// @param agentId The ERC-8004 agent id (any value except `NO_AGENT`).
    /// @param pub The X25519 public key: non-zero, canonical, and not a small-order point.
    /// @param epoch Exactly the agent's stored epoch + 1 (`agentKeyRecord`; 0 when none, so the first is 1).
    function publishForAgent(uint256 agentId, bytes32 pub, uint32 epoch) external {
        if (address(identityRegistry) == address(0)) revert AgentPathDisabled();
        if (agentId == NO_AGENT) revert AgentIdReserved();
        if (_ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        _checkKey(pub);
        AgentKey storage k = _agentKeys[agentId];
        _checkNextEpoch(k.epoch, epoch);
        k.pub = pub;
        k.epoch = epoch;
        // casting to 'uint64' is safe because block.timestamp stays below 2^64 for ~5.8e11 years
        // forge-lint: disable-next-line(unsafe-typecast)
        k.updatedAt = uint64(block.timestamp);
        k.publisher = msg.sender;
        emit KeyPublished(msg.sender, agentId, pub, epoch);
    }

    /// @notice The key to seal to for an address.
    /// @param who The recipient address.
    /// @return pub The X25519 public key, or zero when none is published.
    /// @return epoch The key's epoch, or 0 when none is published.
    /// @return updatedAt The block timestamp of the publish, or 0 when none is published.
    function keyOf(address who) external view returns (bytes32 pub, uint32 epoch, uint64 updatedAt) {
        Key storage k = _keys[who];
        return (k.pub, k.epoch, k.updatedAt);
    }

    /// @notice The key to seal to for an ERC-8004 agent.
    /// @dev Returns zeros when no key was published, or when the agent's current owner is not the key's publisher
    ///      (the agent was transferred or burned): sealing to a previous owner's key would leak to them.
    /// @param agentId The ERC-8004 agent id.
    /// @return pub The X25519 public key, or zero when none resolves.
    /// @return epoch The key's epoch, or 0 when none resolves.
    /// @return updatedAt The block timestamp of the publish, or 0 when none resolves.
    function keyOfAgent(uint256 agentId) external view returns (bytes32 pub, uint32 epoch, uint64 updatedAt) {
        AgentKey storage k = _agentKeys[agentId];
        if (!_agentKeyResolves(agentId, k)) return (0, 0, 0);
        return (k.pub, k.epoch, k.updatedAt);
    }

    /// @notice The raw stored record for an agent key, whether or not its publisher still owns the agent.
    /// @dev For indexers, and for a new owner, who publishes the stored epoch + 1. To seal, use `keyOfAgent`: this
    ///      record keeps a previous owner's key after a transfer.
    /// @param agentId The ERC-8004 agent id.
    /// @return pub The last published X25519 public key (zero when none).
    /// @return epoch The last published epoch (0 when none).
    /// @return updatedAt The block timestamp of the last publish (0 when none).
    /// @return publisher The address that published it (`address(0)` when none).
    function agentKeyRecord(uint256 agentId)
        external
        view
        returns (bytes32 pub, uint32 epoch, uint64 updatedAt, address publisher)
    {
        AgentKey storage k = _agentKeys[agentId];
        return (k.pub, k.epoch, k.updatedAt, k.publisher);
    }

    /// @notice Demo transport: emit an envelope for a recipient that has a key. Stores nothing.
    /// @dev Recipient encoding (exactly one kind): an address recipient passes `to != address(0)` and
    ///      `toAgent == NO_AGENT`; an agent recipient passes `to == address(0)` and its agent id. The recipient must
    ///      have a key that resolves now (`keyOf` / `keyOfAgent` non-zero), so no drop can target a recipient
    ///      without a live key. The contract does not validate the envelope: any 1 to `MAX_ENVELOPE_BYTES` bytes
    ///      are accepted, sealed correctly or not. A drop to an agent is sealed to the key that resolves at that
    ///      time, so after the agent is transferred only its previous owner can open it. The Letterlock SDK drops
    ///      the UTF-8 JSON envelope of docs/SPEC.md §3. Anyone may drop (HPKE base mode is anonymous; see the SPEC
    ///      threat model on replay).
    /// @param to The recipient address, or `address(0)` for an agent recipient.
    /// @param toAgent The recipient agent id, or `NO_AGENT` for an address recipient.
    /// @param envelope The sealed envelope, 1 to `MAX_ENVELOPE_BYTES` bytes.
    function drop(address to, uint256 toAgent, bytes calldata envelope) external {
        bool toAddress = to != address(0);
        if (toAddress == (toAgent != NO_AGENT)) revert InvalidRecipient(to, toAgent);
        if (envelope.length == 0) revert EmptyEnvelope();
        if (envelope.length > MAX_ENVELOPE_BYTES) revert EnvelopeTooLarge(envelope.length, MAX_ENVELOPE_BYTES);
        if (toAddress) {
            if (_keys[to].epoch == 0) revert NoKeyPublished(to, toAgent);
        } else {
            if (address(identityRegistry) == address(0)) revert AgentPathDisabled();
            if (!_agentKeyResolves(toAgent, _agentKeys[toAgent])) revert NoKeyPublished(to, toAgent);
        }
        emit Dropped(to, toAgent, envelope);
    }

    /// @dev Rotation is exactly +1 (docs/SPEC.md §2). With jumps allowed, one publish at 2^32 - 1 (a mistaken or
    ///      phished one, or a seller's just before an agent transfer) would leave no epoch for any later key; with
    ///      +1, reaching epoch n takes n publishes. The sum is taken in uint256, so a slot at 2^32 - 1 reverts
    ///      `EpochNotNext` for every input instead of overflowing.
    function _checkNextEpoch(uint32 current, uint32 given) private pure {
        if (uint256(given) != uint256(current) + 1) revert EpochNotNext(current, given);
    }

    /// @dev A stored agent key resolves only while its publisher still owns the agent. Records exist only when
    ///      `identityRegistry != address(0)`, so the registry is never called on a disabled deployment.
    function _agentKeyResolves(uint256 agentId, AgentKey storage k) private view returns (bool) {
        return k.epoch != 0 && _ownerOf(agentId) == k.publisher;
    }

    /// @dev `ownerOf`, with a revert (nonexistent or burned agent) read as "no owner".
    function _ownerOf(uint256 agentId) private view returns (address owner) {
        try identityRegistry.ownerOf(agentId) returns (address o) {
            owner = o;
        } catch {
            owner = address(0);
        }
    }

    /// @dev X25519 public-key rules, in this order:
    ///      1. not zero (the "no key" value) -> ZeroKey;
    ///      2. not a libsodium small-order encoding, bit 255 ignored as libsodium does -> LowOrderKey;
    ///      3. canonical: bit 255 clear and u < p -> NonCanonicalKey. A non-canonical spelling of a valid key still
    ///         seals, but HPKE puts the sender's copy of the recipient key bytes into the KEM context
    ///         (RFC 9180 §4.1, kem_context = enc || pkRm) while the recipient re-derives the canonical bytes, so
    ///         every envelope sealed to such a spelling would be unopenable.
    function _checkKey(bytes32 pub) private pure {
        if (pub == bytes32(0)) revert ZeroKey();
        bytes32 m = pub & ~bytes32(U_BIT_255);
        if (
            m == SMALL_ORDER_0 || m == SMALL_ORDER_1 || m == SMALL_ORDER_2 || m == SMALL_ORDER_3 || m == SMALL_ORDER_4
                || m == SMALL_ORDER_5 || m == SMALL_ORDER_6
        ) revert LowOrderKey(pub);
        uint256 w = uint256(pub);
        if (w & U_BIT_255 != 0 || (w & KEY_BYTES_1_TO_31 == P_BYTES_1_TO_31 && uint8(pub[0]) >= 0xed)) {
            revert NonCanonicalKey(pub);
        }
    }
}
