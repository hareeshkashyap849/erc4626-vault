/**
 * Smoke test the running dev server: does the page actually have everything it
 * needs, served with the right content types?
 *
 * WHY THIS IS SEPARATE FROM check-modules.mjs
 *
 * `check-modules.mjs` proves the module graph LINKS. It says nothing about
 * whether the server will hand those modules to a browser: a wrong content type
 * makes a browser refuse an ES module outright ("Failed to load module script:
 * expected a JavaScript module script but the server responded with a MIME type
 * of ..."), and a missing file is a 404 that only shows up as a blank page.
 *
 * Run: node web/tools/smoke-server.mjs [baseUrl]
 * Needs the dev server up. Exits 0 with SKIP if it is not.
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';

const failures = [];
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  const body = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', body };
}

// ---- is anything listening?
try {
  await get('/');
} catch (err) {
  console.log(`SKIP: no dev server at ${BASE} (${err.message})`);
  console.log('  start it with: node tools/dev-server.mjs');
  process.exit(0);
}

// ---- the files the browser will ask for, and the type it must be told
const ASSETS = [
  ['/', 'text/html', '<!doctype html>'],
  ['/style.css', 'text/css', null],
  ['/app/main.js', 'javascript', null],
  ['/app/wallet.js', 'javascript', null],
  ['/app/vault.js', 'javascript', null],
  ['/app/render.js', 'javascript', null],
  ['/app/viem.js', 'javascript', null],
];

console.log(`smoke test against ${BASE}`);
console.log('');
console.log('static assets:');
for (const [path, expectedType, expectedBody] of ASSETS) {
  const res = await get(path);
  const typeOk = res.type.includes(expectedType);
  check(res.status === 200 && typeOk, `GET ${path}`, `${res.status} ${res.type}`);
  if (expectedBody && !res.body.toLowerCase().includes(expectedBody)) {
    check(false, `GET ${path} body`, `does not contain ${expectedBody}`);
  }
}

// A browser refuses a module served as text/plain, so this is not pedantry.
console.log('');
console.log('module MIME types (a browser rejects a module served as text/plain):');
for (const path of ['/app/main.js', '/app/viem.js']) {
  const res = await get(path);
  check(/javascript/.test(res.type), `${path} is a JavaScript MIME type`, res.type);
}

// ---- the vendored graph must be reachable through the paths the app uses
console.log('');
console.log('vendored viem (reached only through app/viem.js):');
{
  const entry = await get('/app/viem.js');
  check(entry.status === 200, 'app/viem.js loads');
  const specifier = /from\s+'([^']+)'/.exec(entry.body)?.[1];
  check(Boolean(specifier), 'app/viem.js re-exports a vendor module', specifier ?? 'no import found');
  if (specifier) {
    // Resolve the way a BROWSER does: relative to the importing module's URL.
    // Slicing the string by hand produced "http://127.0.0.1:5173../vendor/..."
    // and undici threw ERR_INVALID_URL, which looked like the server's fault.
    const target = new URL(specifier, `${BASE}/app/viem.js`).pathname;
    const res = await get(target);
    check(res.status === 200, `the vendored bundle resolves (${target})`, String(res.status));
  }
}

// ---- /api/config, which is the only source of addresses
console.log('');
console.log('/api/config (the only source of addresses):');
{
  const res = await get('/api/config');
  check(res.status === 200, 'responds 200', String(res.status));
  let config = null;
  try {
    config = JSON.parse(res.body);
  } catch (err) {
    check(false, 'is valid JSON', err.message);
  }
  if (config) {
    check(config.ok === true, 'ok: true');
    check(/^0x[0-9a-fA-F]{40}$/.test(config.vault ?? ''), 'vault is an address', config.vault);
    check(/^0x[0-9a-fA-F]{40}$/.test(config.asset ?? ''), 'asset is an address', config.asset);
    check(Number.isInteger(config.chainId), 'chainId is a number', String(config.chainId));
    check(Number.isInteger(config.deployBlock), 'deployBlock is a number (P4 needs it as an indexer start)', String(config.deployBlock));
    // main.js calls switchChain with config.walletRpcUrl; a wallet cannot use the
    // page-relative /api/rpc proxy, so this must be a real absolute URL.
    check(/^https?:\/\//.test(config.walletRpcUrl ?? ''), 'walletRpcUrl is absolute (a wallet cannot use /api/rpc)', config.walletRpcUrl);
    check(config.rpcUrl === '/api/rpc', 'rpcUrl is the same-origin proxy', config.rpcUrl);
    check(Boolean(config.chainName), 'chainName is present (shown by the wrong-chain guard)', config.chainName);
  }
}

// ---- the RPC proxy must actually reach the chain
console.log('');
console.log('/api/rpc (same-origin proxy):');
{
  const res = await fetch(`${BASE}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  const body = await res.json();
  check(res.status === 200, 'responds 200', String(res.status));
  check(body.result === '0x7a69', 'reports chain 31337', body.result ?? body.error ?? 'no result');
}

// ---- the page must not leak an absolute RPC URL into a module a browser loads
console.log('');
console.log('no hardcoded addresses in the app modules:');
{
  for (const path of ['/app/main.js', '/app/wallet.js', '/app/vault.js', '/app/render.js']) {
    const res = await get(path);
    const hardcoded = res.body.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    check(hardcoded.length === 0, `${path} contains no contract address`, hardcoded.join(', ') || 'none');
  }
}

console.log('');
if (failures.length) {
  console.log(`${failures.length} problem${failures.length === 1 ? '' : 's'}:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK -- the server serves everything the page needs, with usable types');
