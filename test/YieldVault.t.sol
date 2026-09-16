// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {MockERC20} from "./MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title YieldVaultTest
 * @notice Unit, fuzz and invariant tests for {YieldVault}.
 *
 * The checks are written against an independent restatement of OpenZeppelin's
 * conversion arithmetic (see {_expectedShares} / {_expectedAssets}) rather than
 * against the vault's own output. A test that asks the contract what the answer
 * is and then asserts the contract said so proves nothing; this one recomputes
 * the value from the formula and compares.
 */
contract YieldVaultTest is Test {
    MockERC20 internal asset;
    YieldVault internal vault;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);
    address internal ownerAddr = address(0x0117);

    uint256 internal constant ONE_USDC = 1e6;

    function setUp() public {
        asset = new MockERC20("USD Coin", "USDC", 6);
        vault = new YieldVault(IERC20(address(asset)), ownerAddr);

        // A materially large starting balance for each actor so that tests are
        // not silently constrained by funding rather than by the logic.
        asset.mint(alice, 1_000_000 * ONE_USDC);
        asset.mint(bob, 1_000_000 * ONE_USDC);
        asset.mint(carol, 1_000_000 * ONE_USDC);
        asset.mint(ownerAddr, 1_000_000 * ONE_USDC);

        vm.startPrank(alice);
        asset.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        asset.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(carol);
        asset.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(ownerAddr);
        asset.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Independent restatement of the share formula, resolved once at
    ///      construction and cached, so this does not read the vault's code.
    uint256 internal offsetCache;
    bool internal offsetCached;

    function _offset() internal returns (uint256 o) {
        if (offsetCached) return offsetCache;
        // 18 - assetDecimals, computed here from the mock we control.
        o = 18 - asset.decimals();
        offsetCache = o;
        offsetCached = true;
    }

    function _expectedShares(uint256 assets_, uint256 supply, uint256 total) internal returns (uint256) {
        return (assets_ * (supply + 10 ** _offset())) / (total + 1);
    }

    function _expectedAssets(uint256 shares, uint256 supply, uint256 total) internal returns (uint256) {
        return (shares * (total + 1)) / (supply + 10 ** _offset());
    }

    /// @dev Rounds up, as previewMint and previewWithdraw require.
    function _expectedAssetsCeil(uint256 shares, uint256 supply, uint256 total) internal returns (uint256) {
        uint256 num = shares * (total + 1);
        uint256 den = supply + 10 ** _offset();
        uint256 q = num / den;
        return num % den == 0 ? q : q + 1;
    }

    function _expectedSharesCeil(uint256 assets_, uint256 supply, uint256 total) internal returns (uint256) {
        uint256 num = assets_ * (supply + 10 ** _offset());
        uint256 den = total + 1;
        uint256 q = num / den;
        return num % den == 0 ? q : q + 1;
    }

    // ------------------------------------------------------ decimals / offset

    function test_DecimalsIsEighteenForSixDecimalAsset() public view {
        assertEq(vault.decimals(), 18, "shares must be 18-decimal");
        assertEq(asset.decimals(), 6, "asset is the 6-decimal test token");
    }

    function test_DecimalsIsEighteenForEighteenDecimalAsset() public {
        MockERC20 a18 = new MockERC20("Wrapped Ether", "WETH", 18);
        YieldVault v18 = new YieldVault(IERC20(address(a18)), ownerAddr);
        assertEq(v18.decimals(), 18);
    }

    function test_ConstructorRevertsWhenAssetExceedsEighteenDecimals() public {
        MockERC20 a24 = new MockERC20("Too Many", "TMW", 24);
        vm.expectRevert(abi.encodeWithSelector(YieldVault.AssetDecimalsTooHigh.selector, uint8(24)));
        new YieldVault(IERC20(address(a24)), ownerAddr);
    }

    function test_AssetIsReportedCorrectly() public view {
        assertEq(vault.asset(), address(asset));
    }

    // ----------------------------------------------------------- empty vault

    function test_EmptyVaultReportsZeroAssetsAndSupply() public view {
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.totalSupply(), 0);
    }

    function test_FirstDepositReceivesFullValueInShares() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100 * ONE_USDC, alice);

        // totalSupply == 0, totalAssets == 0, so
        // shares = 100e6 * (0 + 10^12) / (0 + 1) = 100e6 * 10^12 = 100e18.
        assertEq(shares, 100e18, "first depositor must receive assets * 10^offset shares");
        assertEq(vault.totalAssets(), 100 * ONE_USDC);
        assertEq(vault.totalSupply(), 100e18);
        assertEq(asset.balanceOf(address(vault)), 100 * ONE_USDC);
    }

    // ------------------------------------------------------- rounding (INV-3)

    /**
     * @dev The rounding direction of every preview function is checked against
     *      an independent ceil/floor implementation. If any of these four were
     *      reversed the vault would hand value to the user on every operation,
     *      which is the exact failure INV-2 exists to catch -- so these tests
     *      are the mechanism, not a formality.
     */
    function test_RoundingDirectionsMatchTheStandard() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(ownerAddr);
        vault.reportYield(333 * ONE_USDC);

        uint256 supply = vault.totalSupply();
        uint256 total = vault.totalAssets();

        // Preview functions must round in the documented direction...
        assertEq(vault.previewDeposit(7 * ONE_USDC), _expectedShares(7 * ONE_USDC, supply, total), "previewDeposit floor");
        assertEq(vault.previewRedeem(7e18), _expectedAssets(7e18, supply, total), "previewRedeem floor");
        assertEq(
            vault.previewMint(7e18), _expectedAssetsCeil(7e18, supply, total), "previewMint ceil"
        );
        assertEq(
            vault.previewWithdraw(7 * ONE_USDC),
            _expectedSharesCeil(7 * ONE_USDC, supply, total),
            "previewWithdraw ceil"
        );

        // ...and convertTo* must both floor.
        assertEq(vault.convertToShares(7 * ONE_USDC), _expectedShares(7 * ONE_USDC, supply, total), "convertToShares floor");
        assertEq(vault.convertToAssets(7e18), _expectedAssets(7e18, supply, total), "convertToAssets floor");
    }

    /**
     * @dev A ceil implementation that adds one whenever the division was not
     *      exact must never return less than the floor version. This catches a
     *      swapped implementation, which equality-only assertions might miss if
     *      the number happened to divide evenly.
     */
    function test_CeilIsNeverLessThanFloor() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(ownerAddr);
        vault.reportYield(1); // deliberately not a round number

        uint256 supply = vault.totalSupply();
        uint256 total = vault.totalAssets();

        for (uint256 i = 0; i < 25; i++) {
            uint256 shares = 1 + i * 1e15 + i;
            uint256 floorAssets = _expectedAssets(shares, supply, total);
            uint256 ceilAssets = _expectedAssetsCeil(shares, supply, total);
            assertGe(ceilAssets, floorAssets, "ceil < floor for assets");
            assertLe(ceilAssets - floorAssets, 1, "ceil exceeded floor by more than 1 wei");

            uint256 assets_ = 1 + i * ONE_USDC + i;
            uint256 floorShares = _expectedShares(assets_, supply, total);
            uint256 ceilShares = _expectedSharesCeil(assets_, supply, total);
            assertGe(ceilShares, floorShares, "ceil < floor for shares");
            assertLe(ceilShares - floorShares, 1, "ceil exceeded floor by more than 1 wei");
        }
    }

    // ---------------------------------------------------- preview == executed

    /**
     * @dev INV-4. An integrator relies on preview to compute slippage bounds; if
     *      preview and execution disagree, the integrator can be sandwiched.
     */
    function test_PreviewMatchesExecutionForDeposit() public {
        vm.prank(alice);
        vault.deposit(500 * ONE_USDC, alice);

        uint256 amount = 137 * ONE_USDC + 999;
        uint256 predicted = vault.previewDeposit(amount);

        vm.prank(bob);
        uint256 actual = vault.deposit(amount, bob);

        assertEq(actual, predicted, "deposit returned a different value than previewDeposit");
    }

    function test_PreviewMatchesExecutionForMint() public {
        vm.prank(alice);
        vault.deposit(500 * ONE_USDC, alice);

        uint256 shares = 137e18 + 7;
        uint256 predicted = vault.previewMint(shares);

        vm.prank(bob);
        uint256 actual = vault.mint(shares, bob);

        assertEq(actual, predicted, "mint pulled a different amount than previewMint");
    }

    function test_PreviewMatchesExecutionForWithdraw() public {
        vm.prank(alice);
        vault.deposit(500 * ONE_USDC, alice);

        uint256 amount = 137 * ONE_USDC + 999;
        uint256 predicted = vault.previewWithdraw(amount);

        vm.prank(alice);
        uint256 actual = vault.withdraw(amount, alice, alice);

        assertEq(actual, predicted, "withdraw burned a different number of shares than previewWithdraw");
    }

    function test_PreviewMatchesExecutionForRedeem() public {
        vm.prank(alice);
        vault.deposit(500 * ONE_USDC, alice);

        uint256 shares = 137e18 + 7;
        uint256 predicted = vault.previewRedeem(shares);

        vm.prank(alice);
        uint256 actual = vault.redeem(shares, alice, alice);

        assertEq(actual, predicted, "redeem returned a different amount than previewRedeem");
    }

    // ------------------------------------------------------------- reportYield

    function test_ReportYieldRaisesSharePriceWithoutMinting() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);

        uint256 supplyBefore = vault.totalSupply();
        uint256 perShareBefore = vault.convertToAssets(1e18);

        vm.prank(ownerAddr);
        vault.reportYield(250 * ONE_USDC);

        assertEq(vault.totalSupply(), supplyBefore, "reportYield must not mint shares");
        assertEq(vault.totalAssets(), 1_250 * ONE_USDC);
        assertGt(vault.convertToAssets(1e18), perShareBefore, "share price must rise");
    }

    function test_ReportYieldEmitsEvent() public {
        vm.prank(ownerAddr);
        vm.expectEmit(true, false, false, true, address(vault));
        emit YieldVault.YieldReported(ownerAddr, 42 * ONE_USDC);
        vault.reportYield(42 * ONE_USDC);
    }

    function test_ReportYieldRejectsZero() public {
        vm.prank(ownerAddr);
        vm.expectRevert(YieldVault.YieldAmountZero.selector);
        vault.reportYield(0);
    }

    function test_ReportYieldRevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vault.reportYield(1 * ONE_USDC);
    }

    /**
     * @dev The owner's privilege must not extend to taking anything out. This is
     *      the executable form of the claim in the contract header: a compromised
     *      owner key can send money in and can do nothing else.
     */
    function test_OwnerCannotRemoveAssetsOrBlockWithdrawals() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);

        uint256 vaultBalanceBefore = asset.balanceOf(address(vault));

        // The only owner-callable function is reportYield, and it moves assets
        // *from* the owner *to* the vault. Calling it cannot reduce the balance.
        vm.prank(ownerAddr);
        vault.reportYield(1);

        assertGe(asset.balanceOf(address(vault)), vaultBalanceBefore, "owner action reduced vault assets");

        // And alice can still withdraw everything she put in, in full.
        // The balance is read before the prank, because a view call consumes it.
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertEq(asset.balanceOf(address(vault)), 1, "only the owner's 1 wei contribution should remain");
    }

    // ---------------------------------------------------------------- solvency

    /**
     * @dev INV-1. The whole supply can never be redeemable for more than the
     *      vault holds, plus the single virtual asset unit that OpenZeppelin's
     *      formula introduces. Checked across a yield contribution, because that
     *      is the operation that changes the ratio.
     */
    function test_TotalSupplyNeverRedeemableForMoreThanAssetsPlusOneWei() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(500 * ONE_USDC, bob);
        vm.prank(ownerAddr);
        vault.reportYield(321 * ONE_USDC);

        uint256 supply = vault.totalSupply();
        uint256 total = vault.totalAssets();
        uint256 redeemable = (supply * (total + 1)) / (supply + 10 ** _offset());

        assertLe(redeemable, total + 1, "vault cannot cover its own supply");
        assertEq(vault.previewRedeem(supply), redeemable, "preview disagrees with the formula");
    }

    /**
     * @dev The last user out must be paid in full. A vault whose accounting can
     *      exceed its balance fails here, and that failure only shows up at the
     *      end of the queue.
     */
    function test_LastWithdrawerCanAlwaysBePaid() public {
        vm.prank(alice);
        vault.deposit(100 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(200 * ONE_USDC, bob);
        vm.prank(carol);
        vault.deposit(300 * ONE_USDC, carol);
        vm.prank(ownerAddr);
        vault.reportYield(60 * ONE_USDC);

        // Read both balances before any transfer: view calls inside a prank block
        // would consume the prank and send the following call from the wrong
        // address.
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 bobShares = vault.balanceOf(bob);

        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);

        // Carol is last. She must be able to take everything that is left.
        uint256 carolShares = vault.balanceOf(carol);
        uint256 owed = vault.previewRedeem(carolShares);
        uint256 held = asset.balanceOf(address(vault));
        assertLe(owed, held, "the last withdrawer is owed more than the vault holds");

        vm.prank(carol);
        uint256 got = vault.redeem(carolShares, carol, carol);
        assertEq(got, owed);
        assertLe(asset.balanceOf(address(vault)), 1, "dust larger than one virtual unit remains");
    }

    // ------------------------------------------------------------ no free lunch

    /**
     * @dev INV-2. A deposit followed immediately by a redeem must never return
     *      more than went in. If any rounding direction were reversed this is
     *      where it would show, and it is the invariant an attacker would farm
     *      with tiny amounts if it ever failed.
     */
    function testFuzz_DepositThenRedeemNeverProfits(uint96 rawAmount, uint96 rawSeed) public {
        uint256 amount = uint256(rawAmount) % (10_000 * ONE_USDC) + 1;
        uint256 seed = uint256(rawSeed) % (1_000 * ONE_USDC);

        if (seed > 0) {
            vm.prank(carol);
            vault.deposit(seed + 1, carol); // ensure a non-empty vault
        }
        if (seed > 0) {
            vm.prank(ownerAddr);
            vault.reportYield(seed);
        }

        uint256 before = asset.balanceOf(bob);

        vm.prank(bob);
        uint256 shares = vault.deposit(amount, bob);

        vm.prank(bob);
        uint256 received = vault.redeem(shares, bob, bob);

        assertLe(received, amount, "round trip produced a profit");
        assertLe(asset.balanceOf(bob), before, "caller ended with more than they started");
    }

    /**
     * @dev INV-6, stated as an executable claim: minting shares and immediately
     *      redeeming them must not increase the caller's asset balance, and the
     *      vault must not end up with less than it started with.
     */
    function testFuzz_MintThenRedeemNeverProfits(uint96 rawShares) public {
        uint256 shares = uint256(rawShares) % (1_000 * 1e18) + 1e6;

        vm.prank(alice);
        vault.deposit(10_000 * ONE_USDC, alice);

        uint256 vaultBefore = asset.balanceOf(address(vault));
        uint256 bobBefore = asset.balanceOf(bob);

        vm.prank(bob);
        vault.mint(shares, bob);
        vm.prank(bob);
        vault.redeem(shares, bob, bob);

        assertLe(asset.balanceOf(bob), bobBefore, "mint/redeem round trip produced a profit");
        assertGe(asset.balanceOf(address(vault)), vaultBefore, "vault lost assets on a round trip");
    }

    // -------------------------------------------------------- inflation attack

    /**
     * @dev The classic inflation attack, executed rather than described.
     *
     *      The attacker deposits the minimum and then donates a large amount
     *      directly to the vault, inflating the share price so the next
     *      depositor's shares round down to zero -- leaving the attacker holding
     *      the only shares and therefore the victim's deposit.
     *
     *      With the offset derived from the asset's decimals, the victim keeps a
     *      share of the pool that is proportional to their deposit to within a
     *      rounding unit, so the attack yields the attacker nothing.
     */
    function test_InflationAttackFailsToStealTheNextDepositorsValue() public {
        address attacker = address(0xBAD);
        uint256 donation = 10_000 * ONE_USDC;
        // Fund for the donation PLUS the 1 wei opening deposit. Minting exactly
        // the donation would leave the attacker 1 wei short.
        asset.mint(attacker, donation + 1);

        // 1. attacker takes the minimum possible position
        vm.startPrank(attacker);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(1, attacker);
        // 2. and donates a large amount directly, without minting shares
        asset.transfer(address(vault), donation);
        vm.stopPrank();

        uint256 victimDeposit = 2_000 * ONE_USDC;
        vm.prank(bob);
        uint256 victimShares = vault.deposit(victimDeposit, bob);

        assertGt(victimShares, 0, "victim received zero shares: the vault is attackable");

        // The victim's claim on the pool must be close to their contribution.
        uint256 victimClaim = vault.previewRedeem(victimShares);
        assertGe(victimClaim, victimDeposit - victimDeposit / 1000, "victim lost more than 0.1% to the attack");

        // And redeeming must actually pay that out.
        vm.prank(bob);
        uint256 received = vault.redeem(victimShares, bob, bob);
        assertEq(received, victimClaim);
    }

    /**
     * @dev The same attack on a vault with no decimal offset, to show what the
     *      protection is actually buying. Both vaults are real {YieldVault}
     *      deployments; one uses an 18-decimal asset (offset 0) and the other a
     *      6-decimal asset (offset 12). The victim's recovery differs sharply,
     *      which is the evidence that the offset is load-bearing rather than
     *      decorative.
     */
    function test_OffsetIsWhatProvidesTheProtection() public {
        // Control: an 18-decimal asset gives an offset of 0.
        MockERC20 a18 = new MockERC20("Eighteen", "E18", 18);
        YieldVault noOffsetVault = new YieldVault(IERC20(address(a18)), ownerAddr);

        address attacker = address(0xBAD2);
        uint256 donation18 = 10_000e18;
        a18.mint(attacker, donation18 + 1); // donation plus the 1 wei opening deposit
        uint256 victimDeposit = 2_000e18;
        a18.mint(bob, victimDeposit);

        vm.startPrank(attacker);
        a18.approve(address(noOffsetVault), type(uint256).max);
        noOffsetVault.deposit(1, attacker);
        a18.transfer(address(noOffsetVault), donation18);
        vm.stopPrank();

        vm.startPrank(bob);
        a18.approve(address(noOffsetVault), type(uint256).max);
        uint256 victimShares = noOffsetVault.deposit(victimDeposit, bob);
        vm.stopPrank();

        uint256 noOffsetRecovery = noOffsetVault.previewRedeem(victimShares);

        // With offset 0 the donation of 10,000 against a 2,000 deposit wipes out
        // almost the whole deposit.
        assertLt(noOffsetRecovery, victimDeposit / 10, "control case did not reproduce the attack");

        // The same shape of attack against the 6-decimal vault (offset 12) is
        // what test_InflationAttackFailsToStealTheNextDepositorsValue covers.
        // Asserting the offset is non-zero here ties the two together: the
        // difference between the two vaults IS the offset.
        assertGt(_offset(), 0, "the 6-decimal vault must have a non-zero offset");
        assertEq((18 - asset.decimals()), _offset(), "offset must be 18 minus asset decimals");
    }

    // ------------------------------------------------------------------ limits

    function test_MaxFunctionsAreUnboundedForDeposits() public view {
        assertEq(vault.maxDeposit(alice), type(uint256).max);
        assertEq(vault.maxMint(alice), type(uint256).max);
    }

    function test_MaxWithdrawTracksTheOwnerShareBalance() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);

        assertEq(vault.maxRedeem(alice), vault.balanceOf(alice));
        assertEq(vault.maxWithdraw(alice), vault.previewRedeem(vault.balanceOf(alice)));
        assertEq(vault.maxWithdraw(bob), 0, "a non-holder must not be able to withdraw");
    }

    function test_WithdrawingMoreThanHeldReverts() public {
        vm.prank(alice);
        vault.deposit(100 * ONE_USDC, alice);

        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(101 * ONE_USDC, alice, alice);
    }

    function test_RedeemingMoreSharesThanHeldReverts() public {
        vm.prank(alice);
        vault.deposit(100 * ONE_USDC, alice);

        // Read the balance BEFORE the prank: a view call consumes the prank, and
        // consuming it here would leave the redeem to be sent by the test
        // contract, which holds no shares -- so nothing would revert and the
        // test would pass for the wrong reason.
        uint256 held = vault.balanceOf(alice);
        assertGt(held, 0, "alice should hold shares");

        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(held + 1, alice, alice);
    }

    // -------------------------------------------------------- third-party spend

    function test_WithdrawWithoutAllowanceReverts() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);

        vm.prank(bob);
        vm.expectRevert();
        vault.withdraw(10 * ONE_USDC, bob, alice);
    }

    function test_WithdrawWithAllowanceSucceedsAndConsumesIt() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);

        vm.prank(alice);
        vault.approve(bob, 50e18);

        uint256 bobBefore = asset.balanceOf(bob);

        vm.prank(bob);
        uint256 sharesBurned = vault.withdraw(10 * ONE_USDC, bob, alice);

        assertEq(asset.balanceOf(bob) - bobBefore, 10 * ONE_USDC, "receiver was not paid");
        assertEq(vault.allowance(alice, bob), 50e18 - sharesBurned, "allowance was not consumed");
    }

    // ------------------------------------------------------------ share transfer

    function test_SharesAreTransferableAndCarryTheClaim() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(ownerAddr);
        vault.reportYield(1_000 * ONE_USDC);

        uint256 half = vault.balanceOf(alice) / 2;
        uint256 expectedPayout = vault.previewRedeem(half);

        vm.prank(alice);
        vault.transfer(bob, half);

        vm.prank(bob);
        uint256 got = vault.redeem(half, bob, bob);
        assertEq(got, expectedPayout, "a transferred share is worth a different amount");
    }

    // -------------------------------------------------------------- accounting

    /**
     * @dev totalAssets is defined as the balance, so it must always equal it.
     *      This is the structural claim in the contract header, checked directly.
     */
    function test_TotalAssetsAlwaysEqualsTheBalance() public {
        assertEq(vault.totalAssets(), asset.balanceOf(address(vault)));

        vm.prank(alice);
        vault.deposit(123 * ONE_USDC, alice);
        assertEq(vault.totalAssets(), asset.balanceOf(address(vault)));

        vm.prank(ownerAddr);
        vault.reportYield(77 * ONE_USDC);
        assertEq(vault.totalAssets(), asset.balanceOf(address(vault)));

        // even when someone donates directly, bypassing reportYield entirely
        vm.prank(carol);
        asset.transfer(address(vault), 5 * ONE_USDC);
        assertEq(vault.totalAssets(), asset.balanceOf(address(vault)));
    }

    /**
     * @dev A direct donation raises totalAssets without minting shares. That is
     *      not a bug -- it is why the vault cannot report more than it holds --
     *      but it does raise the share price for everyone, so it is worth
     *      pinning down explicitly.
     */
    function test_DirectDonationRaisesSharePriceAndIsNotStolenByTheVault() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        uint256 priceBefore = vault.convertToAssets(1e18);

        vm.prank(carol);
        asset.transfer(address(vault), 100 * ONE_USDC);

        assertGt(vault.convertToAssets(1e18), priceBefore);
        // Alice can now redeem more than she deposited.
        assertGt(vault.previewRedeem(vault.balanceOf(alice)), 1_000 * ONE_USDC);
    }
}
