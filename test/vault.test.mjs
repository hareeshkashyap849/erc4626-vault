/**
 * Tests for the vault interaction layer.
 *
 * WHAT IS TESTED HERE AND WHY IT IS THE INTERESTING PART
 *
 * The approval flow. A deposit is one or two transactions depending on the
 * current allowance, and the state that matters is the one between them: an
 * approval that succeeded must not be repeated, but the operation is not
 * finished either. Getting that wrong produces one of two visible bugs --
 * asking the user to approve twice, or sending a deposit that reverts -- and
 * neither shows up until someone uses the page with a real wallet.
 *
 * Also tested: amount parsing, because a dApp that silently rounds 1.0000005
 * USDC down to 1.000000 has taken something from the user and said nothing.
 *
 * NOT tested: the calls themselves against a real chain. That needs a browser
 * and a wallet, and it is the manual checklist in web/DESIGN.md §7.
 *
 * Run: node test/vault.test.mjs
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ApprovalState, MAX_UINT256, allowanceIsSufficient, formatUnits, nextDepositStep, parseAmount, parseUnits, shareMath, toUiError } from '../web/app/vault.js';
import { FailureClass, USER_REJECTED } from '../web/app/wallet.js';

const USDC = 1_000_000n; // one USDC at 6 decimals

// -------------------------------------------------------- parseUnits/formatUnits
//
// These are ours, not viem's, because importing viem at module scope would drag a
// browser bundle into what is otherwise pure logic. That trade is only worth it if
// our versions are actually correct, so they are tested directly rather than
// trusted because "it is only a decimal shift".

test('parseUnits shifts a whole number', () => {
  assert.equal(parseUnits('1', 6), USDC);
});

test('parseUnits shifts a fraction', () => {
  assert.equal(parseUnits('1.5', 6), 1_500_000n);
});

test('parseUnits pads a short fraction to full width', () => {
  assert.equal(parseUnits('1.5', 6), parseUnits('1.500000', 6));
});

test('parseUnits handles a leading-dot fraction', () => {
  assert.equal(parseUnits('.5', 6), 500_000n);
});

test('parseUnits handles a trailing dot', () => {
  assert.equal(parseUnits('5.', 6), 5n * USDC);
});

test('parseUnits handles zero decimals', () => {
  assert.equal(parseUnits('7', 0), 7n);
});

test('parseUnits rejects a bare dot rather than calling it zero', () => {
  assert.throws(() => parseUnits('.', 6), /not a decimal number/);
});

test('parseUnits rejects an empty string', () => {
  assert.throws(() => parseUnits('', 6), /not a decimal number/);
});

test('parseUnits rejects a negative sign', () => {
  assert.throws(() => parseUnits('-1', 6), /not a decimal number/);
});

test('parseUnits rejects a non-numeric string', () => {
  assert.throws(() => parseUnits('1e6', 6), /not a decimal number/);
});

test('parseUnits refuses to round a fraction that does not fit', () => {
  assert.throws(() => parseUnits('1.0000005', 6), /more than 6 decimal places/);
});

test('formatUnits drops trailing zeros', () => {
  assert.equal(formatUnits(USDC, 6), '1');
});

test('formatUnits keeps a meaningful fraction', () => {
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
});

test('formatUnits pads a small fraction', () => {
  assert.equal(formatUnits(1n, 6), '0.000001');
});

test('formatUnits handles zero', () => {
  assert.equal(formatUnits(0n, 6), '0');
});

test('parseUnits and formatUnits round-trip', () => {
  for (const text of ['0.000001', '1', '1.5', '123456.789012', '999999999']) {
    assert.equal(formatUnits(parseUnits(text, 6), 6), text, `round-trip failed for ${text}`);
  }
});

// ---------------------------------------------------------------- shareMath
//
// These are hand-checked numbers, not captured output. Every one of them was
// computed from OpenZeppelin's formula
//     assets = shares * (totalAssets + 1) / (totalSupply + 10 ** _decimalsOffset())
// with _decimalsOffset() == 18 - 6 == 12, so the term added to totalSupply is
// 10**12. They are written out because this arithmetic had a bug that unit tests
// would have caught and the integration test had to.

const M = (
  totalAssets,
  totalSupply,
  shares,
) => shareMath({ totalAssets, totalSupply, shares, assetDecimals: 6, shareDecimals: 18 });

test('shareMath reports no price for an empty vault rather than inventing one', () => {
  const { sharePrice, shareValue } = M(0n, 0n, 0n);
  assert.equal(sharePrice, null, 'an empty vault has no share price');
  assert.equal(shareValue, 0n);
});

test('shareMath prices one whole share at about one asset right after the first deposit', () => {
  // 25 USDC deposited into an empty vault mints 25e6 * 1e12 = 2.5e19 shares.
  const shares = 25_000_000n * 10n ** 12n;
  const { sharePrice, shareValue } = M(25_000_000n, shares, shares);

  // (A + 1) * 1e18 / (S + 1e12) = 25000001e18 / 25000001e12 -> 1e6, i.e. "1.000000".
  assert.equal(sharePrice, '1', 'one share is one asset to six decimals');
  assert.equal(shareValue, 25_000_000n, 'and the depositor can take all 25 back');
});

/**
 * @dev The regression test for the bug this file was extended for.
 *
 * `shares * (A+1) / (S + 10**1e18)` instead of `(S + 10**12)` makes the
 * denominator 1e6 too large and returns 24,038,462 here where the answer is
 * 25,000,000. The wrong answer is a plausible-looking number, which is the whole
 * reason it needs a test rather than care.
 */
