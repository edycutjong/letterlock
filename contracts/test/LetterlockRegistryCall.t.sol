// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Letterlock} from "../src/Letterlock.sol";
import {FaultyIdentityRegistry} from "./mocks/FaultyIdentityRegistry.sol";
import {IdentityRegistryProxy} from "./mocks/IdentityRegistryProxy.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {KeyOfAgentGasSweep} from "./utils/KeyOfAgentGasSweep.sol";

/// @notice The registry-call rule, with test doubles: only the registry's `ERC721NonexistentToken` revert means "no
///         owner". Every other failure of `ownerOf`, running out of gas included, reverts `RegistryCallFailed` on all
///         three agent paths (`keyOfAgent`, `publishForAgent`, `drop`), or reverts with no data when too little gas
///         is left for that revert, so no failure ever reads as "no key". The live ERC-8004 registry is exercised in
///         LetterlockFork.t.sol.
contract LetterlockRegistryCallTest is KeyOfAgentGasSweep {
    uint256 internal constant AGENT = 10259;
    bytes32 internal constant SDK_E1 = 0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b;
    bytes32 internal constant SDK_E2 = 0x68698a4ee1fa5b9c6b9041b19bf0a69bee3d69e9d00bb6d5c7d01f8add2bce7e;
    bytes internal constant ENVELOPE = bytes('{"v":1,"chainId":143,"recipient":"agent:10259"}');
    /// Gas for each call under test, so the OutOfGas fault burns 63/64 of this and not of the whole test's gas.
    uint256 internal constant CALL_GAS = 1_000_000;

    FaultyIdentityRegistry internal registry;
    Letterlock internal ll;
    address internal carol = makeAddr("carol");

    function setUp() public {
        registry = new FaultyIdentityRegistry();
        ll = new Letterlock(address(registry));
        registry.mint(carol, AGENT);
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E1, 1);
    }

    /// With `fault` set, all three agent paths revert RegistryCallFailed(AGENT); the stored record stays readable and
    /// resolves again once the registry answers.
    function _expectRegistryCallFailed(FaultyIdentityRegistry.Fault fault) internal {
        registry.setFault(fault);
        bytes memory err = abi.encodeWithSelector(Letterlock.RegistryCallFailed.selector, AGENT);

        vm.expectRevert(err);
        ll.keyOfAgent{gas: CALL_GAS}(AGENT);

        vm.expectRevert(err);
        vm.prank(carol);
        ll.publishForAgent{gas: CALL_GAS}(AGENT, SDK_E2, 2);

        vm.expectRevert(err);
        ll.drop{gas: CALL_GAS}(address(0), AGENT, ENVELOPE);

        (bytes32 pub, uint32 epoch,, address publisher) = ll.agentKeyRecord(AGENT); // never calls the registry
        assertEq(pub, SDK_E1);
        assertEq(epoch, 1);
        assertEq(publisher, carol);

        registry.setFault(FaultyIdentityRegistry.Fault.None);
        (pub, epoch,) = ll.keyOfAgent(AGENT);
        assertEq(pub, SDK_E1);
        assertEq(epoch, 1);
    }

    function test_registryCall_revertWithoutDataFails() public {
        _expectRegistryCallFailed(FaultyIdentityRegistry.Fault.EmptyRevert);
    }

    function test_registryCall_outOfGasFails() public {
        _expectRegistryCallFailed(FaultyIdentityRegistry.Fault.OutOfGas);
    }

    /// The registry call runs out of gas, and the 1/64 of the gas kept back from it cannot pay for the
    /// RegistryCallFailed revert: the read then reverts with no data. So RegistryCallFailed is not the only revert a
    /// starved read can give, and a caller must read any revert as "unknown", never as "no key". With enough gas the
    /// same fault reverts RegistryCallFailed (test_registryCall_outOfGasFails).
    function test_registryCall_outOfGasWithTooLittleLeftRevertsWithoutData() public {
        registry.setFault(FaultyIdentityRegistry.Fault.OutOfGas);
        bytes memory read = abi.encodeCall(Letterlock.keyOfAgent, (AGENT));

        // Two reads below, each with one ownerOf call at most: 2 calls means both reached the registry.
        vm.expectCall(address(registry), abi.encodeCall(FaultyIdentityRegistry.ownerOf, (AGENT)), 2);
        (bool ok, bytes memory ret) = address(ll).staticcall{gas: 20_000}(read);
        assertFalse(ok, "a starved read must revert");
        assertEq(ret.length, 0, "a read that runs out of gas in Letterlock itself reverts with no data");

        (ok, ret) = address(ll).staticcall{gas: CALL_GAS}(read);
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(Letterlock.RegistryCallFailed.selector, AGENT));
    }

    function test_registryCall_errorStringFails() public {
        _expectRegistryCallFailed(FaultyIdentityRegistry.Fault.ErrorString);
    }

    function test_registryCall_otherCustomErrorFails() public {
        _expectRegistryCallFailed(FaultyIdentityRegistry.Fault.OtherCustomError);
    }

    function test_registryCall_panicFails() public {
        _expectRegistryCallFailed(FaultyIdentityRegistry.Fault.Panic);
    }

    /// Three bytes of the right selector are not the error: fewer than 4 bytes never match.
    function test_registryCall_selectorPrefixFails() public {
        _expectRegistryCallFailed(FaultyIdentityRegistry.Fault.SelectorPrefix);
    }

    /// An answer that does not decode as an address reverts in Letterlock too (the decoding runs outside the catch),
    /// with no data: never zeros.
    function test_registryCall_malformedAnswerReverts() public {
        registry.setFault(FaultyIdentityRegistry.Fault.MalformedAnswer);
        (bool ok, bytes memory ret) =
            address(ll).staticcall{gas: CALL_GAS}(abi.encodeCall(Letterlock.keyOfAgent, (AGENT)));
        assertFalse(ok, "a malformed registry answer must revert");
        assertEq(ret.length, 0);
    }

    /// The one failure that reads as "no owner": after a burn the registry reverts ERC721NonexistentToken, so the key
    /// stops resolving (zeros, NoKeyPublished) and nobody can publish for the agent (NotAgentOwner).
    function test_registryCall_nonexistentTokenMeansNoOwner() public {
        registry.burn(AGENT);
        (bytes32 pub, uint32 epoch, uint64 at) = ll.keyOfAgent(AGENT);
        assertEq(pub, 0);
        assertEq(epoch, 0);
        assertEq(at, 0);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NoKeyPublished.selector, address(0), AGENT));
        ll.drop(address(0), AGENT, ENVELOPE);
        vm.expectRevert(abi.encodeWithSelector(Letterlock.NotAgentOwner.selector, AGENT, carol));
        vm.prank(carol);
        ll.publishForAgent(AGENT, SDK_E2, 2);
    }

    /// Regression, offline: a contract reads keyOfAgent with every gas budget from 5,000 to 80,000 (step 20), each
    /// read cold in its own transaction, through a proxy registry like the live one. No budget may return zeros. Run
    /// against the previous source (commit d15fe63, which read any ownerOf failure as "no owner"), this test fails:
    /// 512 budgets, 35,920 to 46,140 gas, returned zeros. script/mutate.mjs keeps that rule as a mutant.
    function test_gasStarvedReaderNeverReadsZeros_proxyRegistry() public {
        MockIdentityRegistry proxied =
            MockIdentityRegistry(address(new IdentityRegistryProxy(address(new MockIdentityRegistry()))));
        Letterlock directory = new Letterlock(address(proxied));
        proxied.mint(carol, AGENT);
        assertEq(proxied.ownerOf(AGENT), carol, "the proxy forwards to the registry implementation");
        vm.prank(carol);
        directory.publishForAgent(AGENT, SDK_E1, 1);

        Sweep memory s = _sweepKeyOfAgent(directory, AGENT, 5_000, 80_000, 20);
        _logSweep(s);
        _assertNoBudgetReadsZeros(s);
    }
}
