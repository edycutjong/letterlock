// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MainnetFork} from "./utils/MainnetFork.sol";

/// @notice The switch between skipping and failing the mainnet fork tests (test/utils/MainnetFork.sol), checked
///         offline against an RPC that refuses connections. The URL is passed in, never set with vm.setEnv, because
///         the environment is shared with the fork tests running in parallel.
contract MainnetForkGateTest is MainnetFork {
    /// Port 9 (discard): nothing listens on it, so the connection is refused at once.
    string internal constant UNREACHABLE_RPC = "http://127.0.0.1:9";

    function selectFork(string memory rpc, bool required) external returns (bool, string memory) {
        return _selectFork(rpc, required);
    }

    function strictFlag(string memory name) external view returns (bool) {
        return _strictFlag(name);
    }

    /// Regression: with the RPC unreachable, all 9 mainnet fork tests skipped and `forge test` exited 0, so the
    /// mainnet deploy pre-flight passed without reading the live registry. Required, the failure is a revert, which
    /// fails the fork suite's setUp.
    function test_requiredForkFailsWhenTheRpcIsUnreachable() public {
        try this.selectFork(UNREACHABLE_RPC, true) returns (bool, string memory) {
            fail("a required fork to an unreachable RPC must revert");
        } catch Error(string memory reason) {
            bytes memory prefix = bytes(FORK_REQUIRED_PREFIX);
            assertGt(bytes(reason).length, prefix.length, "the revert carries the RPC error");
            bytes memory head = new bytes(prefix.length);
            for (uint256 i = 0; i < prefix.length; i++) {
                head[i] = bytes(reason)[i];
            }
            assertEq(string(head), FORK_REQUIRED_PREFIX, reason);
        }
    }

    /// Regression: the flag was read with vm.envOr(name, false), which returns false for a value it cannot parse, so
    /// LETTERLOCK_REQUIRE_FORK=yes (or ture, or on) skipped all 9 fork tests with exit 0. Each case uses its own
    /// variable name, never LETTERLOCK_REQUIRE_FORK itself, so vm.setEnv cannot reach the fork tests running in parallel.
    function test_forkFlagParsesStrictlyAndFailsClosed() public {
        assertFalse(this.strictFlag("LETTERLOCK_GATE_TEST_UNSET"), "unset: not required");

        string[4] memory yes = ["true", "TRUE", "1", "True"];
        for (uint256 i = 0; i < yes.length; i++) {
            string memory name = string.concat("LETTERLOCK_GATE_TEST_TRUE_", vm.toString(i));
            vm.setEnv(name, yes[i]);
            assertTrue(this.strictFlag(name), yes[i]);
        }
        string[3] memory no = ["false", "FALSE", "0"];
        for (uint256 i = 0; i < no.length; i++) {
            string memory name = string.concat("LETTERLOCK_GATE_TEST_FALSE_", vm.toString(i));
            vm.setEnv(name, no[i]);
            assertFalse(this.strictFlag(name), no[i]);
        }
        string[4] memory bad = ["yes", "ture", "on", " "];
        for (uint256 i = 0; i < bad.length; i++) {
            string memory name = string.concat("LETTERLOCK_GATE_TEST_BAD_", vm.toString(i));
            vm.setEnv(name, bad[i]);
            try this.strictFlag(name) returns (bool value) {
                fail(string.concat("an unparseable flag must revert, not read as ", vm.toString(value), ": ", bad[i]));
            } catch {}
        }
    }

    /// Not required (CI and local runs): the same failure returns false with the RPC error, and the fork tests skip.
    function test_optionalForkReturnsTheRpcErrorWhenUnreachable() public {
        (bool forked, string memory error) = this.selectFork(UNREACHABLE_RPC, false);
        assertFalse(forked);
        assertGt(bytes(error).length, 0, "the skip message names the RPC error");
    }
}
