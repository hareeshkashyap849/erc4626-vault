/**
 * Validate a deployment record — the keys each reader needs, and then the on-chain facts.
 *
 * WHY THIS EXISTS
 *
 * Three programs read `deployments/<chain>.json` and each reads a different subset: the console's
 * `loadDeployment()` (chainId, vault, asset), `next.config.ts` at build time (chainId, chainName), and
 * the indexer (vault, deployBlock). A record missing one of those keys is not a file that "mostly
 * works" — it is a file that fails at the far end of a deployment, after the testnet ETH has been
 * spent, with an error that names the record rather than the mistake.
 *
 * That is not hypothetical: this repository documented a testnet record format using `address` where
 * the console reads `vault`, and nothing caught it because nothing had been deployed. The cheap fix is
 * a check that runs between "write the record" and "point everything else at it".
 *
 * It checks two layers, and says which it managed:
 *
 *   SHAPE (always)   the keys each reader requires, the address shape, the block number, and whether an
 *                    `abi` entry for the two events the sibling dApp decodes actually exists.
 *   CHAIN (optional) `--rpc <url>`: code is deployed at the vault address, `asset()` on the vault
 *                    equals the recorded asset, `owner()` equals the recorded owner, and the asset's
 *                    `decimals()`/`symbol()` equal what the record claims. **A record that passes the
 *                    shape check and fails this one is worse than no record**, because it looks right.
 *
 * Usage:
 *
 *   node scripts/check-deployment-record.mjs deployments/local.json
 *   node scripts/check-deployment-record.mjs deployments/base-sepolia.json --rpc https://sepolia.base.org
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Viem comes from the vendored copy under `web/`, not from `node_modules`.
 *
 * This repository is a Foundry project: it has no `package.json` and no JS dependencies, and adding
 * one so a single script could import viem would give a Solidity repository a dependency tree for one
 * convenience. The browser app already carries the exact version it needs (`web/vendor/…viem…`), and
 * `web/app/viem.js` exists to re-export it, so the script loads that by URL — the same thing
 * `scripts/check-page-vs-chain.mjs` does.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const viem = await import(pathToFileURL(resolve(REPO, 'web', 'app', 'viem.js')).href);

const args = process.argv.slice(2);
const file = args[0];
const rpcFlag = args.indexOf('--rpc');
const rpcUrl = rpcFlag === -1 ? null : args[rpcFlag + 1];

if (!file) {
  console.error('usage: node scripts/check-deployment-record.mjs <record.json> [--rpc <url>]');
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};
const skip = (label, why) => console.log(`  skip  ${label}  (${why})`);

console.log(`record: ${file}\n`);

let record;
try {
  record = JSON.parse(readFileSync(file, 'utf8'));
} catch (cause) {
  console.error(`  FAIL  the file is not valid JSON: ${cause instanceof Error ? cause.message : cause}`);
  console.error('\n  A record that cannot be parsed is read by three programs as a missing deployment,');
  console.error('  and the error each of them reports is about their own missing key rather than about');
  console.error('  the syntax. Fix the JSON first; no comments are allowed in it.');
  process.exit(1);
}

/**
 * The required keys, grouped by the reader that needs them.
 *
 * Deliberately not a flat list: when a key is missing, the useful sentence names WHO wanted it,
 * because that is what decides how urgent the fix is.
 */
const REQUIRED = [
  { keys: ['chainId', 'vault', 'asset'], reader: 'the console (loadDeployment) and the build (next.config.ts)' },
  { keys: ['vault', 'deployBlock'], reader: 'the indexer (address and start block)' },
];

console.log('shape:');
for (const group of REQUIRED) {
  for (const key of group.keys) {
    if (!(key in record)) check(`"${key}" is present, for ${group.reader}`, false, 'missing');
    else check(`"${key}" is present, for ${group.reader}`, true);
  }
}

/**
 * The key that was wrong in the documented format.
 *
 * Reported specifically rather than as "vault is missing", because the mistake has a name and the fix
 * is one word. This is the check that would have caught it before a deployment existed.
 */
if (!('vault' in record) && 'address' in record) {
  check(
    'the record does not use "address" where the readers expect "vault"',
    false,
    'rename it: the console reads record.vault, and a record with only "address" is refused by name',
  );
}
if ('asset' in record && typeof record.asset === 'object' && record.asset !== null) {
  check(
    'the record does not nest "asset" as an object',
    false,
    'the console reads record.asset as a string; keep symbol/decimals as assetSymbol/assetDecimals',
  );
}

