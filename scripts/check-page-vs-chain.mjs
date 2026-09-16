/**
 * Compare what the PAGE computes against what the CHAIN holds.
 *
 * WHY THIS EXISTS
 *
 * `scripts/seed-demo.mjs` prints the chain values. The page independently computes
 * its own figures from the same reads. Nothing so far checked that the two agree,
 * and they did not, once: the page reported a per-share value 4% low because of a
 * wrong virtual-share term, and every existing test was happy because it asserted
 * the page against itself.
 *
 * So this reads the chain directly over JSON-RPC and reads the page's own module,
 * and compares. The module is imported, not re-implemented -- if the comparison
 * used its own arithmetic it would just be a third opinion.
 *
 * Run with the dev server and a chain up: node scripts/check-page-vs-chain.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RECORD = resolve(REPO, 'deployments', 'local.json');
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const PAGE = process.env.WEB_URL ?? 'http://127.0.0.1:5173';

if (!existsSync(RECORD)) {
  console.log('SKIP: deployments/local.json is missing');
  process.exit(0);
}

let record;
try {
  record = JSON.parse(readFileSync(RECORD, 'utf8'));
} catch (err) {
  console.log(`SKIP: cannot read the deployment record (${err.message})`);
  process.exit(0);
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

const word = (value) => {
  const hex = typeof value === 'bigint' ? value.toString(16) : String(value).replace(/^0x/, '');
  return hex.padStart(64, '0');
};
const decode = (hex) => BigInt(hex === '0x' ? '0x0' : hex);

const failures = [];
const check = (label, page, chain) => {
  const ok = String(page) === String(chain);
  if (!ok) failures.push(`${label}: the page says ${page}, the chain says ${chain}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(22)} page=${page}  chain=${chain}`);
};

// ---- can we reach both sides?
try {
  await rpc('eth_chainId');
} catch (err) {
  console.log(`SKIP: no chain at ${RPC} (${err.message})`);
  process.exit(0);
}

const chainId = Number(decode(await rpc('eth_chainId')));
if (chainId !== record.chainId) {
  console.log(`SKIP: the chain is ${chainId}, the record is for ${record.chainId}`);
  process.exit(0);
}

const viem = await import(pathToFileURL(resolve(REPO, 'web', 'app', 'viem.js')).href);
const vaultModule = await import(pathToFileURL(resolve(REPO, 'web', 'app', 'vault.js')).href);
const { VAULT_ABI, ERC20_MIN_ABI, readState } = vaultModule;

// The page reads through the dev server's same-origin proxy, so this does too --
// that is the path the browser actually uses, and it is worth exercising.
let config;
try {
  config = await (await fetch(`${PAGE}/api/config`, { cache: 'no-store' })).json();
} catch (err) {
  console.log(`SKIP: no dev server at ${PAGE} (${err.message})`);
  process.exit(0);
}
if (!config.ok) {
  console.log(`SKIP: the dev server reports ${config.error}`);
  process.exit(0);
}

const publicClient = viem.createPublicClient({ transport: viem.http(`${PAGE}/api/rpc`) });
const { vault, asset } = config;

// The page's own read, through its own code path.
const state = await readState(viem, { publicClient, vault, asset, account: null });

// The chain's answer, read independently of that code.
const rawCall = (to, selector, args = []) => rpc('eth_call', [{ to, data: selector + args.map(word).join('') }, 'latest']);
const sel = (abi, name) => viem.toFunctionSelector(abi.find((e) => e.type === 'function' && e.name === name));

const chainTotalAssets = decode(await rawCall(vault, sel(VAULT_ABI, 'totalAssets')));
const chainTotalSupply = decode(await rawCall(vault, sel(VAULT_ABI, 'totalSupply')));
const chainShareDecimals = Number(decode(await rawCall(vault, sel(VAULT_ABI, 'decimals'))));
const chainAssetDecimals = Number(decode(await rawCall(asset, sel(ERC20_MIN_ABI, 'decimals'))));
const chainAsset = `0x${(await rawCall(vault, sel(VAULT_ABI, 'asset'))).slice(-40)}`;

// The chain's per-share price, computed here by hand from the raw reads -- so a
// bug in shareMath cannot hide by being the only implementation consulted.
const virtualShares = 10n ** BigInt(chainShareDecimals - chainAssetDecimals);
const one = 10n ** BigInt(chainAssetDecimals);
const chainPriceScaled = ((chainTotalAssets + 1n) * 10n ** BigInt(chainShareDecimals)) / (chainTotalSupply + virtualShares);
const chainPrice = `${chainPriceScaled / one}.${(chainPriceScaled % one).toString().padStart(chainAssetDecimals, '0')}`.replace(/\.?0+$/, '') || '0';

console.log(`page ${PAGE}  chain ${RPC}  vault ${vault}`);
console.log('');
console.log('the page\'s readState() vs the chain:');
check('assetDecimals', state.assetDecimals, chainAssetDecimals);
check('shareDecimals', state.shareDecimals, chainShareDecimals);
check('totalAssets', state.totalAssets, chainTotalAssets);
check('totalSupply', state.totalSupply, chainTotalSupply);
check('sharePrice', state.sharePrice, chainPrice);

// The address the page would talk to must be the address the vault reports.
const addressMatches = asset.toLowerCase() === chainAsset.toLowerCase();
if (!addressMatches) failures.push(`the vault's asset() is ${chainAsset}, the config says ${asset}`);
console.log(`  ${addressMatches ? 'ok  ' : 'FAIL'} ${'vault.asset()'.padEnd(22)} config=${asset}  chain=${chainAsset}`);

console.log('');
if (failures.length) {
  console.log(`${failures.length} mismatch${failures.length === 1 ? '' : 'es'}:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('OK -- the page and the chain agree, and the share price was computed independently');
