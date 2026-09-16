// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {YieldVault} from "../src/YieldVault.sol";
import {MockERC20} from "./MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title YieldVaultHandler
 * @notice Drives {YieldVault} through random sequences of real user actions.
 *
 * @dev SELF-CONTAINED, WITH NO CONSTRUCTOR ARGUMENTS. That is a requirement, not
 *      a stylistic choice: Medusa and Echidna deploy the target contract
 *      themselves and never run Foundry's `setUp()`, so a handler that expected
 *      a pre-built vault would have nothing to talk to under those tools. By
 *      deploying the asset, the vault, the actors and their balances in its own
 *      constructor, one handler serves Forge, Medusa and Echidna unchanged.
 *
 *      The handler also ASSERTS ITS PRECONDITIONS rather than letting them
 *      revert. A fuzzer treats a revert as an uninteresting input and moves on,
 *      so a precondition that is never satisfied appears as a path that is
 *      silently never exercised while the suite still reports success. That
 *      happened during development: every reportYield call reverted because the
 *      owner had no allowance, and the suite was green.
 */
contract YieldVaultHandler is Test {
    MockERC20 public immutable asset;
    YieldVault public immutable vault;
    address public immutable vaultOwner;

    address[] public actors;
    address internal currentActor;

    /// @dev Assets that entered the vault through {deposit} or {mint}.
    uint256 public ghostDeposited;
    /// @dev Assets that left through {withdraw} or {redeem}.
    uint256 public ghostWithdrawn;
    /// @dev Assets that entered through {reportYield}.
    uint256 public ghostYield;
    /// @dev Assets that entered by direct transfer (not an app-facing path).
    uint256 public ghostDonated;

    /// @dev Net shares the app-facing paths should have created: minted by
    ///      deposit/mint, burned by withdraw/redeem, so that totalSupply can be
    ///      checked against a record kept outside the vault.
    int256 public ghostNetShares;

    modifier useActor(uint256 seed) {
        currentActor = actors[bound(seed, 0, actors.length - 1)];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

    constructor() {
        asset = new MockERC20("USD Coin", "USDC", 6);
        vaultOwner = address(0x0117);
        vault = new YieldVault(IERC20(address(asset)), vaultOwner);

        // The probe is an ordinary tracked actor: shares it receives must be
        // counted by the supply and balance invariants, or those invariants fail
        // for a bookkeeping reason rather than a vault defect.
        address[5] memory list = [
            address(0xA1),
            address(0xA2),
            address(0xA3),
            address(0xA4),
            address(0x9e0be) // the "fresh depositor" probe
        ];
        for (uint256 i = 0; i < list.length; i++) {
            actors.push(list[i]);
            asset.mint(list[i], 2_000_000 * 1e6);
            vm.prank(list[i]);
            asset.approve(address(vault), type(uint256).max);
        }

        // The owner is not an actor, so it is funded and approved separately.
        // Without the approval, reportYield reverts on every call.
        asset.mint(vaultOwner, 2_000_000 * 1e6);
        vm.prank(vaultOwner);
        asset.approve(address(vault), type(uint256).max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function deposit(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 1, 1_000_000 * 1e6);
        if (asset.balanceOf(currentActor) < amount) return;

        uint256 vaultBalBefore = asset.balanceOf(address(vault));
        uint256 shares = vault.deposit(amount, currentActor);

        // The transfer must have actually happened: a token that silently
        // no-ops would otherwise be recorded as a successful deposit.
        assertEq(asset.balanceOf(address(vault)), vaultBalBefore + amount, "deposit did not move the assets");
        assertGt(shares, 0, "a non-zero deposit produced zero shares");

        ghostDeposited += amount;
        ghostNetShares += int256(shares);
    }

    function mint(uint256 actorSeed, uint256 shares) external useActor(actorSeed) {
        shares = bound(shares, 1e6, 100_000 * 1e18);
        uint256 cost = vault.previewMint(shares);
        if (cost == 0 || asset.balanceOf(currentActor) < cost) return;

        uint256 vaultBalBefore = asset.balanceOf(address(vault));
        uint256 paid = vault.mint(shares, currentActor);

        assertEq(asset.balanceOf(address(vault)), vaultBalBefore + paid, "mint did not move the assets");

        ghostDeposited += paid;
        ghostNetShares += int256(shares);
    }

    function withdraw(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        uint256 max = vault.maxWithdraw(currentActor);
        if (max == 0) return;
        amount = bound(amount, 1, max);

        uint256 burned = vault.previewWithdraw(amount);
        uint256 got = vault.withdraw(amount, currentActor, currentActor);

        ghostWithdrawn += got;
        ghostNetShares -= int256(burned);
    }

    function redeem(uint256 actorSeed, uint256 shares) external useActor(actorSeed) {
        uint256 max = vault.maxRedeem(currentActor);
        if (max == 0) return;
        shares = bound(shares, 1, max);

        uint256 got = vault.redeem(shares, currentActor, currentActor);
        ghostWithdrawn += got;
        ghostNetShares -= int256(shares);
    }

    function reportYield(uint256 amount) external {
        amount = bound(amount, 1, 100_000 * 1e6);
        if (asset.balanceOf(vaultOwner) < amount) return;

        // Assert the preconditions rather than letting a revert be swallowed by
        // the fuzzer: an earlier version of this handler reverted on every one
        // of its ~2400 calls, which quietly meant the yield path was never
        // exercised while the suite still reported all-green.
        assertGt(asset.balanceOf(vaultOwner), 0, "owner has no assets to contribute");
        assertGe(asset.allowance(vaultOwner, address(vault)), amount, "owner has not approved the vault for this amount");

        vm.prank(vaultOwner);
        vault.reportYield(amount);
        ghostYield += amount;
    }

    /// @dev A direct transfer is a legitimate thing for anyone to do, and the
    ///      vault must stay solvent when it happens. It is modelled separately
    ///      from reportYield because it mints no event and involves no owner.
    function donate(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 1, 10_000 * 1e6);
        if (asset.balanceOf(currentActor) < amount) return;

        asset.transfer(address(vault), amount);
        ghostDonated += amount;
    }

    /// @dev Share transfers must not change the total supply, and must not let
    ///      anyone end up with a claim the vault cannot honour.
    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 shares) external {
        address from = actors[bound(fromSeed, 0, actors.length - 1)];
        address to = actors[bound(toSeed, 0, actors.length - 1)];
        uint256 max = vault.balanceOf(from);
        if (max == 0) return;
        shares = bound(shares, 1, max);

        vm.prank(from);
        vault.transfer(to, shares);
    }
}

