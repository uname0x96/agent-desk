// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TUSD} from "../src/TUSD.sol";
import {AgentDeskRegistry} from "../src/AgentDeskRegistry.sol";

/**
 * @title Deploy
 * @notice Deploys tUSD and AgentDeskRegistry to BSC testnet and overwrites
 *         `deployments/97.json`, which is the only place any process reads a contract
 *         address from (AD-10, AD-14).
 *
 * Run with:
 *
 *   PLATFORM_WALLET_KEY=0x<64 hex> ETHERSCAN_API_KEY=<key> \
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url https://bsc-testnet-dataseed.bnbchain.org \
 *     --broadcast --verify
 *
 * @dev The broadcasting key is the Platform Wallet, and it becomes the registry's
 *      `platform` address: the only account that may {AgentDeskRegistry-slash} or
 *      {AgentDeskRegistry-setReputation}. It is immutable, so getting it wrong means
 *      redeploying the registry.
 *
 * @dev `tusd.name` and `tusd.version` are read back out of the deployed token's
 *      `eip712Domain()` rather than typed here, so the file can never publish a domain the
 *      token does not verify against (AD-6).
 *
 * @dev `deployedAtBlock` is the block this script forked from, which is one or two blocks
 *      before the transactions actually land: a floor, safe for "scan from here", not the
 *      exact mining block, because a Solidity script cannot see its own receipts. Running
 *      `node script/sync-deployment.mjs` afterwards replaces both values with the exact
 *      block numbers from the broadcast receipts. `pnpm --filter contracts deploy` chains
 *      the two.
 */
contract Deploy is Script {
    /// @notice ERC-8004 IdentityRegistry, already live on BSC testnet. AgentDesk only calls it.
    address internal constant IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    uint256 internal constant BSC_TESTNET = 97;
    string internal constant NETWORK_NAME = "bsc-testnet";

    error WrongChain(uint256 chainId);

    function run() external returns (TUSD tusd, AgentDeskRegistry registry) {
        require(block.chainid == BSC_TESTNET, WrongChain(block.chainid));

        uint256 deployerKey = vm.envUint("PLATFORM_WALLET_KEY");
        address platform = vm.addr(deployerKey);
        uint256 forkBlock = vm.getBlockNumber();

        vm.startBroadcast(deployerKey);
        tusd = new TUSD();
        registry = new AgentDeskRegistry(IERC20(address(tusd)), platform);
        vm.stopBroadcast();

        console.log("platform wallet   ", platform);
        console.log("tUSD              ", address(tusd));
        console.log("AgentDeskRegistry ", address(registry));
        console.log("IdentityRegistry  ", IDENTITY_REGISTRY);

        _writeDeployments(tusd, registry, forkBlock);
    }

    function _writeDeployments(TUSD tusd, AgentDeskRegistry registry, uint256 forkBlock) internal {
        (, string memory name, string memory version,,,,) = tusd.eip712Domain();

        string memory head = string.concat(
            "{\n", '  "chainId": ', vm.toString(block.chainid), ",\n", '  "name": "', NETWORK_NAME, '",\n'
        );
        string memory token = string.concat(
            '  "tusd": {\n',
            '    "address": "',
            vm.toString(address(tusd)),
            '",\n',
            '    "name": "',
            name,
            '",\n',
            '    "version": "',
            version,
            '",\n',
            '    "decimals": ',
            vm.toString(uint256(tusd.decimals())),
            "\n  },\n"
        );
        string memory addresses = string.concat(
            '  "registry": {\n    "address": "',
            vm.toString(address(registry)),
            '"\n  },\n',
            '  "identityRegistry": {\n    "address": "',
            vm.toString(IDENTITY_REGISTRY),
            '"\n  },\n'
        );
        string memory blocks = string.concat(
            '  "deployedAtBlock": {\n    "tusd": ',
            vm.toString(forkBlock),
            ',\n    "registry": ',
            vm.toString(forkBlock),
            "\n  }\n}\n"
        );

        string memory path = string.concat("../deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, string.concat(head, token, addresses, blocks));
        console.log("wrote", path);
    }
}
