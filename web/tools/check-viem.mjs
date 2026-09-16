/**
 * Verify the vendored viem bundle is usable before building anything on it.
 *
 * "The download returned 200 and a plausible size" is not evidence that a
 * JavaScript module works. A truncated bundle, a bundle built for the wrong
 * target, or one whose exports were tree-shaken away all look identical from the
 * outside and all fail in the browser with an error that says nothing useful.
 *
 * So this parses and instantiates the module and inspects what it actually
 * exports. Run with --experimental-vm-modules, because SourceTextModule is the
 * only way to instantiate an ES module that was never written to a file with the
 * .mjs extension and never ran through Node's resolver.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const source = readFileSync(file, 'utf8');

let mod;
try {
  mod = new vm.SourceTextModule(source, { identifier: file });
} catch (err) {
  console.error(`PARSE FAILED: ${err.message}`);
  process.exit(1);
}
console.log('parsed: ok');

await mod.link(() => {
  throw new Error('the bundle must be self-contained, but it tried to import something');
});
console.log('linked: ok (no external imports)');

await mod.evaluate();
const names = Object.keys(mod.namespace).sort();
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
  'parseEther',
  'getContract',
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
  'formatGwei',
  'keccak256',
  'toHex',
];

const missing = required.filter((n) => !names.includes(n));
if (missing.length) {
  console.error(`MISSING EXPORTS: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`all ${required.length} required exports present`);

// A couple of behavioural smoke checks. These do not touch the network; they
// exercise pure functions, which is enough to prove the bundle is the real viem
// rather than a stub.
const { formatUnits, parseUnits, isAddress, erc20Abi } = mod.namespace;
if (formatUnits(1_000_000_000n, 6) !== '1000') throw new Error('formatUnits is wrong');
if (parseUnits('1000', 6) !== 1_000_000_000n) throw new Error('parseUnits is wrong');
if (!isAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3')) throw new Error('isAddress rejected a valid address');
if (!Array.isArray(erc20Abi) || erc20Abi.length < 5) throw new Error('erc20Abi looks wrong');
console.log('behavioural checks: ok (formatUnits, parseUnits, isAddress, erc20Abi)');
