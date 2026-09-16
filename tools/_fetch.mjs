// Re-fetch a tarball with a correctly implemented HTTPS client.
//
// The workspace helper produced a file that gzip accepted but tar rejected
// ("bad header checksum" + "truncated"). The signature was the literal prefix
// "8000\r\n" before the gzip magic: a chunked-transfer size line written into
// the body. So the helper is not decoding HTTP chunked encoding, and for a 6 MB
// response GitHub sends chunked.
//
// This client decodes chunked transfer-encoding properly and verifies the gzip
// magic before writing anything.
import https from 'node:https';
import { writeFileSync, statSync } from 'node:fs';

const url = process.argv[2];
const dest = process.argv[3];
if (!url || !dest) {
  console.error('usage: node _fetch.mjs <url> <dest>');
  process.exit(2);
}

const u = new URL(url);

const res = await new Promise((resolve, reject) => {
  const req = https.get(
    { host: u.hostname, path: u.pathname + u.search, headers: { 'user-agent': 'node', accept: '*/*' }, timeout: 300000 },
    resolve,
  );
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
});

console.log(`HTTP ${res.statusCode}`);
console.log(`transfer-encoding: ${res.headers['transfer-encoding'] ?? '(none)'}`);
console.log(`content-length   : ${res.headers['content-length'] ?? '(none)'}`);

if (res.statusCode !== 200) {
  console.error(`unexpected status ${res.statusCode}`);
  process.exit(1);
}

const chunks = [];
for await (const c of res) chunks.push(c);
let body = Buffer.concat(chunks);
console.log(`received ${body.length} bytes (raw stream)`);

// If chunked encoding leaked into the body, de-chunk it.
function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i, 'latin1');
    if (nl < 0) break;
    const sizeLine = buf.toString('latin1', i, nl).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeLine)) return null; // not a chunk header
    const size = parseInt(sizeLine, 16);
    if (size === 0) break;
    const start = nl + 2;
    if (start + size > buf.length) return null;
    out.push(buf.subarray(start, start + size));
    i = start + size + 2; // skip trailing CRLF
  }
  return out.length ? Buffer.concat(out) : null;
}

// Unwrap any leaked transfer layers until the gzip magic is at offset 0.
let layer = 0;
for (;;) {
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) break;
  const d = dechunk(body);
  if (d) {
    layer++;
    body = d;
    console.log(`  de-chunked layer ${layer} -> ${body.length} bytes`);
    continue;
  }
  // single leading chunk header then payload
  const m = body.toString('latin1', 0, 16).match(/^([0-9a-fA-F]+)\r\n/);
  if (m) {
    const skip = m[0].length;
    body = body.subarray(skip);
    console.log(`  stripped leading chunk header (${JSON.stringify(m[0])}) -> ${body.length} bytes`);
    continue;
  }
  break;
}

if (!(body.length > 2 && body[0] === 0x1f && body[1] === 0x8b)) {
  console.error('FAILED: no gzip magic at offset 0 after unwrapping');
  console.error(`  first bytes: ${body.subarray(0, 16).toString('hex')}`);
  process.exit(1);
}

writeFileSync(dest, body);
console.log(`wrote ${dest} (${(statSync(dest).size / 1024 / 1024).toFixed(2)} MB, gzip magic verified)`);
