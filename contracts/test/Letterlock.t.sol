// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Letterlock} from "../src/Letterlock.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {X25519Ref} from "./utils/X25519Ref.sol";

/// @notice Unit and fuzz tests. The agent path uses a test double of the registry here; the real ERC-8004
///         IdentityRegistry is exercised in LetterlockFork.t.sol.
contract LetterlockTest is Test {
    event KeyPublished(address indexed who, uint256 indexed agentId, bytes32 pub, uint32 epoch);
    event Dropped(address indexed to, uint256 indexed toAgent, bytes envelope);

    uint256 internal constant NO_AGENT = type(uint256).max;
    uint256 internal constant MAX = 16 * 1024;

    // RFC 7748 §6.1 public keys (Alice, Bob): real X25519 keys from the RFC's Diffie-Hellman example.
    bytes32 internal constant RFC7748_ALICE = 0x8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a;
    bytes32 internal constant RFC7748_BOB = 0xde9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f;
    // The SDK's deriveKeyPair(prf = 0x000102..1f, epoch 1 / 2) from packages/letterlock (docs/SPEC.md §2).
    bytes32 internal constant SDK_E1 = 0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b;
    bytes32 internal constant SDK_E2 = 0x68698a4ee1fa5b9c6b9041b19bf0a69bee3d69e9d00bb6d5c7d01f8add2bce7e;

    // libsodium 1.0.22 has_small_order() blacklist, byte-for-byte (x25519_ref10.c).
    bytes32 internal constant SO_ZERO = 0x0000000000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant SO_ONE = 0x0100000000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant SO_ORDER8_A = 0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800;
    bytes32 internal constant SO_ORDER8_B = 0x5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157;
    bytes32 internal constant SO_P_MINUS_1 = 0xecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f;
    bytes32 internal constant SO_P = 0xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f;
    bytes32 internal constant SO_P_PLUS_1 = 0xeeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f;
    bytes32 internal constant BIT_255 = bytes32(uint256(0x80));

    MockIdentityRegistry internal registry;
    Letterlock internal ll; // agent path on (test-double registry)
    Letterlock internal llNoAgents; // agent path off, as deployed on Monad testnet

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    bytes internal constant ENVELOPE = bytes('{"v":1,"chainId":10143,"epoch":1,"enc":"...","ct":"..."}');

    function setUp() public {
        registry = new MockIdentityRegistry();
        ll = new Letterlock(address(registry));
        llNoAgents = new Letterlock(address(0));
    }

    // ---------------------------------------------------------------- helpers

    function _assertKey(address who, bytes32 pub, uint32 epoch, uint64 at) internal view {
        (bytes32 p, uint32 e, uint64 t) = ll.keyOf(who);
        assertEq(p, pub, "pub");
        assertEq(e, epoch, "epoch");
        assertEq(t, at, "updatedAt");
    }

    function _assertAgentKey(uint256 agentId, bytes32 pub, uint32 epoch, uint64 at) internal view {
        (bytes32 p, uint32 e, uint64 t) = ll.keyOfAgent(agentId);
        assertEq(p, pub, "agent pub");
        assertEq(e, epoch, "agent epoch");
        assertEq(t, at, "agent updatedAt");
    }

    function _mintAndPublishAgent(uint256 agentId, address owner, bytes32 pub, uint32 epoch) internal {
        registry.mint(owner, agentId);
        vm.prank(owner);
        ll.publishForAgent(agentId, pub, epoch);
    }

    function _epochErr(uint32 current, uint32 given) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Letterlock.EpochNotNext.selector, current, given);
    }

    /// Publish epochs 1..n for `who`, alternating two real keys.
    function _publishUpTo(address who, uint32 n) internal {
        for (uint32 e = 1; e <= n; e++) {
            vm.prank(who);
            ll.publish(e % 2 == 1 ? SDK_E1 : SDK_E2, e);
        }
    }

    /// Publish epochs 1..n for an agent that `owner` already owns.
    function _publishAgentUpTo(uint256 agentId, address owner, uint32 n) internal {
        for (uint32 e = 1; e <= n; e++) {
            vm.prank(owner);
            ll.publishForAgent(agentId, e % 2 == 1 ? SDK_E1 : SDK_E2, e);
        }
    }

    /// Overwrite the stored epoch of an address slot (storage: `_keys` at slot 0; `epoch` is the low 4 bytes of the
    /// struct's second word), for the one state no test can reach by publishing: epoch 2^32 - 1.
    function _storeAddressEpoch(address who, uint32 epoch) internal {
        bytes32 word = bytes32(uint256(keccak256(abi.encode(who, uint256(0)))) + 1);
        uint256 v = uint256(vm.load(address(ll), word));
        vm.store(address(ll), word, bytes32((v & ~uint256(type(uint32).max)) | epoch));
    }

    /// Expect `pub` to be rejected with the right error on BOTH publish paths.
    function _expectKeyRejected(bytes32 pub, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(alice);
        ll.publish(pub, 1);

        if (!registry.exists(7)) registry.mint(alice, 7);
        vm.expectRevert(err);
        vm.prank(alice);
        ll.publishForAgent(7, pub, 1);

        _assertKey(alice, 0, 0, 0);
        _assertAgentKey(7, 0, 0, 0);
    }

    function _expectSmallOrderRejected(bytes32 entry) internal {
        // The entry and its bit-255 twin (libsodium ignores bit 255) are both small-order per the reference model.
        bytes32 twin = entry | BIT_255;
        assertTrue(X25519Ref.isSmallOrder(entry), "entry must match libsodium's decimal comment");
        assertTrue(X25519Ref.isSmallOrder(twin), "twin must match libsodium's decimal comment");
        if (entry == bytes32(0)) _expectKeyRejected(entry, abi.encodeWithSelector(Letterlock.ZeroKey.selector));
        else _expectKeyRejected(entry, abi.encodeWithSelector(Letterlock.LowOrderKey.selector, entry));
        _expectKeyRejected(twin, abi.encodeWithSelector(Letterlock.LowOrderKey.selector, twin));
    }

    function _referenceError(bytes32 pub, X25519Ref.Verdict v) internal pure returns (bytes memory) {
        if (v == X25519Ref.Verdict.Zero) return abi.encodeWithSelector(Letterlock.ZeroKey.selector);
        if (v == X25519Ref.Verdict.LowOrder) return abi.encodeWithSelector(Letterlock.LowOrderKey.selector, pub);
        return abi.encodeWithSelector(Letterlock.NonCanonicalKey.selector, pub);
    }

    /// Differential check: the contract accepts `pub` exactly when the independent reference model does, and
    /// rejects it with the error the model predicts.
    function _assertMatchesReference(bytes32 pub) internal {
        X25519Ref.Verdict v = X25519Ref.verdict(pub);
        address who = address(uint160(uint256(keccak256(abi.encode("caller", pub)))));
        if (v == X25519Ref.Verdict.Valid) {
            vm.prank(who);
            ll.publish(pub, 1);
            (bytes32 got,,) = ll.keyOf(who);
            assertEq(got, pub);
        } else {
            vm.expectRevert(_referenceError(pub, v));
            vm.prank(who);
            ll.publish(pub, 1);
        }
    }

    // ---------------------------------------------------------------- constructor & constants

    function test_constructor_setsRegistry() public view {
        assertEq(address(ll.identityRegistry()), address(registry));
    }

    function test_constructor_zeroRegistryDisablesAgentPath() public view {
        assertEq(address(llNoAgents.identityRegistry()), address(0));
    }

    function test_constructor_revertsOnRegistryWithoutCode() public {
        // e.g. the mainnet ERC-8004 address on testnet, where it has no code
        address noCode = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
        assertEq(noCode.code.length, 0);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.RegistryHasNoCode.selector, noCode));
        new Letterlock(noCode);
    }

    function test_constants() public view {
        assertEq(ll.NO_AGENT(), type(uint256).max);
        assertEq(ll.MAX_ENVELOPE_BYTES(), 16384);
    }

    // ---------------------------------------------------------------- publish / keyOf

    function test_keyOf_isZeroWhenNothingPublished() public view {
        _assertKey(alice, 0, 0, 0);
    }

    function test_publish_firstKeyAtEpochOne() public {
        vm.warp(1_790_000_000);
        vm.expectEmit(true, true, false, true, address(ll));
        emit KeyPublished(alice, NO_AGENT, SDK_E1, 1);
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _assertKey(alice, SDK_E1, 1, 1_790_000_000);
    }

    function test_publish_firstKeyMustBeEpochOne() public {
        uint32[4] memory wrong = [uint32(0), 2, 7, type(uint32).max];
        for (uint256 i = 0; i < wrong.length; i++) {
            vm.expectRevert(_epochErr(0, wrong[i]));
            vm.prank(alice);
            ll.publish(SDK_E1, wrong[i]);
        }
        _assertKey(alice, 0, 0, 0);
    }

    function test_publish_rotateToNextEpoch() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectEmit(true, true, false, true, address(ll));
        emit KeyPublished(alice, NO_AGENT, SDK_E2, 2);
        vm.prank(alice);
        ll.publish(SDK_E2, 2);
        _assertKey(alice, SDK_E2, 2, uint64(vm.getBlockTimestamp()));
    }

    function test_publish_revertsOnEpochJump() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.expectRevert(_epochErr(1, 3));
        vm.prank(alice);
        ll.publish(SDK_E2, 3);
        vm.expectRevert(_epochErr(1, 40));
        vm.prank(alice);
        ll.publish(SDK_E2, 40);
        _assertKey(alice, SDK_E1, 1, uint64(vm.getBlockTimestamp()));
    }

    function test_publish_revertsOnEpochZero() public {
        vm.expectRevert(_epochErr(0, 0));
        vm.prank(alice);
        ll.publish(SDK_E1, 0);
    }

    function test_publish_revertsOnSameEpoch() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.expectRevert(_epochErr(1, 1));
        vm.prank(alice);
        ll.publish(SDK_E2, 1);
        _assertKey(alice, SDK_E1, 1, uint64(vm.getBlockTimestamp()));
    }

    function test_publish_revertsOnLowerEpoch() public {
        _publishUpTo(alice, 5);
        vm.expectRevert(_epochErr(5, 4));
        vm.prank(alice);
        ll.publish(SDK_E2, 4);
        _assertKey(alice, SDK_E1, 5, uint64(vm.getBlockTimestamp()));
    }

    /// Regression, audit A finding 1 (address path): one publish, mistaken or phished, cannot move a slot to the last
    /// epoch. When any higher epoch was accepted, publish(pub, 2^32 - 1) succeeded and no later key could follow it.
    function test_publish_oneCallCannotUseUpTheEpochs() public {
        vm.expectRevert(_epochErr(0, type(uint32).max));
        vm.prank(alice);
        ll.publish(SDK_E1, type(uint32).max);

        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.expectRevert(_epochErr(1, type(uint32).max));
        vm.prank(alice);
        ll.publish(SDK_E2, type(uint32).max);

        vm.prank(alice);
        ll.publish(SDK_E2, 2); // the slot still rotates
        _assertKey(alice, SDK_E2, 2, uint64(vm.getBlockTimestamp()));
    }

    /// A slot at 2^32 - 1 is 4,294,967,295 publishes away, so it is never reached; set it directly. It is final, and
    /// the + 1 does not overflow: every epoch reverts EpochNotNext, never Panic(0x11).
    function test_publish_slotAtMaxEpochIsFinalWithoutOverflow() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _storeAddressEpoch(alice, type(uint32).max);
        _assertKey(alice, SDK_E1, type(uint32).max, uint64(vm.getBlockTimestamp()));
        uint32[3] memory tries = [uint32(0), 1, type(uint32).max];
        for (uint256 i = 0; i < tries.length; i++) {
            vm.expectRevert(_epochErr(type(uint32).max, tries[i]));
            vm.prank(alice);
            ll.publish(SDK_E2, tries[i]);
        }
    }

    function test_publish_writesOnlyTheCallersSlot() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _assertKey(bob, 0, 0, 0);
        vm.prank(bob);
        ll.publish(RFC7748_BOB, 1);
        _assertKey(alice, SDK_E1, 1, uint64(vm.getBlockTimestamp()));
        _assertKey(bob, RFC7748_BOB, 1, uint64(vm.getBlockTimestamp()));
    }

    function test_publish_acceptsRealX25519Keys() public {
        vm.prank(alice);
        ll.publish(RFC7748_ALICE, 1);
        vm.prank(bob);
        ll.publish(RFC7748_BOB, 1);
        vm.prank(carol);
        ll.publish(SDK_E2, 1);
        _assertKey(alice, RFC7748_ALICE, 1, uint64(vm.getBlockTimestamp()));
        _assertKey(bob, RFC7748_BOB, 1, uint64(vm.getBlockTimestamp()));
        _assertKey(carol, SDK_E2, 1, uint64(vm.getBlockTimestamp()));
    }

    // ---------------------------------------------------------------- key rules: zero, small order, canonical

    function test_keyRules_rejectZero() public {
        _expectKeyRejected(bytes32(0), abi.encodeWithSelector(Letterlock.ZeroKey.selector));
    }

    function test_keyRules_rejectLibsodiumSmallOrder_zero() public {
        _expectSmallOrderRejected(SO_ZERO);
    }

    function test_keyRules_rejectLibsodiumSmallOrder_one() public {
        _expectSmallOrderRejected(SO_ONE);
    }

    function test_keyRules_rejectLibsodiumSmallOrder_order8A() public {
        _expectSmallOrderRejected(SO_ORDER8_A);
    }

    function test_keyRules_rejectLibsodiumSmallOrder_order8B() public {
        _expectSmallOrderRejected(SO_ORDER8_B);
    }

    function test_keyRules_rejectLibsodiumSmallOrder_pMinus1() public {
        _expectSmallOrderRejected(SO_P_MINUS_1);
    }

    function test_keyRules_rejectLibsodiumSmallOrder_p() public {
        _expectSmallOrderRejected(SO_P);
    }

    function test_keyRules_rejectLibsodiumSmallOrder_pPlus1() public {
        _expectSmallOrderRejected(SO_P_PLUS_1);
    }

    function test_keyRules_rejectBit255SetOnAValidKey() public {
        // Same point after RFC 7748 masking, but envelopes sealed to this spelling can never be opened
        // (the SDK re-derives the canonical bytes, and HPKE binds the key bytes into the KEM context).
        bytes32 twin = SDK_E1 | BIT_255;
        assertEq(uint8(SDK_E1[31]) & 0x80, 0, "the SDK key itself is canonical");
        assertEq(uint8(twin[31]) & 0x80, 0x80, "the twin sets bit 255");
        assertEq(X25519Ref.le(twin) & (2 ** 255 - 1), X25519Ref.le(SDK_E1), "same u after RFC 7748 masking");
        _expectKeyRejected(twin, abi.encodeWithSelector(Letterlock.NonCanonicalKey.selector, twin));
    }

    function test_keyRules_rejectEveryUAtOrAboveP() public {
        // u in [p, 2^255 - 1] is a non-canonical spelling of 0..18; p and p+1 are libsodium entries.
        for (uint256 k = 0; k <= 18; k++) {
            bytes32 pub = X25519Ref.fromLe(X25519Ref.P + k);
            bytes memory err = k <= 1
                ? abi.encodeWithSelector(Letterlock.LowOrderKey.selector, pub)
                : abi.encodeWithSelector(Letterlock.NonCanonicalKey.selector, pub);
            _expectKeyRejected(pub, err);
        }
        assertEq(X25519Ref.le(X25519Ref.fromLe(X25519Ref.P + 18)), 2 ** 255 - 1);
    }

    function test_keyRules_acceptLargestCanonicalNonSmallOrderU() public {
        bytes32 pub = X25519Ref.fromLe(X25519Ref.P - 2); // p - 1 is small order; p - 2 is the largest valid u
        assertEq(pub, 0xebffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f);
        vm.prank(alice);
        ll.publish(pub, 1);
        _assertKey(alice, pub, 1, uint64(vm.getBlockTimestamp()));
    }

    function test_keyRules_acceptSmallestNonSmallOrderU() public {
        bytes32 pub = X25519Ref.fromLe(2);
        vm.prank(alice);
        ll.publish(pub, 1);
        _assertKey(alice, pub, 1, uint64(vm.getBlockTimestamp()));
    }

    // ---------------------------------------------------------------- publishForAgent / keyOfAgent

    function test_publishForAgent_revertsWhenAgentPathDisabled() public {
        vm.expectRevert(Letterlock.AgentPathDisabled.selector);
        vm.prank(alice);
        llNoAgents.publishForAgent(1, SDK_E1, 1);
    }

    function test_publishForAgent_revertsOnReservedId() public {
        vm.expectRevert(Letterlock.AgentIdReserved.selector);
        vm.prank(alice);
        ll.publishForAgent(NO_AGENT, SDK_E1, 1);
    }

    function test_publishForAgent_revertsForNonOwner() public {
        registry.mint(carol, 42);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, uint256(42), bob));
        vm.prank(bob);
        ll.publishForAgent(42, SDK_E1, 1);
        _assertAgentKey(42, 0, 0, 0);
    }

    function test_publishForAgent_revertsForNonexistentAgent() public {
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, uint256(99), alice));
        vm.prank(alice);
        ll.publishForAgent(99, SDK_E1, 1);
    }

    function test_publishForAgent_ownerPublishesForAgentZero() public {
        // Agent id 0 is a real ERC-8004 id (it exists on Monad mainnet), which is why NO_AGENT is not 0.
        registry.mint(carol, 0);
        vm.warp(1_790_000_000);
        vm.expectEmit(true, true, false, true, address(ll));
        emit KeyPublished(carol, 0, SDK_E1, 1);
        vm.prank(carol);
        ll.publishForAgent(0, SDK_E1, 1);
        _assertAgentKey(0, SDK_E1, 1, 1_790_000_000);
        (bytes32 p, uint32 e, uint64 t, address publisher) = ll.agentKeyRecord(0);
        assertEq(p, SDK_E1);
        assertEq(e, 1);
        assertEq(t, 1_790_000_000);
        assertEq(publisher, carol);
        _assertKey(carol, 0, 0, 0); // the agent key is not carol's address key
    }

    function test_publishForAgent_epochRules() public {
        _mintAndPublishAgent(5, carol, SDK_E1, 1);
        vm.startPrank(carol);
        vm.expectRevert(_epochErr(1, 1));
        ll.publishForAgent(5, SDK_E2, 1);
        vm.expectRevert(_epochErr(1, 0));
        ll.publishForAgent(5, SDK_E2, 0);
        vm.expectRevert(_epochErr(1, 3));
        ll.publishForAgent(5, SDK_E2, 3);
        ll.publishForAgent(5, SDK_E2, 2);
        vm.stopPrank();
        _assertAgentKey(5, SDK_E2, 2, uint64(vm.getBlockTimestamp()));
    }

    function test_publishForAgent_revertsOnEpochZero() public {
        registry.mint(carol, 5);
        vm.expectRevert(_epochErr(0, 0));
        vm.prank(carol);
        ll.publishForAgent(5, SDK_E1, 0);
    }

    function test_publishForAgent_firstKeyMustBeEpochOne() public {
        registry.mint(carol, 5);
        vm.expectRevert(_epochErr(0, 2));
        vm.prank(carol);
        ll.publishForAgent(5, SDK_E1, 2);
        vm.expectRevert(_epochErr(0, type(uint32).max));
        vm.prank(carol);
        ll.publishForAgent(5, SDK_E1, type(uint32).max);
        _assertAgentKey(5, 0, 0, 0);
    }

    /// Regression, audit A finding 1: a seller cannot brick the buyer's agent key slot. When any higher epoch was
    /// accepted, the seller published at 2^32 - 1 and transferred the agent; the buyer's publishForAgent then
    /// reverted for every epoch, keyOfAgent returned zeros forever and every drop to the agent reverted.
    function test_publishForAgent_sellerCannotBrickTheBuyersSlot() public {
        address seller = makeAddr("seller");
        address buyer = makeAddr("buyer");
        registry.mint(seller, 42);
        vm.expectRevert(_epochErr(0, type(uint32).max));
        vm.prank(seller);
        ll.publishForAgent(42, SDK_E1, type(uint32).max);
        vm.prank(seller);
        ll.publishForAgent(42, SDK_E1, 1);
        vm.expectRevert(_epochErr(1, type(uint32).max));
        vm.prank(seller);
        ll.publishForAgent(42, SDK_E2, type(uint32).max);

        registry.transfer(42, buyer);
        _assertAgentKey(42, 0, 0, 0);
        (, uint32 stored,,) = ll.agentKeyRecord(42);
        assertEq(stored, 1);
        vm.prank(buyer);
        ll.publishForAgent(42, RFC7748_BOB, stored + 1);
        _assertAgentKey(42, RFC7748_BOB, 2, uint64(vm.getBlockTimestamp()));
        vm.expectEmit(true, true, false, true, address(ll));
        emit Dropped(address(0), 42, ENVELOPE);
        ll.drop(address(0), 42, ENVELOPE);
    }

    function test_publishForAgent_doesNotTouchAddressKeys() public {
        _publishUpTo(carol, 3);
        _mintAndPublishAgent(5, carol, RFC7748_BOB, 1);
        _assertKey(carol, SDK_E1, 3, uint64(vm.getBlockTimestamp()));
        _assertAgentKey(5, RFC7748_BOB, 1, uint64(vm.getBlockTimestamp()));
    }

    function test_keyOfAgent_isZeroWhenNothingPublished() public {
        registry.mint(carol, 5);
        _assertAgentKey(5, 0, 0, 0);
        _assertAgentKey(6, 0, 0, 0); // nonexistent agent
    }

    function test_keyOfAgent_isZeroWhenAgentPathDisabled() public view {
        (bytes32 p, uint32 e, uint64 t) = llNoAgents.keyOfAgent(0);
        assertEq(p, 0);
        assertEq(e, 0);
        assertEq(t, 0);
    }

    function test_keyOfAgent_stopsResolvingAfterTransfer_newOwnerContinuesEpochs() public {
        registry.mint(carol, 5);
        _publishAgentUpTo(5, carol, 3);
        uint64 publishedAt = uint64(vm.getBlockTimestamp());
        registry.transfer(5, bob);

        // the previous owner's key must not be sealed to any more
        _assertAgentKey(5, 0, 0, 0);
        (bytes32 p, uint32 e, uint64 t, address publisher) = ll.agentKeyRecord(5);
        assertEq(p, SDK_E1);
        assertEq(e, 3);
        assertEq(t, publishedAt);
        assertEq(publisher, carol);

        // the previous owner can no longer publish
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, uint256(5), carol));
        vm.prank(carol);
        ll.publishForAgent(5, SDK_E2, 4);

        // the new owner continues the agent's epoch sequence: the stored epoch + 1, nothing else
        vm.expectRevert(_epochErr(3, 1));
        vm.prank(bob);
        ll.publishForAgent(5, RFC7748_BOB, 1);
        vm.expectRevert(_epochErr(3, 5));
        vm.prank(bob);
        ll.publishForAgent(5, RFC7748_BOB, 5);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(bob);
        ll.publishForAgent(5, RFC7748_BOB, 4);
        _assertAgentKey(5, RFC7748_BOB, 4, uint64(vm.getBlockTimestamp()));
    }

    function test_keyOfAgent_resolvesAgainWhenTransferredBackToPublisher() public {
        _mintAndPublishAgent(5, carol, SDK_E1, 1);
        registry.transfer(5, bob);
        _assertAgentKey(5, 0, 0, 0);
        registry.transfer(5, carol);
        _assertAgentKey(5, SDK_E1, 1, uint64(vm.getBlockTimestamp()));
    }

    function test_keyOfAgent_isZeroAfterBurn() public {
        _mintAndPublishAgent(5, carol, SDK_E1, 1);
        registry.burn(5);
        _assertAgentKey(5, 0, 0, 0);
    }

    /// A reverting ownerOf (nonexistent or burned agent) means "no owner" for every caller, tx.origin included:
    /// nobody publishes for such an agent, and a burned agent's key does not resolve for its last publisher.
    function test_agentWithoutOwner_noCallerIsItsOwner_evenTxOrigin() public {
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, uint256(99), alice));
        vm.prank(alice, alice);
        ll.publishForAgent(99, SDK_E1, 1);

        _mintAndPublishAgent(5, carol, SDK_E1, 1);
        registry.burn(5);
        vm.prank(carol, carol);
        (bytes32 p, uint32 e, uint64 t) = ll.keyOfAgent(5);
        assertEq(p, 0);
        assertEq(e, 0);
        assertEq(t, 0);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NoKeyPublished.selector, address(0), uint256(5)));
        vm.prank(carol, carol);
        ll.drop(address(0), 5, ENVELOPE);
    }

    function test_agentKeyRecord_isZeroWhenNothingPublished() public view {
        (bytes32 p, uint32 e, uint64 t, address publisher) = ll.agentKeyRecord(123);
        assertEq(p, 0);
        assertEq(e, 0);
        assertEq(t, 0);
        assertEq(publisher, address(0));
    }

    // ---------------------------------------------------------------- drop

    function test_drop_toAddress() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.expectEmit(true, true, false, true, address(ll));
        emit Dropped(alice, NO_AGENT, ENVELOPE);
        vm.prank(stranger); // anyone may drop
        ll.drop(alice, NO_AGENT, ENVELOPE);
    }

    function test_drop_toAgent() public {
        _mintAndPublishAgent(0, carol, SDK_E1, 1);
        vm.expectEmit(true, true, false, true, address(ll));
        emit Dropped(address(0), 0, ENVELOPE);
        vm.prank(stranger);
        ll.drop(address(0), 0, ENVELOPE);
    }

    function test_drop_revertsWhenBothRecipientKindsSet() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _mintAndPublishAgent(0, carol, SDK_E2, 1);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.InvalidRecipient.selector, alice, uint256(0)));
        ll.drop(alice, 0, ENVELOPE);
    }

    function test_drop_revertsWhenNoRecipientKindSet() public {
        vm.expectRevert(abi.encodeWithSelector(Letterlock.InvalidRecipient.selector, address(0), NO_AGENT));
        ll.drop(address(0), NO_AGENT, ENVELOPE);
    }

    function test_drop_revertsOnEmptyEnvelope() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.expectRevert(Letterlock.EmptyEnvelope.selector);
        ll.drop(alice, NO_AGENT, "");
    }

    function test_drop_acceptsExactlyMaxBytes() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        ll.drop(alice, NO_AGENT, new bytes(MAX));
    }

    function test_drop_revertsAboveMaxBytes() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.EnvelopeTooLarge.selector, MAX + 1, MAX));
        ll.drop(alice, NO_AGENT, new bytes(MAX + 1));
    }

    function test_drop_revertsWhenAddressHasNoKey() public {
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NoKeyPublished.selector, bob, NO_AGENT));
        ll.drop(bob, NO_AGENT, ENVELOPE);
    }

    function test_drop_revertsWhenAgentHasNoKey() public {
        registry.mint(carol, 5);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NoKeyPublished.selector, address(0), uint256(5)));
        ll.drop(address(0), 5, ENVELOPE);
    }

    function test_drop_revertsWhenAgentKeyIsStale() public {
        _mintAndPublishAgent(5, carol, SDK_E1, 1);
        registry.transfer(5, bob);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NoKeyPublished.selector, address(0), uint256(5)));
        ll.drop(address(0), 5, ENVELOPE);
    }

    function test_drop_revertsToAgentWhenAgentPathDisabled() public {
        vm.expectRevert(Letterlock.AgentPathDisabled.selector);
        llNoAgents.drop(address(0), 1, ENVELOPE);
    }

    function test_drop_toAddressWorksWhenAgentPathDisabled() public {
        vm.prank(alice);
        llNoAgents.publish(SDK_E1, 1);
        vm.expectEmit(true, true, false, true, address(llNoAgents));
        emit Dropped(alice, NO_AGENT, ENVELOPE);
        llNoAgents.drop(alice, NO_AGENT, ENVELOPE);
    }

    function test_drop_writesNoStorage() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _mintAndPublishAgent(0, carol, SDK_E2, 1);
        vm.record();
        ll.drop(alice, NO_AGENT, ENVELOPE);
        ll.drop(address(0), 0, ENVELOPE);
        (, bytes32[] memory writes) = vm.accesses(address(ll));
        assertEq(writes.length, 0);
    }

    /// Audit A finding 3: `drop` guarantees a recipient with a live key and nothing about the envelope. Bytes that no
    /// HPKE open accepts, such as a single zero byte, are dropped like a sealed envelope (NatSpec and README say so).
    function test_drop_doesNotValidateTheEnvelope() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.expectEmit(true, true, false, true, address(ll));
        emit Dropped(alice, NO_AGENT, hex"00");
        ll.drop(alice, NO_AGENT, hex"00");
    }

    /// Audit A finding 4: a KeyPublished log is history, not liveness. After a transfer the only Letterlock log for
    /// the agent still carries the previous owner's key while keyOfAgent returns zeros, so an indexer must confirm
    /// agent keys with keyOfAgent before anyone seals (event NatSpec, README, docs/SPEC.md §8).
    function test_keyPublishedLogIsHistoryNotLiveness() public {
        registry.mint(carol, 42);
        vm.recordLogs();
        vm.prank(carol);
        ll.publishForAgent(42, SDK_E1, 1);
        registry.transfer(42, bob); // the test-double registry emits no logs, like any registry Letterlock cannot see
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(ll));
        assertEq(logs[0].topics[0], Letterlock.KeyPublished.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(carol))));
        assertEq(logs[0].topics[2], bytes32(uint256(42)));
        (bytes32 loggedPub, uint32 loggedEpoch) = abi.decode(logs[0].data, (bytes32, uint32));
        assertEq(loggedPub, SDK_E1);
        assertEq(loggedEpoch, 1);
        _assertAgentKey(42, 0, 0, 0);
    }

    // ---------------------------------------------------------------- funds

    /// Every entry point rejects value, including the calls that would succeed without it.
    function test_acceptsNoValue() public {
        registry.mint(alice, 7);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        (bool ok,) = address(ll).call{value: 1}("");
        assertFalse(ok, "plain transfer must fail");
        (ok,) = address(ll).call{value: 1}(abi.encodeCall(Letterlock.publish, (SDK_E1, 1)));
        assertFalse(ok, "publish must not accept value");
        (ok,) = address(ll).call{value: 1}(abi.encodeCall(Letterlock.publishForAgent, (7, SDK_E1, 1)));
        assertFalse(ok, "publishForAgent must not accept value");
        ll.publish(SDK_E1, 1);
        ll.publishForAgent(7, SDK_E2, 1);
        (ok,) = address(ll).call{value: 1}(abi.encodeCall(Letterlock.drop, (alice, NO_AGENT, ENVELOPE)));
        assertFalse(ok, "drop to an address must not accept value");
        (ok,) = address(ll).call{value: 1}(abi.encodeCall(Letterlock.drop, (address(0), 7, ENVELOPE)));
        assertFalse(ok, "drop to an agent must not accept value");
        vm.stopPrank();
        assertEq(address(ll).balance, 0);
    }

    // ---------------------------------------------------------------- fuzz

    /// After `steps` publishes only steps + 1 is accepted, whatever epoch is tried. `useNext` forces the accepted
    /// case, which a random uint32 would almost never hit.
    function testFuzz_publish_epochMustBeNext(uint8 steps, uint32 given, bool useNext) public {
        uint32 n = uint32(bound(steps, 0, 24));
        _publishUpTo(alice, n);
        if (useNext) given = n + 1;
        vm.prank(alice);
        if (uint256(given) == uint256(n) + 1) {
            ll.publish(RFC7748_ALICE, given);
            _assertKey(alice, RFC7748_ALICE, given, uint64(vm.getBlockTimestamp()));
        } else {
            vm.expectRevert(_epochErr(n, given));
            ll.publish(RFC7748_ALICE, given);
            (, uint32 e,) = ll.keyOf(alice);
            assertEq(e, n);
        }
    }

    function testFuzz_publishForAgent_epochMustBeNext(uint256 agentId, uint8 steps, uint32 given, bool useNext) public {
        vm.assume(agentId != NO_AGENT);
        registry.mint(carol, agentId);
        uint32 n = uint32(bound(steps, 0, 24));
        _publishAgentUpTo(agentId, carol, n);
        if (useNext) given = n + 1;
        vm.prank(carol);
        if (uint256(given) == uint256(n) + 1) {
            ll.publishForAgent(agentId, RFC7748_ALICE, given);
            _assertAgentKey(agentId, RFC7748_ALICE, given, uint64(vm.getBlockTimestamp()));
        } else {
            vm.expectRevert(_epochErr(n, given));
            ll.publishForAgent(agentId, RFC7748_ALICE, given);
            (, uint32 e,,) = ll.agentKeyRecord(agentId);
            assertEq(e, n);
        }
    }

    /// Regression, audit A finding 1, as a property: whatever the previous owner published or tried to publish
    /// before a transfer, the new owner can publish the stored epoch + 1, and the agent then resolves to that key.
    function testFuzz_newAgentOwnerCanAlwaysPublish(uint256 agentId, uint8 sellerSteps, uint32 sellerTry, address buyer)
        public
    {
        assumeNotForgeAddress(buyer);
        vm.assume(agentId != NO_AGENT && buyer != carol && buyer != address(0));
        registry.mint(carol, agentId);
        uint32 n = uint32(bound(sellerSteps, 0, 24));
        _publishAgentUpTo(agentId, carol, n);
        if (uint256(sellerTry) != uint256(n) + 1) {
            vm.expectRevert(_epochErr(n, sellerTry));
            vm.prank(carol);
            ll.publishForAgent(agentId, SDK_E1, sellerTry);
        }
        registry.transfer(agentId, buyer);

        (, uint32 stored,,) = ll.agentKeyRecord(agentId);
        assertEq(stored, n);
        vm.prank(buyer);
        ll.publishForAgent(agentId, RFC7748_BOB, stored + 1);
        _assertAgentKey(agentId, RFC7748_BOB, stored + 1, uint64(vm.getBlockTimestamp()));
    }

    function testFuzz_keyRules_matchReference(bytes32 pub) public {
        _assertMatchesReference(pub);
    }

    function testFuzz_keyRules_matchReferenceNearP(uint8 lowByte, bool bit255) public {
        // u = 2^255 - 256 + lowByte, i.e. p - 237 .. 2^255 - 1: the canonical boundary and every
        // non-canonical spelling, with and without bit 255.
        bytes32 pub = SO_P & ~bytes32(uint256(0xff) << 248) | bytes32(uint256(lowByte) << 248);
        if (bit255) pub |= BIT_255;
        _assertMatchesReference(pub);
    }

    function testFuzz_keyRules_matchReferenceNearSmallOrder(uint8 which, uint8 bytePos, uint8 xorMask, bool bit255)
        public
    {
        bytes32[7] memory list = [SO_ZERO, SO_ONE, SO_ORDER8_A, SO_ORDER8_B, SO_P_MINUS_1, SO_P, SO_P_PLUS_1];
        bytes32 pub = list[which % 7] ^ bytes32(uint256(xorMask) << (8 * (31 - (bytePos % 32))));
        if (bit255) pub |= BIT_255;
        _assertMatchesReference(pub);
    }

    function testFuzz_publish_writesOnlyTheCallersSlot(address a, address b) public {
        assumeNotForgeAddress(a);
        vm.assume(a != b);
        vm.prank(a);
        ll.publish(SDK_E1, 1);
        (bytes32 pb, uint32 eb, uint64 tb) = ll.keyOf(b);
        assertEq(pb, 0);
        assertEq(eb, 0);
        assertEq(tb, 0);
        (bytes32 pa,,) = ll.keyOf(a);
        assertEq(pa, SDK_E1);
    }

    function testFuzz_publishForAgent_onlyCurrentOwner(address caller, uint256 agentId) public {
        assumeNotForgeAddress(caller);
        vm.assume(agentId != NO_AGENT);
        registry.mint(carol, agentId);
        if (caller == carol) {
            vm.prank(caller);
            ll.publishForAgent(agentId, SDK_E1, 1);
            _assertAgentKey(agentId, SDK_E1, 1, uint64(vm.getBlockTimestamp()));
        } else {
            vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, agentId, caller));
            vm.prank(caller);
            ll.publishForAgent(agentId, SDK_E1, 1);
            _assertAgentKey(agentId, 0, 0, 0);
        }
    }

    function testFuzz_keyOfAgent_staleAfterTransfer(uint256 agentId, address newOwner) public {
        vm.assume(agentId != NO_AGENT && newOwner != carol && newOwner != address(0));
        _mintAndPublishAgent(agentId, carol, SDK_E1, 1);
        registry.transfer(agentId, newOwner);
        _assertAgentKey(agentId, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NoKeyPublished.selector, address(0), agentId));
        ll.drop(address(0), agentId, ENVELOPE);
    }

    function testFuzz_drop_sizing(uint256 len) public {
        len = bound(len, 0, 2 * MAX);
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        bytes memory env = new bytes(len);
        if (len == 0) {
            vm.expectRevert(Letterlock.EmptyEnvelope.selector);
        } else if (len > MAX) {
            vm.expectRevert(abi.encodeWithSelector(Letterlock.EnvelopeTooLarge.selector, len, MAX));
        } else {
            vm.expectEmit(true, true, false, true, address(ll));
            emit Dropped(alice, NO_AGENT, env);
        }
        ll.drop(alice, NO_AGENT, env);
    }

    function testFuzz_drop_exactlyOneRecipientKind(address to, uint256 toAgent, uint8 mode) public {
        if (mode % 4 == 1) to = address(0);
        if (mode % 4 == 2) toAgent = NO_AGENT;
        if (mode % 4 == 3) (to, toAgent) = (address(0), NO_AGENT);
        assumeNotForgeAddress(to);
        bool toAddress = to != address(0);
        bool toAnAgent = toAgent != NO_AGENT;
        // give every named recipient a key, so only the recipient encoding decides
        if (toAddress) {
            vm.prank(to);
            ll.publish(SDK_E1, 1);
        }
        if (toAnAgent) _mintAndPublishAgent(toAgent, carol, SDK_E2, 1);

        if (toAddress == toAnAgent) {
            vm.expectRevert(abi.encodeWithSelector(Letterlock.InvalidRecipient.selector, to, toAgent));
        } else {
            vm.expectEmit(true, true, false, true, address(ll));
            emit Dropped(to, toAgent, ENVELOPE);
        }
        ll.drop(to, toAgent, ENVELOPE);
    }
}
