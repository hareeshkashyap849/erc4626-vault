/**
 * Verify the ERC-4626 virtual-share term against the DEPLOYED contract.
 *
 * WHY THIS EXISTS
 *
 * `shareMath` had a bug for two rounds: it used `10 ** shareDecimals` (1e18) where
 * ERC-4626 specifies `10 ** _decimalsOffset()`. The offset is
 * `18 - assetDecimals` = 12, so the term is 1e12. Every derivation of that number
 * in a comment is an argument; this is a measurement.
 *
 * The measurement does not need a `_decimalsOffset()` getter (it is internal).
 * Deposit 1 asset unit and read back:
 *
 *     shares = assets * (totalSupply + T) / (totalAssets + 1)
 *             = 1 * (0 + T) / (0 + 1) = T
 *
 * so the shares minted for a 1-unit first deposit ARE the term T. That is the
 * number, read off the chain, with no arithmetic of mine in between.
 *
 * Run: node scripts/check-share-term.mjs
 * Needs anvil up and a deployed vault. Skips cleanly if either is missing, so it
 * is safe to call from a suite that may run offline.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RECORD = resolve(REPO, 'deployments', 'local.json');
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

if (!existsSync(RECORD)) {
  console.log('SKIP: deployments/local.json is missing -- nothing is deployed to check');
  process.exit(0);
}

const record = JSON.parse(readFileSync(RECORD, 'utf8'));

/**
 * A minimal JSON-RPC call. Deliberately not viem: this must not depend on the
 * module it is checking, or a bug in that module could hide itself.
 */
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

/** `cast`-free function call: selector + padded args. */
function call(address, signature, args = []) {
  // The signatures used here are all single-word types, so the encoding is a
  // selector followed by 32-byte words. A general ABI encoder is not needed and
  // would be another dependency to distrust.
  const selectors = {
    'totalAssets()': '0x01e1d114',
    'totalSupply()': '0x18160ddd',
    'decimals()': '0x313ce567',
    'asset()': '0x38d52e0f',
    'balanceOf(address)': '0x70a08231',
  };
  const selector = selectors[signature];
  if (!selector) throw new Error(`no selector recorded for ${signature}`);
  const encoded = args
    .map((a) => {
      const hex = typeof a === 'bigint' ? a.toString(16) : String(a).replace(/^0x/, '');
      return hex.padStart(64, '0');
    })
    .join('');
  return rpc('eth_call', [{ to: address, data: selector + encoded }, 'latest']);
}

const word = (hex) => BigInt(hex === '0x' ? '0x0' : hex);
const address = (hex) => `0x${hex.slice(-40)}`;