test('shareMath uses 10**offset, not 10**shareDecimals, as the virtual-share term', () => {
  const shares = 25_000_000n * 10n ** 12n;

  const right = M(25_000_000n, shares, shares).shareValue;
  const wrongDenominator = (shares * (25_000_000n + 1n)) / (shares + 10n ** 18n);

  assert.equal(right, 25_000_000n);
  assert.equal(wrongDenominator, 24_038_462n, 'this is what the bug produced');
  assert.notEqual(right, wrongDenominator, 'the two must not agree -- if they do, the term is being applied twice');
});

test('shareMath values a partial holding proportionally', () => {
  const total = 100_000_000n * 10n ** 12n; // 100 USDC in, 1e20 shares
  const { shareValue } = M(100_000_000n, total, total / 4n);
  assert.equal(shareValue, 25_000_000n, 'a quarter of the shares is worth a quarter of the assets');
});

test('shareMath shows the share price rising after yield, and only the price', () => {
  const shares = 100_000_000n * 10n ** 12n; // 1e20 shares for 100 USDC
  // 100 USDC in, then 10 USDC reported as yield: assets rise, shares do not.
  const { sharePrice, shareValue } = M(110_000_000n, shares, shares);

  // The holder captures essentially the whole gain, less one asset base unit from
  // the virtual shares: (S * (A+1)) / (S + 1e12) with S == 1e20 loses exactly 1.
  // That is not an off-by-one in this code, it is the mechanism that makes the
  // inflation attack expensive, and it is visible here because the virtual-share
  // term is a full 1e-8 of totalSupply rather than a rounding crumb.
  assert.equal(shareValue, 109_999_999n, 'the holder captures the gain, less the virtual-share dilution');
  assert.ok(shareValue < 110_000_000n, 'and the vault never owes more than it holds');

  // (110e6 + 1) * 1e18 / (1e20 + 1e12) = 1_099_999 base units -> "1.099999".
  // Not "1.1": the price is a real number and this is what it is.
  assert.equal(sharePrice, '1.099999');
});

test('shareMath puts the loss on the holder when the vault loses assets', () => {
  const shares = 100_000_000n * 10n ** 12n;
  const { sharePrice, shareValue } = M(90_000_000n, shares, shares);
  assert.equal(shareValue, 90_000_000n);
  assert.equal(sharePrice, '0.9');
});

