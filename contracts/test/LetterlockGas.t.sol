// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Letterlock} from "../src/Letterlock.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @notice Per-function gas, one call each, recorded with vm.snapshotGasLastCall into snapshots/Letterlock.json.
///         Execution gas of the call only (no 21,000 intrinsic cost, no calldata cost), under Foundry's Monad
///         execution environment (network = "monad"). Storage is cooled (vm.cool) before each measured call so it
///         is priced like the first access in a fresh transaction. Agent-path numbers use the test-double
///         registry; the live ERC-8004 registry is a proxy and costs more (see the fork test).
contract LetterlockGasTest is Test {
    uint256 internal constant NO_AGENT = type(uint256).max;
    bytes32 internal constant SDK_E1 = 0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b;
    bytes32 internal constant SDK_E2 = 0x68698a4ee1fa5b9c6b9041b19bf0a69bee3d69e9d00bb6d5c7d01f8add2bce7e;
    uint256 internal constant AGENT = 10259;

    MockIdentityRegistry internal registry;
    Letterlock internal ll;
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");

    function setUp() public {
        registry = new MockIdentityRegistry();
        ll = new Letterlock(address(registry));
        registry.mint(carol, AGENT);
    }

    function _cool() internal {
        vm.cool(address(ll));
        vm.cool(address(registry));
    }

    function _envelope(uint256 len) internal pure returns (bytes memory env) {
        env = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            env[i] = 0x61;
        }
    }

    function test_gas_publish_firstKey() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.snapshotGasLastCall("Letterlock", "publish_firstKey");
    }

    function test_gas_publish_rotate() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _cool();
        vm.prank(alice);
        ll.publish(SDK_E2, 2);
        vm.snapshotGasLastCall("Letterlock", "publish_rotate");
    }

    function test_gas_publishForAgent_firstKey() public {
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E1, 1);
        vm.snapshotGasLastCall("Letterlock", "publishForAgent_firstKey_mockRegistry");
    }

    function test_gas_keyOf() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _cool();
        ll.keyOf(alice);
        vm.snapshotGasLastCall("Letterlock", "keyOf");
    }

    function test_gas_keyOfAgent() public {
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E1, 1);
        _cool();
        ll.keyOfAgent(AGENT);
        vm.snapshotGasLastCall("Letterlock", "keyOfAgent_mockRegistry");
    }

    function test_gas_drop_toAddress_1KiB() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        bytes memory env = _envelope(1024);
        _cool();
        ll.drop(alice, NO_AGENT, env);
        vm.snapshotGasLastCall("Letterlock", "drop_toAddress_1KiB");
    }

    function test_gas_drop_toAgent_1KiB() public {
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E1, 1);
        bytes memory env = _envelope(1024);
        _cool();
        ll.drop(address(0), AGENT, env);
        vm.snapshotGasLastCall("Letterlock", "drop_toAgent_1KiB_mockRegistry");
    }

    function test_gas_drop_toAddress_16KiB() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        bytes memory env = _envelope(16 * 1024);
        _cool();
        ll.drop(alice, NO_AGENT, env);
        vm.snapshotGasLastCall("Letterlock", "drop_toAddress_16KiB");
    }
}
