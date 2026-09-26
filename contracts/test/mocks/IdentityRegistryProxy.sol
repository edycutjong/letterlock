// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice TEST DOUBLE: a minimal ERC-1967-style proxy in front of a registry implementation (MockIdentityRegistry).
///         The live ERC-8004 IdentityRegistry is such a proxy, so its `ownerOf` pays for a second account, the
///         implementation slot and a delegatecall. That cost is what gives a gas-starved `keyOfAgent` room to fail
///         inside the registry call and still have gas left afterwards, which this double reproduces without a network.
contract IdentityRegistryProxy {
    /// @dev ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address implementation) {
        assembly ("memory-safe") {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
    }

    fallback() external {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), sload(IMPLEMENTATION_SLOT), 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
