// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Letterlock} from "../src/Letterlock.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @notice The deploy script's registry choice per chain (local EVM; mainnet deploys follow DeployMainnet.md).
contract DeployScriptTest is Test {
    Deploy internal script;

    function setUp() public {
        script = new Deploy();
    }

    function test_defaultRegistry_mainnetIsErc8004_elseDisabled() public view {
        assertEq(script.defaultRegistry(143), 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
        assertEq(script.defaultRegistry(10143), address(0));
        assertEq(script.defaultRegistry(31337), address(0));
    }

    function test_testnetDeployDisablesAgentPath() public {
        vm.chainId(10143);
        Letterlock d = script.run();
        assertEq(address(d.identityRegistry()), address(0));
        vm.expectRevert(Letterlock.AgentPathDisabled.selector);
        d.publishForAgent(1, 0x7295e063d18fc5bd7f377d79a043ae5580f78f4be6d8586ea9df9d82e6604b5b, 1);
    }

    function test_explicitRegistryIsUsed() public {
        MockIdentityRegistry reg = new MockIdentityRegistry();
        Letterlock d = script.deploy(address(reg));
        assertEq(address(d.identityRegistry()), address(reg));
    }

    function test_registryWithoutCodeIsRefused() public {
        vm.expectRevert("Deploy: IDENTITY_REGISTRY has no code on this chain");
        script.deploy(address(0xBEEF));
    }

    function test_mainnetDefaultsToErc8004Registry() public {
        // Local stand-in: put registry code at the mainnet address, as it exists on chain 143.
        address ir = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
        vm.etch(ir, address(new MockIdentityRegistry()).code);
        vm.chainId(143);
        Letterlock d = script.run();
        assertEq(address(d.identityRegistry()), ir);
    }

    function test_mainnetRefusesAnyOtherRegistry() public {
        vm.chainId(143);
        vm.expectRevert("Deploy: Monad mainnet needs the ERC-8004 IdentityRegistry");
        script.deploy(address(0));
    }
}
