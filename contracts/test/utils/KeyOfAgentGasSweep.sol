// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Letterlock} from "../../src/Letterlock.sol";

/// @notice Reads `keyOfAgent` with a fixed gas budget, as another contract does inside its own transaction.
/// @dev `read` writes a counter, so it is not a view and a test calls it with CALL: with `isolate = true`
///      (foundry.toml) each call then runs as its own transaction, and every read starts with cold state.
contract GasBudgetReader {
    uint256 public reads;

    function read(Letterlock ll, uint256 agentId, uint256 budget) external returns (bool ok, bytes memory ret) {
        reads++;
        (ok, ret) = address(ll).staticcall{gas: budget}(abi.encodeCall(Letterlock.keyOfAgent, (agentId)));
    }
}

/// @notice Sweeps `keyOfAgent` over a range of gas budgets, one cold read per budget, and counts each outcome. A
///         gas-starved read must revert; it must never return zeros (or anything else) for a live key.
abstract contract KeyOfAgentGasSweep is Test {
    struct Sweep {
        uint256 budgets;
        uint256 resolved; // returned exactly the live key
        uint256 registryCallFailed; // reverted RegistryCallFailed(agentId): the registry call itself ran out of gas
        uint256 outOfGas; // reverted with no data: the budget ran out in Letterlock's own code
        uint256 zeros; // returned zeros for the live key: must stay 0
        uint256 other; // returned any other value, or reverted with any other data: must stay 0
        uint256 firstResolved; // smallest budget that returned the key
        uint256 lastRegistryCallFailed; // largest budget that reverted RegistryCallFailed
        uint256 firstZeros; // smallest budget that returned zeros (0 when none did)
        uint256 lastZeros; // largest budget that returned zeros (0 when none did)
        uint256 failedAboveFirstResolved; // budgets above firstResolved that did not return the key: must stay 0
    }

    enum Outcome {
        Resolved,
        RegistryCallFailed,
        OutOfGas,
        Zeros,
        Other
    }

    function _sweepKeyOfAgent(Letterlock ll, uint256 agentId, uint256 fromGas, uint256 toGas, uint256 step)
        internal
        returns (Sweep memory s)
    {
        assertTrue(vm.isIsolateMode(), "the sweep needs isolate = true (foundry.toml) for a cold read per budget");
        bytes32 live = _liveKeyHash(ll, agentId);
        bytes32 failed = keccak256(abi.encodeWithSelector(Letterlock.RegistryCallFailed.selector, agentId));
        GasBudgetReader reader = new GasBudgetReader();
        for (uint256 budget = fromGas; budget <= toGas; budget += step) {
            (bool ok, bytes memory ret) = reader.read(ll, agentId, budget);
            _count(s, _outcome(ok, ret, live, failed), budget);
        }
        assertEq(reader.reads(), s.budgets, "one read per budget");
    }

    /// keccak256 of keyOfAgent's return data for a key that resolves.
    function _liveKeyHash(Letterlock ll, uint256 agentId) private view returns (bytes32) {
        (bytes32 pub, uint32 epoch, uint64 at) = ll.keyOfAgent(agentId);
        assertTrue(pub != 0, "the sweep needs an agent key that resolves");
        return keccak256(abi.encode(pub, epoch, at));
    }

    function _outcome(bool ok, bytes memory ret, bytes32 live, bytes32 failed) private pure returns (Outcome) {
        bytes32 h = keccak256(ret);
        if (ok && h == live) return Outcome.Resolved;
        if (ok && h == keccak256(abi.encode(bytes32(0), uint32(0), uint64(0)))) return Outcome.Zeros;
        if (!ok && h == failed) return Outcome.RegistryCallFailed;
        if (!ok && ret.length == 0) return Outcome.OutOfGas;
        return Outcome.Other;
    }

    function _count(Sweep memory s, Outcome o, uint256 budget) private pure {
        s.budgets++;
        if (o == Outcome.Resolved) {
            s.resolved++;
            if (s.firstResolved == 0) s.firstResolved = budget;
            return;
        }
        if (s.firstResolved != 0) s.failedAboveFirstResolved++;
        if (o == Outcome.Zeros) {
            s.zeros++;
            if (s.firstZeros == 0) s.firstZeros = budget;
            s.lastZeros = budget;
        } else if (o == Outcome.RegistryCallFailed) {
            s.registryCallFailed++;
            s.lastRegistryCallFailed = budget;
        } else if (o == Outcome.OutOfGas) {
            s.outOfGas++;
        } else {
            s.other++;
        }
    }

    /// Every budget returns the live key or reverts, and none returns zeros. The sweep must also reach budgets where
    /// the registry call itself runs out of gas with gas left over (the case the previous rule read as "no owner"),
    /// and budgets where the read reverts with no data, the other revert a starved read gives (a caller must read
    /// both as "unknown"). A larger budget must never fail where a smaller one returned the key.
    function _assertNoBudgetReadsZeros(Sweep memory s) internal pure {
        assertEq(s.zeros, 0, "a gas-starved read returned zeros for a live key");
        assertEq(s.other, 0, "a read returned or reverted with something unexpected");
        assertGt(s.registryCallFailed, 0, "no budget starved the registry call itself, so the sweep proves nothing");
        assertGt(s.outOfGas, 0, "no budget reverted with no data, so the sweep does not cover that revert");
        assertGt(s.resolved, 0, "no budget was enough to read the key");
        assertEq(s.failedAboveFirstResolved, 0, "a larger budget failed where a smaller one returned the key");
        assertEq(s.budgets, s.resolved + s.registryCallFailed + s.outOfGas, "every budget is accounted for");
    }

    function _logSweep(Sweep memory s) internal {
        emit log_named_uint("budgets", s.budgets);
        emit log_named_uint("returned the key", s.resolved);
        emit log_named_uint("reverted RegistryCallFailed", s.registryCallFailed);
        emit log_named_uint("ran out of gas in Letterlock", s.outOfGas);
        emit log_named_uint("returned zeros", s.zeros);
        if (s.zeros != 0) {
            emit log_named_uint("smallest budget that returned zeros", s.firstZeros);
            emit log_named_uint("largest budget that returned zeros", s.lastZeros);
        }
        emit log_named_uint("anything else", s.other);
        emit log_named_uint("smallest budget that returned the key", s.firstResolved);
        emit log_named_uint("largest budget that reverted RegistryCallFailed", s.lastRegistryCallFailed);
    }
}
