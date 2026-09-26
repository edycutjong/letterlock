// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Letterlock, IERC721} from "../src/Letterlock.sol";
import {KeyOfAgentGasSweep} from "./utils/KeyOfAgentGasSweep.sol";

/// @notice The ERC-721 transfer the fork test uses to move a real agent (Letterlock itself never transfers).
interface IERC721Transfer {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @notice Monad MAINNET fork against the real ERC-8004 IdentityRegistry (no mock). Forks the latest block of
///         MONAD_MAINNET_RPC (default https://rpc.monad.xyz), deploys Letterlock on the fork, and reads ownerOf live.
///         If the RPC is unreachable every test here is SKIPPED with a message; nothing is faked.
/// @dev Agent 10259 was registered on mainnet in tx 0x0b11de186c6bf57d53300239086398712d17e01967844e701be72a287f7d8f77
///      (block 107945312: Transfer from 0x0 + Registered, read with `cast receipt`). Agent 0 exists too. Override the
///      agent with LETTERLOCK_FORK_AGENT_ID.
contract LetterlockMainnetForkTest is KeyOfAgentGasSweep {
    event KeyPublished(address indexed who, uint256 indexed agentId, bytes32 pub, uint32 epoch);
    event Dropped(address indexed to, uint256 indexed toAgent, bytes envelope);

    address internal constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint256 internal constant MONAD_MAINNET = 143;
    uint256 internal constant NO_AGENT = type(uint256).max;
    // The SDK's deriveKeyPair(prf = 0x000102..1f, epoch 1 / 2) from packages/letterlock.
    bytes32 internal constant SDK_E1 = 0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b;
    bytes32 internal constant SDK_E2 = 0x68698a4ee1fa5b9c6b9041b19bf0a69bee3d69e9d00bb6d5c7d01f8add2bce7e;

    bool internal forked;
    string internal forkError;
    Letterlock internal ll;
    IERC721 internal registry = IERC721(IDENTITY_REGISTRY);
    uint256 internal agentId;
    address internal owner;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC", string("https://rpc.monad.xyz"));
        agentId = vm.envOr("LETTERLOCK_FORK_AGENT_ID", uint256(10259));
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch (bytes memory err) {
            forkError = _reason(err);
            return;
        }
        // A reachable RPC that is not Monad mainnet is a misconfiguration, not an outage: fail, never skip.
        assertEq(block.chainid, MONAD_MAINNET, "MONAD_MAINNET_RPC must point at Monad mainnet (chain 143)");
        ll = new Letterlock(IDENTITY_REGISTRY);
        try registry.ownerOf(agentId) returns (address o) {
            owner = o;
        } catch {
            revert(
                string.concat("agent ", vm.toString(agentId), " has no owner on mainnet; set LETTERLOCK_FORK_AGENT_ID")
            );
        }
    }

