/**
 * Verify the vendored graph loads and exports what the dApp needs.
 *
 * This is the check that matters: 27 locally rewritten files could still be
 * broken in ways that only appear at load time -- a mistyped relative path, a
 * cycle, a module that silently resolved to the wrong package. Parsing and
 * linking the whole graph is the only cheap way to know.
 *
 * Run with --experimental-vm-modules.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const dir = resolve(process.argv[2]);
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));

// The entry is the file that exports the viem API surface.
const entry = files.find((f) => f.startsWith('npm_viem_') && f.includes('__esm.'));
if (!entry) {
  console.error(`no entry module found in ${dir}`);
  process.exit(1);
}
console.log(`entry: ${entry}`);
console.log(`files: ${files.length}`);

const context = vm.createContext({ console, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout });

const pending = new Map(); // name -> Promise<SourceTextModule>, already linked

/**
 * @dev Caches the LINK PROMISE, not the module. viem's graph has cycles, so a
 * module can be requested by its own dependency while its link() is still in
 * flight. Caching the module object early hands that dependency an unlinked
 * module and Node fails with "request for X is from a module not been linked" --
 * which reads like a vendoring problem and is actually a caching-race problem.
 */
async function load(name) {
  if (pending.has(name)) return pending.get(name);

  const promise = (async () => {
    const path = join(dir, name);
    const source = readFileSync(path, 'utf8');
    let mod;
    try {
      mod = new vm.SourceTextModule(source, { identifier: pathToFileURL(path).href, context });
    } catch (err) {
      throw new Error(`parse failed for ${name}: ${err.message}`);
    }
    await mod.link(async (specifier, referencing) => {
      // Every specifier was rewritten to `./<local name>` during vendoring.
      if (!specifier.startsWith('./')) {
        throw new Error(`${referencing.identifier} still imports "${specifier}"`);
      }
      return load(specifier.slice(2));
    });
    return mod;
  })();

  pending.set(name, promise);
  return promise;
}

const entryMod = await load(entry);
console.log('linked: ok (whole graph resolved locally)');
await entryMod.evaluate();
console.log('evaluated: ok');

const names = Object.keys(entryMod.namespace).sort();
console.log(`exports: ${names.length}`);

const required = [
  'createPublicClient',
  'createWalletClient',
  'custom',
  'http',
  'parseAbi',
  'formatUnits',
  'parseUnits',
  'formatEther',
  'erc20Abi',
  'maxUint256',
  'isAddress',
  'getAddress',
  'BaseError',
  'ContractFunctionRevertedError',
  'UserRejectedRequestError',
  'TransactionReceiptNotFoundError',
  'InsufficientFundsError',
  'decodeErrorResult',
  'size',
  'pad',
  'toHex',
];
const missing = required.filter((n) => !names.includes(n));
if (missing.length) {
  console.error(`MISSING: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`all ${required.length} required exports present`);

const { formatUnits, parseUnits, isAddress, erc20Abi, size } = entryMod.namespace;
if (formatUnits(1_000_000_000n, 6) !== '1000') throw new Error('formatUnits wrong');
if (parseUnits('1000', 6) !== 1_000_000_000n) throw new Error('parseUnits wrong');
if (!isAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3')) throw new Error('isAddress wrong');
if (size('0x1234') !== 2) throw new Error('size wrong');
if (!Array.isArray(erc20Abi) || !erc20Abi.some((e) => e.name === 'approve')) throw new Error('erc20Abi wrong');
console.log('behavioural checks: ok');
