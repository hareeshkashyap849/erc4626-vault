/**
 * Tests for the EIP-1193 wallet layer.
 *
 * WHY THIS FILE EXISTS, AND NOT ONE FOR THE UI
 *
 * The wallet layer is where the bugs that matter live: misclassified errors, a
 * chain guard that does not fire, a transaction loop waiting forever on a hash
 * the wallet has already abandoned. The UI is DOM plumbing whose failure modes
 * are visible to anyone looking at the page.
 *
 * No headless browser is available here, so a fake provider stands in for
 * MetaMask. That is a real limitation, stated plainly: these tests prove the
 * LOGIC is right given the events a wallet emits. They do not prove MetaMask
 * emits exactly those events. web/DESIGN.md §7 is the checklist for what only a
 * browser can confirm.
 *
 * Run: node test/wallet.test.mjs
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  classify,
  describeFailure,
  errorDetails,
  FailureClass,
  findProvider,
  hexToBigInt,
  sendAndTrack,
  USER_REJECTED,
  Wallet,
} from '../web/app/wallet.js';

// --------------------------------------------------------------- fake provider

/**
 * A provider that answers from a table and records what was asked.
 *
 * `respond` maps a JSON-RPC method to a value or to a function of
 * (args, callCount). The function form is how a test says "this changes on the
 * second call", which is what the replacement-transaction case needs.
 *
 * AN EARLIER VERSION took an array per method and tried to infer whether that
 * array was one response or a sequence of them. That is genuinely ambiguous:
 * `eth_requestAccounts` returns `['0xabc']`, while `[[], ['0xabc']]` would mean
 * "no accounts, then one". Nothing in the shape distinguishes the two, and the
 * guesses made here were wrong in two opposite directions before the convention
 * was dropped. `respond` removes the ambiguity rather than documenting it.
 */
