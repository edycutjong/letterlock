// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Letterlock} from "../src/Letterlock.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {X25519Ref} from "./utils/X25519Ref.sol";

/// @notice Drives random sequences of publish / publishForAgent / drop / agent transfers / burns / time, and after
///         every call checks the frame condition: only the slot the caller was entitled to write may change.
///         Violations are recorded (not reverted) so fail_on_revert = false cannot swallow them.
contract LetterlockHandler is Test {
    struct Slot {
        bytes32 pub;
        uint32 epoch;
        uint64 at;
        address publisher;
    }

    uint256 internal constant NO_AGENT = type(uint256).max;
    uint256 internal constant NONE = type(uint256).max;

    Letterlock public immutable ll;
    MockIdentityRegistry public immutable registry;

    address[] internal actors;
    uint256[] internal agentIds;
    bytes32[] internal keyPool;

    // Ghost model: the last successful publish per slot.
    mapping(address => uint32) public ghostEpoch;
    mapping(address => bytes32) public ghostPub;
    mapping(uint256 => uint32) public ghostAgentEpoch;
    mapping(uint256 => bytes32) public ghostAgentPub;
    mapping(uint256 => address) public ghostAgentPublisher;

    uint256 public violations;
    string public lastViolation;

    // Call counters, so a vacuous campaign is detectable.
    uint256 public publishOk;
    uint256 public publishRejected;
    uint256 public agentPublishOk;
    uint256 public agentPublishRejected;
    uint256 public dropsOk;
    uint256 public dropsRejected;
    uint256 public registryMoves;

    constructor(Letterlock ll_, MockIdentityRegistry registry_, address[] memory actors_, uint256[] memory agentIds_) {
        ll = ll_;
        registry = registry_;
        actors = actors_;
        agentIds = agentIds_;
        // valid keys: RFC 7748 §6.1, SDK-derived, smallest and largest valid u
        keyPool.push(0x8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a);
        keyPool.push(0xde9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f);
        keyPool.push(0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b);
        keyPool.push(0x68698a4ee1fa5b9c6b9041b19bf0a69bee3d69e9d00bb6d5c7d01f8add2bce7e);
        keyPool.push(X25519Ref.fromLe(2));
        keyPool.push(X25519Ref.fromLe(X25519Ref.P - 2));
        // invalid keys: zero, small order, bit 255 set, u >= p
        keyPool.push(bytes32(0));
        keyPool.push(0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800);
        keyPool.push(0xedffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
        keyPool.push(0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604bdb);
        keyPool.push(X25519Ref.fromLe(X25519Ref.P + 5));
    }

    // ------------------------------------------------------------ actions

    /// @param validKey Bias toward the valid part of the key pool; @param nearCurrent toward epochs near the current one.
    function publish(uint256 actorSeed, uint256 keySeed, uint32 epochSeed, bool nearCurrent, bool validKey) external {
        uint256 ai = actorSeed % actors.length;
        address a = actors[ai];
        bytes32 pub = _key(keySeed, validKey);
        uint32 cur = ghostEpoch[a];
        uint32 epoch = nearCurrent ? _near(cur, epochSeed) : epochSeed;
        bool shouldPass = X25519Ref.verdict(pub) == X25519Ref.Verdict.Valid && epoch > cur;
        (Slot[] memory addr0, Slot[] memory agent0) = _snap();

        vm.prank(a);
        try ll.publish(pub, epoch) {
            publishOk++;
            if (!shouldPass) _violate("publish accepted a bad key or a non-increasing epoch");
            if (epoch <= addr0[ai].epoch) _violate("publish: epoch did not strictly increase");
            ghostEpoch[a] = epoch;
            ghostPub[a] = pub;
            _checkFrame(addr0, agent0, ai, NONE, "publish");
        } catch {
            publishRejected++;
            if (shouldPass) _violate("publish rejected a valid key with a higher epoch");
            _checkFrame(addr0, agent0, NONE, NONE, "failed publish");
        }
    }

    /// @param asOwner Bias toward the agent's current owner, so accepted agent publishes are common.
    function publishForAgent(
        uint256 actorSeed,
        uint256 agentSeed,
        uint256 keySeed,
        uint32 epochSeed,
        bool near,
        bool asOwner,
        bool validKey
    ) external {
        uint256 gi = agentSeed % agentIds.length;
        uint256 id = agentIds[gi];
        address a = asOwner && registry.exists(id) ? registry.ownerOf(id) : actors[actorSeed % actors.length];
        bytes32 pub = _key(keySeed, validKey);
        uint32 cur = ghostAgentEpoch[id];
        uint32 epoch = near ? _near(cur, epochSeed) : epochSeed;
        bool isOwner = registry.exists(id) && registry.ownerOf(id) == a;
        bool shouldPass = isOwner && X25519Ref.verdict(pub) == X25519Ref.Verdict.Valid && epoch > cur;
        (Slot[] memory addr0, Slot[] memory agent0) = _snap();

        vm.prank(a);
        try ll.publishForAgent(id, pub, epoch) {
            agentPublishOk++;
            if (!shouldPass) _violate("publishForAgent accepted a non-owner, a bad key or a non-increasing epoch");
            if (epoch <= agent0[gi].epoch) _violate("publishForAgent: epoch did not strictly increase");
            ghostAgentEpoch[id] = epoch;
            ghostAgentPub[id] = pub;
            ghostAgentPublisher[id] = a;
            _checkFrame(addr0, agent0, NONE, gi, "publishForAgent");
        } catch {
            agentPublishRejected++;
            if (shouldPass) _violate("publishForAgent rejected the owner with a valid key and higher epoch");
            _checkFrame(addr0, agent0, NONE, NONE, "failed publishForAgent");
        }
    }

    /// Transfer (or re-mint) an agent to an actor; one call in eight burns it instead.
    function moveAgent(uint256 agentSeed, uint256 toSeed) external {
        uint256 id = agentIds[agentSeed % agentIds.length];
        address to = actors[toSeed % actors.length];
        (Slot[] memory addr0, Slot[] memory agent0) = _snap();
        if (toSeed % 8 == 7) registry.burn(id);
        else if (registry.exists(id)) registry.transfer(id, to);
        else registry.mint(to, id);
        registryMoves++;
        _checkFrame(addr0, agent0, NONE, NONE, "registry move");
    }

    function drop(uint256 kindSeed, uint256 actorSeed, uint256 agentSeed, uint256 lenSeed) external {
        address a = actors[actorSeed % actors.length];
        uint256 id = agentIds[agentSeed % agentIds.length];
        uint256 kind = kindSeed % 4;
        (address to, uint256 toAgent) =
            kind == 0 ? (a, NO_AGENT) : kind == 1 ? (address(0), id) : kind == 2 ? (a, id) : (address(0), NO_AGENT);
        uint256 len = bound(lenSeed, 0, ll.MAX_ENVELOPE_BYTES() + 1);
        bool live = kind == 0 ? ghostEpoch[a] != 0 : kind == 1 ? _agentLive(id) : false;
        bool shouldPass = kind < 2 && len >= 1 && len <= ll.MAX_ENVELOPE_BYTES() && live;
        (Slot[] memory addr0, Slot[] memory agent0) = _snap();

        try ll.drop(to, toAgent, new bytes(len)) {
            dropsOk++;
            if (!shouldPass) _violate("drop accepted a bad recipient, size, or a recipient without a live key");
        } catch {
            dropsRejected++;
            if (shouldPass) _violate("drop rejected a valid drop");
        }
        _checkFrame(addr0, agent0, NONE, NONE, "drop");
    }

    function warp(uint256 dt) external {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 30 days));
    }

    // ------------------------------------------------------------ views for the invariants

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function agentCount() external view returns (uint256) {
        return agentIds.length;
    }

    function agentAt(uint256 i) external view returns (uint256) {
        return agentIds[i];
    }

    // ------------------------------------------------------------ internals

    /// Keys 0..5 of the pool are valid, 6..10 are not.
    function _key(uint256 seed, bool validOnly) internal view returns (bytes32) {
        return validOnly ? keyPool[seed % 6] : keyPool[seed % keyPool.length];
    }

    function _agentLive(uint256 id) internal view returns (bool) {
        return ghostAgentEpoch[id] != 0 && registry.exists(id) && registry.ownerOf(id) == ghostAgentPublisher[id];
    }

    /// Epochs around the current one (cur - 1 .. cur + 2), saturating at the uint32 bounds.
    function _near(uint32 cur, uint32 seed) internal pure returns (uint32) {
        uint256 e = uint256(cur) + (seed % 4);
        if (e == 0) return 0;
        e -= 1;
        return e > type(uint32).max ? type(uint32).max : uint32(e);
    }

    function _snap() internal view returns (Slot[] memory addrSlots, Slot[] memory agentSlots) {
        addrSlots = new Slot[](actors.length);
        for (uint256 i = 0; i < actors.length; i++) {
            (bytes32 p, uint32 e, uint64 t) = ll.keyOf(actors[i]);
            addrSlots[i] = Slot(p, e, t, address(0));
        }
        agentSlots = new Slot[](agentIds.length);
        for (uint256 j = 0; j < agentIds.length; j++) {
            (bytes32 p, uint32 e, uint64 t, address who) = ll.agentKeyRecord(agentIds[j]);
            agentSlots[j] = Slot(p, e, t, who);
        }
    }

    function _same(Slot memory x, Slot memory y) internal pure returns (bool) {
        return x.pub == y.pub && x.epoch == y.epoch && x.at == y.at && x.publisher == y.publisher;
    }

    /// Frame condition: every slot other than `changedAddr` / `changedAgent` (NONE = no slot) is untouched.
    function _checkFrame(
        Slot[] memory addr0,
        Slot[] memory agent0,
        uint256 changedAddr,
        uint256 changedAgent,
        string memory where
    ) internal {
        (Slot[] memory addr1, Slot[] memory agent1) = _snap();
        for (uint256 i = 0; i < addr0.length; i++) {
            if (i != changedAddr && !_same(addr0[i], addr1[i])) {
                _violate(string.concat(where, ": changed an address key it had no right to write"));
            }
        }
        for (uint256 j = 0; j < agent0.length; j++) {
            if (j != changedAgent && !_same(agent0[j], agent1[j])) {
                _violate(string.concat(where, ": changed an agent key it had no right to write"));
            }
        }
    }

    function _violate(string memory why) internal {
        violations++;
        lastViolation = why;
    }
}

