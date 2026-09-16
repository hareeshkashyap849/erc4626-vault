/**
 * Seed the local demo so the page has something true to show.
 *
 * WHY THIS IS NEEDED
 *
 * The deployed vault is empty, and `dev-deploy.ps1` mints the mock asset to a
 * single account (the browser/demo account, which is also the vault owner). An
 * empty ERC-4626 vault has no share price to display, so the page legitimately
 * shows zeros and "n/a" -- correct, but it demonstrates nothing, and a reader
 * cannot tell a correct zero from a broken zero.
 *
 * So this script, in order:
 *   1. moves some of the asset to a SECOND account, so the page has two holders;
 *   2. deposits from that second account -- the actual product path;
 *   3. reports yield as the owner, so the share price moves above 1, which is the
 *      one number showing the vault is doing something.
 *
 * Every number it prints is read back from the chain, and each step verifies its
 * own effect and throws if the effect is not there. A seeding script that reports
 * success without checking is worse than no seeding script.
 *
 * NO PRIVATE KEYS APPEAR HERE. anvil unlocks all of its accounts, so transactions
 * are sent with `eth_sendTransaction` and anvil signs them. That keeps the keys in
 * one place (`scripts/dev-deploy.ps1`, for the record) and keeps this script
 * readable. On any real network this approach would not work, which is fine: this
 * script only ever runs against the disposable local chain, and it checks the
 * chain id before touching anything.
 *
 * Run: node scripts/seed-demo.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RECORD = resolve(REPO, 'deployments', 'local.json');
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

if (!existsSync(RECORD)) {
  console.log('SKIP: deployments/local.json is missing -- run scripts/dev-chain.ps1 first');
  process.exit(0);
}
const record = JSON.parse(readFileSync(RECORD, 'utf8'));

// ---------------------------------------------------------------- json-rpc

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

/**
 * ABI word encoding.
 *
 * THE ONE TRAP HERE: `String(number)` is DECIMAL. An earlier version of this
 * script padded `String(4000n * 10n**6n)` -- the characters "4000000000" -- into a
 * 32-byte word and sent it as hex, which is 0x4000000000 = 274877906944 rather
 * than 4e9. The transfer then reverted with ERC20InsufficientBalance, and because
 * the receipt only says `status: 0x0`, the actual cause was invisible until the
 * transaction was replayed with `cast run`. So numbers go through toString(16)
 * explicitly, and only genuine hex strings are passed through.
 */
const word = (value) => {
  const hex = typeof value === 'bigint' ? value.toString(16) : typeof value === 'number' ? BigInt(Math.trunc(value)).toString(16) : String(value).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`not encodable as an ABI word: ${value}`);
  return hex.padStart(64, '0');
};

/** Encode a call from a selector and already-encoded words. */
const callData = (selector, ...words) => selector + words.join('');

const decodeWord = (hex) => BigInt(hex === '0x' ? '0x0' : hex);
const addr = (hex) => `0x${hex.slice(-40)}`;
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

async function confirm(hash) {
  for (let i = 0; i < 40; i++) {
    const found = await rpc('eth_getTransactionReceipt', [hash]);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  // anvil may be started with --no-mining; nudge it rather than hanging.
  try {
    await rpc('evm_mine');
  } catch {
    /* not anvil, or mining is not controllable */
  }
  return rpc('eth_getTransactionReceipt', [hash]);
}

async function send(from, to, data) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data }]);
  const r = await confirm(hash);
  if (r?.status !== '0x1') throw new Error(`transaction failed (status ${r?.status ?? 'never mined'})`);
  return hash;
}

/** Selectors come from the vendored viem, so nothing here re-implements keccak. */
async function selectors() {
  // pathToFileURL, not the path: a dynamic import of "D:\..." is rejected with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME, because the loader parses "D:" as a protocol.
  const viem = await import(pathToFileURL(resolve(REPO, 'web', 'app', 'viem.js')).href);
  const selector = (signature) => viem.toFunctionSelector(viem.parseAbi([`function ${signature}`])[0]);
  return {
    totalAssets: selector('totalAssets() view returns (uint256)'),
    totalSupply: selector('totalSupply() view returns (uint256)'),
    decimals: selector('decimals() view returns (uint8)'),
    owner: selector('owner() view returns (address)'),
    balanceOf: selector('balanceOf(address) view returns (uint256)'),
    allowance: selector('allowance(address,address) view returns (uint256)'),
    transfer: selector('transfer(address,uint256)'),
    approve: selector('approve(address,uint256)'),
    deposit: selector('deposit(uint256,address)'),
    reportYield: selector('reportYield(uint256)'),
  };
}

