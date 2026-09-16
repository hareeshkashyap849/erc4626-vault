/** Throwaway: redeem the extra shares so the demo vault is back to its baseline. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RPC = 'http://127.0.0.1:8545';
const record = JSON.parse(readFileSync('deployments/local.json', 'utf8'));
const { vault } = record;
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Selectors are DERIVED, not remembered. A hand-written one was wrong, and the
// only symptom was a receipt with status 0x0.
const viem = await import(pathToFileURL('web/app/viem.js').href);
const sel = (sig) => viem.toFunctionSelector(viem.parseAbi([`function ${sig}`])[0]);
const redeem = sel('redeem(uint256,address,address)');
const previewRedeem = sel('previewRedeem(uint256) view returns (uint256)');
console.log('redeem selector        :', redeem);
console.log('previewRedeem selector :', previewRedeem);

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const b = await res.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}
const pad = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const word = (h) => BigInt(h === '0x' ? '0x0' : h);
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

const ownerShares = word(await call(vault, '0x70a08231' + pad(record.owner)));
console.log('owner shares to redeem:', ownerShares);
console.log('previewRedeem says    :', word(await call(vault, previewRedeem + pad(ownerShares))).toString(), 'asset units');

const hash = await rpc('eth_sendTransaction', [{ from: record.owner, to: vault, data: redeem + pad(ownerShares) + pad(record.owner) + pad(record.owner) }]);
let receipt = null;
for (let i = 0; i < 40 && !receipt; i++) {
  receipt = await rpc('eth_getTransactionReceipt', [hash]);
  if (!receipt) await new Promise((r) => setTimeout(r, 150));
}
if (receipt?.status !== '0x1') throw new Error(`redeem failed (status ${receipt?.status})`);

console.log('');
console.log('after redeem:');
console.log('  totalAssets :', word(await call(vault, '0x01e1d114')).toString());
console.log('  totalSupply :', word(await call(vault, '0x18160ddd')).toString());
console.log('  owner shares:', word(await call(vault, '0x70a08231' + pad(record.owner))).toString());
console.log('  user shares :', word(await call(vault, '0x70a08231' + pad(USER))).toString());
