// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title MockIdentityRegistry
 * @notice A local stand-in for the ERC-8004 IdentityRegistry that is already live on
 *         BSC testnet at 0x8004A818BFB912233c491871b3d84c89A494BD9e.
 *
 * @dev This exists only so the whole listing pipeline can be rehearsed against a local
 *      Anvil chain before anyone funds a testnet key. `script/LocalChain.s.sol` deploys it
 *      and then copies its runtime code to the real registry address with `anvil_setCode`,
 *      so application code needs no local-only branch. It is never deployed to a public
 *      network: it lives under `test/`, so `forge build --skip test` leaves it out.
 */
contract MockIdentityRegistry {
    event Registered(uint256 indexed agentId, string tokenURI, address indexed owner);

    uint256 private _nextId = 1;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => string) private _uris;

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _nextId++;
        _owners[agentId] = msg.sender;
        _uris[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata agentURI) external {
        require(_owners[agentId] == msg.sender, "not owner");
        _uris[agentId] = agentURI;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _owners[agentId];
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        return _uris[agentId];
    }
}
