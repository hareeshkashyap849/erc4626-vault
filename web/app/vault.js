/**
 * The vault, from the browser.
 *
 * TWO THINGS HERE ARE EASIER TO GET WRONG THAN THEY LOOK
 *
 * 1. The approval flow. ERC-20 requires `approve` before the vault can take
 *    tokens, so a deposit is one or two transactions depending on the current
 *    allowance. The interesting state is the one in between: the approval
 *    succeeded, so the user must NOT be asked to approve again, but the deposit
 *    did not happen, so the operation is not finished either. That is a
 *    three-state machine, not a boolean, and it is the single most common thing
 *    dApps get wrong.

 * 2. Reading after writing. Every read here goes to the chain. Nothing is
 *    updated from a transaction receipt, because a receipt says what we asked
 *    for and the chain says what happened. A balance shown from a receipt is a
 *    balance we believe in rather than a balance that exists.
 */
import { classify, describeFailure, sendAndTrack } from './wallet.js';

/**
 * viem is INJECTED as the first argument to every function that needs it, and
 * is deliberately NOT imported here.
 *
 * The vendored viem is a browser bundle: importing it at module scope would mean
 * this file cannot be loaded in Node at all, and the approval state machine --
 * the part most worth testing -- could only be tested behind a browser. Injecting
 * it keeps the pure logic pure and independently testable, which is the whole
 * reason this file has tests.
 *
 * Hence also the three definitions below that a viem import would otherwise
 * provide -- MAX_UINT256, parseUnits, formatUnits. All three are small, and all
 * three are tested directly in test/vault.test.mjs rather than assumed correct
 * because they look like a decimal shift.
 */

/*
 * THERE IS NO APPROVAL STATE MACHINE HERE, and that is deliberate.
 *
 * This file used to export `ApprovalState` (IDLE / NEEDS_APPROVAL / APPROVED) and
 * the page kept one in memory to avoid asking for a second approval. That memory
 * was the bug: it claimed an authorisation was still in place after the deposit had
 * consumed it, so a second deposit went out with an allowance of zero and reverted
 * with `ERC20InsufficientAllowance(vault, 0, 5850e6)`.
 *
 * The state that matters lives on the chain, and `nextDepositStep` reads it
 * immediately before the write. Deleting the enum rather than leaving it unused is
 * the point: dead code that models the wrong idea is an invitation to use it again.
 */

export const VAULT_ABI = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewDeposit', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewRedeem', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxWithdraw', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'Deposit', inputs: [
    { type: 'address', name: 'sender', indexed: true },
    { type: 'address', name: 'owner', indexed: true },
    { type: 'uint256', name: 'assets', indexed: false },
    { type: 'uint256', name: 'shares', indexed: false },
  ] },
  { type: 'event', name: 'Withdraw', inputs: [
    { type: 'address', name: 'sender', indexed: true },
    { type: 'address', name: 'receiver', indexed: true },
    { type: 'address', name: 'owner', indexed: true },
    { type: 'uint256', name: 'assets', indexed: false },
    { type: 'uint256', name: 'shares', indexed: false },
  ] },
];

export const ERC20_MIN_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

/**
 * `type(uint256).max`, written out rather than imported from viem.
 *
 * Same reason as `parseUnits`: an infinite allowance is a constant, and needing a
 * browser bundle to know a constant is how a pure module stops being testable.
 */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * A decimal shift: "1.5" with 6 decimals -> 1500000n.
 *
 * Deliberately NOT a general-purpose replacement for viem's `parseUnits`:
 * it accepts only `digits[.digits]`, rejects anything else, and refuses to round.
 * A silently-rounded amount is the failure mode this exists to prevent, so the
 * caller (`parseAmount`) checks the fraction length first and this throws if it
 * somehow sees one anyway. Also refuses a `.` with no digits on either side --
 * viem would read `.` as 0 and 0 passes an amount check far too easily.
 */
