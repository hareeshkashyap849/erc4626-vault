/**
 * Build the static site: the browser files, plus a generated `api/config`.
 *
 * WHY THIS EXISTS
 *
 * `web/` is written to be served, not bundled: no framework, no build step, no
 * bundler (web/DESIGN.md §1). It reads its addresses at runtime from `api/config` and
 * sends its chain reads to a JSON-RPC endpoint, and in development `tools/dev-server.mjs`
 * supplies both -- the config from `deployments/local.json`, the reads through a
 * same-origin proxy.
 *
 * A static host supplies neither: there is no process to serve `api/config`, and no
 * proxy to receive the reads. So this writes the config to a FILE, from the same
 * deployment record and through the same derivation the dev server uses
 * (`tools/config-shape.mjs`), and points reads at the public endpoint the record names.
 * The alternative -- hand-writing the addresses into the published page -- is the thing
 * the whole design is arranged to prevent: an address in two places is an address that
 * will be right in one of them.
 *
 * WHAT IT REFUSES TO DO
 *
 *  * Publish a record that cannot address a contract (`assertUsableRecord`).
 *  * Publish a config whose addresses differ from the record's, re-read after writing.
 *  * Copy the tools, the tests, or the docs into the published site: what is published
 *    is the list below and nothing else.
 *
 * Usage:
 *   node scripts/build-static-site.mjs \
 *     --record deployments/base-sepolia.json \
 *     --out .site
 *
 * The read endpoint defaults to the record's own `rpcUrl`. Override with `--rpc` when
 * the record's endpoint is not reachable from a browser (a local anvil URL, for
 * instance, which exists only on the machine that ran it).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertUsableRecord, deriveConfig } from '../tools/config-shape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WEB = join(REPO, 'web');

/** Exactly what a browser needs, and nothing else. */
const PUBLISHED = ['index.html', 'style.css', 'app', 'vendor'];

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const recordPath = resolve(REPO, flag('--record', 'deployments/base-sepolia.json'));
const outDir = resolve(REPO, flag('--out', '.site'));

if (!existsSync(recordPath)) {
  console.error(`no deployment record at ${recordPath}\nRun the deploy script, or pass --record <path>.`);
  process.exit(2);
}

const record = assertUsableRecord(JSON.parse(readFileSync(recordPath, 'utf8')), recordPath);
const readRpcUrl = flag('--rpc', record.rpcUrl ?? record.walletRpcUrl);
if (!/^https?:\/\//.test(readRpcUrl ?? '')) {
  console.error(
    `the read endpoint must be an absolute http(s) URL, got ${JSON.stringify(readRpcUrl)}.\n` +
      'A static page has no proxy, so a page-relative path cannot work. Pass --rpc <url>.',
  );
  process.exit(2);
}

// From scratch every time: a stale file left from a previous build is a published file
// nobody decided to publish.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const entry of PUBLISHED) {
  const from = join(WEB, entry);
  if (!existsSync(from)) {
    console.error(`web/${entry} is missing; refusing to publish a partial site`);
    process.exit(2);
  }
  cpSync(from, join(outDir, entry), { recursive: true });
}

// `candlesUrl: null` says this page has NO route to the index service. A static host runs
// no process, so there is nothing to proxy `/api/candles` -- and the page then reports
// that, rather than reporting a service failure it never observed.
const config = deriveConfig(record, { readRpcUrl, candlesUrl: null });
mkdirSync(join(outDir, 'api'), { recursive: true });
writeFileSync(join(outDir, 'api', 'config'), JSON.stringify({ ok: true, ...config }, null, 2) + '\n', 'utf8');

// GitHub Pages runs Jekyll unless this file is present, and Jekyll drops paths it
// considers special. The page has no such paths today; the file is here so that adding
// one later is not a silent 404 on the published site only.
writeFileSync(join(outDir, '.nojekyll'), '');

// Re-read what was written and compare it with the record. A build step that reports
// success without checking its own output is a build step that reports success.
const written = JSON.parse(readFileSync(join(outDir, 'api', 'config'), 'utf8'));
const mismatches = ['vault', 'asset', 'chainId'].filter((f) => written[f] !== record[f]);
if (mismatches.length) {
  console.error(`the published config disagrees with the record on: ${mismatches.join(', ')}`);
  process.exit(1);
}

console.log(`record      ${recordPath}`);
console.log(`chain       ${record.chainId} (${config.chainName})`);
console.log(`vault       ${record.vault}`);
console.log(`asset       ${record.asset}`);
console.log(`reads go to ${readRpcUrl}   (no proxy: the browser calls this directly)`);
console.log(`wallet gets ${config.walletRpcUrl}`);
console.log(`published   ${outDir}`);
for (const entry of [...PUBLISHED, 'api/config', '.nojekyll']) console.log(`  ${entry}`);
