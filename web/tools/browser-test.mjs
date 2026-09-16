/**
 * Browser tests, in a REAL browser, against the REAL chain.
 *
 * WHAT THIS IS FOR
 *
 * Three of this project's bugs were found by a human opening the page, and no
 * automated test saw any of them: a wrong-chain warning shown before connecting, an
 * inert Connect button, and a TypeError in clearMessage that killed every message.
 * In each case the reason was the same -- a DOM stub is not a browser, and a stub
 * more permissive than the DOM hides the bug instead of finding it.
 *
 * So this runs the actual page in actual Chrome. The page is served by the actual
 * dev server, and its reads and writes go to the actual local chain.
 *
 * WHAT IS FAKED, AND WHY THAT IS STILL WORTH IT
 *
 * Only `window.ethereum` -- the wallet -- is fake, because a real MetaMask cannot
 * be driven from here: it needs a person to click Approve. The fake is a genuine
 * EIP-1193 provider that FORWARDS to anvil, so:
 *
 *   - reads (`eth_call`) go to the real chain, unmodified;
 *   - writes (`eth_sendTransaction`) are signed by anvil's unlocked account and
 *     really execute, so the vault's state really changes.
 *
 * That is a large step up from every other test in this repository: the DOM, the
 * CSS, event dispatch, the module loader, the dev server and the chain are all
 * real. What is not proven is anything specific to MetaMask's own UI -- see
 * web/DESIGN.md §7, which stays the manual checklist.
 *
 * SANDBOX: Chromium needs unconfined process/IPC access (it dies under a confined
 * sandbox with "platform_channel.cc: Check failed: permission denied"). This file is
 * therefore NOT part of scripts/run-all.mjs, which must pass in a confined shell.
 *
 * Run: node web/tools/browser-test.mjs [--keep-screenshots]
 */
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SHOTS = resolve(REPO, 'web', 'tools', 'screenshots');
const PAGE = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const KEEP = process.argv.includes('--keep-screenshots');

// ---------------------------------------------------------------- assertions

const failures = [];
const passes = [];

function check(label, ok, detail = '') {
  if (ok) {
    passes.push(label);
    console.log(`  ok   ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ''}`);
  }
}

