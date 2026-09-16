/**
 * Connect to an ALREADY-RUNNING Chrome over CDP, load a URL, and screenshot it.
 *
 * Why this exists next to `browser-test.mjs`: that file launches its own browser. When
 * a browser is already open at a debugging port -- which is the case when a person is
 * looking at the page and you want a picture of what they are looking at -- launching a
 * second one shows you a different window's worth of truth. This attaches instead.
 *
 * It asserts nothing. It is a camera. The assertions live in `browser-test.mjs`;
 * this is for the times you need to SEE the page, including the parts no assertion
 * covers (does the chart actually have candles in it, is anything overlapping).
 *
 * Usage:
 *   node web/tools/screenshot-live.mjs [url] [outfile] [port]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const out = resolve(process.argv[3] ?? resolve(REPO, 'web', 'tools', 'screenshots', 'live.png'));
const port = Number(process.argv[4] ?? 9222);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Which page to drive: the one already showing the target, else any page.
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page');
  if (pages.length === 0) throw new Error(`no page targets on port ${port}`);
  const target = pages.find((p) => p.url.startsWith(url)) ?? pages[0];
  console.log(`attached to ${target.url}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('websocket failed')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  // A fresh load, so the picture is of the current code rather than whatever the tab
  // was showing. `ignoreCache` matters here: this repository's whole point is that the
  // module on disk is the module the page runs, and a cached module would hide an edit.
  await send('Page.navigate', { url });
  await sleep(3500);
  await send('Page.reload', { ignoreCache: true });
  await sleep(4000);

  // What the chart actually rendered, as text, so a failure is legible without the image.
  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const svg = document.getElementById('price-chart');
      const cap = document.getElementById('chart-caption');
      const note = document.getElementById('chart-note');
      const bodies = svg ? svg.querySelectorAll('.chart-body').length : -1;
      const wicks = svg ? svg.querySelectorAll('.chart-wick').length : -1;
      const placeholder = svg ? (svg.querySelector('.chart-placeholder')?.textContent ?? null) : null;
      return JSON.stringify({
        candles: bodies, wicks,
        placeholder,
        caption: cap ? cap.textContent : null,
        note: note ? note.textContent : null,
        ariaLabel: svg ? svg.getAttribute('aria-label') : null,
      }, null, 2);
    })()`,
    returnByValue: true,
  });
  console.log('chart probe:');
  console.log(probe.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot: ${out}`);
  ws.close();
}

main().catch((err) => {
  console.error('screenshot-live failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
