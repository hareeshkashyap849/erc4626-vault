// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/**
 * @title DeployValidation
 * @notice The preflight and postflight checks used by the deployment script,
 *         extracted so they can be tested.
 *
 * WHY THIS IS A SEPARATE CONTRACT AND NOT JUST `require` STATEMENTS
 *
 * The deployment script's checks are its most valuable part. A vault deployed
 * against the wrong asset, or with an owner nobody controls, or reporting a
 * share precision other than 18, would look entirely normal on a block explorer
 * — and the consequences are subtle rather than obvious:
 *
 *   - The wrong asset decimals change `_decimalsOffset()`, which is the
 *     inflation-attack cost. A 6-decimal asset gives an offset of 12; an
 *     18-decimal asset gives an offset of 0. Nothing about the deployment looks
 *     wrong; the protection is simply gone.
 *   - An owner of `address(0)` makes `reportYield` permanently uncallable, so the
 *     vault can never demonstrate a rising share price.
 *   - An asset address with no code makes every transfer revert, long after the
 *     deployment succeeded.
 *
 * `require` statements inside a `Script.run()` cannot be tested: reaching them
 * means deploying a contract, and `vm.startBroadcast` inside a test is a dry run
 * (documented in Foundry's own guidance: without `--broadcast` it does not send
 * anything). Untestable validation is validation that will be deleted by the
 * next person who trips over it. As pure functions over primitives, these are
 * covered by `test/DeployScript.t.sol` and therefore by CI.
 *
 * These functions are `public` rather than `internal` for one reason: an
 * `internal` library function is inlined into its caller, so its revert happens
 * at the same call depth as `vm.expectRevert` and Foundry cannot observe it
 * ("call didn't revert at a lower depth than cheatcode call depth"). A `public`
 * library function is reached by a static call from the test, which puts the
 * revert one frame down where the cheatcode can see it. The visibility is a
 * testability requirement, not a style choice.
 */
library DeployValidation {
    /// @notice Thrown when the asset address has no contract code.
    error AssetHasNoCode(address asset);
    /// @notice Thrown when the asset reports more than 18 decimals.
    error AssetDecimalsTooHigh(uint8 decimals);
    /// @notice Thrown when the asset's decimals differ from the expected value.
    error AssetDecimalsUnexpected(uint8 reported, uint8 expected);
    /// @notice Thrown when the owner is the zero address.
    error OwnerIsZero();
    /// @notice Thrown when a deployed vault does not match the intended shape.
    error VaultShapeMismatch(string what);

    /// @dev The decimals this deployment is specified for. USDC has 6.
    uint8 internal constant EXPECTED_ASSET_DECIMALS = 6;

    /// @dev Shares are 18-decimal by construction; see YieldVault._decimalsOffset.
    uint8 internal constant EXPECTED_SHARE_DECIMALS = 18;

    /**
     * @notice Validates the inputs to a deployment.
     * @param asset The intended asset, carried only so the error is useful.
     * @param assetCodeSize `asset.code.length`, passed in so this stays pure.
     * @param assetDecimals The value read from the asset contract.
     * @param owner The address that will own the vault.
     */
    function validateInputs(address asset, uint256 assetCodeSize, uint8 assetDecimals, address owner) public pure {
        if (assetCodeSize == 0) revert AssetHasNoCode(asset);
        if (assetDecimals > 18) revert AssetDecimalsTooHigh(assetDecimals);
        if (assetDecimals != EXPECTED_ASSET_DECIMALS) {
            revert AssetDecimalsUnexpected(assetDecimals, EXPECTED_ASSET_DECIMALS);
        }
        if (owner == address(0)) revert OwnerIsZero();
    }

    /**
     * @notice Validates the vault that was actually deployed.
     * @param vaultAsset `vault.asset()`
     * @param expectedAsset The asset the deployment intended.
     * @param vaultOwner `vault.owner()`
     * @param expectedOwner The owner the deployment intended.
     * @param shareDecimals `vault.decimals()`
     * @param totalSupply `vault.totalSupply()`
     * @param totalAssets `vault.totalAssets()`
     */
    function validateDeployment(
        address vaultAsset,
        address expectedAsset,
        address vaultOwner,
        address expectedOwner,
        uint8 shareDecimals,
        uint256 totalSupply,
        uint256 totalAssets
    ) public pure {
        if (vaultAsset != expectedAsset) revert VaultShapeMismatch("asset");
        if (vaultOwner != expectedOwner) revert VaultShapeMismatch("owner");
        if (shareDecimals != EXPECTED_SHARE_DECIMALS) revert VaultShapeMismatch("share decimals");
        if (totalSupply != 0) revert VaultShapeMismatch("totalSupply is not zero");
        if (totalAssets != 0) revert VaultShapeMismatch("totalAssets is not zero");
    }

    /**
     * @notice The decimal offset the vault will derive for a given asset.
     * @dev Exposed so a test can show that a wrong asset silently changes the
     *      inflation-attack cost, which is the reason the decimals check exists.
     */
    function offsetFor(uint8 assetDecimals) public pure returns (uint8) {
        if (assetDecimals > EXPECTED_SHARE_DECIMALS) revert AssetDecimalsTooHigh(assetDecimals);
        return EXPECTED_SHARE_DECIMALS - assetDecimals;
    }
}