check('"vault" looks like an address', typeof record.vault === 'string' && viem.isAddress(record.vault), String(record.vault));
check('"asset" looks like an address', typeof record.asset === 'string' && viem.isAddress(record.asset), String(record.asset));
check(
  '"deployBlock" is a positive integer',
  Number.isInteger(record.deployBlock) && record.deployBlock > 0,
  String(record.deployBlock),
);
if ('owner' in record) {
  check('"owner" looks like an address', typeof record.owner === 'string' && viem.isAddress(record.owner), String(record.owner));
} else {
  skip('"owner" looks like an address', 'not recorded');
}

/**
 * The ABI, if this record is going to be used by the sibling dApp.
 *
 * `Deposit` and `Withdraw` are the two events its indexer decodes, and an ABI without them produces an
 * indexer that runs, reports success, and records nothing.
 */
if ('abi' in record) {
  const abi = record.abi;
  const has = (name) =>
    Array.isArray(abi) && abi.some((entry) => entry?.type === 'event' && entry?.name === name);
  check('the ABI includes the Deposit event', has('Deposit'));
  check('the ABI includes the Withdraw event', has('Withdraw'));
} else {
  skip('the ABI includes Deposit and Withdraw', 'no abi in this record');
}

if ('sourceCommit' in record) {
  check('"sourceCommit" looks like a git sha', /^[0-9a-f]{7,40}$/.test(String(record.sourceCommit)), String(record.sourceCommit));
} else {
  skip('"sourceCommit" looks like a git sha', 'not recorded (fine for local, required for a public deployment)');
}

if (rpcUrl === null) {
  console.log('\nchain:');
  skip('on-chain facts', 'no --rpc given, so nothing was compared against the chain');
} else {
  console.log(`\nchain: ${rpcUrl}`);
  const client = viem.createPublicClient({ transport: viem.http(rpcUrl, { timeout: 30_000 }) });
  const vault = viem.getAddress(record.vault);
  const asset = viem.getAddress(record.asset);

  try {
    const chainId = await client.getChainId();
    check(`the endpoint is on the record's chain (record says ${record.chainId})`, chainId === record.chainId, `endpoint says ${chainId}`);

    const code = await client.getBytecode({ address: vault });
    check('there is bytecode at the vault address', typeof code === 'string' && code.length > 2, `${(code?.length ?? 0) / 2 - 1} bytes`);

    // A minimal ABI, written out rather than imported, so this script does not depend on the vault
    // module it is meant to be checking against.
    const VAULT_ABI = [
      { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
      { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
      { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
      { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    ];

    const onChainAsset = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'asset' });
    check('the vault\'s asset() equals the recorded asset', viem.getAddress(onChainAsset) === asset, String(onChainAsset));

    if ('owner' in record) {
      const onChainOwner = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'owner' });
      check('the vault\'s owner() equals the recorded owner', viem.getAddress(onChainOwner) === viem.getAddress(record.owner), String(onChainOwner));
    }

    const ERC20_ABI = [
      { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
    ];
    const decimals = await client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'decimals' });
    const symbol = await client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'symbol' });
    check('the asset reports the recorded decimals', record.assetDecimals === undefined || Number(decimals) === Number(record.assetDecimals), `${decimals} on chain${record.assetDecimals !== undefined ? `, record says ${record.assetDecimals}` : ' (not recorded)'}`);
    check('the asset reports the recorded symbol', record.assetSymbol === undefined || symbol === record.assetSymbol, `${symbol} on chain${record.assetSymbol !== undefined ? `, record says ${record.assetSymbol}` : ' (not recorded)'}`);

    const totalAssets = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'totalAssets' });
    const totalSupply = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'totalSupply' });
    console.log(`        totalAssets ${totalAssets}  totalSupply ${totalSupply}  (read now, not asserted)`);
  } catch (cause) {
    check('the chain could be read', false, String(cause instanceof Error ? cause.message : cause).slice(0, 140));
  }
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('record is valid');
if (rpcUrl === null) {
  console.log('(shape only -- pass --rpc to compare it against the chain; a record that is merely well-formed is not a deployment)');
}
