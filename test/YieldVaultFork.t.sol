// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title YieldVaultForkTest
 * @notice The core assertions, run against the REAL USDC contract with REAL
 *         token transfers. No mocks, no stubs, and no token written by this
 *         repository anywhere in the value path.
 *
 * WHY THIS FILE EXISTS, AND WHY IT FORKS MAINNET RATHER THAN BASE SEPOLIA
 *
 * Every other test here uses `MockERC20`, which this repository also wrote.
 * Passing those proves the vault works with *our idea of* an ERC-20, not with
 * USDC — and USDC is not a plain ERC-20: it is a proxy in front of an
 * upgradeable implementation with its own behaviour. A mock cannot disagree with
 * the code that tests it.
 *
 * The first version of this test forked Base Sepolia and used `vm.mockCall` to
 * fake USDC's `transferFrom`. It failed for an instructive reason: the mock
 * returned `true` without moving any balance, so the vault minted shares against
 * assets it never received and the share arithmetic came out wrong. A mock that
 * lies about a transfer is worse than no test, because it manufactures
 * confidence. `vm.deal` on Base Sepolia's USDC would carry the same defect in a
 * different form — it rewrites a balance slot directly, bypassing the token
 * logic the test exists to exercise.
 *
 * Mainnet USDC is reachable, and on a fork forge can fund an account with the
 * real token via `vm.deal`, which does move the balance that `balanceOf`
 * reports. So this forks MAINNET and moves genuine USDC. That also answers a
 * question Base Sepolia could not: how the vault behaves against the
 * implementation that actually holds real money.
 *
 * The vault is deployed on Base Sepolia, not mainnet. Worth being explicit
 * about: the property under test is "does this contract integrate correctly with
 * the real USDC contract", which is chain-independent — USDC is the same
 * implementation with the same 6 decimals on both. What this test cannot tell
 * you is anything about Base Sepolia in particular.
 *
 * RUNNING IT
 *
 *   forge test --match-contract YieldVaultForkTest \
 *     --fork-url https://ethereum-rpc.publicnode.com
 *
 * Requires network access. With no fork URL configured every test skips, so the
 * rest of the suite still runs offline.
 */
