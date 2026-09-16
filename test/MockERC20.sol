// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice A minimal ERC-20 with configurable decimals, used as the vault's
 *         asset in unit tests.
 *
 * @dev This exists so tests can use the real 6-decimal precision of USDC
 *      without touching the network. It is NOT a substitute for testing against
 *      the real token: see the fork test, which runs the same assertions against
 *      Base Sepolia's actual USDC. Testing only against a mock issued by this
 *      repository would be evidence that the vault works with *this* token, not
 *      with USDC.
 *
 *      `mint` is unrestricted on purpose -- it is a test double, and the vault
 *      never gives this contract any authority.
 */
contract MockERC20 is ERC20 {
    uint8 private immutable _DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
