// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Selects the Monad mainnet fork for test/LetterlockFork.t.sol. By default an unreachable RPC makes the fork
///         tests skip, so an RPC outage does not fail CI. With LETTERLOCK_REQUIRE_FORK=true, which the mainnet deploy
///         pre-flight sets, it fails them instead: a pre-deploy run can never pass without reading the live registry.
abstract contract MainnetFork is Test {
    string internal constant FORK_REQUIRED_PREFIX =
        "LETTERLOCK_REQUIRE_FORK is set and the Monad mainnet fork failed: ";

    /// True when LETTERLOCK_REQUIRE_FORK=true. Any other value than true or false fails the run (vm.envOr).
    function _forkRequired() internal view returns (bool) {
        return vm.envOr("LETTERLOCK_REQUIRE_FORK", false);
    }

    /// Forks `rpc` and selects it. If that fails: reverts when `required`, else returns (false, the RPC error).
    function _selectFork(string memory rpc, bool required) internal returns (bool forked, string memory error) {
        try vm.createSelectFork(rpc) {
            return (true, "");
        } catch (bytes memory err) {
            error = _reason(err);
            if (required) revert(string.concat(FORK_REQUIRED_PREFIX, error));
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
}
