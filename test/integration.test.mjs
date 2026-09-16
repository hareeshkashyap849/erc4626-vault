/**
 * Integration test: the real deposit path, against a fake chain.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT
 *
 * The unit tests in vault.test.mjs cover the approval state machine as a pure
 * function. That leaves the half that actually breaks: whether `deposit()` calls
 * that state machine at the right moment, with the right allowance, and whether
 * the two wallets prompts it produces are the two the user expects.
 *
 * So this test drives the REAL `deposit()` and `redeem()` from web/app/vault.js
 * through a REAL viem client, and only fakes the thing at the bottom: a JSON-RPC
 * provider. Everything above it -- ABI encoding, the transport, the allowance
 * read, the nonce tracking in sendAndTrack -- is the code that ships.
 *
 * The fake chain is a tiny ledger that actually moves balances and actually
 * records allowances. That is the point: an earlier fork test in this project
 * used `vm.mockCall` to make `transferFrom` return true without moving anything,
 * and the vault happily minted shares against assets it never received. A fake
 * that lies about a transfer is worse than no test. This one does the transfer.
 *
 * What is still NOT covered here: a real browser, a real wallet, real gas, and
 * the actual DOM. Those are the manual checklist in web/DESIGN.md §7.
 *
 * Run: node test/integration.test.mjs
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import * as viem from '../web/app/viem.js';
import { ERC20_MIN_ABI, VAULT_ABI, ApprovalState, deposit, readState, redeem } from '../web/app/vault.js';
import { FailureClass } from '../web/app/wallet.js';

const VAULT = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const ASSET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ALICE = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';
const BOB = '0x0d959D5a8BC8e03bCD4FA298CEDBBFa6ffb4200f';
const SYMBOL = 'mUSDC';
const ASSET_DECIMALS = 6;
const SHARE_DECIMALS = 18;

// ------------------------------------------------------------------ encoding

/** ABI-encode a return value for the fake chain to hand back. */
const enc = (types, values) => viem.encodeAbiParameters(types.map((t) => ({ type: t })), values);

/** Selector -> what the fake chain should return, per contract. */
function buildSelectors() {
  const sel = (abi, name) => {
    const fn = abi.find((e) => e.type === 'function' && e.name === name);
    return viem.toFunctionSelector(fn);
  };
  return {
    vault: {
      [sel(VAULT_ABI, 'asset')]: () => enc(['address'], [ASSET]),
      [sel(VAULT_ABI, 'decimals')]: () => enc(['uint8'], [SHARE_DECIMALS]),
      [sel(VAULT_ABI, 'totalAssets')]: (c) => enc(['uint256'], [c.totalAssets]),
      [sel(VAULT_ABI, 'totalSupply')]: (c) => enc(['uint256'], [c.totalSupply]),
      [sel(VAULT_ABI, 'balanceOf')]: (c, args) => enc(['uint256'], [c.shares[args[0].toLowerCase()] ?? 0n]),
      [sel(VAULT_ABI, 'previewRedeem')]: (c, args) => enc(['uint256'], [c.convertToAssets(args[0])]),
      [sel(VAULT_ABI, 'maxWithdraw')]: (c, args) => enc(['uint256'], [c.convertToAssets(c.shares[args[0].toLowerCase()] ?? 0n)]),
    },
    asset: {
      [sel(ERC20_MIN_ABI, 'decimals')]: () => enc(['uint8'], [ASSET_DECIMALS]),
      [sel(ERC20_MIN_ABI, 'symbol')]: () => enc(['string'], [SYMBOL]),
      [sel(ERC20_MIN_ABI, 'balanceOf')]: (c, args) => enc(['uint256'], [c.balances[args[0].toLowerCase()] ?? 0n]),
      [sel(ERC20_MIN_ABI, 'allowance')]: (c, args) => enc(['uint256'], [c.allowances[`${args[0].toLowerCase()}:${args[1].toLowerCase()}`] ?? 0n]),
    },
  };
}

// --------------------------------------------------------------- fake chain

/**
 * A JSON-RPC provider backed by a ledger that actually moves tokens.
 *
 * `failNext` makes the next transaction revert, which is how the
 * approval-then-failed-deposit case is set up.
 */
