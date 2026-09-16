// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "../test/MockERC20.sol";

/**
 * @title DeployTestAsset
 * @notice Deploys a 6-decimal ERC-20 so that {Deploy} can be exercised locally.
 *
 * This exists so the deployment script has something to run against without a
 * funded account and without a live network. It is what makes "the deploy script
 * has been executed" a checkable claim rather than an assertion — the same code
 * path runs, the same preflight and postflight checks fire, and the only
 * difference from a real deployment is which asset address is passed in.
 *
 * It uses the same 6 decimals as USDC, so the vault's decimal offset is derived
 * identically. Deploying against an 18-decimal asset would silently exercise a
 * different offset and prove less.
 *
 *   anvil &
 *   forge script script/DeployTestAsset.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 */
contract DeployTestAsset is Script {
    function run() external returns (address) {
        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        vm.startBroadcast(key);
        MockERC20 asset = new MockERC20("USD Coin", "USDC", 6);
        vm.stopBroadcast();

        console2.log("test asset deployed at:", address(asset));
        console2.log("decimals             :", asset.decimals());
        console2.log("");
        console2.log("Now run:");
        console2.log("  ASSET_ADDRESS=<address above> forge script script/Deploy.s.sol \\");
        console2.log("    --rpc-url http://127.0.0.1:8545 --broadcast");

        return address(asset);
    }
}