export function parseUnits(text, decimals) {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) throw new Error(`not a decimal number: "${text}"`);
  const whole = match[1] === '' ? 0n : BigInt(match[1]);
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  return whole * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Format base units for display: 1500000n with 6 decimals -> "1.5". */
export function formatUnits(value, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** Encode a call. A named wrapper so the injected viem dependency is explicit at
 *  each call site rather than appearing out of thin air. */
export function encodeFunctionData(viem, { abi, functionName, args }) {
  return viem.encodeFunctionData({ abi, functionName, args });
}

/**
 * Read everything the page shows, in one place.
 *
 * One function rather than five, because the page must never show a mix of
 * fresh and stale figures: reading them together means they come from the same
 * block, and a refresh cannot half-succeed.
 */
export async function readState(viem, { publicClient, vault, asset, account }) {
  const common = { abi: VAULT_ABI };
  const erc20 = { abi: ERC20_MIN_ABI };

  const [assetDecimals, shareDecimals, vaultBalance, totalAssets, totalSupply, allowance, walletBalance, symbol, maxWithdraw] =
    await Promise.all([
      publicClient.readContract({ address: asset, ...erc20, functionName: 'decimals' }),
      publicClient.readContract({ address: vault, ...common, functionName: 'decimals' }),
      account ? publicClient.readContract({ address: vault, ...common, functionName: 'balanceOf', args: [account] }) : 0n,
      publicClient.readContract({ address: vault, ...common, functionName: 'totalAssets' }),
      publicClient.readContract({ address: vault, ...common, functionName: 'totalSupply' }),
      account ? publicClient.readContract({ address: asset, ...erc20, functionName: 'allowance', args: [account, vault] }) : 0n,
      account ? publicClient.readContract({ address: asset, ...erc20, functionName: 'balanceOf', args: [account] }) : 0n,
      publicClient.readContract({ address: asset, ...erc20, functionName: 'symbol' }),
      account ? publicClient.readContract({ address: vault, ...common, functionName: 'maxWithdraw', args: [account] }) : 0n,
    ]);

  const { sharePrice, shareValue } = shareMath({ totalAssets, totalSupply, shares: vaultBalance, assetDecimals, shareDecimals });

  return {
    assetDecimals,
    shareDecimals,
    symbol,
    shares: vaultBalance,
    // Labelled "estimated" in the page: a redemption is priced at the block it
    // lands in, and `maxWithdraw` is read separately for the same reason.
    shareValue,
    totalAssets,
    totalSupply,
    allowance,
    walletBalance,
    maxWithdraw,
    sharePrice,
  };
}

/**
 * The ERC-4626 conversions this page displays, as a pure function.
 *
 * Extracted from `readState` so the arithmetic can be tested directly with
 * hand-checked numbers. It needs that: this is where the bug was. A reader can
 * check these two lines against OpenZeppelin's source far faster than they can
 * run a chain.
 *
 * OpenZeppelin's rule, verbatim from ERC4626.sol:
 *
 *     assets = shares.mulDiv(totalAssets() + 1, totalSupply() + 10 ** _decimalsOffset(), rounding)
 *     shares = assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), totalAssets() + 1, rounding)
 *
 * `_decimalsOffset()` returns a NUMBER OF DECIMAL PLACES, and OpenZeppelin raises
 * 10 to it. YieldVault sets `_decimalOffset = SHARE_DECIMALS - assetDecimals`
 * (18 - 6 = 12), so the term added to totalSupply is 10**12.
 *
 * THE EXPONENT APPLIES TWICE AND IT IS EASY TO APPLY IT ONCE -- which is exactly
 * what an earlier version of this file did, using `10 ** shareDecimals` (10**18).
 * That is 10**6 times too large a term, and it reported a per-share value that was
 * 24,038,462/25,000,000 of the truth: a 4% error that still printed as a
 * plausible-looking number, which is why it survived a reading and was caught
 * only by an integration test asserting that `shareValue` and `maxWithdraw` agree.
 */
export function shareMath({ totalAssets, totalSupply, shares, assetDecimals, shareDecimals }) {
  const virtualShares = 10n ** BigInt(shareDecimals - assetDecimals);
  const virtualAssets = 1n;

  if (totalSupply === 0n) {
    // No shares exist, so there is no price. Returning 1 would invent one.
    return { sharePrice: null, shareValue: 0n };
  }

  // The value of one whole share (`10 ** shareDecimals` share base units) in
  // asset base units, formatted with the ASSET's decimals. The multiply is by
  // 10**shareDecimals only -- an earlier version also multiplied by
  // 10**(shareDecimals - assetDecimals) to "convert to asset units", which
  // double-counted and printed 1e12 times the true price.
  const sharePrice = formatUnits(((totalAssets + virtualAssets) * 10n ** BigInt(shareDecimals)) / (totalSupply + virtualShares), assetDecimals);

  const shareValue = (shares * (totalAssets + virtualAssets)) / (totalSupply + virtualShares);

  return { sharePrice, shareValue };
}

/**
 * How much allowance is enough.
 *
 * `MAX_UINT256` is treated as always sufficient without arithmetic, because
 * adding to it overflows. An earlier shape of this compared `allowance >= amount`
 * and would have been wrong for an infinite approval by wrapping round.
 */
export function allowanceIsSufficient(allowance, amount) {
  if (allowance === MAX_UINT256) return true;
  return allowance >= amount;
}

/**
 * Decide the next step for a deposit, given the CURRENT on-chain allowance.
 *
 * THE ALLOWANCE IS THE ONLY INPUT THAT DECIDES THIS, and that is the whole point.
 *
 * An earlier version also took an `approvalState` and short-circuited on it:
 *
 *     if (approvalState === APPROVED) return { step: 'deposit', reason: 'already approved in this session' };
 *
 * That is wrong twice over, and it cost a real user a reverted transaction:
 *
 *   1. An approval is CONSUMED by the deposit that uses it. `approve(100)` then
 *      `deposit(100)` leaves an allowance of 0 -- so "approved earlier" says
 *      nothing about whether an approval exists now.
 *   2. An approval covers the AMOUNT it was for. `approve(100)` does not authorise
 *      a later `deposit(5850)`.
 *
 * The reported symptom was exactly that: deposit 100 (approve + deposit), then
 * enter 5850 and press Deposit. The page sent `deposit(5850)` with no approval
 * because it remembered the earlier one, and the vault reverted with
 * `ERC20InsufficientAllowance(vault, 0, 5850e6)`. The on-chain history shows it
 * plainly -- nonce 13 approve(100), 14 deposit(100), 15 deposit(5850) with no
 * approve, status 0.
 *
 * The stale-state argument for the short-circuit was that an allowance read might
 * predate the approval's inclusion. It cannot: this read happens immediately before
 * the write, and `deposit()` reads again itself. So the short-circuit guarded
 * against nothing while causing the bug it was meant to prevent.
 *
 * "Do not ask for a second approval" is therefore not implemented by remembering
 * anything. It falls out of reading the chain: after `approve(300)`, the allowance
 * really is 300, so the next deposit of 50 sees 300 >= 50 and goes straight through
 * with one prompt. The behaviour is preserved; the memory that broke it is gone.
 */
export function nextDepositStep({ allowance, amount }) {
  if (amount <= 0n) return { step: 'none', reason: 'amount is zero' };
  if (allowanceIsSufficient(allowance, amount)) return { step: 'deposit', reason: 'the allowance already covers this amount' };
  return { step: 'approve', reason: allowance === 0n ? 'nothing is approved yet' : 'the allowance is lower than this amount' };
}

/** Parse a user-entered amount into base units, refusing anything unusable. */
export function parseAmount(input, decimals) {
  const text = String(input ?? '').trim();
  if (text === '') throw new Error('enter an amount');
  if (!/^\d*\.?\d*$/.test(text) || text === '.') throw new Error('that is not a number');
  // More decimals than the token has would be silently truncated by parseUnits,
  // so the input is refused rather than rounded: a user who types 1.0000005 USDC
  // should be told, not given 1.000000.
  const fraction = text.split('.')[1] ?? '';
  if (fraction.length > decimals) {
    throw new Error(`this token has ${decimals} decimals, so "${text}" cannot be represented exactly`);
  }
  const value = parseUnits(text, decimals);
  if (value <= 0n) throw new Error('amount must be greater than zero');
  return value;
}

/**
 * Deposit: at most two transactions, decided entirely by the current allowance.
 *
 * The `onStage` callback is what lets the page report which of the two steps is
 * happening, so a user who sees two wallet prompts knows why.
 *
 * Note what this does NOT accept: any remembered approval. It reads the allowance
 * and decides from that, which is the only thing that cannot go stale.
 */
export async function deposit(viem, { provider, vault, asset, account, amount, onStage = () => {} }) {
  const state = await readState(viem, {
    publicClient: viem.createPublicClient({ transport: viem.custom(provider) }),
    vault,
    asset,
    account,
  });

  const { step, reason } = nextDepositStep({ allowance: state.allowance, amount });
  onStage('plan', { step, reason });

  /**
   * Check the balance BEFORE spending anything.
   *
   * A deposit larger than the wallet holds cannot succeed, and the failure has a
   * particular shape that is worth avoiding: `approve(5850)` SUCCEEDS (an approval
   * needs no balance), and only then does `deposit(5850)` revert on an insufficient
   * balance. The user pays gas for a transaction that could not have worked.
   *
   * This is easy to hit by accident because a vault with reported yield does not
   * hold round numbers -- an account displaying "5850" may hold 5849.999999, one
   * base unit short. Reading the balance first turns a paid revert into a sentence.
   */
  if (amount > state.walletBalance) {
    return {
      hash: null,
      status: 'insufficient-balance',
      stage: 'plan',
      blockedBy: 'insufficient-balance',
      needed: amount,
      held: state.walletBalance,
      shortfall: amount - state.walletBalance,
    };
  }

  if (step === 'approve') {
    const data = viem.encodeFunctionData({ abi: ERC20_MIN_ABI, functionName: 'approve', args: [vault, amount] });
    const approved = await sendAndTrack(provider, { to: asset, data, from: account }, { onStage: (s, h) => onStage('approve', { stage: s, hash: h }) });

    // The approval is only worth anything if it actually succeeded, so the deposit
    // is not attempted when it did not. Sending it anyway produces a second
    // reverted transaction, and the user pays gas to be told what is already known.
    if (approved.status !== 'success') {
      return { ...approved, stage: 'approve', blockedBy: 'approval-not-confirmed' };
    }
    onStage('approved', {});
  }

  const data = viem.encodeFunctionData({ abi: VAULT_ABI, functionName: 'deposit', args: [amount, account] });
  const result = await sendAndTrack(provider, { to: vault, data, from: account }, { onStage: (s, h) => onStage('deposit', { stage: s, hash: h }) });
  return result;
}

/** Redeem shares for assets. One transaction, no approval needed. */
export async function redeem(viem, { provider, vault, account, shares, onStage = () => {} }) {
  const data = viem.encodeFunctionData({ abi: VAULT_ABI, functionName: 'redeem', args: [shares, account, account] });
  return sendAndTrack(provider, { to: vault, data, from: account }, { onStage: (s, h) => onStage('redeem', { stage: s, hash: h }) });
}

/** Turn any thrown thing into something the page can render. */
export function toUiError(err) {
  const classified = err?.classified ?? classify(err);
  return { ...describeFailure(classified), raw: classified.message };
}
