/**
 * Reconstruct the owner's mUSDC balance at every block, from Transfer events.
 *
 * WHY NOT ARITHMETIC
 *
 * Adding up the transactions I know about gave 5950 where the chain says
 * 5949.999999, so at least one of my assumptions is wrong and I cannot tell which.
 * The token's own Transfer events are the ground truth: every movement of every
 * unit is in there, including any I did not think of.
 */
import { readFileSync } from 'node:fs';

const RPC = 'http://127.0.0.1:8545';
const record = JSON.parse(readFileSync('deployments/local.json', 'utf8'));
const ASSET = record.asset;
const OWNER = record.owner.toLowerCase();

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

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MINT_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

const height = Number(BigInt(await rpc('eth_blockNumber')));
console.log(`scanning every block from 0 to ${height} for Transfer events on ${ASSET}`);
console.log('');

const logs = [];
for (let n = 0; n <= height; n++) {
  const res = await rpc('eth_getLogs', [{ fromBlock: '0x' + n.toString(16), toBlock: '0x' + n.toString(16), address: ASSET, topics: [TRANSFER] }]);
  for (const log of res) {
    const from = '0x' + log.topics[1].slice(26);
    const to = '0x' + log.topics[2].slice(26);
    const value = BigInt(log.data);
    logs.push({ block: n, from, to, value, isMint: log.topics[1] === MINT_TOPIC });
  }
}

const short = (a) => (a.toLowerCase() === OWNER ? 'OWNER' : a.slice(0, 10) + '…');
console.log(`every mUSDC movement touching the owner (${logs.length} transfers total):`);
console.log('');
let running = 0n;
for (const l of logs) {
  const touchesOwner = l.from.toLowerCase() === OWNER || l.to.toLowerCase() === OWNER;
  if (l.isMint && l.to.toLowerCase() === OWNER) {
    running += l.value;
    console.log(`  block ${String(l.block).padStart(3)}  MINT      +${l.value}                -> ${running}`);
    continue;
  }
  if (!touchesOwner) continue;
  const delta = l.to.toLowerCase() === OWNER ? l.value : -l.value;
  running += delta;
  const sign = delta > 0n ? '+' : '';
  console.log(`  block ${String(l.block).padStart(3)}  ${short(l.from)} -> ${short(l.to)}  ${sign}${delta}  -> ${running}`);
}

console.log('');
const final = BigInt(await rpc('eth_call', [{ to: ASSET, data: '0x70a08231' + OWNER.replace(/^0x/, '').padStart(64, '0') }, 'latest']));
console.log(`reconstructed balance : ${running}`);
console.log(`balanceOf says        : ${final}`);
console.log(`match                 : ${running === final}`);