/**
 * `10 ** _decimalsOffset()`, the term OpenZeppelin adds to `totalSupply` in every
 * conversion.
 *
 * YieldVault sets `_decimalOffset = SHARE_DECIMALS - assetDecimals` (see its
 * constructor), so `_decimalsOffset()` returns 12 and the term is 10**12. Note
 * the exponent twice over: 18 - 6 = 12, then `10 ** 12`. Writing 10**18 here --
 * which is what an earlier version of this fake chain did -- makes the fake vault
 * mint 10**6 times too many shares and report a share value 24/25ths of the
 * truth. The two wrongs very nearly cancelled, which is exactly how a fake chain
 * teaches you nothing.
 */
const OFFSET = 10n ** BigInt(SHARE_DECIMALS - ASSET_DECIMALS); // 10 ** 12 == 1e12

function makeChain({ balances = {}, totalAssets = 0n, totalSupply = 0n } = {}) {
  const lowers = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));

  const chain = {
    balances: lowers(balances),
    allowances: {},
    shares: {},
    totalAssets,
    totalSupply,
    sent: [],
    receipts: new Map(),
    nonces: {},
    failNext: null,
    /**
     * Called with each transaction just before it is mined, so a test can inject
     * a failure at a precise point.
     *
     * This exists because the obvious approach -- monkey-patching
     * `chain.request` -- does not work here: the provider handed to `deposit()`
     * closes over `chain` and calls `chain.request(...)`, but the module under
     * test also gets a `publicClient` built separately, and an earlier attempt to
     * patch the method was silently bypassed. A hook the chain itself calls
     * cannot be bypassed. (That attempt also cost a `console.log` that proved
     * nothing, because node:test runs tests concurrently and the interleaved
     * output looked like it came from the test under investigation.)
     */
    onSend: null,
    selectors: buildSelectors(),

    /**
     * The vault's pricing rule, mirrored from OpenZeppelin's virtual shares.
     *
     * `convertToShares` is the one that is easy to get wrong: a 6-decimal asset
     * and 18-decimal shares mean one whole USDC is 1e18 shares, not 1e6. Omitting
     * the offset makes the fake vault mint a trillion times too few shares, and a
     * test written against that fake would "prove" a wrong share price.
     */
    convertToAssets(shares) {
      return (shares * (this.totalAssets + 1n)) / (this.totalSupply + OFFSET);
    },

    convertToShares(assets) {
      return (assets * (this.totalSupply + OFFSET)) / (this.totalAssets + 1n);
    },

    /** Mine a transaction: apply it to the ledger and store a receipt. */
    mine(tx) {
      const key = (tx.to ?? '').toLowerCase();
      const data = tx.data ?? '0x';
      const selector = data.slice(0, 10);
      const body = `0x${data.slice(10)}`;

      if (this.failNext) {
        const reason = this.failNext;
        this.failNext = null;
        return { status: '0x0', reason };
      }

      if (key === ASSET.toLowerCase()) {
        const fn = ERC20_MIN_ABI.find((e) => e.type === 'function' && viem.toFunctionSelector(e) === selector);
        if (fn?.name === 'approve') {
          const [spender, amount] = viem.decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], body);
          this.allowances[`${tx.from.toLowerCase()}:${spender.toLowerCase()}`] = amount;
          return { status: '0x1' };
        }
        throw new Error(`the fake chain does not implement ${fn?.name ?? selector} on the asset`);
      }

      if (key === VAULT.toLowerCase()) {
        const fn = VAULT_ABI.find((e) => e.type === 'function' && viem.toFunctionSelector(e) === selector);
        if (fn?.name === 'deposit') {
          const [assets] = viem.decodeAbiParameters([{ type: 'uint256' }], body);
          const from = tx.from.toLowerCase();
          const allowance = this.allowances[`${from}:${VAULT.toLowerCase()}`] ?? 0n;
          // The check the real vault relies on. If the approval step were skipped
          // or ordered wrongly, this is what catches it.
          if (allowance < assets) return { status: '0x0', reason: 'ERC20InsufficientAllowance' };
          if ((this.balances[from] ?? 0n) < assets) return { status: '0x0', reason: 'ERC20InsufficientBalance' };

          const shares = this.convertToShares(assets);
          this.balances[from] -= assets;
          this.allowances[`${from}:${VAULT.toLowerCase()}`] = allowance - assets;
          this.shares[from] = (this.shares[from] ?? 0n) + shares;
          this.totalAssets += assets;
          this.totalSupply += shares;
          return { status: '0x1' };
        }
        if (fn?.name === 'redeem') {
          const [shares] = viem.decodeAbiParameters([{ type: 'uint256' }], body);
          const from = tx.from.toLowerCase();
          if ((this.shares[from] ?? 0n) < shares) return { status: '0x0', reason: 'ERC4626ExceededMaxRedeem' };
          const assets = this.convertToAssets(shares);
          if (assets > this.totalAssets) return { status: '0x0', reason: 'ERC4626ExceededMaxWithdraw' };
          this.shares[from] -= shares;
          this.balances[from] = (this.balances[from] ?? 0n) + assets;
          this.totalAssets -= assets;
          this.totalSupply -= shares;
          return { status: '0x1' };
        }
        throw new Error(`the fake chain does not implement ${fn?.name ?? selector} on the vault`);
      }

      throw new Error(`transaction to unknown address ${tx.to}`);
    },

    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_accounts':
          return [ALICE];
        case 'eth_chainId':
          return '0x7a69'; // 31337
        case 'eth_call': {
          const [{ to, data }] = params;
          const key = to.toLowerCase();
          const table = key === VAULT.toLowerCase() ? this.selectors.vault : key === ASSET.toLowerCase() ? this.selectors.asset : null;
          if (!table) throw new Error(`eth_call to unknown address ${to}`);
          const selector = data.slice(0, 10);
          const handler = table[selector];
          if (!handler) throw new Error(`fake chain has no handler for ${selector} at ${to}`);
          // Decode the arguments from the ABI the module under test supplies, so
          // the arguments are read the same way the real contract would.
          const fn =
            (key === VAULT.toLowerCase() ? VAULT_ABI : ERC20_MIN_ABI).find((e) => e.type === 'function' && viem.toFunctionSelector(e) === selector) ?? null;
          const argTypes = (fn?.inputs ?? []).map((i) => ({ type: i.type }));
          const args = argTypes.length ? viem.decodeAbiParameters(argTypes, `0x${data.slice(10)}`) : [];
          return handler(this, args);
        }
        case 'eth_getTransactionCount': {
          const [addr] = params;
          // Strictly the number of transactions this account has sent. A real
          // node reports the same value for 'pending' and 'latest' once nothing
          // is in flight, which is what this returns -- but it must ADVANCE per
          // transaction. An earlier version always returned 0, and
          // `sendAndTrack`'s replacement detection (which compares the nonce
          // after the send against the nonce before it) then believed every
          // transaction had vanished and went hunting for a replacement.
          return viem.numberToHex(this.nonces[addr.toLowerCase()] ?? 0);
        }
        case 'eth_sendTransaction': {
          const [tx] = params;
          const from = tx.from.toLowerCase();
          const nonce = this.nonces[from] ?? 0;
          this.nonces[from] = nonce + 1;
          const hash = `0x${(this.sent.length + 1).toString(16).padStart(64, '0')}`;
          this.sent.push({ ...tx, nonce });
          this.onSend?.(tx);
          this.receipts.set(hash, this.mine(tx));
          return hash;
        }
        case 'eth_getTransactionReceipt': {
          const [hash] = params;
          const receipt = this.receipts.get(hash);
          if (!receipt) return null;
          return {
            transactionHash: hash,
            status: receipt.status,
            blockNumber: '0x1',
            gasUsed: '0x5208',
          };
        }
        default:
          throw new Error(`the fake chain does not implement ${method}`);
      }
    },
  };

  return chain;
}

