/**
 * Can we obtain a browser-usable viem bundle?
 *
 * The npm registry is unreachable from here, so `npm install viem` is not an
 * option. But the browser needs viem as ES modules with a single entry point,
 * which is not what a node_modules tree looks like.
 *
 * Two candidate sources, tested in order of preference:
 *
 *   1. esm.sh with ?bundle -- returns one self-contained ES module. This is the
 *      one that matters, because a single fetch can then be committed to the
 *      repository and served offline forever.
 *   2. esm.sh without ?bundle -- works but produces a dependency graph of
 *      hundreds of requests, which is unusable offline.
 *
 * This script only reports; it writes nothing.
 */
import https from 'node:https';

const URLS = [
  ['esm.sh viem (bundled)', 'https://esm.sh/viem@2.56.5?bundle&target=es2022'],
  ['esm.sh viem (graph)', 'https://esm.sh/viem@2.56.5'],
  ['esm.sh viem/actions', 'https://esm.sh/viem@2.56.5/actions?bundle&target=es2022'],
  ['jsdelivr viem esm', 'https://cdn.jsdelivr.net/npm/viem@2.56.5/+esm'],
  ['unpkg viem', 'https://unpkg.com/viem@2.56.5/_esm/index.js'],
];

function head(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'user-agent': 'node', accept: '*/*' }, timeout: timeoutMs },
      (res) => {
        // Read only the start: enough to tell a module from an error page.
        let got = 0;
        const chunks = [];
        res.on('data', (c) => {
          got += c.length;
          if (chunks.reduce((a, b) => a + b.length, 0) < 400) chunks.push(c);
          if (got > 4_000_000) req.destroy();
        });
        res.on('end', () => {}
        );
        res.on('close', () => {
          const head = Buffer.concat(chunks).toString('utf8').slice(0, 220).replace(/\s+/g, ' ');
          resolve({ status: res.statusCode, len: got, head });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, len: 0, head: `net ${e.message.slice(0, 60)}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, len: 0, head: 'timeout' });
    });
    req.end();
  });
}

for (const [label, url] of URLS) {
  const r = await head(url);
  const ok = r.status === 200 && r.len > 1000;
  console.log(`${label.padEnd(26)} ${String(r.status).padStart(3)}  ${String(r.len).padStart(8)} B  ${ok ? 'USABLE' : 'no'}`);
  console.log(`    ${r.head}`);
  console.log('');
}