const eq = (label, actual, expected) => check(label, String(actual) === String(expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
const has = (label, haystack, needle) => check(label, String(haystack).includes(needle), `${JSON.stringify(String(haystack).slice(0, 120))} should contain ${JSON.stringify(needle)}`);

// ------------------------------------------------------------- the fake wallet

/**
 * The injected EIP-1193 provider.
 *
 * Generated as source text because it has to exist in the page before any page
 * script runs. It records every request on `window.__walletLog` so a test can
 * assert on what the page ASKED FOR, which is where the approval-flow bugs live.
 */
function fakeWalletSource({ rpcUrl, address, chainId }) {
  return `
(() => {
  const RPC = ${JSON.stringify(rpcUrl)};
  const ADDRESS = ${JSON.stringify(address)};
  const CHAIN_ID_HEX = ${JSON.stringify(chainId)};
  const log = [];
  window.__walletLog = log;

  let id = 0;
  const call = async (method, params) => {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };

  const provider = {
    isFakeWallet: true,
    // The page reads this to detect several injected wallets.
    providers: undefined,
    async request({ method, params = [] }) {
      log.push({ method, params });

      switch (method) {
        // --- wallet-level, answered locally
        case 'eth_requestAccounts':
        case 'eth_accounts':
          // A short delay so the page's "waiting for the wallet" state is real.
          await new Promise((r) => setTimeout(r, 60));
          return [ADDRESS];
        case 'eth_chainId':
          return CHAIN_ID_HEX;
        case 'net_version':
          return String(parseInt(CHAIN_ID_HEX, 16));
        case 'wallet_switchEthereumChain':
          // Already on the right chain: a successful no-op, which is what MetaMask
          // does when asked to switch to the chain it is already on.
          return null;

        // --- chain-level: forwarded to the real anvil
        case 'eth_call':
        case 'eth_getCode':
        case 'eth_getTransactionReceipt':
        case 'eth_getTransactionCount':
        case 'eth_blockNumber':
        case 'eth_getTransactionByHash':
        case 'eth_getBlockTransactionCountByNumber':
        case 'eth_getTransactionByBlockNumberAndIndex':
        case 'eth_estimateGas':
        case 'eth_gasPrice':
          return call(method, params);

        // --- writes: sent by anvil's own unlocked account, so they really execute
        case 'eth_sendTransaction': {
          const [tx] = params;
          // The page passes \`from\`; anvil signs for it because it is one of its own
          // unlocked accounts. Gas and nonce are left to anvil, exactly as a wallet
          // would fill them in.
          const hash = await call('eth_sendTransaction', [{ from: ADDRESS, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }]);
          // Give the receipt a moment to exist, as a real wallet's promise implies
          // nothing at all about mining -- but the page polls for it, so this is
          // only to keep the test quick.
          await new Promise((r) => setTimeout(r, 120));
          return hash;
        }
        default:
          throw Object.assign(new Error('the fake wallet does not implement ' + method), { code: -32601 });
      }
    },
    on() {},
    removeListener() {},
  };

  Object.defineProperty(window, 'ethereum', { value: provider, writable: false, configurable: false });
})();
`;
}

// ---------------------------------------------------------------- the chain

/**
 * Read the chain directly, so expectations come from the chain rather than from
 * numbers typed into this file.
 *
 * The first version hard-coded "550 total assets" and "500 shares". It passed
 * once and then failed on every later run, because this test really deposits -- so
 * the vault really grows. A test whose expected values are a snapshot of one
 * moment is a test that fails for the wrong reason.
 */
async function chainCall(to, data) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`eth_call ${data}: ${body.error.message}`);
  return BigInt(body.result === '0x' ? '0x0' : body.result);
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** The same call, but returning raw hex -- needed for strings and addresses. */
async function chainCallRaw(to, data) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`eth_call ${data}: ${body.error.message}`);
  return body.result;
}

const SEL = {
  totalAssets: '0x01e1d114',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  symbol: '0x95d89b41',
};
const pad = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');

/** The value shown for `assets` in the page's own formatter. */
const formatUnits = (value, decimals) => {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
};

/** Decode a returned string (offset, length, data). Only used for `symbol()`. */
function decodeString(hex) {
  const raw = hex.replace(/^0x/, '');
  if (raw.length <= 128) return Buffer.from(raw, 'hex').toString('utf8').replace(/\0+$/, '');
  const offset = Number(BigInt(`0x${raw.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${raw.slice(offset, offset + 64)}`));
  return Buffer.from(raw.slice(offset + 64, offset + 64 + length * 2), 'hex').toString('utf8');
}

// ---------------------------------------------------------------- the run

