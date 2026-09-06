// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC3009} from "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC3009.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {TUSD} from "../src/TUSD.sol";

/// @dev The x402 `exact` scheme signs exactly this struct (ERC-3009).
bytes32 constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
);

contract TUSDTest is Test {
    TUSD internal tusd;

    uint256 internal payerKey = 0xA11CE;
    address internal payer;
    address internal payee = address(0xBEEF);

    function setUp() public {
        // Any timestamp far from zero; ERC-3009 compares against block.timestamp.
        vm.warp(1_800_000_000);
        payer = vm.addr(payerKey);
        tusd = new TUSD();
    }

    // ------------------------------------------------------------ token basics

    function test_MetadataAndDecimals() public view {
        assertEq(tusd.name(), "tUSD");
        assertEq(tusd.symbol(), "tUSD");
        assertEq(tusd.decimals(), 6, "AD-13: amounts on the wire are 6-decimal base units");
    }

    /**
     * @dev AD-6: the domain a client rebuilds from the 402's `extra { name, version }` must
     *      be the domain this token verifies against, or every payment fails to recover.
     *      `deployments/97.json` carries the same two literals.
     */
    function test_Eip712DomainIsTUSDVersion1() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = tusd.eip712Domain();

        assertEq(name, "tUSD");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(tusd));
        assertEq(fields, hex"0f");
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    // -------------------------------------------------------------------- mint

    function test_MintAtCap() public {
        tusd.mint(payer, tusd.MINT_CAP());
        assertEq(tusd.balanceOf(payer), 1_000_000_000);
        assertEq(tusd.MINT_CAP(), 1_000 * 10 ** 6);
    }

    function test_MintIsOpenToAnyone() public {
        vm.prank(address(0xD00D));
        tusd.mint(payee, 1);
        assertEq(tusd.balanceOf(payee), 1);
    }

    function test_MintRevertsAboveCap() public {
        uint256 cap = tusd.MINT_CAP();
        vm.expectRevert(abi.encodeWithSelector(TUSD.TUSDMintCapExceeded.selector, cap + 1, cap));
        tusd.mint(payer, cap + 1);
    }

    function test_MintTwiceExceedsCapInAggregate() public {
        // The cap is per call, not a supply ceiling. Stated so a reader does not assume otherwise.
        tusd.mint(payer, tusd.MINT_CAP());
        tusd.mint(payer, tusd.MINT_CAP());
        assertEq(tusd.totalSupply(), 2 * tusd.MINT_CAP());
    }

    // ------------------------------------------------ transferWithAuthorization

    /// @dev The x402 path: a random 32-byte nonce settles once and is dead afterwards.
    function test_TransferWithAuthorizationRandomNonceSucceedsThenRevertsOnReplay() public {
        tusd.mint(payer, 1_000_000);
        bytes32 nonce = keccak256("a random 32-byte nonce, not a counter");
        uint256 value = 10_000; // 0.01 tUSD
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 15;

        assertFalse(tusd.authorizationState(payer, nonce));

        (uint8 v, bytes32 r, bytes32 s) =
            _signTransfer(payerKey, payer, payee, value, validAfter, validBefore, nonce);

        // Relayed by the facilitator, not by the payer: the payer holds no BNB.
        vm.prank(address(0xFACC));
        tusd.transferWithAuthorization(payer, payee, value, validAfter, validBefore, nonce, v, r, s);

        assertEq(tusd.balanceOf(payee), value);
        assertEq(tusd.balanceOf(payer), 1_000_000 - value);
        assertTrue(tusd.authorizationState(payer, nonce), "nonce must read as used after settlement");

        vm.prank(address(0xFACC));
        vm.expectRevert(abi.encodeWithSelector(ERC3009.ERC3009UsedAuthorization.selector, payer, nonce));
        tusd.transferWithAuthorization(payer, payee, value, validAfter, validBefore, nonce, v, r, s);

        assertEq(tusd.balanceOf(payee), value, "a replay must move nothing");
    }

    /**
     * @dev The reason `ERC20TransferAuthorization` is not used anywhere: its nonces are
     *      sequential per authorizer, so an out-of-order pair reverts. x402 generates random
     *      nonces and settles them in whatever order the facilitator gets to them, which is
     *      what this asserts works.
     */
    function test_UnorderedRandomNoncesBothSettle() public {
        tusd.mint(payer, 1_000_000);
        bytes32 high = bytes32(type(uint256).max);
        bytes32 low = bytes32(uint256(1));
        uint256 validBefore = block.timestamp + 15;

        (uint8 v1, bytes32 r1, bytes32 s1) = _signTransfer(payerKey, payer, payee, 1, 0, validBefore, high);
        (uint8 v2, bytes32 r2, bytes32 s2) = _signTransfer(payerKey, payer, payee, 2, 0, validBefore, low);

        tusd.transferWithAuthorization(payer, payee, 1, 0, validBefore, high, v1, r1, s1);
        tusd.transferWithAuthorization(payer, payee, 2, 0, validBefore, low, v2, r2, s2);

        assertEq(tusd.balanceOf(payee), 3);
        assertTrue(tusd.authorizationState(payer, high));
        assertTrue(tusd.authorizationState(payer, low));
    }

    function test_TransferWithAuthorizationRevertsOnWrongSigner() public {
        tusd.mint(payer, 1_000_000);
        bytes32 nonce = keccak256("wrong signer");
        uint256 validBefore = block.timestamp + 15;
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(0xB0B, payer, payee, 1, 0, validBefore, nonce);

        vm.expectRevert(ERC3009.ERC3009InvalidSignature.selector);
        tusd.transferWithAuthorization(payer, payee, 1, 0, validBefore, nonce, v, r, s);
    }

    function test_TransferWithAuthorizationRevertsAfterValidBefore() public {
        tusd.mint(payer, 1_000_000);
        bytes32 nonce = keccak256("expired");
        uint256 validBefore = block.timestamp + 15;
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(payerKey, payer, payee, 1, 0, validBefore, nonce);

        vm.warp(validBefore + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ERC3009.ERC3009InvalidAuthorizationTime.selector, 0, validBefore)
        );
        tusd.transferWithAuthorization(payer, payee, 1, 0, validBefore, nonce, v, r, s);
        assertFalse(tusd.authorizationState(payer, nonce), "a rejected authorization must stay unused");
    }

    /// @dev Any nonce the engine may generate settles exactly once.
    function testFuzz_AnyNonceSettlesOnce(bytes32 nonce, uint96 value) public {
        vm.assume(value > 0);
        tusd.mint(payer, tusd.MINT_CAP());
        vm.assume(value <= tusd.MINT_CAP());
        uint256 validBefore = block.timestamp + 15;

        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(payerKey, payer, payee, value, 0, validBefore, nonce);
        tusd.transferWithAuthorization(payer, payee, value, 0, validBefore, nonce, v, r, s);
        assertTrue(tusd.authorizationState(payer, nonce));

        vm.expectRevert(abi.encodeWithSelector(ERC3009.ERC3009UsedAuthorization.selector, payer, nonce));
        tusd.transferWithAuthorization(payer, payee, value, 0, validBefore, nonce, v, r, s);
    }

    // ---------------------------------------------------------------- internal

    function _domainSeparator() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            tusd.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    function _signTransfer(
        uint256 key,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return vm.sign(key, MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash));
    }
}
