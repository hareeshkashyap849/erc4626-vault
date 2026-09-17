// What a public JSON-RPC endpoint can actually do for a BROWSER-CLIENT dApp.
//
// A static host (GitHub Pages and friends) has no server to proxy through, so the page
// calls the endpoint directly. Two capabilities decide whether that works at all:
//
//   1. CORS -- without an Access-Control-Allow-Origin covering the page's origin, the
//      browser discards every response and the page looks broken with no error.
//   2. BATCHING -- this dApp's `readState` sends nine calls in ONE JSON-RPC batch. An
//      endpoint that rejects a batch (some public ones do: `-32600 invalid request` or a
//      400) makes the page fail in a way that reads as a chain problem, not a transport
//      one. Measured here rather than assumed, because "supported by anvil, geth" in a
//      comment is not evidence about a hosted endpoint.
//
// Usage: node probe-rpc-capabilities.mjs <rpc url> [origin]
import { request as httpsRequest } from 'node:https';

const url = process.argv[2] ?? 'https://sepolia.base.org';
const origin = process.argv[3] ?? 'https://hareeshkashyap849.github.io';

function post(body, extraHeaders = {}) {
  return send('POST', body === null ? null : JSON.stringify(body), extraHeaders);
}

function send(method, text, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { origin, ...extraHeaders };
    if (text !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(text);
    }
    const req = httpsRequest(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (text !== null) req.write(text);
    req.end();
  });
}

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`endpoint: ${url}\norigin:   ${origin}\n`);

// 1. a single call, as the browser would send it
const single = await post({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
const allow = single.headers['access-control-allow-origin'];
console.log(`single call -> ${single.status} ${single.body.slice(0, 120)}`);
check(single.status === 200, 'a single call succeeds', `HTTP ${single.status}`);
check(allow === '*' || allow === origin, 'CORS allows this origin', `Access-Control-Allow-Origin: ${allow}`);

// 2. a real preflight: OPTIONS with the headers a JSON POST makes the browser send.
//    `content-type: application/json` is NOT a CORS-safelisted value, so the browser
//    asks permission first and blocks the POST if the answer is not right. Sending a
//    POST with preflight headers (as a first version of this script did) proves nothing.
const preflight = await send('OPTIONS', null, {
  'access-control-request-method': 'POST',
  'access-control-request-headers': 'content-type',
});
const preAllow = preflight.headers['access-control-allow-origin'];
const preMethods = preflight.headers['access-control-allow-methods'];
const preHeaders = preflight.headers['access-control-allow-headers'];
console.log(`\nOPTIONS preflight -> ${preflight.status}`);
console.log(`  allow-origin: ${preAllow} | allow-methods: ${preMethods} | allow-headers: ${preHeaders}`);
const preflightUsable =
  (preAllow === '*' || preAllow === origin) &&
  (!preMethods || /post/i.test(preMethods)) &&
  (!preHeaders || /content-type/i.test(preHeaders));
check(
  preflightUsable,
  'a CORS preflight for a JSON POST is answered usably',
  preMethods === undefined && preAllow === undefined
    ? 'no CORS headers at all on OPTIONS: the browser would block the POST'
    : `status ${preflight.status}, methods ${preMethods}, headers ${preHeaders}`,
);

// 3. the batch the dApp actually sends: nine reads in one request
const batchSize = 9;
const batch = Array.from({ length: batchSize }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_chainId', params: [] }));
const batched = await post(batch);
let parsed;
try {
  parsed = JSON.parse(batched.body);
} catch {
  parsed = null;
}
console.log(`\nbatch of ${batchSize} -> ${batched.status} ${batched.body.slice(0, 120)}`);
check(batched.status === 200, `a batch of ${batchSize} is accepted`, `HTTP ${batched.status}`);
check(Array.isArray(parsed), 'the batch answer is an array', Array.isArray(parsed) ? `${parsed.length} entries` : typeof parsed);
check(
  Array.isArray(parsed) && parsed.length === batchSize,
  'every call in the batch is answered',
  Array.isArray(parsed) ? `answered ${parsed.length} of ${batchSize}` : 'not an array',
);

console.log(failures === 0 ? '\nVERDICT: a static page on this origin can use this endpoint' : `\nVERDICT: ${failures} capability(ies) missing`);
process.exit(failures === 0 ? 0 : 1);
