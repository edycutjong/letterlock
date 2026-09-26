// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice TEST DOUBLE for the registry-call rule: an ERC-721 `ownerOf` that answers normally, or fails in a chosen
///         way. Letterlock must read only `ERC721NonexistentToken` as "no owner" and revert `RegistryCallFailed` on
///         every other failure.
contract FaultyIdentityRegistry {
    enum Fault {
        None, // answer normally: the owner, or ERC721NonexistentToken for an agent nobody owns
        EmptyRevert, // revert with no data, which is also what the caller sees when a call runs out of gas
        OutOfGas, // run out of gas for real
        ErrorString, // Error(string), as OpenZeppelin ERC-721 before v5 reverted for a missing token
        OtherCustomError, // another OpenZeppelin ERC-721 error
        Panic, // Panic(0x01)
        SelectorPrefix, // the first 3 bytes of the ERC721NonexistentToken selector: too short to be that error
        MalformedAnswer // succeed with 31 bytes, which do not decode as an address
    }

    /// @dev Same errors as OpenZeppelin's ERC721.
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721InsufficientApproval(address operator, uint256 tokenId);

    mapping(uint256 => address) private _owners;
    Fault public fault;

    function mint(address to, uint256 agentId) external {
        _owners[agentId] = to;
    }

    function burn(uint256 agentId) external {
        delete _owners[agentId];
    }

    function setFault(Fault f) external {
        fault = f;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        Fault f = fault;
        if (f == Fault.EmptyRevert) revert();
        if (f == Fault.OutOfGas) {
            assembly ("memory-safe") {
                for {} 1 {} {}
            }
        }
        if (f == Fault.ErrorString) revert("ERC721: invalid token ID");
        if (f == Fault.OtherCustomError) revert ERC721InsufficientApproval(msg.sender, agentId);
        if (f == Fault.Panic) assert(false);
        if (f == Fault.SelectorPrefix) {
            bytes4 selector = ERC721NonexistentToken.selector;
            assembly ("memory-safe") {
                mstore(0, selector)
                revert(0, 3)
            }
        }
        if (f == Fault.MalformedAnswer) {
            assembly ("memory-safe") {
                mstore(0, 0)
                return(0, 31)
            }
        }
        owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }
}
