/**
 * Bring the local demo back to a usable state after the chain was restarted.
 *
 * WHY THIS IS NEEDED
 *
 * `deployments/anvil-state.json` is written by anvil on a GRACEFUL exit. The demo
 * chain was killed rather than interrupted, so the file is a snapshot from partway
 * through the original deployment: the vault and the asset are both deployed at the
 * addresses in `deployments/local.json` (so the page still points at real code),
 * but the mock asset was never minted. `totalSupply` is 0 and every account holds
 * nothing.
 *
 * That is recoverable without redeploying, because `MockERC20.mint` is
 * permissionless -- it exists to be called by tests. So this mints the demo supply
 * to the owner account, and then `seed-demo.mjs` does the rest (top up a second
 * holder, deposit, report yield).
 *
 * Run: node scripts/fund-demo.mjs
 * Then: node scripts/seed-demo.mjs
 *
 * If a redeploy is ever preferable, `scripts/dev-chain.ps1 -Force` does that
 * instead. This script exists because redeploying changes every address, which
 * means re-importing into MetaMask and re-adding the network -- a lot of manual
 * work to recover from a file that only lost its balances.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RECORD = resolve(REPO, 'deployments', 'local.json');
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

/** The supply the original deploy script minted. */
const DEMO_SUPPLY = 10_000n * 10n ** 6n;

if (!existsSync(RECORD)) {
  console.log('SKIP: deployments/local.json is missing -- run scripts/dev-chain.ps1 first');
  process.exit(0);
}
const record = JSON.parse(readFileSync(RECORD, 'utf8'));

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
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

async function confirm(hash) {
  for (let i = 0; i < 40; i++) {
    const found = await rpc('eth_getTransactionReceipt', [hash]);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    await rpc('evm_mine');
  } catch {
    /* not anvil */
  }
  return rpc('eth_getTransactionReceipt', [hash]);
}

async function send(from, to, data) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data }]);
  const r = await confirm(hash);
  if (r?.status !== '0x1') throw new Error(`transaction failed (status ${r?.status ?? 'never mined'})`);
  return hash;
}

// ---------------------------------------------------------------- preflight

try {
  await rpc('eth_chainId');
} catch (err) {
  console.log(`SKIP: no chain at ${RPC} (${err.message})`);
  process.exit(0);
}

const chainId = Number(decode(await rpc('eth_chainId')));
if (chainId !== record.chainId) {
  console.log(`ABORT: the chain is ${chainId}; the deployment record is for ${record.chainId}`);
  process.exit(1);
}

const { vault, asset, owner } = record;

// Prove the addresses are real before touching anything. A record that points at
// empty addresses is the failure this script most needs to report rather than
// paper over with a mint that would then go nowhere.
const vaultCode = await rpc('eth_getCode', [vault, 'latest']);
if (vaultCode === '0x') {
  console.log(`ABORT: no contract at the recorded vault address ${vault}.`);
  console.log('       The saved chain state does not match deployments/local.json.');
  console.log('       Redeploy instead:  powershell -ExecutionPolicy Bypass -File scripts/dev-chain.ps1 -Force');
  process.exit(1);
}

const viem = await import(pathToFileURL(resolve(REPO, 'web', 'app', 'viem.js')).href);
const selector = (signature) => viem.toFunctionSelector(viem.parseAbi([`function ${signature}`])[0]);
const mint = selector('mint(address,uint256)');
const totalSupply = selector('totalSupply() view returns (uint256)');
const balanceOf = selector('balanceOf(address) view returns (uint256)');

console.log(`chain ${chainId}  vault ${vault}`);
console.log(`asset ${asset}  owner ${owner}`);
console.log('');

/**
 * The mock's supply is a single hard-coded 10,000 in the original deploy, so the
 * target is "the owner holds the whole demo supply", not "mint another 10,000".
 * Re-running must not inflate the supply, or a second run would quietly hand every
 * depositor a 2x share of the vault on the next yield.
 */
const supplyNow = decode(await ethCall(asset, totalSupply));
const ownerNow = decode(await ethCall(asset, balanceOf + word(owner)));

console.log(`asset totalSupply : ${supplyNow} (${Number(supplyNow) / 1e6} mUSDC)`);
console.log(`owner balance     : ${ownerNow} (${Number(ownerNow) / 1e6} mUSDC)`);
console.log('');

if (ownerNow >= DEMO_SUPPLY) {
  console.log(`already funded (the owner holds ${Number(ownerNow) / 1e6}); nothing to do`);
} else {
  const shortfall = DEMO_SUPPLY - ownerNow;
  console.log(`minting ${Number(shortfall) / 1e6} mUSDC to the owner...`);
  await send(owner, asset, mint + word(owner) + word(shortfall));

  const after = decode(await ethCall(asset, balanceOf + word(owner)));
  if (after !== DEMO_SUPPLY) throw new Error(`the mint did not land: the owner holds ${after}, expected ${DEMO_SUPPLY}`);
  const supplyAfter = decode(await ethCall(asset, totalSupply));
  console.log(`  verified: owner holds ${Number(after) / 1e6}, totalSupply ${Number(supplyAfter) / 1e6}`);
}

console.log('');
console.log('next:  node scripts/seed-demo.mjs     (top up the second holder, deposit, report yield)');
