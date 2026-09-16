/**
 * What is Chrome actually saying when it dies?
 *
 * The previous probe used stdio:'ignore', which threw away the one piece of
 * evidence that matters. This one captures stderr to a FILE -- not a pipe, because
 * the sandbox forbids named pipes and async spawn with piped stdio is where that
 * bites -- and then prints it.
 *
 * It also tries the flag combinations in order of how likely they are to matter,
 * so the answer is "which flag fixed it" rather than another guess.
 *
 * Run: node tools/_probe-chrome-stderr.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;

const VARIANTS = [
  ['as before (baseline)', ['--headless=new', '--disable-gpu', '--disable-extensions']],
  ['+ --no-sandbox', ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-sandbox']],
  ['old headless', ['--headless', '--disable-gpu', '--no-sandbox']],
  ['--no-sandbox --disable-dev-shm-usage', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']],
];

for (const [label, flags] of VARIANTS) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-chrome-'));
  const logPath = join(profile, 'stderr.log');
  const fd = openSync(logPath, 'w');

  console.log(`\n=== ${label}`);
  console.log(`    flags: ${flags.join(' ')}`);

  const child = spawn(
    CHROME,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...flags, 'about:blank'],
    { stdio: ['ignore', fd, fd], detached: false },
  );

  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });

  await new Promise((r) => setTimeout(r, 3500));

  const alive = child.exitCode === null;
  console.log(`    alive after 3.5s : ${alive}${alive ? '' : ` (exitCode ${child.exitCode})`}`);
  if (spawnError) console.log(`    spawn error      : ${spawnError.message}`);

  let endpoint = 'no';
  if (alive) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const body = await res.json();
      endpoint = `yes (${body.Browser})`;
    } catch (err) {
      endpoint = `no (${err.message})`;
    }
  }
  console.log(`    devtools endpoint: ${endpoint}`);

  const log = readFileSync(logPath, 'utf8').trim();
  if (log) {
    console.log('    --- chrome output (first 25 lines) ---');
    for (const line of log.split('\n').slice(0, 25)) console.log(`    ${line}`);
  } else {
    console.log('    (chrome printed nothing)');
  }

  try {
    child.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 400));
  rmSync(profile, { recursive: true, force: true });

  if (alive && endpoint.startsWith('yes')) {
    console.log(`\nRESULT: "${label}" WORKS`);
    break;
  }
}