contract LetterlockInvariantTest is Test {
    Letterlock internal ll;
    MockIdentityRegistry internal registry;
    LetterlockHandler internal handler;

    function setUp() public {
        registry = new MockIdentityRegistry();
        ll = new Letterlock(address(registry));

        address[] memory actors = new address[](4);
        actors[0] = makeAddr("actor0");
        actors[1] = makeAddr("actor1");
        actors[2] = makeAddr("actor2");
        actors[3] = makeAddr("bystander"); // may be picked, never special-cased
        uint256[] memory agentIds = new uint256[](3);
        agentIds[0] = 0; // agent id 0 is a real id on Monad mainnet
        agentIds[1] = 1;
        agentIds[2] = 8004;
        for (uint256 i = 0; i < agentIds.length; i++) {
            registry.mint(actors[i], agentIds[i]);
        }

        handler = new LetterlockHandler(ll, registry, actors, agentIds);
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = LetterlockHandler.publish.selector;
        selectors[1] = LetterlockHandler.publishForAgent.selector;
        selectors[2] = LetterlockHandler.moveAgent.selector;
        selectors[3] = LetterlockHandler.drop.selector;
        selectors[4] = LetterlockHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Accept/reject decisions matched the model, epochs only rose, and no call wrote a slot it had no right to.
    function invariant_noFrameOrRuleViolations() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
    }

    /// Each slot holds exactly the last successful publish: epochs never move except by their owner's publish.
    function invariant_slotsMatchGhostModel() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actorAt(i);
            (bytes32 p, uint32 e,) = ll.keyOf(a);
            assertEq(e, handler.ghostEpoch(a), "address epoch");
            assertEq(p, handler.ghostPub(a), "address pub");
        }
        for (uint256 j = 0; j < handler.agentCount(); j++) {
            uint256 id = handler.agentAt(j);
            (bytes32 p, uint32 e,, address publisher) = ll.agentKeyRecord(id);
            assertEq(e, handler.ghostAgentEpoch(id), "agent epoch");
            assertEq(p, handler.ghostAgentPub(id), "agent pub");
            assertEq(publisher, handler.ghostAgentPublisher(id), "agent publisher");
        }
    }

    /// Every stored key is non-zero, canonical and not small-order; an empty slot is all zeros.
    function invariant_storedKeysAreValid() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            (bytes32 p, uint32 e, uint64 t) = ll.keyOf(handler.actorAt(i));
            if (e == 0) {
                assertEq(p, 0);
                assertEq(t, 0);
            } else {
                assertTrue(X25519Ref.verdict(p) == X25519Ref.Verdict.Valid, "invalid address key stored");
            }
        }
        for (uint256 j = 0; j < handler.agentCount(); j++) {
            (bytes32 p, uint32 e,,) = ll.agentKeyRecord(handler.agentAt(j));
            if (e == 0) assertEq(p, 0);
            else assertTrue(X25519Ref.verdict(p) == X25519Ref.Verdict.Valid, "invalid agent key stored");
        }
    }

    /// keyOfAgent resolves only while the key's publisher still owns the agent.
    function invariant_agentKeyResolvesOnlyForCurrentOwner() public view {
        for (uint256 j = 0; j < handler.agentCount(); j++) {
            uint256 id = handler.agentAt(j);
            (bytes32 p, uint32 e,) = ll.keyOfAgent(id);
            (,,, address publisher) = ll.agentKeyRecord(id);
            bool live = registry.exists(id) && registry.ownerOf(id) == publisher && publisher != address(0);
            if (live) assertEq(e, handler.ghostAgentEpoch(id));
            else assertEq(p, 0, "stale agent key resolved");
        }
    }

    function invariant_holdsNoFunds() public view {
        assertEq(address(ll).balance, 0);
    }

    /// Non-vacuity check for the handler: a fixed-seed random walk of 3,000 calls must hit BOTH outcomes of every
    /// action (so the campaign above can succeed and fail on each path) with zero violations.
    function test_handlerRandomWalkHitsEveryOutcome() public {
        uint256 seed = uint256(keccak256("letterlock-invariant-walk"));
        for (uint256 i = 0; i < 3000; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 r = seed;
            uint256 action = r % 5;
            if (action == 0) {
                handler.publish(r >> 8, r >> 16, uint32(r >> 24), (r >> 60) & 1 == 1, (r >> 61) & 1 == 1);
            } else if (action == 1) {
                handler.publishForAgent(
                    r >> 8,
                    r >> 16,
                    r >> 24,
                    uint32(r >> 32),
                    (r >> 60) & 1 == 1,
                    (r >> 61) & 1 == 1,
                    (r >> 62) & 1 == 1
                );
            } else if (action == 2) {
                handler.moveAgent(r >> 8, r >> 16);
            } else if (action == 3) {
                handler.drop(r >> 8, r >> 16, r >> 24, (r >> 32) % 20_000);
            } else {
                handler.warp(r >> 8);
            }
        }
        assertEq(handler.violations(), 0, handler.lastViolation());
        emit log_named_uint("publish accepted", handler.publishOk());
        emit log_named_uint("publish rejected", handler.publishRejected());
        emit log_named_uint("publishForAgent accepted", handler.agentPublishOk());
        emit log_named_uint("publishForAgent rejected", handler.agentPublishRejected());
        emit log_named_uint("drop accepted", handler.dropsOk());
        emit log_named_uint("drop rejected", handler.dropsRejected());
        assertGt(handler.publishOk(), 0);
        assertGt(handler.publishRejected(), 0);
        assertGt(handler.agentPublishOk(), 0);
        assertGt(handler.agentPublishRejected(), 0);
        assertGt(handler.dropsOk(), 0);
        assertGt(handler.dropsRejected(), 0);
    }
}