test('shareMath matches maxWithdraw for the whole balance', () => {
  // OpenZeppelin defines maxWithdraw(owner) as previewRedeem(maxRedeem(owner)),
  // i.e. this same conversion applied to the full balance. The page shows both
  // figures side by side, so they must not disagree.
  const shares = 123_456_789n * 10n ** 12n;
  const { shareValue } = M(123_456_700n, shares + 1_000n, shares);
  const expected = (shares * (123_456_700n + 1n)) / (shares + 1_000n + 10n ** 12n);
  assert.equal(shareValue, expected);
});

// ------------------------------------------------------- allowanceIsSufficient

test('an exact allowance is sufficient', () => {
  assert.equal(allowanceIsSufficient(100n, 100n), true);
});

test('one unit short is not sufficient', () => {
  assert.equal(allowanceIsSufficient(99n, 100n), false);
});

test('zero allowance is not sufficient for a real amount', () => {
  assert.equal(allowanceIsSufficient(0n, 1n), false);
});

/**
 * @dev The case that breaks a naive comparison. `maxUint256` is the conventional
 *      "unlimited approval" value, and adding to it overflows -- so an
 *      implementation that computes `allowance >= amount` after any arithmetic
 *      on the allowance can wrap to zero and conclude an unlimited approval is
 *      insufficient, which would ask the user to approve again for no reason.
 */
test('an unlimited approval counts as sufficient without any arithmetic', () => {
  assert.equal(allowanceIsSufficient(MAX_UINT256, 10n ** 30n), true);
  assert.equal(allowanceIsSufficient(MAX_UINT256, MAX_UINT256), true);
});

/**
 * @dev `MAX_UINT256` is hand-written here instead of imported from viem, so its
 *      value is pinned. A typo in a bit shift would not be obvious from reading
 *      it, and the bug it would cause is a spurious re-approval prompt.
 */
test('MAX_UINT256 is exactly type(uint256).max', () => {
  assert.equal(MAX_UINT256, 2n ** 256n - 1n);
  assert.equal(MAX_UINT256.toString(16).length, 64);
  assert.equal(MAX_UINT256 % 255n, 0n); // 2^256 - 1 is a Mersenne number
});

// ------------------------------------------------------------ nextDepositStep

test('step: no allowance means approve first', () => {
  const r = nextDepositStep({ approvalState: ApprovalState.IDLE, allowance: 0n, amount: USDC });
  assert.equal(r.step, 'approve');
});

test('step: sufficient allowance goes straight to deposit', () => {
  const r = nextDepositStep({ approvalState: ApprovalState.IDLE, allowance: 5n * USDC, amount: USDC });
  assert.equal(r.step, 'deposit');
});

/**
 * @dev The state this whole machine exists for. The user approved, the deposit
 *      was then refused (or their wallet rejected it), and they try again. They
 *      must not be shown a second approval prompt.
 *
 *      Note that this asserts the decision is made from the STATE and not from a
 *      fresh allowance read. A read taken immediately after an approval can
 *      still show the old value if the approval has not been included yet, and
 *      acting on that read is how a dApp ends up asking twice.
 */
test('step: an approval that already succeeded is not repeated, even if the read disagrees', () => {
  const r = nextDepositStep({ approvalState: ApprovalState.APPROVED, allowance: 0n, amount: USDC });
  assert.equal(r.step, 'deposit');
  assert.match(r.reason, /already approved/);
});

test('step: a zero amount does nothing at all', () => {
  assert.equal(nextDepositStep({ approvalState: ApprovalState.IDLE, allowance: 0n, amount: 0n }).step, 'none');
});

