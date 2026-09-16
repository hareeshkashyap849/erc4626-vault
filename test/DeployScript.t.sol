// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {DeployValidation} from "../src/DeployValidation.sol";
import {MockERC20} from "./MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title DeployValidationTest
 * @notice Tests the checks the deployment script runs before and after deploying.
 *
 * WHY THESE CHECKS ARE THE INTERESTING PART
 *
 * A deployment that goes wrong here does not look wrong. Consider the failure
 * this suite exists to prevent: deploying against an 18-decimal asset instead of
 * a 6-decimal one. The vault deploys, its owner is correct, `decimals()` returns
 * 18 as documented, and a block explorer shows a healthy contract. The only
 * difference is that `_decimalsOffset()` is 0 instead of 12 — which is the
 * inflation-attack cost, silently reduced by a factor of 10^12.
 *
 * Nothing about the deployment surfaces that. Only a check does.
 */
contract DeployValidationTest is Test {
    address internal constant OWNER = address(0x0117);
    address internal constant ASSET = address(0xA55E7);

    // ------------------------------------------------------------- preflight

    function test_AcceptsTheIntendedConfiguration() public pure {
        // 6 decimals, code present, real owner: nothing should revert.
        DeployValidation.validateInputs(ASSET, 1798, 6, OWNER);
    }

    /// @dev An asset with no code would make every transfer revert, but only
    ///      after the deployment had already succeeded and been recorded.
    function test_RejectsAssetWithoutCode() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidation.AssetHasNoCode.selector, ASSET));
        DeployValidation.validateInputs(ASSET, 0, 6, OWNER);
    }

    /// @dev The check that matters most. An 18-decimal asset is perfectly
    ///      legitimate for the vault, but not for THIS deployment: it yields an
    ///      offset of 0 and removes the inflation-attack protection.
    function test_RejectsAnAssetWithTheWrongDecimals() public {
        vm.expectRevert(
            abi.encodeWithSelector(DeployValidation.AssetDecimalsUnexpected.selector, uint8(18), uint8(6))
        );
        DeployValidation.validateInputs(ASSET, 1798, 18, OWNER);
    }

    function test_RejectsDecimalsAboveEighteen() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidation.AssetDecimalsTooHigh.selector, uint8(24)));
        DeployValidation.validateInputs(ASSET, 1798, 24, OWNER);
    }

    /// @dev The order of the checks is part of the behaviour: a nonsense decimals
    ///      value from an address with no code should report the missing code,
    ///      not the decimals, because the missing code is the real problem.
    function test_MissingCodeIsReportedBeforeDecimals() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidation.AssetHasNoCode.selector, ASSET));
        DeployValidation.validateInputs(ASSET, 0, 99, OWNER);
    }

    /// @dev An owner of address(0) makes reportYield permanently uncallable, so
    ///      the vault can never demonstrate a rising share price. Ownable itself
    ///      permits a zero owner, which is exactly why the script must not.
    function test_RejectsZeroOwner() public {
        vm.expectRevert(DeployValidation.OwnerIsZero.selector);
        DeployValidation.validateInputs(ASSET, 1798, 6, address(0));
    }

    // ------------------------------------------------------------- the reason

    /**
     * @dev Shows the consequence the decimals check exists to prevent: the
     *      offset — and therefore the inflation-attack cost — differs by a
     *      factor of 10^12 between a 6-decimal and an 18-decimal asset.
     *
     *      This is asserted through the real vault, not through the library, so
     *      that the claim "the offset depends on the asset" is checked against
     *      the contract rather than against a formula in a test.
     */
    function test_OffsetDifferenceIsTheReasonForTheDecimalsCheck() public {
        MockERC20 six = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 eighteen = new MockERC20("Wrapped Ether", "WETH", 18);

        YieldVault vault6 = new YieldVault(IERC20(address(six)), OWNER);
        YieldVault vault18 = new YieldVault(IERC20(address(eighteen)), OWNER);

        uint8 offset6 = vault6.decimals() - IERC20Metadata(address(six)).decimals();
        uint8 offset18 = vault18.decimals() - IERC20Metadata(address(eighteen)).decimals();

        assertEq(offset6, 12, "a 6-decimal asset must give an offset of 12");
        assertEq(offset18, 0, "an 18-decimal asset gives an offset of 0");
        assertEq(DeployValidation.offsetFor(6), 12);
        assertEq(DeployValidation.offsetFor(18), 0);

        // 10**12 versus 10**0. This is the attack-cost factor an 18-decimal
        // asset would silently remove. Compared as powers rather than by
        // dividing, which would need a special case for the zero offset and
        // would make the assertion harder to read than the claim it supports.
        assertEq(10 ** uint256(offset6), 1e12, "the 6-decimal offset must give an attack cost of 10^12");
        assertEq(10 ** uint256(offset18), 1, "the 18-decimal offset gives an attack cost of 10^0");
    }

    // ------------------------------------------------------------ postflight

    function test_PostflightAcceptsAFreshlyDeployedVault() public {
        MockERC20 asset = new MockERC20("USD Coin", "USDC", 6);
        YieldVault vault = new YieldVault(IERC20(address(asset)), OWNER);

        DeployValidation.validateDeployment(
            vault.asset(),
            address(asset),
            vault.owner(),
            OWNER,
            vault.decimals(),
            vault.totalSupply(),
            vault.totalAssets()
        );
    }

    function test_PostflightRejectsTheWrongAsset() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidation.VaultShapeMismatch.selector, "asset"));
        DeployValidation.validateDeployment(address(0xBAD), ASSET, OWNER, OWNER, 18, 0, 0);
    }

    function test_PostflightRejectsTheWrongOwner() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidation.VaultShapeMismatch.selector, "owner"));
        DeployValidation.validateDeployment(ASSET, ASSET, address(0xBAD), OWNER, 18, 0, 0);
    }

    function test_PostflightRejectsUnexpectedShareDecimals() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidation.VaultShapeMismatch.selector, "share decimals"));
        DeployValidation.validateDeployment(ASSET, ASSET, OWNER, OWNER, 6, 0, 0);
    }

    /// @dev A vault that already holds shares or assets at "deployment" means the
    ///      address was reused, or the script is pointed at an existing vault.
    ///      Either way the deployment record would be wrong.
    function test_PostflightRejectsANonEmptyVault() public {
        vm.expectRevert(abi.encodeWithSelector(DeployValidation.VaultShapeMismatch.selector, "totalSupply is not zero"));
        DeployValidation.validateDeployment(ASSET, ASSET, OWNER, OWNER, 18, 1, 0);

        vm.expectRevert(abi.encodeWithSelector(DeployValidation.VaultShapeMismatch.selector, "totalAssets is not zero"));
        DeployValidation.validateDeployment(ASSET, ASSET, OWNER, OWNER, 18, 0, 1);
    }

    // ------------------------------------------------- the real asset's shape

    /// @dev The values the preflight expects, checked against a mock built to
    ///      USDC's actual shape (6 decimals, symbol USDC). The genuine contract
    ///      is exercised in `YieldVaultFork.t.sol`.
    function test_TheExpectedConfigurationMatchesUsdcShape() public {
        MockERC20 usdcShape = new MockERC20("USD Coin", "USDC", 6);
        assertEq(usdcShape.decimals(), DeployValidation.EXPECTED_ASSET_DECIMALS, "expectation does not match USDC");
        assertEq(DeployValidation.EXPECTED_SHARE_DECIMALS, 18, "shares are 18-decimal");

        // And the preflight accepts it.
        DeployValidation.validateInputs(address(usdcShape), address(usdcShape).code.length, usdcShape.decimals(), OWNER);
    }
}