// ---------------------------------------------------------------- preflight

try {
  await rpc('eth_chainId');
} catch (err) {
  console.log(`SKIP: no chain at ${RPC} (${err.message})`);
  process.exit(0);
}

const chainId = Number(decodeWord(await rpc('eth_chainId')));
if (chainId !== record.chainId) {
  console.log(`ABORT: the chain is ${chainId}, but the deployment record is for ${record.chainId}.`);
  console.log('       These addresses do not exist on this chain.');
  process.exit(1);
}

const S = await selectors();
const vault = record.vault;
const asset = record.asset;
const decimals = Number(decodeWord(await ethCall(asset, S.decimals)));
const one = 10n ** BigInt(decimals);
const owner = addr(await ethCall(vault, S.owner));

const accounts = await rpc('eth_accounts');
if (!accounts.some((a) => a.toLowerCase() === owner.toLowerCase())) {
  console.log(`ABORT: the vault owner ${owner} is not one of anvil's unlocked accounts, so this`);
  console.log('       script cannot act as it. Is this the chain the record was written against?');
  process.exit(1);
}
// A second, distinct holder. Prefer one that is not the owner so the page shows
// two separate positions.
const user = accounts.find((a) => a.toLowerCase() !== owner.toLowerCase());

const bal = async (who) => decodeWord(await ethCall(asset, callData(S.balanceOf, word(who))));
const shares = async (who) => decodeWord(await ethCall(vault, callData(S.balanceOf, word(who))));
const allowanceOf = async (who) => decodeWord(await ethCall(asset, callData(S.allowance, word(who), word(vault))));
const show = (v) => Number(v / one);

console.log(`chain ${chainId}  vault ${vault}`);
console.log(`asset ${asset} (${decimals} decimals)`);
console.log(`owner ${owner}   <- the account to import into the wallet`);
console.log(`user  ${user}   <- a second holder, so the page has two positions`);
console.log('');

// ------------------------------------------------------------ 1. fund the user
//
// Top up to a TARGET rather than sending a fixed amount and asserting the result
// equals it. A fixed send is not idempotent, and this script gets re-run: an
// earlier version asserted `balance === SEED` and failed on the second run with
// "user holds 7500000000, expected 4000000000", which reads like a broken transfer
// when it is a correct balance and a wrong expectation.
const TARGET = 4_000n * one;
console.log(`1. topping the user up to ${show(TARGET)} of the asset...`);
{
  const held = await bal(user);
  if (held >= TARGET) {
    console.log(`   already funded (user holds ${show(held)}), skipping`);
  } else {
    const shortfall = TARGET - held;
    const ownerHolds = await bal(owner);
    if (ownerHolds < shortfall) throw new Error(`the owner holds only ${show(ownerHolds)}; cannot send ${show(shortfall)}`);
    await send(owner, asset, callData(S.transfer, word(user), word(shortfall)));
    const after = await bal(user);
    if (after !== TARGET) throw new Error(`top-up did not land: user holds ${after}, expected ${TARGET}`);
    console.log(`   sent ${show(shortfall)}; verified the user now holds exactly ${show(after)}`);
  }
}

// ------------------------------------------------------------- 2. deposit

const DEPOSIT = 500n * one;
console.log(`\n2. depositing ${show(DEPOSIT)} from the user (approve, then deposit)...`);
if ((await shares(user)) > 0n) {
  console.log(`   already deposited (user holds ${await shares(user)} shares), skipping`);
} else {
  if ((await allowanceOf(user)) < DEPOSIT) {
    await send(user, asset, callData(S.approve, word(vault), word(DEPOSIT)));
    const a = await allowanceOf(user);
    if (a < DEPOSIT) throw new Error(`the approval did not land: allowance is ${a}`);
    console.log(`   approved (allowance now ${show(a)})`);
  }
  await send(user, vault, callData(S.deposit, word(DEPOSIT), word(user)));
  const got = await shares(user);
  if (got === 0n) throw new Error('the deposit produced no shares');
  console.log(`   verified: the user holds ${got} shares`);
}

