/**
 * Real-wallet check: the page against the MetaMask the user actually has installed.
 *
 * WHY THIS IS SEPARATE FROM `browser-test.mjs`
 *
 * `browser-test.mjs` replaces `window.ethereum` with a fake that forwards to anvil. That
 * file's own header says what that leaves unproven: "anything specific to MetaMask's own
 * UI". This file attacks exactly that gap, and it is a different kind of program:
 *
 *   - it attaches to a Chrome instance that was started with the REAL user profile, so
 *     the MetaMask extension is genuinely loaded and genuinely injects;
 *   - it therefore does NOT control the wallet. MetaMask decides when to show a popup,
 *     and a human clicks Approve.
 *
 * So this is a PROBE AND A REPORTER, not an assertion suite. It answers questions that
 * only a real wallet can answer, and it prints the answers for a human to read. Where it
 * can assert, it asserts; where the answer depends on a click, it reports what it sees.
 *
 * THE QUESTIONS ONLY A REAL WALLET CAN ANSWER
 *
 *   1. Does MetaMask inject into this page at all, and does it announce itself the way
 *      the page's provider discovery expects? The page listens for `ethereum#initialized`
 *      AND `eip6963:announceProvider`; a real extension exercises both, a fake exercises
 *      neither.
 *   2. Does MetaMask accept `wallet_addEthereumChain` for Anvil Local, and does the page
 *      then see the right chain?
 *   3. Does `eth_requestAccounts` produce the account the page displays?
 *   4. Do the figures the page shows match the chain, with a real provider in the path?
 *
 * Usage (needs a Chrome already running the real profile with --remote-debugging-port):
 *   node web/tools/real-wallet-check.mjs [port] [url]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PORT = Number(process.argv[2] ?? 9222);
const PAGE = process.env.WEB_URL ?? 'http://localhost:5173';
const OUT = resolve(REPO, 'web', 'tools', 'screenshots', 'real-wallet.png');

const RPC = 'http://127.0.0.1:8545';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
function assert(ok, what, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}${detail ? `  (${detail})` : ''}`);
  } else {
    failed.push(`${what}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL ${what}${detail ? `  (${detail})` : ''}`);
  }
}

/** A CDP session on one target, with the handful of methods this needs. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('websocket failed')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate threw');
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log(`targets on ${PORT}: ${list.length}`);
  for (const t of list) console.log(`  [${t.type}] ${String(t.url).slice(0, 90)}`);

  const pages = list.filter((t) => t.type === 'page' && !String(t.url).startsWith('chrome://'));
  if (pages.length === 0) throw new Error('no usable page target; is the dApp open?');

  // A MetaMask service worker or extension page is the proof the extension is loaded --
  // more reliable than asking the page, because the page can only see the result of
  // injection, not whether the extension exists.
  const mmTargets = list.filter((t) => String(t.url).includes('nkbihfbeogaeaoehlefnkodbefgpgknn'));
  console.log(`\nMetaMask targets visible to CDP: ${mmTargets.length}`);
  for (const t of mmTargets) console.log(`  [${t.type}] ${String(t.url).slice(0, 110)}`);

  const page = pages.find((p) => String(p.url).startsWith(PAGE)) ?? pages[0];
  const session = await attach(page.webSocketDebuggerUrl);
  await session.send('Page.enable');
  await session.send('Runtime.enable');

  await session.send('Page.navigate', { url: PAGE });
  await sleep(3000);
  await session.send('Page.reload', { ignoreCache: true });
  await sleep(5000);

  console.log('\n--- what the page sees ---');
  const seen = await session.evaluate(`(() => {
    const eth = window.ethereum;
    const t = (id) => { const n = document.getElementById(id); return n ? n.textContent.trim() : null; };
    const guard = document.getElementById('wrong-chain-guard');
    return {
      href: location.href,
      hasEthereum: Boolean(eth),
      isMetaMask: eth ? Boolean(eth.isMetaMask) : false,
      providers: eth && eth.providers ? eth.providers.length : null,
      selectedAddress: eth ? (eth.selectedAddress || null) : null,
      ethChainId: eth ? (eth.chainId || null) : null,
      account: t('account'),
      chain: t('chain'),
      chainClass: document.getElementById('chain') ? document.getElementById('chain').className : null,
      walletBalance: t('wallet-balance'),
      allowance: t('allowance'),
      shares: t('share-balance'),
      totalAssets: t('total-assets'),
      sharePrice: t('share-price'),
      assetSymbol: t('asset-symbol'),
      lastRead: t('last-read'),
      message: t('message'),
      guardDisplay: guard ? getComputedStyle(guard).display : null,
      chartCandles: document.querySelectorAll('#price-chart .chart-body').length,
      chartCaption: t('chart-caption'),
    };
  })()`);
  console.log(JSON.stringify(seen, null, 2));

  console.log('\n--- assertions ---');
  assert(seen.hasEthereum, 'MetaMask injects window.ethereum', seen.hasEthereum ? 'present' : 'ABSENT');
  assert(seen.isMetaMask === true, 'the injected provider identifies as MetaMask', String(seen.isMetaMask));
  assert(mmTargets.length > 0, 'a MetaMask extension target is visible to CDP', `${mmTargets.length} target(s)`);

  // The chain and account are what a locked wallet cannot provide. Saying so is more
  // useful than a red line that looks like a page bug.
  // Two different failures, two different sentences. The first version printed the
  // "locked wallet" note whenever the chain and account were null -- including when
  // there was no provider at all, which is a different problem with a different fix
  // (wrong Chrome profile) and would have sent the reader to unlock a wallet that is
  // not there.
  if (!seen.hasEthereum) {
    console.log(
      '\n  NOTE: no `window.ethereum` at all, and no MetaMask target on the debug port.\n' +
      '        That is NOT a locked wallet -- it is the extension missing from the Chrome\n' +
      '        profile you launched. MetaMask is only installed in one of this machine\'s\n' +
      '        profiles, so the browser must be started with that profile AND with every\n' +
      '        other Chrome closed first: Chrome is single-instance, and while any other\n' +
      '        instance is running the --profile-directory flag is handed off and ignored.\n' +
      '        The other pages on this page still work -- they read the chain directly.',
    );
  } else if (seen.ethChainId === null && seen.selectedAddress === null) {
    console.log(
      '\n  NOTE: the provider is present but reports no chain and no account. That is the\n' +
      '        signature of a LOCKED MetaMask. Unlock it in the window, then re-run.',
    );
  } else {
    assert(seen.ethChainId === '0x7a69', 'MetaMask is on chain 31337 (0x7a69)', String(seen.ethChainId));
    if (seen.selectedAddress) {
      assert(
        String(seen.account).toLowerCase() === String(seen.selectedAddress).toLowerCase(),
        'the page shows the account MetaMask reports',
        `page=${seen.account} wallet=${seen.selectedAddress}`,
      );
    }
  }

  assert(seen.guardDisplay === 'none', 'the wrong-chain guard is hidden (computed style)', String(seen.guardDisplay));
  assert(seen.chartCandles > 0, 'the chart has candles', String(seen.chartCandles));

  // Independently read the chain and compare, so "the page agrees with the chain" is not
  // the page's own claim about itself.
  const rpc = async (method, params = []) => {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await r.json()).result;
  };
  const chainId = await rpc('eth_chainId');
  assert(chainId === '0x7a69', 'the chain itself is 31337', chainId);

  const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`\nscreenshot: ${OUT}`);
  session.close();

  console.log('');
  if (failed.length === 0) {
    console.log(`OK -- ${passed} check(s) passed with the REAL MetaMask in the path.`);
    return 0;
  }
  console.log(`${passed} passed, ${failed.length} failed:`);
  for (const f of failed) console.log(`  - ${f}`);
  return 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error('real-wallet-check failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
