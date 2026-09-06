// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title IIdentityRegistry
 * @notice The slice of the ERC-8004 IdentityRegistry that AgentDesk uses (AD-2).
 *
 * @dev Not implemented here. The registry is already deployed on BSC testnet at
 *      `0x8004A818BFB912233c491871b3d84c89A494BD9e` (an ERC-1967 proxy in front of
 *      `0x7274e874ca62410a93bd8bf61c69d8045e399c02`), and this interface exists only so
 *      `script/export-abi.mjs` can emit a compiler-checked ABI for
 *      `packages/adapters/src/chain/abi/IdentityRegistry.json`.
 *
 * @dev Every member below was verified against that deployment on 2026-09-06: the four
 *      selectors appear in the implementation's dispatcher, `register(string)` returns the
 *      new agent id under `eth_call`, and a live `Registered` log carries three topics
 *      (signature, `agentId`, `owner`) with the URI string in `data`.
 *
 * @dev `listing.verify` calls {register} from the Creator wallet, so the Creator owns the
 *      agent id, and decodes that id from the {Registered} log in the receipt.
 */
interface IIdentityRegistry {
    /// @notice Emitted by {register}. `agentId` and `owner` are indexed; the URI is in `data`.
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    /// @notice Mints a new agent identity to the caller pointing at `agentURI`.
    function register(string calldata agentURI) external returns (uint256 agentId);

    /// @notice Repoints an existing identity at a new URI (AD-8 intent `identity-uri:`).
    function setAgentURI(uint256 agentId, string calldata agentURI) external;

    /// @notice The URI currently recorded for `agentId`.
    function tokenURI(uint256 agentId) external view returns (string memory);

    /// @notice The account that owns `agentId`.
    function ownerOf(uint256 agentId) external view returns (address);
}
