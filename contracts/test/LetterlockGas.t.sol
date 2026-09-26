// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Letterlock} from "../src/Letterlock.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @notice Gas per call under Foundry's Monad execution environment (network = "monad", isolate = true), recorded in
///         snapshots/Letterlock.json and checked with
///         `forge test --match-path test/LetterlockGas.t.sol --gas-snapshot-check true`.
///
///         `<call>_tx`: a write call runs isolated, as its own transaction with cold storage, so the number is the
///         whole transaction: 21,000 + calldata + execution, where EIP-7623 charges calldata and execution together
///         as max(4 × tokens + execution, 10 × tokens) (a zero byte is 1 token, any other byte 4). A receipt shows
///         this number; Monad charges the gas limit, so a sender sets at least this much.
///         `<call>_execution`: that transaction's execution gas, derived as tx − 21,000 − 4 × tokens. It is exact only
///         above the 10-per-token floor, and a drop of a JSON envelope (every byte non-zero) pays exactly the floor, so
///         drop execution is measured on a zero-filled envelope of the same length: drop reads the length, never the
///         bytes. Each drop benchmark asserts that both measurements fit the EIP-7623 formula.
///         `keyOf_execution` / `keyOfAgent_…_execution`: a view is a static call, which Foundry does not isolate. The
///         number is the call's own execution with Letterlock's storage cold (the test context's first read of it).
///
///         vm.cool is not used: under network = "monad" it did not make Letterlock's storage cold again (a second
///         keyOf cost 756 gas after vm.cool; the first cost 8,756). Agent-path numbers use the test-double registry;
///         the live ERC-8004 registry is a proxy and costs more (see the fork test).
contract LetterlockGasTest is Test {
    string internal constant GROUP = "Letterlock";
    uint256 internal constant TX_BASE = 21_000;
    uint256 internal constant STANDARD_PER_TOKEN = 4; // EIP-7623 STANDARD_TOKEN_COST
    uint256 internal constant FLOOR_PER_TOKEN = 10; // EIP-7623 TOTAL_COST_FLOOR_PER_TOKEN

    uint256 internal constant NO_AGENT = type(uint256).max;
    bytes32 internal constant SDK_E1 = 0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b;
    bytes32 internal constant SDK_E2 = 0x68698a4ee1fa5b9c6b9041b19bf0a69bee3d69e9d00bb6d5c7d01f8add2bce7e;
    uint256 internal constant AGENT = 10259;

    MockIdentityRegistry internal registry;
    Letterlock internal ll;
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");

    function setUp() public {
        // Without isolation a write shares the test's transaction: no 21,000, no calldata, storage already warm.
        assertTrue(vm.isIsolateMode(), "gas benchmarks need isolate = true (foundry.toml)");
        registry = new MockIdentityRegistry();
        ll = new Letterlock(address(registry));
        registry.mint(carol, AGENT);
    }

    // ---------------------------------------------------------------- helpers

    /// EIP-7623 calldata tokens: a zero byte is 1 token, any other byte 4.
    function _tokens(bytes memory data) internal pure returns (uint256 t) {
        for (uint256 i = 0; i < data.length; i++) {
            t += data[i] == 0 ? 1 : 4;
        }
    }

    function _envelope(uint256 len, bytes1 fill) internal pure returns (bytes memory env) {
        env = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            env[i] = fill;
        }
    }

    /// Records the last (isolated) call as `<name>_tx`; every transaction pays at least the calldata floor.
    function _recordTx(string memory name, bytes memory callData) internal returns (uint256 txGas, uint256 tokens) {
        txGas = vm.snapshotGasLastFrame(GROUP, string.concat(name, "_tx"));
        tokens = _tokens(callData);
        assertGe(txGas, TX_BASE + FLOOR_PER_TOKEN * tokens, "below the EIP-7623 floor: not a whole transaction");
    }

    /// Records `<name>_execution` = tx − 21,000 − 4 × tokens, which is exact only above the floor.
    function _recordExecution(string memory name, uint256 txGas, uint256 tokens) internal returns (uint256 execGas) {
        assertGt(txGas, TX_BASE + FLOOR_PER_TOKEN * tokens, "at the floor, execution is hidden");
        execGas = txGas - TX_BASE - STANDARD_PER_TOKEN * tokens;
        vm.snapshotValue(GROUP, string.concat(name, "_execution"), execGas);
    }

    function _recordWrite(string memory name, bytes memory callData) internal {
        (uint256 txGas, uint256 tokens) = _recordTx(name, callData);
        _recordExecution(name, txGas, tokens);
    }

    /// A drop of `len` bytes of 'a' (non-zero, like a UTF-8 JSON envelope), then of `len` zero bytes, each its own
    /// transaction. The second gives the execution of both; the first must then equal the EIP-7623 formula.
    function _recordDrop(string memory name, address to, uint256 toAgent, uint256 len) internal {
        bytes memory env = _envelope(len, 0x61);
        ll.drop(to, toAgent, env);
        (uint256 txGas, uint256 tokens) = _recordTx(name, abi.encodeCall(Letterlock.drop, (to, toAgent, env)));

        bytes memory zeros = new bytes(len);
        ll.drop(to, toAgent, zeros);
        uint256 zeroTokens = _tokens(abi.encodeCall(Letterlock.drop, (to, toAgent, zeros)));
        uint256 execGas = _recordExecution(name, vm.lastFrameGas().gasTotalUsed, zeroTokens);

        uint256 standard = TX_BASE + STANDARD_PER_TOKEN * tokens + execGas;
        uint256 floor = TX_BASE + FLOOR_PER_TOKEN * tokens;
        assertEq(txGas, standard > floor ? standard : floor, "tx != 21,000 + max(4 x tokens + execution, 10 x tokens)");
    }

    // ---------------------------------------------------------------- writes: whole transactions

    function test_gas_publish_firstKey() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _recordWrite("publish_firstKey", abi.encodeCall(Letterlock.publish, (SDK_E1, 1)));
    }

    function test_gas_publish_rotate() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        vm.prank(alice);
        ll.publish(SDK_E2, 2);
        _recordWrite("publish_rotate", abi.encodeCall(Letterlock.publish, (SDK_E2, 2)));
    }

    function test_gas_publishForAgent_firstKey() public {
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E1, 1);
        _recordWrite(
            "publishForAgent_firstKey_mockRegistry", abi.encodeCall(Letterlock.publishForAgent, (AGENT, SDK_E1, 1))
        );
    }

    function test_gas_drop_toAddress_1KiB() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _recordDrop("drop_toAddress_1KiB", alice, NO_AGENT, 1024);
    }

    function test_gas_drop_toAgent_1KiB() public {
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E1, 1);
        _recordDrop("drop_toAgent_1KiB_mockRegistry", address(0), AGENT, 1024);
    }

    function test_gas_drop_toAddress_16KiB() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        _recordDrop("drop_toAddress_16KiB", alice, NO_AGENT, 16 * 1024);
    }

    // ---------------------------------------------------------------- views: execution of a static call

    function test_gas_keyOf() public {
        vm.prank(alice);
        ll.publish(SDK_E1, 1);
        ll.keyOf(alice);
        uint256 cold = vm.snapshotGasLastFrame(GROUP, "keyOf_execution");
        ll.keyOf(alice);
        // The recorded read paid Monad's cold storage-page cost (8,100 against 100 warm) and the repeat did not, so
        // the view ran in the test's own context, not as an isolated transaction.
        assertEq(cold - vm.lastFrameGas().gasTotalUsed, 8_000, "the recorded keyOf was not a cold read");
    }

    function test_gas_keyOfAgent() public {
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E1, 1);
        ll.keyOfAgent(AGENT);
        uint256 cold = vm.snapshotGasLastFrame(GROUP, "keyOfAgent_mockRegistry_execution");
        ll.keyOfAgent(AGENT);
        // As above, for two storage pages: Letterlock's and the registry's.
        assertEq(cold - vm.lastFrameGas().gasTotalUsed, 16_000, "the recorded keyOfAgent was not a cold read");
    }
}