    /// Cheatcode failures revert with an ABI-encoded (selector, string) payload; show the string.
    function _reason(bytes memory err) internal pure returns (string memory) {
        if (err.length < 68) return "createSelectFork failed";
        bytes memory payload = new bytes(err.length - 4);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = err[i + 4];
        }
        return abi.decode(payload, (string));
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true, string.concat("SKIPPED: Monad mainnet RPC unreachable (", forkError, ")"));
            return;
        }
        _;
    }

    function test_fork_registryIsTheLiveErc8004Registry() public onlyFork {
        assertGt(IDENTITY_REGISTRY.code.length, 0, "registry has code on mainnet");
        assertEq(address(ll.identityRegistry()), IDENTITY_REGISTRY);
        assertTrue(owner != address(0), "agent has a live owner");
        emit log_named_uint("fork block", block.number);
        emit log_named_uint("agent id", agentId);
        emit log_named_address("ownerOf(agent)", owner);
    }

    function test_fork_ownerPublishesForRealAgent() public onlyFork {
        vm.expectEmit(true, true, false, true, address(ll));
        emit KeyPublished(owner, agentId, SDK_E1, 1);
        vm.prank(owner);
        ll.publishForAgent(agentId, SDK_E1, 1);

        (bytes32 pub, uint32 epoch, uint64 at) = ll.keyOfAgent(agentId);
        assertEq(pub, SDK_E1);
        assertEq(epoch, 1);
        assertEq(at, uint64(vm.getBlockTimestamp()));
        (,,, address publisher) = ll.agentKeyRecord(agentId);
        assertEq(publisher, owner);

        vm.prank(owner);
        ll.publishForAgent(agentId, SDK_E2, 2); // rotation by the real owner
        (pub, epoch,) = ll.keyOfAgent(agentId);
        assertEq(pub, SDK_E2);
        assertEq(epoch, 2);
    }

    function test_fork_nonOwnerCannotPublishForRealAgent() public onlyFork {
        address stranger = makeAddr("stranger");
        assertTrue(stranger != owner);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, agentId, stranger));
        vm.prank(stranger);
        ll.publishForAgent(agentId, SDK_E1, 1);
        (bytes32 pub,,) = ll.keyOfAgent(agentId);
        assertEq(pub, 0);
    }

    function test_fork_ownerOfAnotherAgentCannotPublish() public onlyFork {
        address ownerOfZero = registry.ownerOf(0);
        if (ownerOfZero == owner) {
            vm.skip(true, "SKIPPED: agent 0 and the test agent have the same owner at this block");
            return;
        }
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, agentId, ownerOfZero));
        vm.prank(ownerOfZero);
        ll.publishForAgent(agentId, SDK_E1, 1);
    }

    function test_fork_unregisteredAgentIdReverts() public onlyFork {
        uint256 unregistered = 1 << 200;
        // The live registry reverts ERC721NonexistentToken(id), the one failure Letterlock reads as "no owner" ...
        vm.expectRevert(abi.encodeWithSelector(IERC721.ERC721NonexistentToken.selector, unregistered));
        registry.ownerOf(unregistered);
        // ... so Letterlock reports NotAgentOwner, not RegistryCallFailed.
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, unregistered, owner));
        vm.prank(owner);
        ll.publishForAgent(unregistered, SDK_E1, 1);
    }

    function test_fork_agentZeroIsRealSoAddressKeysUseNoAgent() public onlyFork {
        address ownerOfZero = registry.ownerOf(0);
        vm.expectEmit(true, true, false, true, address(ll));
        emit KeyPublished(ownerOfZero, 0, SDK_E1, 1);
        vm.prank(ownerOfZero);
        ll.publishForAgent(0, SDK_E1, 1);

        vm.expectEmit(true, true, false, true, address(ll));
        emit KeyPublished(ownerOfZero, NO_AGENT, SDK_E2, 1);
        vm.prank(ownerOfZero);
        ll.publish(SDK_E2, 1);
    }

    /// Regression, audit A finding 1, against the live registry: the owner of a real agent cannot use up its epochs and
    /// then sell it. When any higher epoch was accepted, a publish at 2^32 - 1 followed by the registry's own
    /// transferFrom left the buyer reverting EpochNotIncreasing(4294967295, 1) forever.
    function test_fork_sellerCannotBrickBuyerThroughRealTransfer() public onlyFork {
        address buyer = makeAddr("buyer");
        vm.expectRevert(abi.encodeWithSelector(Letterlock.EpochNotNext.selector, uint32(0), type(uint32).max));
        vm.prank(owner);
        ll.publishForAgent(agentId, SDK_E1, type(uint32).max);
        vm.prank(owner);
        ll.publishForAgent(agentId, SDK_E1, 1);

        vm.prank(owner);
        IERC721Transfer(IDENTITY_REGISTRY).transferFrom(owner, buyer, agentId);
        assertEq(registry.ownerOf(agentId), buyer, "the live registry moved the agent");
        (bytes32 pub, uint32 epoch,) = ll.keyOfAgent(agentId);
        assertEq(pub, 0, "the seller's key no longer resolves");

        vm.prank(buyer);
        ll.publishForAgent(agentId, SDK_E2, 2);
        (pub, epoch,) = ll.keyOfAgent(agentId);
        assertEq(pub, SDK_E2);
        assertEq(epoch, 2);
        bytes memory envelope = bytes("{}");
        vm.expectEmit(true, true, false, true, address(ll));
        emit Dropped(address(0), agentId, envelope);
        ll.drop(address(0), agentId, envelope);
    }

    function test_fork_dropToRealAgent() public onlyFork {
        bytes memory envelope =
            bytes(string.concat('{"v":1,"chainId":143,"recipient":"agent:', vm.toString(agentId), '"}'));
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NoKeyPublished.selector, address(0), agentId));
        ll.drop(address(0), agentId, envelope);

        vm.prank(owner);
        ll.publishForAgent(agentId, SDK_E1, 1);
        vm.expectEmit(true, true, false, true, address(ll));
        emit Dropped(address(0), agentId, envelope);
        ll.drop(address(0), agentId, envelope);
    }

    /// Regression, against the live registry: a contract reads keyOfAgent for the real agent with every gas budget
    /// from 5,000 to 80,000 (step 20), each read cold in its own transaction. Every budget must return the live key
    /// or revert; none may return zeros. Run against the previous source (commit d15fe63, which read any ownerOf
    /// failure as "no owner"; only the two error declarations this file names, RegistryCallFailed and
    /// IERC721.ERC721NonexistentToken, added so it compiles), this test fails at block 108228931: 527 budgets, 35,920
    /// to 46,440 gas, returned zeros for the live key.
    function test_fork_gasStarvedReaderNeverReadsZeros() public onlyFork {
        vm.prank(owner);
        ll.publishForAgent(agentId, SDK_E1, 1);
        Sweep memory s = _sweepKeyOfAgent(ll, agentId, 5_000, 80_000, 20);
        emit log_named_uint("fork block", block.number);
        _logSweep(s);
        _assertNoBudgetReadsZeros(s);
    }
}