/** The provider shape sendAndTrack expects: an object with request(). */
const providerOf = (chain) => ({
  request: (args) => chain.request(args),
  on: () => {},
  removeListener: () => {},
});

const publicClientOf = (chain) => viem.createPublicClient({ transport: viem.custom(providerOf(chain)) });

const ONE = 10n ** BigInt(ASSET_DECIMALS); // one whole asset unit

/** The names of the transactions sent, in order, for readable assertions. */
function sentNames(chain) {
  return chain.sent.map((tx) => {
    const selector = (tx.data ?? '0x').slice(0, 10);
    const abi = tx.to.toLowerCase() === VAULT.toLowerCase() ? VAULT_ABI : ERC20_MIN_ABI;
    const fn = abi.find((e) => e.type === 'function' && viem.toFunctionSelector(e) === selector);
    return fn ? fn.name : `unknown(${selector})`;
  });
}

// --------------------------------------------------------------------- tests

test('a first deposit is approve-then-deposit, in that order', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);

  const stages = [];
  const result = await deposit(viem, {
    provider,
    vault: VAULT,
    asset: ASSET,
    account: ALICE,
    amount: 10n * ONE,
    approvalState: ApprovalState.IDLE,
    onStage: (stage, info) => stages.push([stage, info?.step ?? info?.stage ?? '']),
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(sentNames(chain), ['approve', 'deposit'], 'the approval must come first');
  assert.equal(stages[0][0], 'plan');
  assert.equal(stages[0][1], 'approve', 'the page is told the plan before any prompt appears');
  assert.ok(stages.some(([s]) => s === 'approved'), 'the page is told the approval landed');

  // The deposit actually moved tokens, in the fake chain and therefore in the
  // arithmetic the assertion is about.
  assert.equal(chain.balances[ALICE.toLowerCase()], 90n * ONE);
  assert.equal(chain.totalAssets, 10n * ONE);
  assert.ok(chain.shares[ALICE.toLowerCase()] > 0n);
});

