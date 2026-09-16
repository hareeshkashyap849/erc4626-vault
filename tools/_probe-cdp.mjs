/**
 * Can I actually drive a real browser from here?
 *
 * Three things have to be true, and none of them should be assumed:
 *   1. Chrome launches headless in this sandbox and is still alive a moment later.
 *   2. Its DevTools HTTP endpoint answers.
 *   3. Node can open a WebSocket to it -- node:24 has a global WebSocket, but the
 *      sandbox forbids named pipes, and TCP to localhost has been fine so far.
 *
 * Run: node tools/_probe-cdp.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
console.log('chrome exists   :', existsSync(CHROME));
console.log('global WebSocket:', typeof WebSocket);

const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'));
const PORT = 9333;

console.log('profile         :', profile);
console.log('launching chrome headless with --remote-debugging-port', PORT, '...');

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

chrome.on('error', (err) => console.log('  spawn error:', err.message));

// Give it time to bind the port.
await new Promise((r) => setTimeout(r, 4000));

console.log('chrome pid      :', chrome.pid, 'killed:', chrome.killed, 'exitCode:', chrome.exitCode);

async function tryFetch(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
    return { ok: true, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const version = await tryFetch('/json/version');
console.log('');
console.log('GET /json/version:', version.ok ? 'OK' : `FAILED (${version.error})`);
if (version.ok) console.log('  ', version.body.slice(0, 200));

if (!version.ok) {
  try {
    chrome.kill();
  } catch {}
  rmSync(profile, { recursive: true, force: true });
  process.exit(1);
}

// ---- the actual test: open a WebSocket and ask the browser to do something
const targets = await tryFetch('/json/list');
const list = JSON.parse(targets.body);
console.log('');
console.log('targets         :', list.length, list.map((t) => `${t.type}:${t.url}`).join(' '));

const wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
console.log('page ws url     :', wsUrl ? 'present' : 'MISSING');

if (!wsUrl) {
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }
    }, 10000);
  });

try {
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
    setTimeout(() => reject(new Error('websocket open timed out')), 8000);
  });
  console.log('');
  console.log('websocket       : OPEN');

  const result = await send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
  console.log('Runtime.evaluate 1+1 =', result.result.value);

  const nav = await send('Page.navigate', { url: 'data:text/html,<title>hi</title><h1 id=x>hello</h1>' });
  console.log('Page.navigate   :', nav.frameId ? 'ok' : JSON.stringify(nav));
  await new Promise((r) => setTimeout(r, 1200));

  const dom = await send('Runtime.evaluate', { expression: 'document.querySelector("#x").textContent', returnByValue: true });
  console.log('document read   :', dom.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  console.log('screenshot      :', shot.data ? `${Math.round(shot.data.length * 0.75 / 1024)} KB of PNG` : 'FAILED');

  console.log('');
  console.log('RESULT: a real browser is drivable from here');
} catch (err) {
  console.log('');
  console.log('RESULT: FAILED --', err.message);
} finally {
  try {
    ws.close();
  } catch {}
  try {
    chrome.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
  rmSync(profile, { recursive: true, force: true });
}
