// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Reference model of Letterlock's key rules, written independently of the contract: it decodes the
///         little-endian u-coordinate into an integer and compares numbers, using the DECIMAL values that
///         libsodium 1.0.22 prints in has_small_order()'s comments (x25519_ref10.c) instead of the contract's
///         byte literals. Differential fuzz tests check that the two agree.
library X25519Ref {
    uint256 internal constant P = 2 ** 255 - 19;
    uint256 internal constant ORDER8_A =
        325606250916557431795983626356110631294008115727848805560023387167927233504;
    uint256 internal constant ORDER8_B =
        39382357235489614581723060781553021112529911719440698176882885853963445705823;

    enum Verdict {
        Valid,
        Zero,
        LowOrder,
        NonCanonical
    }

    /// @dev bytes32 holds key byte 0 first; X25519 reads the 32 bytes as a little-endian integer.
    function le(bytes32 b) internal pure returns (uint256 u) {
        for (uint256 i = 0; i < 32; i++) {
            u |= uint256(uint8(b[i])) << (8 * i);
        }
    }

    /// @dev Inverse of `le`.
    function fromLe(uint256 u) internal pure returns (bytes32 b) {
        for (uint256 i = 0; i < 32; i++) {
            b |= bytes32(uint256(uint8(u >> (8 * i))) << (8 * (31 - i)));
        }
    }

    /// @dev libsodium has_small_order(): bit 255 ignored, then compared against its 7 entries.
    function isSmallOrder(bytes32 b) internal pure returns (bool) {
        uint256 u = le(b) & (2 ** 255 - 1);
        return u == 0 || u == 1 || u == ORDER8_A || u == ORDER8_B || u == P - 1 || u == P || u == P + 1;
    }

    /// @dev Canonical = the integer is already reduced: u < p (which also means bit 255 is clear).
    function isCanonical(bytes32 b) internal pure returns (bool) {
        return le(b) < P;
    }

    function verdict(bytes32 b) internal pure returns (Verdict) {
        if (b == bytes32(0)) return Verdict.Zero;
        if (isSmallOrder(b)) return Verdict.LowOrder;
        if (!isCanonical(b)) return Verdict.NonCanonical;
        return Verdict.Valid;
    }
}