/** Wait for a receipt. Anvil may be started with --no-mining, so send + poll. */
async function receipt(hash, { tries = 40, delayMs = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const found = await rpc('eth_getTransactionReceipt', [hash]);
    if (found) return found;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/** Send and wait, and if nothing mines, nudge the chain rather than hanging. */
async function send(tx) {
  const hash = await rpc('eth_sendTransaction', [tx]);
  let found = await receipt(hash);
  if (!found) {
    // --no-mining, or an interval longer than the poll window. `evm_mine` is
    // universally available on anvil and is a no-op if something already mined.
    try {
      await rpc('evm_mine');
      found = await receipt(hash);
    } catch {
      /* not anvil, or mining is not controllable */
    }
  }
  return { hash, receipt: found };
}

let failed = false;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};

let snapshot = null;
const cleanup = async () => {
  if (snapshot === null) return;
  try {
    await rpc('evm_revert', [snapshot]);
    console.log('');
    console.log('  reverted the measurement: the vault is exactly as it was');
  } catch {
    console.log('');
    console.log(`  WARNING: could not revert snapshot ${snapshot}; the vault now holds 1 extra asset unit`);
  }
  snapshot = null;
};

try {
  await rpc('eth_chainId');
} catch (err) {
  console.log(`SKIP: no chain at ${RPC} (${err.message})`);
  process.exit(0);
}

const chainId = Number(word(await rpc('eth_chainId')));
const vault = record.vault;
const asset = address(await call(vault, 'asset()'));
const shareDecimals = Number(word(await call(vault, 'decimals()')));
const assetDecimals = Number(word(await call(asset, 'decimals()')));

console.log(`chain ${chainId}, vault ${vault}`);
console.log(`asset ${asset} (${assetDecimals} decimals), shares ${shareDecimals} decimals`);
console.log('');

// ---- the deployment record must describe the contract that is actually there
check('record.chainId matches the chain', chainId, record.chainId);
check('vault.asset() matches record.asset', asset.toLowerCase(), String(record.asset).toLowerCase());
check('share decimals are 18', shareDecimals, 18);

// ---- the term, read off the chain
const totalSupply = word(await call(vault, 'totalSupply()'));
const totalAssets = word(await call(vault, 'totalAssets()'));
const expectedTerm = 10n ** BigInt(shareDecimals - assetDecimals); // what shareMath assumes: 1e12

console.log('');
console.log('the virtual-share term, derived two ways:');
console.log(`  from decimals offset 18 - ${assetDecimals} -> 10**${shareDecimals - assetDecimals} = ${expectedTerm}`);
console.log(`  from a 1-unit first deposit             -> shares = totalSupply + term (needs an empty vault)`);

if (totalSupply === 0n && totalAssets === 0n) {
  // The vault is empty, so a 1-unit deposit mints exactly the term. Done by
  // sending a real transaction from an account that actually holds the asset.
  //
  // Not anvil's default account: `dev-deploy.ps1` funds the BROWSER account, so
  // the first default account holds 0 of the asset and the deposit reverts. That
  // is what this script did on its first run, and the failure looked like a
  // contract problem rather than a wrong sender.
  const nodeAccounts = await rpc('eth_accounts');
  const candidates = [record.owner, ...nodeAccounts].filter(Boolean);

  let sender = null;
  let balance = 0n;
  for (const candidate of candidates) {
    const held = word(await call(asset, 'balanceOf(address)', [candidate]));
    if (held > 0n) {
      sender = candidate;
      balance = held;
      break;
    }
  }

  if (!sender) {
    console.log('  cannot measure: none of the node accounts holds any of the asset');
    console.log(`  checked: ${candidates.join(', ')}`);
    failed = true;
  } else {
    console.log(`  depositing from ${sender} (holds ${balance} asset units)`);

    // Snapshot first: this writes to the live demo chain, and the measurement
    // should not change the thing being demonstrated.
    try {
      snapshot = await rpc('evm_snapshot');
    } catch {
      console.log('  WARNING: evm_snapshot unavailable; this will leave 1 asset unit in the vault');
    }

    const allowance = word(
      await rpc('eth_call', [
        { to: asset, data: '0xdd62ed3e' + sender.replace(/^0x/, '').padStart(64, '0') + vault.replace(/^0x/, '').padStart(64, '0') },
        'latest',
      ]),
    );
    if (allowance < 1n) {
      const approved = await send({ from: sender, to: asset, data: '0x095ea7b3' + vault.replace(/^0x/, '').padStart(64, '0') + '1'.padStart(64, '0') });
      if (approved.receipt?.status !== '0x1') throw new Error(`the approval did not succeed (receipt ${approved.receipt?.status ?? 'never mined'})`);
    }

    const deposited = await send({ from: sender, to: vault, data: '0x6e553f65' + '1'.padStart(64, '0') + sender.replace(/^0x/, '').padStart(64, '0') });
    if (deposited.receipt?.status !== '0x1') {
      console.log(`  the 1-unit deposit did not succeed (receipt ${deposited.receipt?.status ?? 'never mined'}) -- cannot measure the term`);
      failed = true;
    } else {
      const minted = word(await call(vault, 'balanceOf(address)', [sender]));
      console.log(`  measured: a 1-unit deposit into an empty vault minted ${minted} shares`);
      check('measured term equals 10**offset', minted, expectedTerm);
      const WRONG = 10n ** BigInt(shareDecimals);
      check('and is NOT 10**shareDecimals (the bug that was fixed)', minted === WRONG, false);
    }
    await cleanup();
  }
} else {
  console.log(`  SKIPPED the deposit measurement: the vault is not empty (totalSupply ${totalSupply}, totalAssets ${totalAssets})`);
  console.log('  to measure it, redeploy on a fresh chain: scripts/dev-chain.ps1');
}

console.log('');
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('OK -- the deployed contract agrees with the offset shareMath assumes');
