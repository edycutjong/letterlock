// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice TEST DOUBLE for unit and invariant tests only: the ERC-721 `ownerOf` surface of an ERC-8004
///         IdentityRegistry, with open mint/transfer/burn so tests can move agents around. The real registry is
///         exercised in LetterlockFork.t.sol against Monad mainnet.
contract MockIdentityRegistry {
    mapping(uint256 => address) private _owners;

    /// @dev Same error as OpenZeppelin's ERC721 for a missing token.
    error ERC721NonexistentToken(uint256 tokenId);

    function mint(address to, uint256 agentId) external {
        require(to != address(0) && _owners[agentId] == address(0), "mock: bad mint");
        _owners[agentId] = to;
    }

    function transfer(uint256 agentId, address to) external {
        require(to != address(0) && _owners[agentId] != address(0), "mock: bad transfer");
        _owners[agentId] = to;
    }

    function burn(uint256 agentId) external {
        delete _owners[agentId];
    }

    function exists(uint256 agentId) external view returns (bool) {
        return _owners[agentId] != address(0);
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }
}