function fakeProvider({ respond = {} } = {}) {
  const calls = [];
  const listeners = new Map();
  const counts = new Map();

  return {
    calls,
    callCount: (method) => counts.get(method) ?? 0,
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    removeListener(event, fn) {
      const list = listeners.get(event) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    async request(args) {
      calls.push(args);
      const n = (counts.get(args.method) ?? 0) + 1;
      counts.set(args.method, n);

      const handler = respond[args.method];
      if (typeof handler === 'function') {
        const out = await handler(args, n);
        if (out instanceof Error) throw out;
        return out;
      }
      if (handler !== undefined) return handler;

      // Defaults describe an unconnected wallet sitting on the local chain.
      if (args.method === 'eth_chainId') return '0x7a69';
      if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') return [];
      throw new Error(`fake provider has no response for ${args.method}`);
    },
  };
}

/** Shorthand for a provider already connected as `account` on `chainId`. */
function connectedProvider(account = '0x1', chainId = '0x7a69', extra = {}) {
  return fakeProvider({
    respond: {
      eth_requestAccounts: [account],
      eth_accounts: [account],
      eth_chainId: chainId,
      ...extra,
    },
  });
}

const rpcError = (code, message) => Object.assign(new Error(message), { code });

// ------------------------------------------------------------------ provider

test('findProvider returns null when nothing is injected', () => {
  assert.equal(findProvider({}), null);
});

test('findProvider prefers the first entry of the providers array', () => {
  const a = { request() {} };
  const b = { request() {} };
  assert.equal(findProvider({ ethereum: { providers: [a, b] } }), a);
});

test('findProvider falls back to ethereum itself', () => {
  const eth = { request() {} };
  assert.equal(findProvider({ ethereum: eth }), eth);
});

// ---------------------------------------------------------------- constructor

test('Wallet refuses something that is not a provider', () => {
  assert.throws(() => new Wallet({}), /not an EIP-1193 provider/);
  assert.throws(() => new Wallet(null), /not an EIP-1193 provider/);
});

// -------------------------------------------------------------------- connect

test('connect returns the account and chain, and marks itself connected', async () => {
  const p = connectedProvider('0xAbC');
  const w = new Wallet(p);
  const state = await w.connect();
  assert.equal(state.account, '0xAbC');
  assert.equal(state.chainId, 31337);
  assert.equal(state.connected, true);
});

test('connect rejects when the wallet hands back no account', async () => {
  const p = fakeProvider({ respond: { eth_requestAccounts: [] } });
  const w = new Wallet(p);
  await assert.rejects(() => w.connect(), /no account/);
});

test('refresh does not prompt: it reads eth_accounts, never eth_requestAccounts', async () => {
  const p = connectedProvider('0x5');
  const w = new Wallet(p);
  await w.refresh();
  assert.equal(w.state.account, '0x5');
  assert.equal(p.callCount('eth_requestAccounts'), 0, 'refresh must not open a connect prompt');
});

test('subscribers are notified on connect, on an account change, and on a chain change', async () => {
  const p = connectedProvider('0x1');
  const w = new Wallet(p);
  const seen = [];
  w.subscribe((s) => seen.push(s.account));

  await w.connect();
  p.emit('accountsChanged', ['0x2']);
  p.emit('chainChanged', '0x1');

  // '0x2' appears twice on purpose. A chain change must notify even though the
  // account is unchanged, because everything read from the chain is now from a
  // different chain -- balances, allowances and the vault address all need
  // re-reading. Suppressing the notification because the account did not change
  // would leave the page showing mainnet balances while the wallet is on
  // Sepolia, which is exactly the confusion the chain guard exists to prevent.
  // An earlier version of this test expected only three entries and was wrong.
  assert.deepEqual(seen, [null, '0x1', '0x2', '0x2']);
  assert.equal(w.state.chainId, 1);
});

/**
 * @dev Wallets disagree about what disconnection looks like. Some emit
 *      `disconnect`; others report an empty account list. Both must land in the
 *      same state, because the UI has exactly one "not connected" screen.
 */
test('an empty accountsChanged array means disconnected, like the disconnect event', async () => {
  const p = connectedProvider('0x1');
  const w = new Wallet(p);
  await w.connect();

  p.emit('accountsChanged', []);
  assert.equal(w.state.connected, false);
  assert.equal(w.state.account, null);
});

test('the disconnect event also clears the account', async () => {
  const p = connectedProvider('0x1');
  const w = new Wallet(p);
  await w.connect();
  p.emit('disconnect', {});
  assert.equal(w.state.connected, false);
});

test('destroy removes the listeners so a hot-reloading page does not accumulate them', async () => {
  const p = connectedProvider('0x1');
  const w = new Wallet(p);
  await w.connect();
  w.destroy();
  p.emit('accountsChanged', ['0x9']);
  assert.equal(w.state.account, '0x1', 'a listener survived destroy()');
});

// ---------------------------------------------------------------- chain guard

/**
 * @dev The guard must fire BEFORE the wallet is asked to send, or the
 *      transaction is signed and broadcast on the wrong network. Asserting that
 *      no eth_sendTransaction happened is the real point here, not merely that
 *      an error was thrown.
 */
test('assertChain throws on a mismatch and no transaction is attempted', async () => {
  const p = connectedProvider('0x1', '0x1');
  const w = new Wallet(p);
  await w.connect();

  assert.throws(() => w.assertChain(31337), /chain mismatch/);
  assert.equal(p.callCount('eth_sendTransaction'), 0);
});

test('assertChain passes when the chain matches', async () => {
  const w = new Wallet(connectedProvider());
  await w.connect();
  assert.doesNotThrow(() => w.assertChain(31337));
});

test('assertChain refuses when the wallet was never connected', () => {
  const w = new Wallet(fakeProvider());
  assert.throws(() => w.assertChain(31337), /not connected/);
});

test('switchChain falls back to wallet_addEthereumChain on the 4902 unknown-chain error', async () => {
  const p = connectedProvider('0x1', '0x1', {
    wallet_switchEthereumChain: () => rpcError(4902, 'Unrecognized chain ID'),
    wallet_addEthereumChain: null,
  });
  const w = new Wallet(p);
  await w.connect();

  await w.switchChain(31337, { rpcUrl: 'http://127.0.0.1:8545' });
  const add = p.calls.find((c) => c.method === 'wallet_addEthereumChain');
  assert.ok(add, 'wallet_addEthereumChain was never called');
  assert.equal(add.params[0].chainId, '0x7a69');
  assert.deepEqual(add.params[0].rpcUrls, ['http://127.0.0.1:8545']);
});

test('switchChain does not add a chain when the wallet refused for another reason', async () => {
  const p = connectedProvider('0x1', '0x1', {
    wallet_switchEthereumChain: () => rpcError(USER_REJECTED, 'User rejected the request'),
  });
  const w = new Wallet(p);
  await w.connect();
  await assert.rejects(() => w.switchChain(31337, { rpcUrl: 'http://127.0.0.1:8545' }));
  assert.equal(p.callCount('wallet_addEthereumChain'), 0);
});

// ------------------------------------------------------------- classification

/**
 * @dev One test per failure class. A single catch-all handler is precisely the
 *      bug this function exists to prevent -- category 2 in particular must be
 *      REJECTED and not an error, because the user cancelling is not a failure.
 */
test('classify: user rejection is its own class, not an error', () => {
  const r = classify(rpcError(USER_REJECTED, 'User rejected the request.'));
  assert.equal(r.class, FailureClass.REJECTED);
  assert.equal(describeFailure(r).tone, 'neutral');
});

test('classify: a rejection nested under cause is still found', () => {
  const inner = rpcError(USER_REJECTED, 'User denied transaction signature');
  const outer = Object.assign(new Error('An unknown RPC error occurred.'), { cause: inner });
  assert.equal(classify(outer).class, FailureClass.REJECTED);
});

test('classify: chain mismatch', () => {
  assert.equal(classify(new Error('Chain mismatch: expected chain 31337, received 1')).class, FailureClass.CHAIN);
});

test('classify: allowance', () => {
  assert.equal(classify(new Error('ERC20: insufficient allowance')).class, FailureClass.ALLOWANCE);
});

test('classify: revert', () => {
  assert.equal(classify(new Error('Execution reverted with reason: YieldAmountZero()')).class, FailureClass.REVERT);
});

test('classify: funds', () => {
  assert.equal(classify(new Error('insufficient funds for gas * price + value')).class, FailureClass.FUNDS);
});

test('classify: replacement', () => {
  assert.equal(classify(new Error('replacement transaction underpriced')).class, FailureClass.REPLACED);
});

/**
 * @dev The fallback is deliberate. An unfamiliar error is reported as UNKNOWN
 *      with its original text, rather than tidied into "the contract refused it"
 *      -- a confident wrong explanation is worse than a raw one.
 */
test('classify: an unfamiliar error stays unknown and keeps its message', () => {
  const r = classify(new Error('something nobody has seen before'));
  assert.equal(r.class, FailureClass.UNKNOWN);
  assert.match(describeFailure(r).detail, /nobody has seen before/);
});

/**
 * @dev The outermost message wins. viem puts a readable summary on the outside
 *      with the raw provider text nested under `cause`, so returning the
 *      innermost string would show the user the least useful part of the chain.
 */
test('errorDetails keeps all messages and returns the outermost as the summary', () => {
  const deep = Object.assign(new Error('leaf'), { code: 4001 });
  const mid = Object.assign(new Error('middle'), { cause: deep });
  const top = Object.assign(new Error('top'), { cause: mid });
  const d = errorDetails(top);
  assert.deepEqual(d.codes, [4001]);
  assert.equal(d.message, 'top');
  assert.deepEqual(d.messages, ['top', 'middle', 'leaf']);
});

test('hexToBigInt treats null as zero rather than throwing', () => {
  assert.equal(hexToBigInt(null), 0n);
  assert.equal(hexToBigInt('0x0'), 0n);
  assert.equal(hexToBigInt('0x7a69'), 31337n);
});

// ------------------------------------------------------------- sendAndTrack

test('sendAndTrack returns success and the receipt when the transaction mines', async () => {
  const hash = '0xaaa';
  const p = fakeProvider({
    respond: {
      eth_accounts: ['0x1'],
      eth_sendTransaction: hash,
      eth_getTransactionCount: '0x0',
      eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x10' },
    },
  });

  const stages = [];
  const r = await sendAndTrack(p, { to: '0xvault', data: '0xdead' }, { onStage: (s, h) => stages.push([s, h]) });
  assert.equal(r.status, 'success');
  assert.equal(r.hash, hash);
  assert.deepEqual(stages, [['sent', hash]]);
});

test('sendAndTrack reports a reverted transaction as reverted, not as a failed send', async () => {
  const p = fakeProvider({
    respond: {
      eth_accounts: ['0x1'],
      eth_sendTransaction: '0xbbb',
      eth_getTransactionCount: '0x5',
      eth_getTransactionReceipt: { status: '0x0' },
    },
  });
  const r = await sendAndTrack(p, { to: '0xvault', data: '0x' });
  assert.equal(r.status, 'reverted');
});

/**
 * @dev The case a naive implementation waits forever on. The user pressed
 *      "speed up": the wallet resent the same nonce with a higher fee, so the
 *      original hash will never produce a receipt while the nonce is consumed by
 *      something else. A loop that only polls the old hash hangs until its
 *      timeout, telling the user a transaction is "still pending" long after it
 *      was mined.
 */
test('sendAndTrack detects a replacement instead of waiting on a hash that will never mine', async () => {
  const originalHash = '0xoriginal';
  const replacementHash = '0xreplacement';

  const p = fakeProvider({
    respond: {
      eth_accounts: ['0x1'],
      eth_sendTransaction: originalHash,
      // pending reports our slot; latest reports it consumed only after the
      // replacement lands. The gap between the two is the signal.
      eth_getTransactionCount: (args, n) => (args.params?.[1] === 'pending' || n === 1 ? '0x7' : '0x8'),
      eth_getTransactionReceipt: null, // never mines
      eth_getBlockTransactionCountByNumber: '0x1',
      eth_getTransactionByBlockNumberAndIndex: {
        hash: replacementHash,
        from: '0x1',
        nonce: '0x7',
      },
    },
  });

  const r = await sendAndTrack(p, { to: '0xvault', data: '0x' }, { pollMs: 1 });
  assert.equal(r.status, 'replaced');
  assert.equal(r.replaced, true);
  assert.equal(r.hash, replacementHash, 'the replacement hash is what the user must be told to follow');
  assert.equal(r.originalHash, originalHash);
});

test('sendAndTrack gives up eventually rather than looping forever', async () => {
  const p = fakeProvider({
    respond: {
      eth_accounts: ['0x1'],
      eth_sendTransaction: '0xccc',
      eth_getTransactionCount: '0x1',
      eth_getTransactionReceipt: null,
    },
  });
  const r = await sendAndTrack(p, { to: '0xvault', data: '0x' }, { pollMs: 1, timeoutMs: 20 });
  assert.equal(r.status, 'pending');
  assert.equal(r.timedOut, true);
});

test('sendAndTrack surfaces a user rejection from the send call itself', async () => {
  const p = fakeProvider({
    respond: {
      eth_accounts: ['0x1'],
      eth_sendTransaction: () => rpcError(USER_REJECTED, 'User rejected the request.'),
    },
  });
  await assert.rejects(
    () => sendAndTrack(p, { to: '0xvault', data: '0x' }),
    (err) => {
      assert.equal(err.classified.class, FailureClass.REJECTED);
      return true;
    },
  );
});

test('sendAndTrack refuses when there is no account to send from', async () => {
  const p = fakeProvider({ respond: { eth_accounts: [] } });
  await assert.rejects(() => sendAndTrack(p, { to: '0xvault', data: '0x' }), /no account/);
});

test('sendAndTrack abbreviates large values as hex rather than decimal', async () => {
  const p = fakeProvider({
    respond: {
      eth_accounts: ['0x1'],
      eth_sendTransaction: '0xddd',
      eth_getTransactionCount: '0x0',
      eth_getTransactionReceipt: { status: '0x1' },
    },
  });
  await sendAndTrack(p, { to: '0xvault', data: '0x', value: 1234n });
  const sent = p.calls.find((c) => c.method === 'eth_sendTransaction');
  assert.equal(sent.params[0].value, '0x4d2', 'value must be hex; a decimal string is rejected by the node');
});
