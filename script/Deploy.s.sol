// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {DeployValidation} from "../src/DeployValidation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title Deploy
 * @notice Deploys {YieldVault} and prints everything the deployment record needs.
 *
 * USAGE
 *
 *   # dry run against a local anvil chain (no funds, no risk)
 *   anvil &
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 *
 *   # real deployment to Base Sepolia
 *   export PRIVATE_KEY=0x...
 *   export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
 *
 * WHAT IT PRINTS AND WHY
 *
 * The console output is the raw material for `deployments/base-sepolia.json`.
 *
 * It does NOT print the deployment block, and that is deliberate. A broadcast script is
 * run against a SIMULATION of the chain first, so `block.number` here is the height the
 * simulation ran at -- shortly before the CREATE is mined, never the block it lands in.
 * The line below is labelled `simulation block` for that reason. Take `deployBlock` from
 * the broadcast file instead: `broadcast/Deploy.s.sol/<chainid>/run-latest.json` holds one
 * receipt per transaction, and the one whose `transactionHash` matches the vault's CREATE
 * carries the block the vault was deployed in. Note that this file deploys TWO contracts --
 * the `DeployValidation` library goes out as a CREATE2 first, usually one block earlier --
 * so "the first receipt in the file" is the library, not the vault.
 *
 * `deployBlock` is not decoration: the indexer's start block may be at or before the
 * vault's block (one extra empty block), but a start block AFTER it misses every early
 * event and fails SILENTLY, reporting success. A value that is not the block containing
 * `deployTxHash` makes the two fields disagree, which a reader can see but no program here
 * checked until this comment existed.
 *
 * THE ASSET IS READ, NOT ASSUMED
 *
 * The asset address comes from `config/BaseSepolia.sol`, and its `decimals()` is
 * read from chain and checked against the expected value before deploying. A
 * vault deployed against the wrong asset — or against an asset whose decimals
 * are not what we think — would have a different decimal offset and therefore a
 * different inflation-attack cost, and nothing about the deployment would look
 * wrong. So it fails loudly here instead.
 *
 * The owner defaults to the deployer. Override with OWNER_ADDRESS.
 */
contract Deploy is Script {
    /// @dev Base Sepolia test USDC. Verified on chain: 6 decimals, symbol USDC.
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("OWNER_ADDRESS", deployer);
        address asset = vm.envOr("ASSET_ADDRESS", BASE_SEPOLIA_USDC);

        // -- preflight: refuse to deploy into a state we do not understand -----
        //
        // The checks live in DeployValidation so that they are unit-testable. A
        // `require` here could only be reached by deploying a contract, and
        // `vm.startBroadcast` inside a test is a dry run, so an inline check
        // would never be covered.

        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        DeployValidation.validateInputs(asset, asset.code.length, assetDecimals, owner);

        console2.log("=== YieldVault deployment ===");
        console2.log("chain id        :", block.chainid);
        console2.log("deployer        :", deployer);
        console2.log("owner           :", owner);
        console2.log("asset           :", asset);
        console2.log("asset symbol    :", IERC20Metadata(asset).symbol());
        console2.log("asset decimals  :", assetDecimals);

        vm.startBroadcast(deployerKey);
        YieldVault vault = new YieldVault(IERC20(asset), owner);
        vm.stopBroadcast();

        // -- postflight: assert the deployment is what we intended -------------

        DeployValidation.validateDeployment(
            vault.asset(),
            asset,
            vault.owner(),
            owner,
            vault.decimals(),
            vault.totalSupply(),
            vault.totalAssets()
        );

        console2.log("");
        console2.log("=== deployment record (paste into deployments/) ===");
        console2.log("address         :", address(vault));
        console2.log("simulation block:", block.number);
        console2.log("share decimals  :", vault.decimals());
        console2.log("");
        console2.log("The block above is the SIMULATION height, not the block the vault");
        console2.log("is mined in -- nothing has been mined when this line runs. Take");
        console2.log("deployBlock from the broadcast file's receipt for THIS address");
        console2.log("(broadcast/Deploy.s.sol/<chainid>/run-latest.json), so that it is");
        console2.log("the block that contains the transaction hash recorded beside it.");
    }
}
