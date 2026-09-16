/**
 * A tiny Chrome DevTools Protocol driver.
 *
 * WHY HAND-WRITTEN, WITH NO DEPENDENCIES
 *
 * Puppeteer and Playwright would each be a large install, and neither is needed:
 * Chrome is already on this machine, CDP is a WebSocket with JSON messages, and
 * node 24 has a global `WebSocket`. This file is the whole client.
 *
 * WHY IT MATTERS THAT THIS EXISTS AT ALL
 *
 * Every previous bug in this project's front end was found by a human opening the
 * page -- a wrong-chain warning on load, an inert Connect button, a TypeError in
 * clearMessage. Automated tests missed all three because a DOM stub is not a
 * browser, and a stub that is more permissive than the DOM does not test the page,
 * it tests the stub. This driver removes that excuse: it is a real browser, with
 * real CSS, real event dispatch and real `HTMLCollection` semantics.
 *
 * SANDBOX NOTE: Chromium will not start unless it can create mojo IPC named pipes.
 * Under a confined sandbox it dies with "FATAL platform_channel.cc: Check failed:
 * 拒绝访问 (0x5)" and NO combination of Chrome flags helps, because the denial is
 * the OS sandbox rather than Chrome's own. So anything using this module needs
 * unconfined process/IPC access. It is not a flag to add; it is a precondition, and
 * stating it here saves the next person from re-deriving it from a crash log.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function findBrowser() {
  for (const path of CHROME_CANDIDATES) if (existsSync(path)) return path;
  throw new Error('no Chrome or Edge found; checked:\n  ' + CHROME_CANDIDATES.join('\n  '));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch a headless browser and connect to the first page target.
 *
 * Returns an object with `send(method, params)`, `evaluate(expression)`,
 * `screenshot(path)`, `navigate(url)`, `consoleErrors` and `close()`.
 */
export async function launchBrowser({ port = 9333, width = 1280, height = 900, extraArgs = [] } = {}) {
  const binary = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'));
  const logPath = join(profile, 'browser.log');
  const logFd = openSync(logPath, 'w');

  const child = spawn(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      ...extraArgs,
      'about:blank',
    ],
    // stderr goes to a FILE, not a pipe: the sandbox forbids named pipes, and a
    // crashed browser is exactly when its output is worth having.
    { stdio: ['ignore', logFd, logFd] },
  );

  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });

  // Wait for the DevTools endpoint. Chrome takes a variable amount of time to bind
  // it, so this polls rather than sleeping a fixed amount and hoping.
  let version = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (spawnError) break;
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      version = await res.json();
      break;
    } catch {
      /* not up yet */
    }
  }

  const cleanup = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* best effort; a leftover temp profile is harmless */
    }
  };

  if (!version) {
    const log = readFileSync(logPath, 'utf8').trim();
    cleanup();
    throw new Error(
      `the browser did not expose a DevTools endpoint.\n` +
        (spawnError ? `spawn error: ${spawnError.message}\n` : '') +
        (child.exitCode !== null ? `exited with code ${child.exitCode}\n` : '') +
        `output:\n${log || '  (nothing)'}\n\n` +
        'If the output mentions platform_channel / permission denied, this process needs ' +
        'unconfined access: Chromium requires mojo IPC named pipes and no Chrome flag avoids that.',
    );
  }

  // ---- the WebSocket
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    cleanup();
    throw new Error('no page target');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    // Collect diagnostics as they happen: a page that "works" while logging a
    // TypeError is not working, and this is how that gets noticed.
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description ?? d.text ?? 'unknown exception');
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method}: timed out after 15s`));
        }
      }, 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not open the DevTools websocket')), { once: true });
    setTimeout(() => reject(new Error('DevTools websocket open timed out')), 10000);
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const api = {
    version,
    child,
    consoleErrors,
    pageErrors,

    send,

    /** Evaluate in the page and return the value. Throws on a page-side throw. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    },

    /**
     * Run this source in EVERY document, before any page script.
     *
     * This is how a fake wallet is injected: `window.ethereum` has to exist before
     * main.js runs, or the page takes its no-wallet path and the test proves
     * nothing about the wallet path.
     */
    injectOnNewDocument(source) {
      return send('Page.addScriptToEvaluateOnNewDocument', { source });
    },

    async navigate(url, { settleMs = 1500 } = {}) {
      await send('Page.navigate', { url });
      await sleep(settleMs);
    },

    /** Wait for a condition in the page, polling. Returns false on timeout. */
    async waitFor(expression, { timeoutMs = 10000, intervalMs = 200 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await api.evaluate(expression)) return true;
        } catch {
          /* page may be mid-navigation */
        }
        await sleep(intervalMs);
      }
      return false;
    },

    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },

    /** Click an element by id, in the page, as a user would. */
    async click(id) {
      const ok = await api.evaluate(`(() => { const n = document.getElementById(${JSON.stringify(id)}); if (!n) return false; n.click(); return true; })()`);
      if (!ok) throw new Error(`no element #${id} to click`);
      await sleep(150);
    },

    /** Type into an input, firing the events the page listens for. */
    async type(id, value) {
      const ok = await api.evaluate(
        `(() => { const n = document.getElementById(${JSON.stringify(id)}); if (!n) return false;` +
          ` n.value = ${JSON.stringify(value)};` +
          ` n.dispatchEvent(new Event('input', { bubbles: true }));` +
          ` n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      );
      if (!ok) throw new Error(`no element #${id} to type into`);
      await sleep(100);
    },

    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      cleanup();
    },
  };

  return api;
}