test('step: the full transition, in the order a user goes through it', () => {
  // 1. nothing approved yet
  assert.equal(nextDepositStep({ approvalState: ApprovalState.IDLE, allowance: 0n, amount: USDC }).step, 'approve');
  // 2. approval mined; allowance now covers it
  assert.equal(
    nextDepositStep({ approvalState: ApprovalState.APPROVED, allowance: USDC, amount: USDC }).step,
    'deposit',
  );
  // 3. a second, larger deposit still needs approval
  assert.equal(
    nextDepositStep({ approvalState: ApprovalState.APPROVED, allowance: USDC, amount: 3n * USDC }).step,
    'deposit',
    'the session flag sends it straight to deposit; the chain rejects it if the allowance is genuinely short',
  );
  // 4. a fresh session with the old allowance still in place needs no approval
  assert.equal(nextDepositStep({ approvalState: ApprovalState.IDLE, allowance: 3n * USDC, amount: USDC }).step, 'deposit');
});

// ---------------------------------------------------------------- parseAmount

test('parseAmount converts a plain amount', () => {
  assert.equal(parseAmount('1000', 6), 1_000_000_000n);
});

test('parseAmount handles a decimal', () => {
  assert.equal(parseAmount('1.5', 6), 1_500_000n);
});

test('parseAmount handles the smallest representable unit', () => {
  assert.equal(parseAmount('0.000001', 6), 1n);
});

test('parseAmount trims whitespace', () => {
  assert.equal(parseAmount('  2  ', 6), 2_000_000n);
});

test('parseAmount rejects an empty value', () => {
  assert.throws(() => parseAmount('', 6), /enter an amount/);
  assert.throws(() => parseAmount('   ', 6), /enter an amount/);
});

test('parseAmount rejects something that is not a number', () => {
  assert.throws(() => parseAmount('abc', 6), /not a number/);
  assert.throws(() => parseAmount('1e6', 6), /not a number/);
  assert.throws(() => parseAmount('-5', 6), /not a number/);
  assert.throws(() => parseAmount('.', 6), /not a number/);
});

test('parseAmount rejects zero', () => {
  assert.throws(() => parseAmount('0', 6), /greater than zero/);
  assert.throws(() => parseAmount('0.0', 6), /greater than zero/);
});

/**
 * @dev Refusing rather than rounding. `parseUnits('1.0000005', 6)` silently
 *      produces 1.000000 -- the user asked to deposit one thing and the app
 *      sends another. Saying so is the only honest option.
 */
test('parseAmount refuses more decimals than the token has, instead of truncating', () => {
  assert.throws(() => parseAmount('1.0000005', 6), /6 decimals/);
  assert.throws(() => parseAmount('0.1234567', 6), /cannot be represented exactly/);
});

test('parseAmount allows exactly the number of decimals the token has', () => {
  assert.equal(parseAmount('1.123456', 6), 1_123_456n);
});

test('parseAmount works for 18-decimal share amounts', () => {
  assert.equal(parseAmount('1.5', 18), 1_500_000_000_000_000_000n);
});

// ------------------------------------------------------------------ toUiError

test('toUiError turns a user rejection into a neutral message, not an error', () => {
  const err = Object.assign(new Error('User rejected the request.'), { code: USER_REJECTED });
  const ui = toUiError(err);
  assert.equal(ui.tone, 'neutral');
  assert.equal(ui.title, 'Cancelled');
});

test('toUiError uses a classification already attached to the error', () => {
  const err = Object.assign(new Error('whatever'), {
    classified: { class: FailureClass.FUNDS, message: 'not enough' },
  });
  const ui = toUiError(err);
  assert.equal(ui.title, 'Not enough funds');
  assert.equal(ui.raw, 'not enough');
});

test('toUiError classifies an unclassified error itself', () => {
  const ui = toUiError(new Error('ERC20: insufficient allowance'));
  assert.equal(ui.title, 'Approval needed');
});

test('toUiError keeps the raw message for the ones the user may need to quote', () => {
  const ui = toUiError(new Error('something nobody has seen before'));
  assert.equal(ui.raw, 'something nobody has seen before');
  assert.match(ui.detail, /nobody has seen before/);
});