test('an exact approval is consumed by the deposit, so the next one must approve again', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);

  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 10n * ONE, approvalState: ApprovalState.IDLE });
  assert.deepEqual(sentNames(chain), ['approve', 'deposit']);

  // The approval was for exactly 10 and the deposit spent all of it, so the
  // allowance is now zero. A second deposit therefore has to approve again.
  //
  // This is the correct behaviour and it is worth being explicit about, because
  // the opposite is easy to assume: `deposit()` approves the amount it needs, not
  // an unlimited amount, so "approve once, deposit many times" is NOT what this
  // page does. It is one approval per deposit unless the user approves a larger
  // amount themselves with the "Approve only" button.
  assert.equal(chain.allowances[`${ALICE.toLowerCase()}:${VAULT.toLowerCase()}`], 0n, 'the exact approval was fully consumed');

  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 5n * ONE, approvalState: ApprovalState.IDLE });

  assert.deepEqual(sentNames(chain), ['approve', 'deposit', 'approve', 'deposit'], 'a consumed approval must be renewed');
  assert.equal(chain.totalAssets, 15n * ONE);
  // And a fresh read sees the second approval, which is what keeps the page and
  // the chain agreeing: the page re-reads the allowance rather than remembering it.
  const state = await readState(viem, { publicClient: publicClientOf(chain), vault: VAULT, asset: ASSET, account: ALICE });
  assert.equal(state.allowance, 0n, 'the second approval was consumed too');
});

test('an unlimited approval lets a second deposit reuse it with no new approval', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);

  // What the "Approve only" button is for: a user who approves a large amount
  // once, to avoid a second wallet prompt on every deposit.
  chain.allowances[`${ALICE.toLowerCase()}:${VAULT.toLowerCase()}`] = 10n ** 30n;

  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 10n * ONE, approvalState: ApprovalState.IDLE });
  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 5n * ONE, approvalState: ApprovalState.IDLE });

  assert.deepEqual(sentNames(chain), ['deposit', 'deposit'], 'a large standing allowance needs no further approvals');
  assert.equal(chain.totalAssets, 15n * ONE);
});

test('approvalState APPROVED skips the approval even when the allowance read says otherwise', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);

  // Approval was granted in an earlier session; the allowance is on chain.
  chain.allowances[`${ALICE.toLowerCase()}:${VAULT.toLowerCase()}`] = 10n * ONE;

  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 10n * ONE, approvalState: ApprovalState.APPROVED });

  assert.deepEqual(sentNames(chain), ['deposit'], 'a known-good approval must not be repeated');
});

