/**
 * Why are the buttons disabled after connecting?
 *
 * The report: connect through MetaMask, see "Connected / Reading from chain
 * 31337", and then Refresh does nothing and neither Deposit nor Approve can be
 * clicked. Not a missing feature -- a bug.
 *
 * WHAT IS DIFFERENT ABOUT THE USER'S FLOW
 *
 * Every existing browser test injects the wallet BEFORE the page loads, so the
 * page auto-detects it and finishes starting with a wallet already attached. The
 * user pressed Connect, which means the page ran its whole startup with a provider
 * present but NOT YET AUTHORISED, and only later did `eth_requestAccounts` succeed.
 *
 * That is a different path through the same code, and it is the one nobody has
 * exercised. So this drives exactly it and then asks the page what it thinks:
 * the disabled flags, the hint text, the module's own view of the world, and any
 * exception it swallowed.
 *
 * Run: node web/tools/diagnose-controls.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PAGE = process.env.WEB_URL ?? 'http://127.0.0.1:5173';
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

const config = await (await fetch(`${PAGE}/api/config`, { cache: 'no-store' })).json();
if (!config.ok) {
  console.log(`SKIP: ${config.error}`);
  process.exit(0);
}

/**
 * A wallet that is present but NOT authorised until asked -- which is what MetaMask
 * does. `eth_accounts` returns [] until `eth_requestAccounts` has been called.
 */
function fakeWalletSource({ rpcUrl, address, chainId }) {
  return `
(() => {
  const RPC = ${JSON.stringify(rpcUrl)};
  const ADDRESS = ${JSON.stringify(address)};
  const CHAIN_ID_HEX = ${JSON.stringify(chainId)};
  const log = [];
  let authorised = false;
  window.__walletLog = log;
  window.__authorise = () => { authorised = true; };

  let id = 0;
  const call = async (method, params) => {
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };

  const provider = {
    isFakeWallet: true,
    async request({ method, params = [] }) {
      log.push({ method });
      switch (method) {
        case 'eth_accounts':
          return authorised ? [ADDRESS] : [];
        case 'eth_requestAccounts':
          await new Promise((r) => setTimeout(r, 60));
          authorised = true;
          return [ADDRESS];
        case 'eth_chainId':
          return CHAIN_ID_HEX;
        case 'wallet_switchEthereumChain':
          return null;
        case 'eth_call': case 'eth_getCode': case 'eth_getTransactionReceipt':
        case 'eth_getTransactionCount': case 'eth_blockNumber': case 'eth_estimateGas':
        case 'eth_getTransactionByHash': case 'eth_getBlockTransactionCountByNumber':
        case 'eth_getTransactionByBlockNumberAndIndex': case 'eth_gasPrice':
          return call(method, params);
        case 'eth_sendTransaction': {
          const [tx] = params;
          const hash = await call('eth_sendTransaction', [{ from: ADDRESS, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }]);
          await new Promise((r) => setTimeout(r, 120));
          return hash;
        }
        default:
          throw Object.assign(new Error('not implemented: ' + method), { code: -32601 });
      }
    },
    on() {}, removeListener() {},
  };
  Object.defineProperty(window, 'ethereum', { value: provider, writable: false, configurable: false });
})();
`;
}

/** Everything the page knows about its own controls. */
const PROBE = `(() => {
  const btn = (id) => {
    const n = document.getElementById(id);
    if (!n) return { missing: true };
    return {
      disabled: n.disabled,
      hasDisabledAttr: n.hasAttribute('disabled'),
      display: getComputedStyle(n).display,
      pointerEvents: getComputedStyle(n).pointerEvents,
      opacity: getComputedStyle(n).opacity,
      clickHandlers: 'n/a',
    };
  };
  return {
    account: document.getElementById('account').textContent,
    chain: document.getElementById('chain').textContent,
    hint: document.getElementById('control-hint').textContent,
    message: document.getElementById('message').textContent.slice(0, 200),
    depositAmountValue: document.getElementById('deposit-amount').value,
    buttons: {
      connect: btn('connect-button'),
      refresh: btn('refresh-button'),
      deposit: btn('deposit-button'),
      approve: btn('approve-button'),
      redeem: btn('redeem-button'),
      redeemMax: btn('redeem-max-button'),
    },
  };
})()`;

console.log(`diagnosing ${PAGE}`);
console.log('');

const browser = await launchBrowser({ port: 9335, width: 1280, height: 1000 });
try {
  await browser.injectOnNewDocument(fakeWalletSource({ rpcUrl: RPC, address: config.owner, chainId: `0x${config.chainId.toString(16)}` }));
  await browser.navigate(PAGE, { settleMs: 3000 });

  const log = (label, value) => {
    console.log(`--- ${label}`);
    console.log(JSON.stringify(value, null, 2).split('\n').map((l) => '  ' + l).join('\n'));
  };

  log('BEFORE clicking Connect (wallet present but unauthorised)', await browser.evaluate(PROBE));

  console.log('');
  console.log('--- clicking Connect wallet');
  await browser.click('connect-button');
  await new Promise((r) => setTimeout(r, 2500));
  log('AFTER clicking Connect', await browser.evaluate(PROBE));

  console.log('');
  console.log('--- typing 100 into the deposit amount');
  await browser.type('deposit-amount', '100');
  await new Promise((r) => setTimeout(r, 600));
  log('AFTER typing an amount', await browser.evaluate(PROBE));

  console.log('');
  console.log('--- clicking Refresh (must prove it did something) ---');
  const beforeRefresh = await browser.evaluate(`document.getElementById('last-read').textContent`);
  await new Promise((r) => setTimeout(r, 1100));
  await browser.click('refresh-button');
  await new Promise((r) => setTimeout(r, 1200));
  const afterRefresh = await browser.evaluate(`document.getElementById('last-read').textContent`);
  console.log(`  last-read before: ${JSON.stringify(beforeRefresh)}`);
  console.log(`  last-read after : ${JSON.stringify(afterRefresh)}`);
  console.log(`  changed         : ${beforeRefresh !== afterRefresh}`);

  console.log('');
  console.log('--- wallet calls the page made');
  console.log('  ' + (await browser.evaluate('window.__walletLog.map((c) => c.method).join(", ")')));

  console.log('');
  console.log('--- page exceptions');
  console.log('  ' + (browser.pageErrors.length ? browser.pageErrors.join('\n  ') : '(none)'));
  console.log('--- console errors');
  console.log('  ' + (browser.consoleErrors.length ? browser.consoleErrors.join('\n  ') : '(none)'));

  await browser.screenshot(resolve(REPO, 'web', 'tools', 'screenshots', 'diagnose.png'));
} finally {
  browser.close();
}