async function main() {
  // ---- prerequisites, reported rather than crashed on
  let config;
  try {
    config = await (await fetch(`${PAGE}/api/config`, { cache: 'no-store' })).json();
  } catch (err) {
    console.log(`SKIP: no dev server at ${PAGE} (${err.message})`);
    process.exit(0);
  }
  if (!config.ok) {
    console.log(`SKIP: the dev server reports: ${config.error}`);
    process.exit(0);
  }

  const chainId = Number(BigInt(await rpc('eth_chainId')));
  if (chainId !== config.chainId) {
    console.log(`SKIP: the chain is ${chainId} but the deployment record is for ${config.chainId}`);
    process.exit(0);
  }

  // ---- the chain's own figures, before anything is touched
  const before = {
    totalAssets: await chainCall(config.vault, SEL.totalAssets),
    totalSupply: await chainCall(config.vault, SEL.totalSupply),
    ownerBalance: await chainCall(config.asset, SEL.balanceOf + pad(config.owner)),
    symbol: decodeString(await chainCallRaw(config.asset, SEL.symbol)),
  };
  console.log(`chain before: totalAssets ${before.totalAssets}, totalSupply ${before.totalSupply}, owner ${before.ownerBalance}, symbol ${before.symbol}`);

  /**
   * What the page should display for an asset amount: the number, then the symbol.
   *
   * The page appends the chain's symbol to asset figures, which is right -- and the
   * first version of these assertions compared against the bare number and failed
   * on correct output. The symbol is read from the chain rather than typed here, so
   * this stays true if the mock is ever renamed.
   */
  const shown = (assets, decimals = 6) => `${formatUnits(assets, decimals)} ${before.symbol}`;

  // A snapshot so this test can deposit for real and then put the chain back.
  //
  // THE REVERT IS VERIFIED RATHER THAN TRUSTED. An earlier version called
  // `evm_revert` and printed "reverted the chain snapshot", which was a lie: the
  // next run started from a HIGHER total than the one before, because anvil's
  // periodic state dump (`--state-interval 5`) writes the CURRENT state to disk and
  // can land after the revert. Reporting a cleanup that did not happen is worse
  // than reporting none, so the result is read back and compared.
  let snapshot = null;
  try {
    snapshot = await rpc('evm_snapshot');
  } catch {
    console.log('note: evm_snapshot unavailable; this run will leave its deposits on the chain');
  }

  mkdirSync(SHOTS, { recursive: true });
  const shots = [];

  console.log(`browser test against ${PAGE}, chain ${chainId}`);
  console.log('');

  const browser = await launchBrowser({ port: 9333, width: 1280, height: 1000 });
  console.log(`  browser: ${browser.version.Browser}`);
  console.log('');

  try {
    // ================================================================ no wallet
    console.log('--- with NO wallet injected (the state the page opens in) ---');
    await browser.navigate(PAGE, { settleMs: 2500 });

    const noWallet = await browser.evaluate(`(() => {
      const guard = document.getElementById('wrong-chain-guard');
      const showPrice = document.getElementById('share-price').textContent;
      return {
        chainText: document.getElementById('chain').textContent,
        chainClass: document.getElementById('chain').className,
        guardHiddenProp: guard.hidden,
        guardHasAttr: guard.hasAttribute('hidden'),
        guardAttrValue: guard.getAttribute('hidden'),
        guardDisplay: getComputedStyle(guard).display,
        guardVisible: guard.getBoundingClientRect().height > 0,
        guardText: guard.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
        account: document.getElementById('account').textContent,
        totalAssets: document.getElementById('total-assets').textContent,
        sharePrice: showPrice,
        // 500 whole shares is 5e20 base units, which formats to exactly "500".
        // The first version of this test asserted the raw base units and failed on
        // correct output.
        totalSupply: document.getElementById('total-supply').textContent,
        assetSymbol: document.getElementById('asset-symbol').textContent,
        message: document.getElementById('message').textContent,
        hint: document.getElementById('control-hint').textContent,
        depositDisabled: document.getElementById('deposit-button').disabled,
      };
    })()`);

    eq('account reads "not connected"', noWallet.account, 'not connected');
    // The `hidden` attribute is not enough on its own: if a CSS rule sets
    // `display`, the attribute is overridden and the banner shows anyway. Asserting
    // the computed style is what catches that, and asserting only the attribute is
    // what let it through the first time.
    check('the wrong-chain guard is HIDDEN before connecting (computed style)', noWallet.guardDisplay === 'none', `display="${noWallet.guardDisplay}"`);
    check('...and occupies no space on the page', noWallet.guardVisible === false, `height>0: ${noWallet.guardVisible}`);
    check('the network line is not styled as bad', !noWallet.chainClass.includes('bad'), `className="${noWallet.chainClass}"`);
    has('the network line says not connected', noWallet.chainText, 'not connected');
    has('a wallet message is shown', noWallet.message, 'wallet');
    has('the hint names the wallet', noWallet.hint, 'wallet');

    // The chain reads must work with no wallet at all, and must match the chain.
    eq('the vault total assets match the chain (no wallet needed)', noWallet.totalAssets, shown(before.totalAssets));
    eq('the vault total shares match the chain', noWallet.totalSupply, formatUnits(before.totalSupply, 18));
    check('a share price is shown', /^\d/.test(noWallet.sharePrice), `sharePrice="${noWallet.sharePrice}"`);
    // The Asset field showed "—" in a real browser while readState held the symbol.
    // Asserting on it here is the regression test for that, and it can only be
    // written in a browser test -- the value comes from main.js's call, not from
    // renderState's contract.
    eq('the asset symbol shown is the one the chain reports', noWallet.assetSymbol, before.symbol);

    shots.push(await browser.screenshot(resolve(SHOTS, '01-no-wallet.png')));

    // The Connect button must RESPOND with no wallet. This is the bug that was
    // reported from a real browser and that no stub-based test caught.
    await browser.click('connect-button');
    await new Promise((r) => setTimeout(r, 400));
    const afterConnect = await browser.evaluate(`document.getElementById('message').textContent`);
    has('clicking Connect with no wallet explains itself', afterConnect, 'wallet');
    check('and does not paint an error the user caused', !/undefined|NaN/.test(afterConnect), `message="${afterConnect.slice(0, 80)}"`);

    // ============================================================= with a wallet
    console.log('');
    console.log('--- with a wallet injected, forwarded to the real chain ---');

    const provider = {
      rpcUrl: RPC,
      address: config.owner,
      chainId: `0x${config.chainId.toString(16)}`,
    };
    await browser.injectOnNewDocument(fakeWalletSource(provider));
    await browser.navigate(PAGE, { settleMs: 2500 });

    const connected = await browser.evaluate(`(() => {
      const guard = document.getElementById('wrong-chain-guard');
      return {
        hasProvider: Boolean(window.ethereum && window.ethereum.isFakeWallet),
        chainText: document.getElementById('chain').textContent,
        chainClass: document.getElementById('chain').className,
        guardDisplay: getComputedStyle(guard).display,
        guardVisible: guard.getBoundingClientRect().height > 0,
        account: document.getElementById('account').textContent,
        walletBalance: document.getElementById('wallet-balance').textContent,
        allowance: document.getElementById('allowance').textContent,
        shares: document.getElementById('share-balance').textContent,
        depositDisabled: document.getElementById('deposit-button').disabled,
        hint: document.getElementById('control-hint').textContent,
      };
    })()`);

    check('the injected provider is present before page scripts', connected.hasProvider === true);
    eq('the page auto-detected the wallet and shows the account', connected.account.toLowerCase(), config.owner.toLowerCase());
    has('the network line names the chain', connected.chainText, 'Anvil Local');
    check('the network line is styled good', connected.chainClass.includes('ok'), `className="${connected.chainClass}"`);
    check('the guard is hidden when connected to the right chain (computed style)', connected.guardDisplay === 'none', `display="${connected.guardDisplay}"`);
    check('...and occupies no space', connected.guardVisible === false);
    eq('the wallet balance matches the chain', connected.walletBalance, shown(before.ownerBalance));
    check('deposit is disabled until an amount is entered', connected.depositDisabled === true, `disabled=${connected.depositDisabled}`);

    shots.push(await browser.screenshot(resolve(SHOTS, '02-connected.png')));

    // ---- the deposit flow, which is the point of the page
    const balanceBefore = await browser.evaluate(`document.getElementById('wallet-balance').textContent`);
    await browser.type('deposit-amount', '100');
    const typed = await browser.evaluate(`document.getElementById('deposit-button').disabled`);
    check('typing an amount enables Deposit', typed === false, `disabled=${typed}`);

    await browser.click('deposit-button');
    // approve (mined) + deposit (mined), each polled by the page.
    await browser.waitFor(`document.getElementById('message').textContent.includes('confirmed')`, { timeoutMs: 25000 });
    await new Promise((r) => setTimeout(r, 1500));

    const afterDeposit = await browser.evaluate(`({
      message: document.getElementById('message').textContent,
      messageClass: document.getElementById('message').className,
      walletBalance: document.getElementById('wallet-balance').textContent,
      shares: document.getElementById('share-balance').textContent,
      shareValue: document.getElementById('share-value').textContent,
      allowance: document.getElementById('allowance').textContent,
      totalAssets: document.getElementById('total-assets').textContent,
      calls: window.__walletLog.filter((c) => c.method === 'eth_sendTransaction').length,
      methods: window.__walletLog.map((c) => c.method),
    })`);

    has('the deposit reports success', afterDeposit.message, 'confirmed');
    check('the success message is not styled as an error', afterDeposit.messageClass.includes('ok'), `className="${afterDeposit.messageClass}"`);

    // Two wallet prompts: the approval, then the deposit. Counted from the wallet's
    // own log, so it reflects what the PAGE asked for.
    eq('the deposit produced exactly two transactions (approve, then deposit)', afterDeposit.calls, 2);
    check('shares appear', afterDeposit.shares !== '0' && !afterDeposit.shares.startsWith('0 '), `shares="${afterDeposit.shares}"`);
    check('the wallet balance fell', afterDeposit.walletBalance !== balanceBefore, `${balanceBefore} -> ${afterDeposit.walletBalance}`);

    // Deltas against the chain, not absolute numbers typed into this file.
    const deposited = 100n * 10n ** 6n;
    eq('the vault total assets rose by exactly the deposit', afterDeposit.totalAssets, shown(before.totalAssets + deposited));
    eq('the wallet balance fell by exactly the deposit', afterDeposit.walletBalance, shown(before.ownerBalance - deposited));

    shots.push(await browser.screenshot(resolve(SHOTS, '03-after-deposit.png')));

    // ---- failure class 3: an approval succeeded, then the DEPOSIT was rejected
    //
    // This is the case ARCHITECTURE.md §11 singles out, and the first version of
    // this test simply got it wrong: it rejected the APPROVAL and then expected a
    // retry to succeed. With no allowance granted, a retry correctly needs one.
    // The expectation was the bug, not the page.
    //
    // To exercise the real case the allowance has to EXIST and the deposit has to
    // be what the user refuses. The standing allowance is deliberately EXACTLY the
    // amount deposited, so that the attempt consumes all of it -- which is the
    // precondition the next section needs in order to reproduce the reported bug.
    console.log('');
    console.log('--- failure class 3: approval succeeds, then the deposit is rejected ---');

    await browser.type('deposit-amount', '50');
    await browser.click('approve-button');
    await browser.waitFor(`document.getElementById('message').textContent.includes('Approval confirmed')`, { timeoutMs: 25000 });
    await new Promise((r) => setTimeout(r, 1200));
    const allowed = await browser.evaluate(`document.getElementById('allowance').textContent`);
    eq('the "Approve only" button grants the allowance', allowed, '50');

    const txBeforeReject = await browser.evaluate(`window.__walletLog.filter((c) => c.method === 'eth_sendTransaction').length`);

    // Patch the wallet so the NEXT transaction is refused, the way MetaMask does
    // when the user presses Reject.
    await browser.evaluate(`
      window.__rejectNext = true;
      if (!window.__patched) {
        window.__patched = true;
        const original = window.ethereum.request.bind(window.ethereum);
        window.ethereum.request = async (args) => {
          if (window.__rejectNext && args.method === 'eth_sendTransaction') {
            window.__rejectNext = false;
            throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          }
          return original(args);
        };
      }
      true;
    `);

    await browser.type('deposit-amount', '50');
    await browser.click('deposit-button');
    await new Promise((r) => setTimeout(r, 1500));

    const rejected = await browser.evaluate(`({
      message: document.getElementById('message').textContent,
      messageClass: document.getElementById('message').className,
    })`);
    has('a rejected deposit is reported', rejected.message, 'Cancelled');
    check('...in a NEUTRAL tone, not an error', rejected.messageClass.includes('neutral'), `className="${rejected.messageClass}"`);
    check('...and not as a failure', !rejected.messageClass.includes('error'), `className="${rejected.messageClass}"`);

    // Nothing was sent, so the count must be unchanged. This is also how the
    // "no second approval" claim below is made meaningful.
    const txAfterReject = await browser.evaluate(`window.__walletLog.filter((c) => c.method === 'eth_sendTransaction').length`);
    eq('a rejection sends nothing at all', txAfterReject, txBeforeReject);

    shots.push(await browser.screenshot(resolve(SHOTS, '04-rejected.png')));

    // The retry must be ONE prompt -- the deposit, with no second approval -- and
    // the standing allowance must be SPENT rather than replaced. The arithmetic is
    // the proof: a fresh 50-approval would leave a different number.
    await browser.type('deposit-amount', '50');
    await browser.click('deposit-button');
    await browser.waitFor(`document.getElementById('message').textContent.includes('confirmed')`, { timeoutMs: 25000 });
    await new Promise((r) => setTimeout(r, 1200));

    const retried = await browser.evaluate(`({
      message: document.getElementById('message').textContent,
      totalAssets: document.getElementById('total-assets').textContent,
      allowance: document.getElementById('allowance').textContent,
    })`);
    has('depositing again after a rejected deposit works', retried.message, 'confirmed');

    const txAfterRetry = await browser.evaluate(`window.__walletLog.filter((c) => c.method === 'eth_sendTransaction').length`);
    eq('the retry cost exactly ONE transaction -- no second approval', txAfterRetry - txAfterReject, 1);
    // The allowance was exactly the amount deposited, so the retry consumed all of
    // it. That is the precondition the next section needs: a zero allowance with a
    // deposit already behind it is precisely the state the reported bug was in.
    eq('the whole allowance was spent, not replaced', retried.allowance, '0');
    eq(
      'the vault total assets rose by the retried deposit',
      retried.totalAssets,
      shown(before.totalAssets + deposited + 50n * 10n ** 6n),
    );

    // ===================================================================
    // THE REPORTED BUG, in the exact shape the user hit it.
    //
    // Their on-chain history: nonce 13 approve(100), 14 deposit(100), then
    // 15 deposit(5850) with NO approve -- status 0, reverted with
    // ERC20InsufficientAllowance(vault, 0, 5850e6). The page remembered the first
    // approval and skipped the second, after the first had been consumed.
    //
    // Everything before this point in the file passed while that bug was live,
    // because none of it deposited twice with a LARGER amount the second time.
    // ===================================================================
    console.log('');
    console.log('--- the reported bug: deposit 100, then deposit MORE with a spent allowance ---');

    // The allowance is now zero and a deposit is already behind us -- exactly the
    // state the user's chain was in at nonce 15.
    const spent = await browser.evaluate(`document.getElementById('allowance').textContent`);
    eq('precondition: the allowance is zero after the previous deposit', spent, '0');

    await browser.type('deposit-amount', '150');
    await browser.click('deposit-button');
    await browser.waitFor(`document.getElementById('message').textContent.includes('confirmed') || document.getElementById('message').textContent.includes('refused')`, { timeoutMs: 25000 });
    await new Promise((r) => setTimeout(r, 1500));

    const big = await browser.evaluate(`(() => {
      const sends = window.__walletLog.filter((c) => c.method === 'eth_sendTransaction');
      const word = (data, i) => BigInt('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));
      const label = (c) => {
        const data = c.params[0].data ?? '0x';
        const sel = data.slice(0, 10);
        if (sel === '0x6e553f65') return 'deposit ' + Number(word(data, 0)) / 1e6;
        if (sel === '0x095ea7b3') return 'approve ' + Number(word(data, 1)) / 1e6;
        return sel;
      };
      return {
        message: document.getElementById('message').textContent.slice(0, 60),
        messageClass: document.getElementById('message').className,
        allowance: document.getElementById('allowance').textContent,
        totalAssets: document.getElementById('total-assets').textContent,
        // Only what this step sent. Taking "the last two" instead picked up the
        // rejected 50 from the previous section and made a correct page look wrong.
        since: sends.slice(${txAfterRetry}).map(label),
      };
    })()`);

    has('the larger deposit is confirmed, not refused', big.message, 'confirmed');
    check('...and not styled as an error', big.messageClass.includes('ok'), `className="${big.messageClass}"`);
    eq('the page asked for an approve AND a deposit, in that order', big.since.join(', '), 'approve 150, deposit 150');
    eq('the vault grew by the larger deposit too', big.totalAssets, shown(before.totalAssets + deposited + 50n * 10n ** 6n + 150n * 10n ** 6n));

    shots.push(await browser.screenshot(resolve(SHOTS, '05-second-deposit.png')));

    // ==================================================================
    // THE USER'S ACTUAL CASE: typing the number their wallet shows.
    //
    // A wallet displays fewer decimals than the chain holds. MetaMask showed
    // "5850" while the chain held 5849.999999, so the amount typed was one base
    // unit MORE than the balance. The page must refuse it WITHOUT SENDING
    // ANYTHING -- the earlier shape was approve(5850) (which succeeds, an approval
    // needs no balance) followed by a reverting deposit: two transactions of gas
    // to learn the amount was too large.
    //
    // The unit test covers the decision; this covers that the page obeys it.
    // ==================================================================
    console.log('');
    console.log('--- typing more than the wallet holds must send NOTHING ---');

    const held = await chainCall(config.asset, SEL.balanceOf + pad(config.owner));
    const tooMuch = held + 1n; // one base unit over, which is the whole trap
    const sentBefore = await browser.evaluate(`window.__walletLog.filter((c) => c.method === 'eth_sendTransaction').length`);

    await browser.type('deposit-amount', formatUnits(tooMuch, 6));
    await browser.click('deposit-button');
    await new Promise((r) => setTimeout(r, 2500));

    const overspend = await browser.evaluate(`({
      message: document.getElementById('message').textContent,
      messageClass: document.getElementById('message').className,
      sent: window.__walletLog.filter((c) => c.method === 'eth_sendTransaction').length,
    })`);

    eq('an over-balance deposit sends no transaction at all', overspend.sent, sentBefore);
    has('...and says the wallet does not hold enough', overspend.message, 'Not enough');
    check('...without claiming the contract refused it', !/refused/i.test(overspend.message), `message="${overspend.message.slice(0, 80)}"`);
    check('...and without spending a transaction', !/Gas was still spent/i.test(overspend.message), `message="${overspend.message.slice(0, 80)}"`);
    check('...in a warning tone, not an error', overspend.messageClass.includes('warn'), `className="${overspend.messageClass}"`);

    // The Max button is the real fix for a human: it fills in the EXACT balance, so
    // the number on the wallet's screen never has to be retyped here.
    await browser.click('deposit-max-button');
    const maxFilled = await browser.evaluate(`document.getElementById('deposit-amount').value`);
    eq('the Max button fills the exact balance, to the last decimal', maxFilled, formatUnits(held, 6));
    check('the filled value really is not the round number a wallet shows', maxFilled !== '5850' && maxFilled.includes('.999999'), `value="${maxFilled}"`);

    // And that exact amount is actually accepted, i.e. the boundary is not off by one.
    await browser.click('deposit-button');
    await browser.waitFor(`document.getElementById('message').textContent.includes('confirmed') || document.getElementById('message').textContent.includes('refused') || document.getElementById('message').textContent.includes('Not enough')`, { timeoutMs: 25000 });
    await new Promise((r) => setTimeout(r, 1200));
    const emptied = await browser.evaluate(`document.getElementById('message').textContent.slice(0, 60)`);
    has('depositing the exact balance works', emptied, 'confirmed');

    // ==================================================================
    // The REDEEM Max button. Reported as broken, and it was: it filled the input
    // with the raw share count in base units -- 2.7e20 -- where every other amount
    // on the page is a decimal number. The deposit equivalent used formatUnits and
    // was right; this one did not, and the two were written separately.
    // ==================================================================
    console.log('');
    console.log('--- the REDEEM Max button ---');

    await browser.click('redeem-max-button');
    await new Promise((r) => setTimeout(r, 300));

    const redeemFill = await browser.evaluate(`(() => {
      const shown = document.getElementById('redeem-amount').value;
      const sharesText = document.getElementById('share-balance').textContent;
      return { shown, sharesText, disabled: document.getElementById('redeem-button').disabled };
    })()`);

    check('the redeem Max button fills a decimal number, not raw base units', /^\d+(\.\d+)?$/.test(redeemFill.shown), `value="${redeemFill.shown}"`);
    eq('...and it matches the share balance shown on the page', redeemFill.shown, redeemFill.sharesText);
    // The real distinction is not length: 18-decimal shares are long either way
    // (5409.090899330578546053 is 23 characters, and so is the wrong answer). It is
    // that the filled value must be the SAME NUMBER as the balance on screen. A raw
    // base-unit count is 1e18 times larger while looking superficially similar,
    // which is what made this survive a reading -- and cost a reverted redemption.
    const filledValue = Number(redeemFill.shown);
    const balanceShown = Number(redeemFill.sharesText);
    check(
      '...and the filled value is the same magnitude as the balance, not 1e18 larger',
      Math.abs(filledValue - balanceShown) < 1e-6 * Math.max(1, balanceShown),
      `filled=${filledValue} balance=${balanceShown}`,
    );
    check('the Redeem button is enabled afterwards', redeemFill.disabled === false, `disabled=${redeemFill.disabled}`);

    // The real proof: redeeming everything must succeed.
    await browser.click('redeem-button');
    await browser.waitFor(`document.getElementById('message').textContent.includes('confirmed') || document.getElementById('message').textContent.includes('refused')`, { timeoutMs: 25000 });
    await new Promise((r) => setTimeout(r, 1500));
    const redeemed = await browser.evaluate(`({
      message: document.getElementById('message').textContent.slice(0, 60),
      shares: document.getElementById('share-balance').textContent,
      totalAssets: document.getElementById('total-assets').textContent,
    })`);
    has('redeeming everything succeeds', redeemed.message, 'confirmed');
    eq('...and the shares are gone', redeemed.shares, '0');

    // ====================================================== what the console said
    console.log('');
    console.log('--- page diagnostics ---');
    check('no uncaught exceptions in the page', browser.pageErrors.length === 0, browser.pageErrors.slice(0, 3).join(' | '));
    const realConsoleErrors = browser.consoleErrors.filter((e) => !/favicon/i.test(e));
    check('no console errors', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 3).join(' | '));
  } finally {
    const shotList = shots.slice();
    browser.close();

    // Put the chain back, and CHECK that it went back. A test that deposits for
    // real must not quietly grow the demo vault every time it runs.
    if (snapshot !== null) {
      try {
        await rpc('evm_revert', [snapshot]);
        const restored = await chainCall(config.vault, SEL.totalAssets);
        const restoredSupply = await chainCall(config.vault, SEL.totalSupply);
        console.log('');
        if (restored === before.totalAssets && restoredSupply === before.totalSupply) {
          console.log(`  chain restored: totalAssets ${restored}, totalSupply ${restoredSupply}`);
        } else {
          // Do not paper over this. The demo now disagrees with its own README, and
          // the way back is to reseed, which is a deliberate step rather than a
          // surprise discovered later.
          console.log(`  WARNING: the snapshot did not hold.`);
          console.log(`    before: totalAssets ${before.totalAssets}, totalSupply ${before.totalSupply}`);
          console.log(`    after : totalAssets ${restored}, totalSupply ${restoredSupply}`);
          console.log('    anvil writes its state file every few seconds, so a revert can be');
          console.log('    overwritten by the next dump. Re-baseline with:');
          console.log('      node scripts/seed-demo.mjs');
          console.log('    (the vault is not corrupt -- it simply holds this run\'s deposits.)');
        }
      } catch (err) {
        console.log('');
        console.log(`  WARNING: could not revert the snapshot (${err.message}); the deposits remain`);
      }
    }

    console.log('');
    console.log('screenshots:');
    for (const s of shotList) console.log(`  ${s}`);
    if (!KEEP) {
      rmSync(SHOTS, { recursive: true, force: true });
      console.log('  (removed; pass --keep-screenshots to keep them)');
    }
  }

  console.log('');
  console.log('================================================');
  console.log(`  ${passes.length} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('');
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('');
  console.log('OK -- the real page, in a real browser, against the real chain');
}

await main();