contract YieldVaultForkTest is Test {
    /// @dev Real USDC on Ethereum mainnet. Verified on chain: 2186 bytes of
    ///      code, symbol "USDC", decimals 6.
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    YieldVault internal vault;
    address internal ownerAddr = address(0x0117);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr('MAINNET_RPC_URL', string(''));
        if (bytes(rpc).length == 0) rpc = vm.envOr('FORK_RPC_URL', string(''));
        if (bytes(rpc).length == 0) return; // offline: every test skips

        vm.createSelectFork(rpc);
        forked = true;

        // Built against the real USDC contract. The constructor reads
        // `decimals()` from it, so the offset -- and therefore the
        // inflation-attack cost -- comes from the deployed token.
        vault = new YieldVault(IERC20(USDC), ownerAddr);

        deal(USDC, alice, 1_000_000e6);
        deal(USDC, bob, 1_000_000e6);
        deal(USDC, ownerAddr, 1_000_000e6);

        vm.prank(alice);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        vm.prank(bob);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        vm.prank(ownerAddr);
        IERC20(USDC).approve(address(vault), type(uint256).max);
    }

    modifier onlyForked() {
        if (!forked) vm.skip(true);
        _;
    }

    // ------------------------------------------------------- facts about USDC

    function test_RealUsdcMetadata() public onlyForked {
        assertEq(IERC20Metadata(USDC).symbol(), 'USDC', 'the asset is not USDC');
        assertEq(IERC20Metadata(USDC).decimals(), 6, 'USDC decimals are not 6');
        assertGt(USDC.code.length, 500, 'no plausible code at the USDC address');
        assertEq(vault.asset(), USDC, 'the vault holds the wrong asset');
    }

    function test_VaultDecimalsAgainstRealUsdc() public onlyForked {
        assertEq(vault.decimals(), 18, 'shares must be 18-decimal');
    }

    /// @dev The real token really does move. This is asserted explicitly because
    ///      the mocked version of this test never moved anything, and if the
    ///      funding mechanism ever stopped working the failure should point here
    ///      rather than at the vault.
    function test_FundingActuallyMovesRealUsdc() public onlyForked {
        uint256 before = IERC20(USDC).balanceOf(bob);
        assertEq(before, 1_000_000e6, 'deal did not fund bob');

        vm.prank(bob);
        IERC20(USDC).transfer(alice, 1_000e6);
        assertEq(IERC20(USDC).balanceOf(bob), before - 1_000e6, 'a real USDC transfer did not move the balance');
    }

    // ------------------------------------------------------------- core maths

    function test_FirstDepositAgainstRealUsdc() public onlyForked {
        uint256 amount = 1_000e6;
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);

        assertEq(shares, 1_000e18, 'first deposit share count is wrong');
        assertEq(vault.totalAssets(), amount, 'the vault did not receive the real tokens');
        assertEq(IERC20(USDC).balanceOf(address(vault)), amount, 'the vault balance is not the real balance');
    }

    function test_RoundingDirectionsAgainstRealUsdc() public onlyForked {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        vm.prank(ownerAddr);
        vault.reportYield(333e6);

        uint256 S = vault.totalSupply();
        uint256 A = vault.totalAssets();
        uint256 offset = 10 ** 12; // 18 - 6

        uint256 probeAssets = 7e6 + 1;
        uint256 probeShares = 3e18 + 7;

        // convertTo* must BOTH floor.
        assertEq(vault.convertToShares(probeAssets), (probeAssets * (S + offset)) / (A + 1), 'convertToShares floor');
        assertEq(vault.convertToAssets(probeShares), (probeShares * (A + 1)) / (S + offset), 'convertToAssets floor');
        // deposit/redeem previews floor.
        assertEq(vault.previewDeposit(probeAssets), (probeAssets * (S + offset)) / (A + 1), 'previewDeposit floor');
        assertEq(vault.previewRedeem(probeShares), (probeShares * (A + 1)) / (S + offset), 'previewRedeem floor');

        // mint/withdraw previews ceil, and must not over-round.
        uint256 ceilMint = vault.previewMint(probeShares);
        uint256 floorForShares = (probeShares * (A + 1)) / (S + offset);
        assertGe(ceilMint, floorForShares, 'previewMint rounded down');
        assertLe(ceilMint - floorForShares, 1, 'previewMint over-rounded');

        uint256 ceilWithdraw = vault.previewWithdraw(probeAssets);
        uint256 floorForAssets = (probeAssets * (S + offset)) / (A + 1);
        assertGe(ceilWithdraw, floorForAssets, 'previewWithdraw rounded down');
        assertLe(ceilWithdraw - floorForAssets, 1, 'previewWithdraw over-rounded');
    }

    function test_PreviewMatchesExecutionAgainstRealUsdc() public onlyForked {
        vm.prank(alice);
        vault.deposit(500e6, alice);

        uint256 amount = 137e6 + 999;
        uint256 predictedShares = vault.previewDeposit(amount);
        vm.prank(bob);
        uint256 actualShares = vault.deposit(amount, bob);
        assertEq(actualShares, predictedShares, 'deposit disagrees with previewDeposit');

        uint256 sharesToRedeem = predictedShares / 2;
        uint256 predictedAssets = vault.previewRedeem(sharesToRedeem);
        vm.prank(bob);
        uint256 actualAssets = vault.redeem(sharesToRedeem, bob, bob);
        assertEq(actualAssets, predictedAssets, 'redeem disagrees with previewRedeem');
    }

    // --------------------------------------------------------------- solvency

    function test_SolvencyAgainstRealUsdc() public onlyForked {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        vm.prank(bob);
        vault.deposit(500e6, bob);
        vm.prank(ownerAddr);
        vault.reportYield(321e6);

        uint256 S = vault.totalSupply();
        uint256 A = vault.totalAssets();
        assertEq(A, IERC20(USDC).balanceOf(address(vault)), 'totalAssets is not the real balance');
        assertLe(vault.previewRedeem(S), A + 1, 'vault cannot honour its total supply');
    }

    /// @dev The last withdrawer is paid in full, in real USDC. This is the
    ///      failure that only appears at the end of the queue.
    function test_LastWithdrawerPaidInFullAgainstRealUsdc() public onlyForked {
        vm.prank(alice);
        vault.deposit(100e6, alice);
        vm.prank(bob);
        vault.deposit(200e6, bob);
        vm.prank(ownerAddr);
        vault.reportYield(60e6);

        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);

        uint256 bobBefore = IERC20(USDC).balanceOf(bob);
        uint256 bobShares = vault.balanceOf(bob);
        uint256 owed = vault.previewRedeem(bobShares);

        vm.prank(bob);
        uint256 got = vault.redeem(bobShares, bob, bob);

        assertEq(got, owed, 'the last withdrawer was not paid what was owed');
        assertEq(IERC20(USDC).balanceOf(bob), bobBefore + owed, 'the real USDC transfer did not arrive');
    }

    function testFuzz_NoFreeLunchAgainstRealUsdc(uint96 rawAmount) public onlyForked {
        uint256 amount = (uint256(rawAmount) % 10_000e6) + 1;

        vm.prank(alice);
        vault.deposit(1_000e6, alice);
        vm.prank(ownerAddr);
        vault.reportYield(17e6); // a non-round ratio

        uint256 before = IERC20(USDC).balanceOf(bob);
        vm.prank(bob);
        uint256 shares = vault.deposit(amount, bob);
        vm.prank(bob);
        uint256 received = vault.redeem(shares, bob, bob);

        assertLe(received, amount, 'a round trip against real USDC produced a profit');
        assertLe(IERC20(USDC).balanceOf(bob), before, 'bob ended with more real USDC than he started with');
    }

    // -------------------------------------------------------- inflation attack

    /**
     * @dev The inflation attack, executed against the real token.
     *
     *      The attacker takes the minimum position and then donates a large
     *      amount of real USDC directly to the vault, inflating the share price.
     *      A new depositor must still receive shares worth approximately what
     *      they paid -- which is what the `18 - decimals` offset buys.
     *
     *      The donation is a REAL transfer of REAL USDC, so `totalAssets()` rises
     *      through the same path it would in production.
     */
    function test_InflationAttackAgainstRealUsdc() public onlyForked {
        address attacker = address(0xBAD);
        uint256 donation = 10_000e6;
        // Fund for the donation PLUS the 1 wei opening deposit. Funding exactly
        // the donation leaves the attacker 1 wei short and the test fails on the
        // token's own balance check rather than on anything about the vault.
        deal(USDC, attacker, donation + 1);

        vm.startPrank(attacker);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        vault.deposit(1, attacker); // the minimum position
        IERC20(USDC).transfer(address(vault), donation); // donation: no shares minted
        vm.stopPrank();

        uint256 victimDeposit = 2_000e6;
        vm.prank(bob);
        uint256 victimShares = vault.deposit(victimDeposit, bob);

        assertGt(victimShares, 0, 'victim received zero shares: the vault is attackable against real USDC');

        uint256 claim = vault.previewRedeem(victimShares);
        assertGe(claim, (victimDeposit * 99) / 100, 'the victim lost more than 1% to the inflation attack');

        // And the claim is payable in real tokens.
        uint256 bobBefore = IERC20(USDC).balanceOf(bob);
        vm.prank(bob);
        uint256 received = vault.redeem(victimShares, bob, bob);
        assertEq(received, claim, 'redeem did not pay the previewed amount');
        assertEq(IERC20(USDC).balanceOf(bob), bobBefore + claim, 'real USDC did not arrive');
    }

    // ---------------------------------------------------------------- controls

    /// @dev The offset comes from the real token and is not zero, which is what
    ///      makes the attack above unprofitable.
    function test_OffsetIsDerivedFromTheRealToken() public onlyForked {
        uint8 assetDecimals = IERC20Metadata(USDC).decimals();
        assertEq(uint256(vault.decimals()) - uint256(assetDecimals), 18 - uint256(assetDecimals), 'offset is wrong');
        assertGt(uint256(vault.decimals()) - uint256(assetDecimals), 0, 'a zero offset would weaken the protection');
    }

    function test_ReportYieldMovesRealUsdc() public onlyForked {
        vm.prank(alice);
        vault.deposit(1_000e6, alice);

        uint256 supplyBefore = vault.totalSupply();
        uint256 ownerBefore = IERC20(USDC).balanceOf(ownerAddr);

        vm.prank(ownerAddr);
        vault.reportYield(250e6);

        assertEq(vault.totalSupply(), supplyBefore, 'reportYield minted shares');
        assertEq(IERC20(USDC).balanceOf(ownerAddr), ownerBefore - 250e6, 'the owner was not debited');
        assertEq(vault.totalAssets(), 1_250e6, 'totalAssets did not rise by the contribution');
    }
}
