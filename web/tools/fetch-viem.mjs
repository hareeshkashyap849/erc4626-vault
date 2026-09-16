/**
 * Fetch the browser build of viem and vendor it into the repository.
 *
 * WHY VENDOR A CDN BUNDLE INSTEAD OF USING NPM
 *
 * The npm registry is unreachable from this environment, so `npm install viem`
 * is not available. And even with it, the browser cannot consume a node_modules
 * tree: viem's ESM output is a graph of hundreds of relative imports, each one a
 * separate request, none of which works offline.
 *
 * jsDelivr publishes a pre-bundled single-file ESM build (`/+esm`). Committing
 * that one file means the dApp has no build step, no package manager and no
 * network dependency at run time -- which is the same reasoning as the
 * zero-build dashboard in the sibling indexer project.
 *
 * WHAT THIS SCRIPT VERIFIES BEFORE WRITING
 *
 * A download that silently returns an error page or a truncated body is worse
 * than a failed one, because the mistake surfaces later as a syntax error in the
 * browser. So the response is checked for: HTTP 200, a plausible size, that it
 * is JavaScript rather than HTML, and that the closing bracket of the bundled
 * module is present.
 */
import https from 'node:https';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SRC = 'https://cdn.jsdelivr.net/npm/viem@2.56.5/+esm';
const dest = process.argv[2];
if (!dest) {
  console.error('usage: node fetch-viem.mjs <destFile>');
  process.exit(2);
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const chunks = [];
    const req = https.get(
      { host: u.hostname, path: u.pathname + u.search, headers: { 'user-agent': 'node', accept: '*/*' }, timeout: 120000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

console.log(`fetching ${SRC}`);
let body;
try {
  body = await get(SRC);
} catch (err) {
  // Fall back to esm.sh, which publishes the same kind of bundle at a different
  // path (its top-level file is a re-export pointing at the real one).
  console.log(`  ${err.message}`);
  console.log('  falling back to esm.sh');
  body = await get('https://esm.sh/viem@2.56.5/es2022/viem.bundle.mjs');
}

const text = body.toString('utf8');

// --- verify before writing ---------------------------------------------------
const problems = [];
if (body.length < 50_000) problems.push(`implausibly small (${body.length} bytes)`);
if (/^\s*</.test(text)) problems.push('looks like HTML, not JavaScript');
if (!/export\s*\{/.test(text) && !/export\s+default/.test(text)) problems.push('no ES export statement found');
// A truncated download would not contain the final line of the module.
const tail = text.trimEnd().slice(-40);
if (!/[;}]\s*(\/\/# sourceMappingURL=\S+)?$/.test(text.trimEnd())) {
  problems.push(`does not end like a complete module (tail: ${JSON.stringify(tail)})`);
}

if (problems.length) {
  console.error('REFUSING TO WRITE:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, body);

console.log('');
console.log(`wrote ${dest}`);
console.log(`  ${(statSync(dest).size / 1024).toFixed(0)} KB`);
console.log(`  exports found: ${(text.match(/export\s*\{/g) ?? []).length} export statement(s)`);
console.log(`  tail: ${JSON.stringify(text.trimEnd().slice(-70))}`);
