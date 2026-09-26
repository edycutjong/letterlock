// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Letterlock} from "../src/Letterlock.sol";

/// @notice Deploys the Letterlock directory.
///
///   Registry = env IDENTITY_REGISTRY if set, else the chain default:
///     Monad mainnet (143):   the ERC-8004 IdentityRegistry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 (enforced)
///     Monad testnet (10143): address(0), so the agent path is DISABLED: ERC-8004 has no registry on testnet,
///                            and publishForAgent / drop-to-agent revert AgentPathDisabled there.
///   Or pass it explicitly: --sig "deploy(address)" <registry>
///
///   forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$KEY" --broadcast
///   (full mainnet procedure: script/DeployMainnet.md)
contract Deploy is Script {
    address public constant MAINNET_IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint256 public constant MONAD_MAINNET = 143;

    function run() external returns (Letterlock directory) {
        return deploy(vm.envOr("IDENTITY_REGISTRY", defaultRegistry(block.chainid)));
    }

    function deploy(address registry) public returns (Letterlock directory) {
        if (block.chainid == MONAD_MAINNET) {
            require(registry == MAINNET_IDENTITY_REGISTRY, "Deploy: Monad mainnet needs the ERC-8004 IdentityRegistry");
        }
        if (registry == address(0)) {
            console.log("Agent path DISABLED: identityRegistry = address(0) (no ERC-8004 registry on this chain)");
        } else {
            require(registry.code.length > 0, "Deploy: IDENTITY_REGISTRY has no code on this chain");
            console.log("Agent path enabled: identityRegistry =", registry);
        }

        vm.startBroadcast();
        directory = new Letterlock(registry);
        vm.stopBroadcast();

        console.log("Letterlock:", address(directory));
        console.log("chain id:", block.chainid);
    }

    function defaultRegistry(uint256 chainId) public pure returns (address) {
        return chainId == MONAD_MAINNET ? MAINNET_IDENTITY_REGISTRY : address(0);
    }
}
