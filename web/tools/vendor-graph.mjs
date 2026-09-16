/**
 * Vendor an ES module graph into a directory of local files.
 *
 * WHY THIS EXISTS
 *
 * jsDelivr's `+esm` build of viem is a single 255 KB file that imports three
 * root-relative paths. Those paths only resolve on jsdelivr.net, so serving the
 * bundle from localhost fails the moment the browser tries to resolve them --
 * and the failure is a network error that looks like the server being down.
 *
 * Two alternatives were considered and rejected:
 *
 *   - An import map pointing the three paths back at the CDN. That works, but it
 *     makes the dApp require the internet at run time. The sibling indexer
 *     project already established that this repository should work with no
 *     network, and a demo that breaks the moment a connection drops is exactly
 *     the problem that was just fixed for the chain.
 *   - Hand-writing a JSON-RPC client instead of using viem. Around 500 lines of
 *     EIP-1193 plumbing, ABI encoding and error decoding, with no test budget
 *     left to find the bugs in it. Three vendored dependencies are strictly less
 *     risk than a hand-rolled replacement.
 *
 * So this walks the graph, downloads each file, and rewrites every root-relative
 * specifier to a local one. Files are named by a hash of their original path,
 * because two packages can contain the same basename and a collision would
 * silently substitute one module for another.
 */
import https from 'node:https';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ORIGIN = 'https://cdn.jsdelivr.net';
const entryUrl = process.argv[2]; // e.g. /npm/viem@2.56.5/+esm
const outDir = process.argv[3];
if (!entryUrl || !outDir) {
  console.error('usage: node vendor-graph.mjs </npm/...> <outDir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/** Deterministic local filename for a remote path: readable stem + short hash. */
function localName(remotePath) {
  const hash = createHash('sha256').update(remotePath).digest('hex').slice(0, 10);
  const stem = remotePath.replace(/^\//, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
  return `${stem}.${hash}.js`;
}

function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { host: u.hostname, path: u.pathname + u.search, headers: { 'user-agent': 'node', accept: '*/*' }, timeout: 120000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(get(next, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout for ${url}`)));
  });
}

/** Root-relative ES specifiers: `from "/x"`, `import "/x"`, `import("/x")`. */
const SPECIFIER_RE = /(?<=(?:from|import)\s*\(?\s*['"])(\/[^'"]+)(?=['"])/g;

const seen = new Map(); // remote path -> local filename
const queue = [entryUrl];
const downloaded = [];

/** Root-relative specifiers contained in a module body. */
function specifiersIn(body) {
  return [...new Set([...body.matchAll(SPECIFIER_RE)].map((m) => m[1]))];
}

while (queue.length) {
  const path = queue.shift();
  if (seen.has(path)) continue;

  const local = localName(path);
  seen.set(path, local);
  const localPath = join(outDir, local);

  let body;
  if (existsSync(localPath)) {
    body = readFileSync(localPath, 'utf8');
    console.log(`cached   ${path} -> ${local}`);
  } else {
    body = await get(ORIGIN + path);
    if (body.length < 100) throw new Error(`suspiciously small response for ${path} (${body.length} bytes)`);
    if (/^\s*</.test(body)) throw new Error(`${path} returned HTML, not JavaScript`);
    writeFileSync(localPath, body);
    console.log(`fetched  ${path} (${(body.length / 1024).toFixed(1)} KB) -> ${local}`);
    downloaded.push({ path, local, bytes: body.length });
  }

  // Discover this module's own dependencies. Without this the crawl never
  // follows the graph and the second pass fails on unresolved specifiers -- the
  // first version of this script did exactly that.
  for (const dep of specifiersIn(body)) {
    if (!seen.has(dep)) queue.push(dep);
  }
}

// Second pass: rewrite specifiers now that every target has a local name. Doing
// this after the crawl means a rewrite never depends on crawl order.
console.log('');
console.log('rewriting specifiers');
for (const [remote, local] of seen) {
  const localPath = join(outDir, local);
  let body = readFileSync(localPath, 'utf8');
  let rewrites = 0;
  body = body.replace(SPECIFIER_RE, (spec) => {
    const target = seen.get(spec);
    if (!target) {
      throw new Error(`unresolved specifier ${spec} inside ${remote}; the crawl did not discover it`);
    }
    rewrites++;
    return `./${target}`;
  });
  writeFileSync(localPath, body);
  if (rewrites) console.log(`  ${local}: ${rewrites} rewrite(s)`);
}

// Any remaining root-relative specifier would be a load failure in the browser,
// so refuse to report success if one survived.
console.log('');
let leftovers = 0;
for (const [, local] of seen) {
  const body = readFileSync(join(outDir, local), 'utf8');
  const m = body.match(SPECIFIER_RE);
  if (m) {
    leftovers += m.length;
    console.log(`LEFTOVER in ${local}: ${[...new Set(m)].join(', ')}`);
  }
}
if (leftovers) {
  console.error(`\n${leftovers} root-relative specifier(s) remain; the browser would fail to resolve them`);
  process.exit(1);
}

const total = Object.keys(Object.fromEntries(seen)).length;
console.log(`done: ${total} files, ${downloaded.length} downloaded, no remote specifiers remain`);