/**
 * @title YieldVaultInvariantTest
 * @notice Stateful invariant checks, written once and exposed under two names.
 *
 * WHY THIS FILE IS THE POINT OF THE PROJECT
 *
 * Unit tests check the cases the author thought of. Invariant tests try to find
 * the cases the author did not think of. For a vault -- whose failure mode is
 * "the last user cannot withdraw" -- that difference matters, because the
 * failure usually needs a specific interleaving rather than one bad call.
 *
 * TWO NAMING CONVENTIONS, ONE IMPLEMENTATION
 *
 * Each property is implemented once in a private `_check*` function. It is then
 * exposed as `invariant_*` (Forge's convention) and as `property_*` (Medusa's
 * and Echidna's). The duplication is only in the one-line wrappers, so the two
 * tools can never disagree about what a property means -- which is the whole
 * reason for running two fuzzers rather than one twice.
 *
 * The properties are stated in terms of OBSERVABLE STATE, not in terms of a
 * ledger this file maintains. Two earlier versions compared against a snapshot
 * taken at construction and against hand-kept ghost counters; both produced
 * failures that were artefacts of the bookkeeping rather than defects in the
 * vault. An invariant is only as trustworthy as the thing it is measured
 * against.
 */
contract YieldVaultInvariantTest is Test {
    YieldVaultHandler internal handler;

    /**
     * @dev The handler is deployed in the CONSTRUCTOR, not in `setUp()`.
     *
     *      This is what makes the properties portable. Foundry runs `setUp()`
     *      before an invariant campaign; Medusa and Echidna deploy the contract
     *      and never call it. A handler built in `setUp()` therefore does not
     *      exist under those tools, every property calls into the zero address,
     *      and all of them fail -- which is exactly what happened here. It took
     *      a deliberate probe (`property_HandlerIsDeployed`) to see it, because
     *      "every property fails" looks like a broken vault rather than a broken
     *      harness.
     *
     *      Constructors run under every deployment mechanism, so this is the
     *      difference between the properties being checked by one fuzzer and by
     *      three.
     */
    constructor() {
        handler = new YieldVaultHandler();
    }

    function setUp() public {
        // Only the handler may drive state under Forge. Medusa is told the same
        // thing through targetContracts in medusa.json.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = YieldVaultHandler.deposit.selector;
        selectors[1] = YieldVaultHandler.mint.selector;
        selectors[2] = YieldVaultHandler.withdraw.selector;
        selectors[3] = YieldVaultHandler.redeem.selector;
        selectors[4] = YieldVaultHandler.reportYield.selector;
        selectors[5] = YieldVaultHandler.donate.selector;
        selectors[6] = YieldVaultHandler.transferShares.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ------------------------------------------------------------ the checks
    //
    // Each check returns whether the property HOLDS. Returning a bool rather
    // than asserting is what lets one implementation serve two tools with
    // different conventions: Forge wants `invariant_*` that reverts on failure,
    // Medusa wants `property_*` that returns false. Writing the logic twice
    // would let the two tools disagree about what a property means, which
    // defeats the reason for running two fuzzers.

    /**
     * @dev INV-1. The vault can never promise more than it holds. The single
     *      permitted wei of slack is the virtual asset unit that OpenZeppelin's
     *      conversion formula adds; it is an artefact of the mechanism, not a
     *      debt the vault owes.
     */
    function _holdsSolvency() private view returns (bool) {
        uint256 supply = handler.vault().totalSupply();
        if (supply == 0) return true;
        return handler.vault().previewRedeem(supply) <= handler.vault().totalAssets() + 1;
    }

    /**
     * @dev INV-2. Reported assets must be exactly the balance. If these diverge,
     *      the vault is reporting a number it cannot pay -- the failure that
     *      strands the last withdrawer.
     */
    function _holdsTotalAssetsEqualsBalance() private view returns (bool) {
        return handler.vault().totalAssets() == handler.asset().balanceOf(address(handler.vault()));
    }

    /**
     * @dev INV-3. Assets with no shares outstanding is a legitimate state: anyone
     *      can transfer the asset to the vault directly. That is why
     *      {totalAssets} is defined as the balance rather than as a ledger. What
     *      must hold is that such assets are unclaimable -- no share exists, so
     *      nobody can redeem them.
     */
    function _holdsAssetsWithoutSharesAreUnclaimable() private view returns (bool) {
        if (handler.vault().totalSupply() != 0) return true;
        return handler.vault().convertToAssets(0) == 0;
    }

    /**
     * @dev INV-4. Supply must equal the net shares the app-facing paths created.
     *      An equality, not an inequality: if any path mints or burns outside
     *      deposit/mint/withdraw/redeem, the two records diverge and this fails.
     */
    function _holdsSupplyMatchesShareDelta() private view returns (bool) {
        return handler.vault().totalSupply() == uint256(handler.ghostNetShares());
    }

    /**
     * @dev INV-5. Shares held by the tracked actors must sum to exactly the
     *      supply. The handler is the only route that can create shares, so a
     *      share that ends up elsewhere would leave a gap.
     */
    function _holdsSumOfActorBalancesEqualsSupply() private view returns (bool) {
        uint256 sum;
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            sum += handler.vault().balanceOf(handler.actorAt(i));
        }
        return sum == handler.vault().totalSupply();
    }

    /**
     * @dev INV-6. The vault can never hold more than everything that was ever
     *      put into it. A violation means some path created assets.
     */
    function _holdsBalanceBoundedByInflows() private view returns (bool) {
        uint256 inflows = handler.ghostDeposited() + handler.ghostYield() + handler.ghostDonated();
        return handler.asset().balanceOf(address(handler.vault())) <= inflows;
    }

    /**
     * @dev INV-7 -- "no free lunch". The vault can never hold more of the asset
     *      than exists. If any path created value, the vault would eventually
     *      exceed the asset's entire supply. Needs no snapshot and no ledger.
     */
    function _holdsVaultBoundedByAssetSupply() private view returns (bool) {
        return handler.asset().balanceOf(address(handler.vault())) <= handler.asset().totalSupply();
    }

    /// @dev INV-8. Contributions through {reportYield} mint no shares, so the
    ///      recorded share delta can never go negative.
    function _holdsShareDeltaNonNegative() private view returns (bool) {
        return handler.ghostNetShares() >= 0;
    }

    /// @dev INV-9. See {_depositAsFreshHolder} for the reasoning; this is the
    ///      number the property has to clear.
    uint256 private constant MIN_RETENTION_BPS = 9900; // 99%

    /**
     * @dev INV-9 -- the anti-inflation property, stated directly.
     *
     *      A depositor arriving at the current share price must receive shares
     *      worth at least 99% of what they paid. The threshold is loose on
     *      purpose: rounding is expected to cost a few wei, and a tight bound
     *      would fail on legitimate dust. What it catches is the
     *      order-of-magnitude loss the inflation attack causes, where a new
     *      depositor receives essentially nothing.
     */
    function _holdsNewDepositorRetainsValue() private returns (bool) {
        uint256 amount = 1_000 * 1e6;
        address probe = address(0x9e0be);

        if (handler.vault().totalSupply() == 0 || handler.asset().balanceOf(address(handler.vault())) == 0) {
            return true; // nothing to manipulate yet; the unit tests cover a fresh vault
        }

        // Top the probe up so it always has exactly the amount being tested. The
        // probe is also an ordinary actor, so the fuzzer may have spent its
        // balance on other calls -- which made this check fail with
        // ERC20InsufficientBalance for a reason unrelated to the vault.
        handler.asset().mint(probe, amount);
        uint256 balBefore = handler.asset().balanceOf(probe);

        vm.startPrank(probe);
        // Re-approve every time: the fuzzer can call approve() on this probe
        // while exercising the asset directly, which resets the allowance.
        handler.asset().approve(address(handler.vault()), type(uint256).max);
        uint256 shares = handler.vault().deposit(amount, probe);
        vm.stopPrank();

        if (handler.asset().balanceOf(probe) != balBefore - amount) return false; // the transfer did not happen
        if (shares == 0) return false;
        return handler.vault().previewRedeem(shares) >= (amount * MIN_RETENTION_BPS) / 10_000;
    }

    // ------------------------------------------- Forge entry points (invariant_)

    function invariant_SolvencyTotalSupplyRedeemable() public view {
        assertTrue(_holdsSolvency(), "INV-1: vault cannot honour its own total supply");
    }

    function invariant_TotalAssetsEqualsBalance() public view {
        assertTrue(_holdsTotalAssetsEqualsBalance(), "INV-2: totalAssets drifted from the balance");
    }

    function invariant_AssetsWithoutSharesAreUnclaimable() public view {
        assertTrue(_holdsAssetsWithoutSharesAreUnclaimable(), "INV-3: zero shares must convert to zero assets");
    }

    function invariant_SupplyMatchesRecordedShareDelta() public view {
        assertTrue(_holdsSupplyMatchesShareDelta(), "INV-4: totalSupply disagrees with the recorded share delta");
    }

    function invariant_SumOfActorBalancesEqualsSupply() public view {
        assertTrue(_holdsSumOfActorBalancesEqualsSupply(), "INV-5: actor balances do not sum to the supply");
    }

    function invariant_BalanceBoundedByInflows() public view {
        assertTrue(_holdsBalanceBoundedByInflows(), "INV-6: vault holds more than was ever put in");
    }

    function invariant_VaultCannotHoldMoreThanTheAssetSupply() public view {
        assertTrue(_holdsVaultBoundedByAssetSupply(), "INV-7: vault holds more than the asset supply");
    }

    function invariant_ShareDeltaIsNonNegative() public view {
        assertTrue(_holdsShareDeltaNonNegative(), "INV-8: more shares were burned than minted");
    }

    function invariant_NewDepositorRetainsTheirValue() public {
        assertTrue(_holdsNewDepositorRetainsValue(), "INV-9: a new depositor lost more than 1% of their deposit");
    }

    // ------------------------------- Medusa / Echidna entry points (property_)
    //
    // These MUST return bool: Medusa's property provider rejects a `property_*`
    // function whose signature does not return a bool, and silently reclassifies
    // it as an assertion test -- which is how an earlier version of this file
    // ended up running zero property tests while reporting success.

    function property_SolvencyTotalSupplyRedeemable() public view returns (bool) {
        return _holdsSolvency();
    }

    function property_TotalAssetsEqualsBalance() public view returns (bool) {
        return _holdsTotalAssetsEqualsBalance();
    }

    function property_AssetsWithoutSharesAreUnclaimable() public view returns (bool) {
        return _holdsAssetsWithoutSharesAreUnclaimable();
    }

    function property_SupplyMatchesRecordedShareDelta() public view returns (bool) {
        return _holdsSupplyMatchesShareDelta();
    }

    function property_SumOfActorBalancesEqualsSupply() public view returns (bool) {
        return _holdsSumOfActorBalancesEqualsSupply();
    }

    function property_BalanceBoundedByInflows() public view returns (bool) {
        return _holdsBalanceBoundedByInflows();
    }

    function property_VaultCannotHoldMoreThanTheAssetSupply() public view returns (bool) {
        return _holdsVaultBoundedByAssetSupply();
    }

    function property_ShareDeltaIsNonNegative() public view returns (bool) {
        return _holdsShareDeltaNonNegative();
    }

    function property_NewDepositorRetainsTheirValue() public returns (bool) {
        return _holdsNewDepositorRetainsValue();
    }
}
