// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC3009} from "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC3009.sol";

/**
 * @title tUSD - the AgentDesk test settlement token
 * @notice ERC-20 with the ERC-3009 `transferWithAuthorization` rail that x402's `exact`
 *         scheme settles through (AD-6). Six decimals, so every amount on the wire is an
 *         integer number of base units (AD-13).
 *
 * @dev The EIP-712 domain is `EIP712("tUSD", "1")`. That pair is published in
 *      `deployments/97.json` as `tusd.name` / `tusd.version` and reaches every 402 as
 *      `extra { name, version }`, so a client can rebuild the exact domain the token
 *      verifies against. `TUSDTest` asserts `eip712Domain()` against those literals.
 *
 * @dev Nonces are the random 32-byte values ERC-3009 specifies, tracked as a set in
 *      {ERC3009-authorizationState}. This contract deliberately does NOT use OpenZeppelin's
 *      `ERC20TransferAuthorization`: that extension keys authorizations by a sequential
 *      nonce, and x402 sends unordered random nonces, which it rejects.
 *
 * @dev `mint` is intentionally permissionless: this is a testnet faucet token. The
 *      per-call cap keeps a single transaction from minting an absurd supply; it is not a
 *      rate limit and is not meant to be one.
 */
contract TUSD is ERC20, ERC3009 {
    uint8 private constant DECIMALS = 6;

    /// @notice The most tUSD a single {mint} call may create: 1,000 tUSD.
    uint256 public constant MINT_CAP = 1_000 * (10 ** uint256(DECIMALS));

    /// @dev `amount` exceeds {MINT_CAP}.
    error TUSDMintCapExceeded(uint256 amount, uint256 cap);

    constructor() ERC20("tUSD", "tUSD") EIP712("tUSD", "1") {}

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Mints up to {MINT_CAP} tUSD to `to`. Open to anyone; testnet only.
    function mint(address to, uint256 amount) external {
        require(amount <= MINT_CAP, TUSDMintCapExceeded(amount, MINT_CAP));
        _mint(to, amount);
    }
}