// ---------------------------------------------------------------- 3. yield
//
// reportYield does `safeTransferFrom(msg.sender, address(this), amount)`, so the
// OWNER must approve the vault -- it is a pull, not a push. This script's first
// version called reportYield with no owner allowance, and the transaction
// reverted; a receipt only says `status: 0x0`, so the cause stayed invisible until
// the contract was re-read. The approve below is the fix, not a formality.
const YIELD = 50n * one;
console.log(`\n3. reporting ${show(YIELD)} of yield as the owner, so the share price moves above 1...`);
if ((await ethCall(vault, S.totalAssets)) > DEPOSIT) {
  console.log('   yield was already reported, skipping');
} else {
  const ownerSharesBefore = await shares(owner);
  const userSharesBefore = await shares(user);

  // The owner's allowance is separate from the depositor's, which the deposit
  // above already spent.
  const ownerAllowance = async () => decodeWord(await ethCall(asset, callData(S.allowance, word(owner), word(vault))));
  if ((await ownerAllowance()) < YIELD) {
    if ((await bal(owner)) < YIELD) throw new Error('the owner does not hold enough of the asset to report yield');
    await send(owner, asset, callData(S.approve, word(vault), word(YIELD)));
    const a = await ownerAllowance();
    if (a < YIELD) throw new Error(`the owner's approval did not land: allowance is ${a}`);
    console.log(`   owner approved the vault (allowance ${show(a)})`);
  }

  const assetsBefore = decodeWord(await ethCall(vault, S.totalAssets));
  await send(owner, vault, callData(S.reportYield, word(YIELD)));

  // reportYield must only add assets. If it also minted shares, the existing
  // depositor would gain nothing, so both effects are checked -- not just the one
  // that is easy to see.
  const assetsAfter = decodeWord(await ethCall(vault, S.totalAssets));
  if (assetsAfter !== assetsBefore + YIELD) {
    throw new Error(`totalAssets went ${assetsBefore} -> ${assetsAfter}, expected +${YIELD}`);
  }
  if ((await shares(owner)) !== ownerSharesBefore || (await shares(user)) !== userSharesBefore) {
    throw new Error('reportYield changed a share balance; it must only add assets');
  }
  console.log('   verified: assets rose by exactly the reported amount, share counts unchanged');
}

// ------------------------------------------------------------------ summary

const totalAssets = decodeWord(await ethCall(vault, S.totalAssets));
const totalSupply = decodeWord(await ethCall(vault, S.totalSupply));
const offsetTerm = 10n ** BigInt(18 - decimals);
const price = ((totalAssets + 1n) * 10n ** 18n) / (totalSupply + offsetTerm);
const priceText = `${price / one}.${(price % one).toString().padStart(decimals, '0')}`;

console.log('\n================ what the page should now show ================');
console.log(`  VAULT (visible with no wallet connected)`);
console.log(`    Total assets     ${show(totalAssets)} mUSDC`);
console.log(`    Total shares     ${totalSupply}`);
console.log(`    Price per share  ${priceText}`);
console.log('');
console.log(`  YOUR POSITION (needs the wallet connected as ${owner.slice(0, 10)}...)`);
console.log(`    Wallet balance   ${show(await bal(owner))} mUSDC`);
console.log(`    Allowance        ${show(await allowanceOf(owner))} mUSDC`);
console.log(`    Shares           0`);
console.log(`    Shares worth     0`);
console.log('');
console.log(`  THE OTHER HOLDER (not your wallet -- you will see this on-chain, not in the UI)`);
console.log(`    ${user}`);
console.log(`    ${show(await bal(user))} mUSDC, ${await shares(user)} shares`);
console.log('');
console.log('Refresh http://127.0.0.1:5173/ -- the VAULT rows above must match.');
console.log('The per-account rows stay at zero until a wallet is connected as that account,');
console.log('which is correct: the page reads your balance from the chain, and your account');
console.log('is a different account from the one holding the shares.');
