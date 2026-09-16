/** Throwaway: how far has the demo vault drifted, and how do I put it back? */
import { readFileSync } from 'node:fs';

const RPC = 'http://127.0.0.1:8545';
const record = JSON.parse(readFileSync('deployments/local.json', 'utf8'));
const { vault } = record;
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // the seeded depositor

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

const totalAssets = word(await call(vault, '0x01e1d114'));
const totalSupply = word(await call(vault, '0x18160ddd'));
const userShares = word(await call(vault, '0x70a08231' + pad(USER)));
const ownerShares = word(await call(vault, '0x70a08231' + pad(record.owner)));

console.log('vault totalAssets :', totalAssets, `(${Number(totalAssets) / 1e6} mUSDC)`);
console.log('vault totalSupply :', totalSupply);
console.log('user shares       :', userShares);
console.log('owner shares      :', ownerShares);
console.log('');
console.log('TARGET (what the README and seed script describe):');
console.log('  totalAssets 550000000, totalSupply 500000000000000000000, held entirely by the user');
console.log('');
const excess = totalSupply - 500000000000000000000n;
console.log('excess shares to remove :', excess);
console.log('assets those shares are worth, roughly :', (excess * (totalAssets + 1n)) / (totalSupply + 10n ** 12n));
console.log('');
console.log('the depositor (anvil #0) must burn the excess:');
console.log(`  redeem(${excess}, ${USER}, ${USER})`);