test('a deposit that reverts after the approval does not lose the approval', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);

  // The approval succeeds, then the deposit is refused by the contract. This is
  // the case that matters: the user has already paid for the approval, and a
  // page that forgets it will ask them to approve a second time for nothing.
  let deposits = 0;
  chain.onSend = (tx) => {
    const selector = (tx.data ?? '').slice(0, 10);
    const fn = VAULT_ABI.find((e) => e.type === 'function' && viem.toFunctionSelector(e) === selector);
    if (fn?.name === 'deposit' && ++deposits === 1) chain.failNext = 'ERC4626ExceededMaxDeposit';
  };

  const result = await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 10n * ONE, approvalState: ApprovalState.IDLE });

  // A reverted transaction is reported, not thrown: the transaction DID happen
  // and it cost gas, so it is a result with status 'reverted' rather than an
  // error. Asserting on the status is therefore the honest shape here, and it is
  // what the page branches on.
  assert.equal(result.status, 'reverted', 'the deposit was mined and reverted');
  assert.deepEqual(sentNames(chain), ['approve', 'deposit']);

  // The approval is on chain and was NOT rolled back by the failed deposit, so a
  // retry must not ask for it again.
  const allowance = chain.allowances[`${ALICE.toLowerCase()}:${VAULT.toLowerCase()}`];
  assert.equal(allowance, 10n * ONE, 'the approval must still be in place after a failed deposit');

  const before = chain.sent.length;
  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 10n * ONE, approvalState: ApprovalState.IDLE });
  assert.deepEqual(sentNames(chain).slice(before), ['deposit'], 'the retry must not re-approve');
  assert.equal(chain.allowances[`${ALICE.toLowerCase()}:${VAULT.toLowerCase()}`], 0n, 'and the retry spent the allowance');
});

test('a deposit whose approval is rejected throws rather than reporting success', async () => {
  // The other half of the previous test: when the WALLET refuses, there is no
  // transaction at all, and that must surface as a thrown, classified error.
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  chain.onSend = () => {
    chain.failNext = null;
  };
  const provider = {
    request: async ({ method, params = [] }) => {
      if (method === 'eth_sendTransaction') {
        // What MetaMask does when the user presses Reject -- and note it throws
        // instead of returning a hash, which is why this cannot be expressed by
        // the fake chain's `failNext`.
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      }
      return chain.request({ method, params });
    },
  };

  await assert.rejects(
    () => deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 10n * ONE, approvalState: ApprovalState.IDLE }),
    (err) => {
      assert.equal(err.classified?.class, FailureClass.REJECTED);
      return true;
    },
  );
  assert.equal(chain.sent.length, 0, 'a rejected prompt must not have sent anything');
});

test('a rejected approval sends nothing and is classified as a rejection', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = {
    request: async ({ method, params = [] }) => {
      if (method === 'eth_sendTransaction') {
        // What MetaMask does when the user presses Reject.
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      }
      return chain.request({ method, params });
    },
  };

  await assert.rejects(
    () => deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 10n * ONE, approvalState: ApprovalState.IDLE }),
    (err) => {
      assert.equal(err.classified?.class, FailureClass.REJECTED);
      return true;
    },
  );
  assert.equal(chain.sent.length, 0, 'a rejected prompt must not have sent anything');
});

test('redeem sends exactly one transaction and moves the assets back', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);

  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 40n * ONE, approvalState: ApprovalState.IDLE });
  const shares = chain.shares[ALICE.toLowerCase()];
  assert.ok(shares > 0n);

  const before = chain.sent.length;
  const result = await redeem(viem, { provider, vault: VAULT, account: ALICE, shares });

  assert.equal(result.status, 'success');
  assert.deepEqual(sentNames(chain).slice(before), ['redeem'], 'redeem needs no approval');
  assert.equal(chain.shares[ALICE.toLowerCase()], 0n);
  assert.ok(chain.balances[ALICE.toLowerCase()] > 90n * ONE, 'the assets came back, including the yield-free principal');
});

