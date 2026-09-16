/**
 * Dev server for the dApp.
 *
 * THREE JOBS, AND NO OTHERS
 *
 *   1. Serve `web/` over HTTP. `file://` cannot load ES modules, so the page
 *      needs an origin.
 *
 *   2. `GET /api/config` returns the deployed addresses by reading
 *      `deployments/local.json`. This is what keeps addresses out of the source:
 *      the page has no hardcoded contract address anywhere, so re-running the
 *      deploy script cannot leave the front end pointing at a contract that no
 *      longer exists. That failure mode -- a dApp showing an empty balance
 *      because it is talking to nothing -- looks identical to a broken app.
 *
 *   3. `POST /api/rpc` proxies JSON-RPC to the local chain. Same-origin, so
 *      there is no CORS question, and it makes the local-only scope explicit
 *      rather than implied.
 *
 * It is not a backend: no database, no auth, no session, no state that outlives
 * a request.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..');
const WEB_DIR = resolve(REPO, 'web');
const CONFIG_FILE = join(REPO, 'deployments', 'local.json');

const PORT = Number(process.env.WEB_PORT ?? 5173);
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Map a URL path to a file inside WEB_DIR, or null.
 *
 * The resolved path is checked to be inside WEB_DIR after normalisation, so
 * `..` in a URL cannot escape it. A dev server on localhost is still a server
 * that reads files named by a request.
 */
function resolveStatic(urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]);
  const target = resolve(WEB_DIR, '.' + normalize(rel));
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + (process.platform === 'win32' ? '\\' : '/'))) {
    return null;
  }
  return target;
}

function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return {
      ok: false,
      error:
        'deployments/local.json is missing. Run scripts/dev-chain.ps1 (which deploys and writes it) before starting the dApp.',
    };
  }
  try {
    const record = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return {
      ok: true,
      ...record,
      // Derived here, not required from the record.
      //
      // `chainName` and `walletRpcUrl` were added to the deploy script after the
      // first local.json was written, so a record from an older script lacks them
      // -- and the page then cannot call `wallet_addEthereumChain` at all, which
      // shows up as "switch network did nothing" rather than as a missing field.
      // Defaulting them means an old record still works.
      //
      // The real RPC URL matters: the page reads through the same-origin
      // `/api/rpc` proxy, but a WALLET cannot use a page-relative URL, so it needs
      // the absolute endpoint the record was deployed against.
      chainName: record.chainName ?? `Chain ${record.chainId}`,
      walletRpcUrl: record.walletRpcUrl ?? record.rpcUrl,
      rpcUrl: '/api/rpc',
    };
  } catch (err) {
    return { ok: false, error: `deployments/local.json is not valid JSON: ${err.message}` };
  }
}

async function proxyRpc(req, res) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) {
      res.writeHead(413, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'request too large' }));
    }
    chunks.push(c);
  }

  try {
    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.concat(chunks),
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    // Reported as a failed gateway rather than a crash: the page needs to be
    // able to say "the chain is not running", which is a normal thing for it to
    // have to say when someone has stopped anvil.
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: `cannot reach the chain at ${RPC_URL}: ${err.message}`,
        hint: 'is anvil running? start it with scripts/dev-chain.ps1',
      }),
    );
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(readConfig(), null, 2));
  }

  if (url === '/api/rpc' && req.method === 'POST') {
    return proxyRpc(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('method not allowed');
  }

  const target = resolveStatic(url === '/' ? '/index.html' : url);
  if (!target) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      // No caching: this is a dev server and a stale cached module is a
      // debugging session spent on code that is not running.
      'cache-control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const cfg = readConfig();
  console.log(`erc4626-vault dApp  ->  http://127.0.0.1:${PORT}/`);
  console.log(`  serving   ${WEB_DIR}`);
  console.log(`  rpc proxy ${RPC_URL}`);
  if (cfg.ok) {
    console.log(`  vault     ${cfg.vault}`);
    console.log(`  asset     ${cfg.asset}`);
    console.log(`  owner     ${cfg.owner}`);
  } else {
    console.log(`  WARNING   ${cfg.error}`);
  }
});
