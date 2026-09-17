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

import { deriveConfig } from './config-shape.mjs';

const PORT = Number(process.env.WEB_PORT ?? 5173);
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
/**
 * Where the index service lives. Overridable because it is a separate process that a
 * developer may well be running on another port; the default matches its own default.
 */
const INDEX_API = process.env.INDEX_API ?? 'http://127.0.0.1:8787';

/**
 * Counters for how the page talks to the chain.
 *
 * WHAT THIS IS FOR
 *
 * "Is the page batching its reads?" is otherwise unanswerable from outside. Patching
 * `window.fetch` in the page does NOT work: the modules captured the original
 * reference before any test could replace it, so the patch recorded zero requests
 * while the page was demonstrably polling -- a measurement that reports nothing
 * looks exactly like a feature that does nothing.
 *
 * The proxy sees every request as it arrives and cannot be bypassed, so the counts
 * here are the honest answer. Three numbers:
 *
 *   http    how many HTTP requests reached the proxy
 *   batched how many of those were JSON-RPC arrays
 *   calls   how many individual JSON-RPC calls those carried
 *
 * Batching is working when `calls` is much larger than `http`. It is NOT working
 * when they are equal.
 */
const rpcStats = { http: 0, batched: 0, singles: 0, calls: 0 };

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
    // The shape is shared with the static build (tools/config-shape.mjs), so the page
    // served here and the page published to a static host cannot disagree about which
    // contract they address. The only difference is where reads go: through this
    // server's own proxy, because it is same-origin and it is what the counters below
    // measure.
    return { ok: true, ...deriveConfig(record, { readRpcUrl: '/api/rpc' }) };
  } catch (err) {
    return { ok: false, error: `deployments/local.json is not valid JSON: ${err.message}` };
  }
}

/**
 * Forward `/api/candles` to the index service.
 *
 * THREE OUTCOMES, ALL OF THEM EXPLICIT:
 *
 *   200  the index service answered; its body is passed through unchanged, including
 *        `count`, `pointsSkipped` and the note. Rewriting it here would create a
 *        second place that decides what the numbers mean.
 *   502  it is not running, or refused. Reported as 502 with a sentence, so the chart
 *        can say "not reachable" instead of the page dying on an unhandled rejection.
 *   504  it accepted the connection and did not answer in time.
 *
 * The timeout is not decoration: a proxy with no timeout on a local socket waits
 * forever, and the chart then stays on its last frame while looking live.
 */
async function proxyCandles(pathAndQuery, res) {
  const url = `${INDEX_API}${pathAndQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const upstream = await fetch(url, { signal: controller.signal });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    res.writeHead(aborted ? 504 : 502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: aborted
          ? `the index service at ${INDEX_API} did not answer within 5s`
          : `the index service at ${INDEX_API} is not reachable: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'Start it with: node --experimental-strip-types src/api/cli.ts  (in the erc4626-vault-dapp repository)',
      }),
    );
  } finally {
    clearTimeout(timer);
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
    const body = Buffer.concat(chunks).toString('utf8');
    // Counted before forwarding, so a failure upstream is still counted as an
    // attempt. A request that never arrives is not evidence about batching.
    try {
      const parsed = JSON.parse(body);
      rpcStats.http += 1;
      if (Array.isArray(parsed)) {
        rpcStats.batched += 1;
        rpcStats.calls += parsed.length;
      } else {
        rpcStats.singles += 1;
        rpcStats.calls += 1;
      }
    } catch {
      // Not JSON. Forwarded anyway; the chain will say what it thinks.
    }

    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const response = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(response);
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

  // The price history comes from the index service (the sibling `erc4626-vault-dapp`
  // repository), which serves its own HTTP API on loopback. Proxying it here keeps the
  // page SAME-ORIGIN, which matters for three reasons and not just convenience:
  //
  //   1. No CORS preflight, so the chart needs no server-side allowance and the index
  //      service keeps refusing cross-origin requests -- which is right, because it has
  //      no authentication and should not be reachable from a stranger's page.
  //   2. The page has no second base URL to get wrong. A hard-coded
  //      `http://127.0.0.1:8787` in the front end would be a deployment bug waiting for
  //      the first person who runs the API on another port.
  //   3. "The index service is down" becomes a normal, observable 502 from this server
  //      instead of a browser-level network error the page has to guess about.
  //
  // The index service is NOT required for anything else on the page: balances and the
  // price figure come straight off the chain. So a 502 here must leave the rest of the
  // page working, and it does -- the chart is the only caller.
  if (url.startsWith('/api/candles') && req.method === 'GET') {
    return proxyCandles(url, res);
  }

  // How the page has been talking to the chain, for the browser tests. Read-only,
  // local-only, and it exposes nothing but counters.
  if (url === '/api/rpc-stats' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(rpcStats));
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