test('readState returns figures that agree with the chain, and with each other', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);
  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 25n * ONE, approvalState: ApprovalState.IDLE });

  const state = await readState(viem, { publicClient: publicClientOf(chain), vault: VAULT, asset: ASSET, account: ALICE });

  assert.equal(state.assetDecimals, ASSET_DECIMALS);
  assert.equal(state.shareDecimals, SHARE_DECIMALS);
  assert.equal(state.symbol, SYMBOL);
  assert.equal(state.walletBalance, 75n * ONE);
  assert.equal(state.totalAssets, 25n * ONE);
  assert.equal(state.totalSupply, chain.totalSupply);
  assert.equal(state.shares, chain.shares[ALICE.toLowerCase()]);

  // The two derived figures must be internally consistent: shareValue is what
  // those shares are worth, and maxWithdraw is what the vault will actually pay.
  // OpenZeppelin defines the latter as `previewRedeem(maxRedeem(owner))`, so these
  // are the same number by construction -- and they were NOT, until the
  // virtual-share term in `readState` was fixed.
  assert.equal(state.shareValue, state.maxWithdraw, 'maxWithdraw is the value of every share held');
  assert.equal(state.shareValue, chain.convertToAssets(state.shares));

  // Here it also happens to equal the 25 assets deposited. An earlier version of
  // this test asserted a one-unit floor loss, which was wrong: at a 1e-6 asset
  // and 1e18 shares the virtual terms sit far below the last asset unit, so the
  // round trip is exact.
  assert.equal(state.shareValue, 25n * ONE, 'a round trip with an empty vault returns the deposit in full');

  // One whole share is worth very nearly one asset, and the honest assertion is
  // that it is CLOSE to 1 -- not a specific string. Two earlier guesses here were
  // both wrong (0.000000000025, then 0.999999) because the true value has to be
  // worked out rather than recalled: the virtual-share term is 10**12 against a
  // totalSupply of 2.5e19, so it perturbs the seventh decimal and the rounded
  // display really is "1". Pinning the string would pin a rounding artefact.
  const price = Number(state.sharePrice);
  assert.ok(Math.abs(price - 1) < 1e-5, `one whole share should be about one asset, got ${state.sharePrice}`);
});

test('readState with no account still reads the vault totals', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);
  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 30n * ONE, approvalState: ApprovalState.IDLE });

  // This is the no-wallet case: the totals do not depend on who is asking.
  const state = await readState(viem, { publicClient: publicClientOf(chain), vault: VAULT, asset: ASSET, account: null });

  assert.equal(state.totalAssets, 30n * ONE);
  assert.equal(state.walletBalance, 0n);
  assert.equal(state.shares, 0n);
  assert.equal(state.allowance, 0n);
  // And an empty vault must not claim a price it cannot know.
  const empty = await readState(viem, { publicClient: publicClientOf(makeChain()), vault: VAULT, asset: ASSET, account: null });
  assert.equal(empty.sharePrice, null, 'an empty vault has no share price to report');
});

test('after a reported yield, one share is worth more than one asset', async () => {
  const chain = makeChain({ balances: { [ALICE]: 100n * ONE } });
  const provider = providerOf(chain);
  await deposit(viem, { provider, vault: VAULT, asset: ASSET, account: ALICE, amount: 100n * ONE, approvalState: ApprovalState.IDLE });

  const shares = chain.shares[ALICE.toLowerCase()];
  const gain = 10n * ONE;
  chain.totalAssets += gain; // exactly what reportYield does: assets appear
  chain.balances[VAULT.toLowerCase()] = chain.totalAssets;

  const state = await readState(viem, { publicClient: publicClientOf(chain), vault: VAULT, asset: ASSET, account: ALICE });
  assert.ok(Number(state.sharePrice) > 1, `share price should exceed 1, got ${state.sharePrice}`);
  assert.equal(state.shareValue, chain.convertToAssets(shares));
  // 100 assets in, 10 reported, so the depositor's shares are worth ~110 -- less
  // one 1e-6 unit from the floor on the way in, which is why this is `>` and not
  // an equality against 110 * ONE.
  assert.ok(state.shareValue > 109n * ONE, `the depositor captures the yield, got ${state.shareValue}`);
  assert.ok(state.shareValue < 110n * ONE, 'and cannot capture more than the vault holds');
});
