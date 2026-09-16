// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title YieldVault
 * @notice An ERC-4626 tokenised vault that holds a single ERC-20 asset and lets
 *         anyone deposit into or withdraw from it. Yield is added by the owner
 *         transferring real assets in, which raises the value of every share.
 *
 * DESIGN NOTES (each of these is a deliberate choice, not a default):
 *
 * 1. NOT UPGRADEABLE. There is no proxy. A vault with no strategy and no
 *    external integrations has no upgrade requirement, and "no upgrade path"
 *    means "no upgrade authority", which removes an entire class of risk. The
 *    cost is that a bug cannot be fixed in place -- which is exactly why the
 *    invariant suite exists.
 *
 * 2. FULLY NON-CUSTODIAL. The vault holds the assets; no party can move them
 *    except through {deposit}, {mint}, {withdraw} and {redeem}, each of which
 *    pays out strictly according to the caller's own share balance.
 *
 * 3. totalAssets() IS THE ASSET BALANCE -- `balanceOf(address(this))` -- and is
 *    never a bookkeeping variable. This is the structural reason the vault can
 *    always pay out: what it reports is what it holds. A vault that tracks
 *    assets in a variable can drift into reporting more than it has, and then
 *    the last withdrawer cannot be paid.
 *
 * 4. THE OWNER'S ONLY PRIVILEGE IS {reportYield}, WHICH CAN ONLY ADD. It moves
 *    assets from the owner into the vault and mints nothing. It cannot remove
 *    assets, cannot target a specific user, and cannot block a withdrawal.
 *    Therefore a fully compromised owner key can send the vault money and can
 *    do nothing else. The upper bound on user loss from owner key compromise is
 *    zero, by construction rather than by operational care.
 *
 * 5. SHARES ARE ALWAYS 18 DECIMALS. See {_decimalsOffset} -- this one choice
 *    simultaneously satisfies the "mirror or exceed asset precision" guidance
 *    and sets the inflation-attack cost.
 */
contract YieldVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Emitted when the owner adds assets to the vault without minting shares.
    /// @dev ERC-4626 defines events for deposits and withdrawals only. A yield
    ///      contribution is neither, so it needs its own event or it would be
    ///      invisible to an indexer.
    event YieldReported(address indexed reporter, uint256 assets);

    /// @notice Thrown when {reportYield} is called with a zero amount.
    /// @dev A zero-value contribution would emit an event that looks like real
    ///      activity while changing nothing, so it is rejected rather than
    ///      recorded.
    error YieldAmountZero();

    /// @notice Thrown when the underlying asset reports more than 18 decimals.
    /// @dev There is no vault-internal reason for this limit other than that
    ///      shares are 18-decimal; failing loudly at construction beats silently
    ///      choosing an offset that weakens the inflation-attack protection.
    error AssetDecimalsTooHigh(uint8 assetDecimals);

    /// @notice The precision of vault shares, for every underlying asset.
    /// @dev Fixed rather than mirrored from the asset so that share amounts have
    ///      one predictable scale. See {_decimalsOffset} for why this also sets
    ///      the inflation-attack cost.
    uint8 private constant SHARE_DECIMALS = 18;

    /// @dev The decimal gap between shares and the asset, resolved once at
    ///      construction. Immutable, so {_decimalsOffset} costs nothing at
    ///      runtime and the value cannot drift.
    uint8 private immutable _decimalOffset;

    /**
     * @param asset_ The ERC-20 the vault accepts. For the Base Sepolia
     *        deployment this is the test USDC at
     *        0x036CbD53842c5426634e7929541eC2318f3dCF7e (6 decimals).
     * @param owner_ The address allowed to call {reportYield}. It has no other
     *        power; see note 4 above.
     */
    constructor(IERC20 asset_, address owner_) ERC4626(asset_) ERC20("Yield Vault Share", "yvSHARE") Ownable(owner_) {
        // Read the asset's decimals once, here, using the standard interface.
        // Doing it at construction rather than inside the view path means the
        // hot path ({decimals}, hit by every preview and every integration) does
        // no external call at all.
        uint8 assetDecimals = IERC20Metadata(address(asset_)).decimals();
        if (assetDecimals > SHARE_DECIMALS) revert AssetDecimalsTooHigh(assetDecimals);
        _decimalOffset = SHARE_DECIMALS - assetDecimals;
    }

    /**
     * @dev Makes {decimals} equal 18 for any underlying asset, and in doing so
     *      sets the inflation-attack cost.
     *
     *      OpenZeppelin's virtual-shares mechanism prepends `10**_decimalsOffset()`
     *      virtual shares and 1 virtual asset to every conversion:
     *
     *          shares = assets * (totalSupply + 10**offset) / (totalAssets + 1)
     *
     *      The classic inflation attack is: deposit 1 wei, then donate a large
     *      amount directly to the vault. The next depositor's shares round down,
     *      and the attacker -- holding the only shares -- owns the donation and
     *      the victim's deposit. With an offset of 0 the attacker needs to donate
     *      only about as much as the victim deposits.
     *
     *      With an offset of n the attacker must donate roughly 10**n times the
     *      value they hope to capture, so the attack costs far more than it can
     *      return. Taking the offset as `18 - assetDecimals` makes that factor
     *      10**12 for a 6-decimal asset such as USDC.
     *
     *      Deriving it from the asset rather than hardcoding a number has two
     *      benefits: shares are 18-decimal for every asset, and the protection
     *      scales automatically with the asset's precision instead of needing to
     *      be re-reasoned per deployment.
     *
     *      The cost of virtual shares is that they capture a vanishingly small
     *      part of accrued yield. That is the price of the protection and is
     *      accepted here.
     */
    function _decimalsOffset() internal view override returns (uint8) {
        return _decimalOffset;
    }

    /**
     * @notice Adds `amount` of the underlying asset to the vault without minting
     *         any shares, raising the value of every existing share.
     *
     * @dev Only the owner may call this, and only the owner's own assets can be
     *      moved. `totalAssets()` needs no update because it reads the asset
     *      balance (see note 3): the transfer itself is the accounting.
     *
     * @param amount The quantity of the underlying asset to contribute, in the
     *        asset's own units.
     */
    function reportYield(uint256 amount) external onlyOwner {
        if (amount == 0) revert YieldAmountZero();
        // SafeERC20 because a token that returns false instead of reverting
        // would otherwise be recorded as a successful contribution that never
        // happened.
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        emit YieldReported(msg.sender, amount);
    }
}
