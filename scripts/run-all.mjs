/**
 * Run every check in this project, in order, and report a single verdict.
 *
 * WHY THIS EXISTS
 *
 * The checks have different prerequisites and different runners -- some need
 * `--experimental-vm-modules`, one needs anvil, one needs the dev server -- and
 * running them one at a time by hand is how one gets skipped. It is also how a
 * result gets misread: `node test/render.test.mjs | Select-Object` reported exit 1
 * from PowerShell's handling of a stderr warning while node itself exited 0, and
 * that looked exactly like a failing test.
 *
 * Each check is a child process. Most inherit stdio. The forge test checks have
 * their output written to a file instead, because the runner has to READ what
 * forge printed: an exit code cannot tell "12 tests passed against real USDC" from
 * "12 tests declined to run" (see `forgeTotals` below). Piped stdio is not used
 * because this sandbox forbids named pipes, so capturing a child's output through
 * a pipe fails with EPERM; an inherited file descriptor is a regular file and
 * works. The captured output is printed as soon as the check returns, so nothing
 * that used to be visible on the console is hidden by this.
 *
 * A check whose PREREQUISITE is missing reports SKIP and does not fail the run --
 * the offline path is a supported way to work on this project. A check that runs
 * and fails, fails the run. A check that RUNS BUT SKIPS its tests is also reported
 * as SKIP rather than as a pass: it exercised nothing, and a skip presented as
 * evidence is the failure mode this file exists to prevent.
 *
 * Run: node scripts/run-all.mjs [--offline]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TC = resolve(REPO, '..', '..', 'toolchain');
const offline = process.argv.includes('--offline');

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const DAPP = process.env.WEB_URL ?? 'http://127.0.0.1:5173';

/** Is anything answering at this URL? */
async function reachable(url) {
  if (offline) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

const chainUp = await reachable(RPC);
const serverUp = await reachable(`${DAPP}/api/config`);

/**
 * The pass/fail/skip counts forge printed, or null if it printed none.
 *
 * WHY THE COUNTS AND NOT THE EXIT CODE
 *
 * `forge test` exits 0 both when a suite ran and when every test in it skipped:
 * `YieldVaultFork.t.sol` returns early from `setUp` -- and every test carries
 * `onlyForked`, which calls `vm.skip(true)` -- when no fork RPC is configured, and
 * forge reports that as a successful run with 12 skips. So the exit code cannot
 * distinguish "12 tests passed against the real USDC contract" from "12 tests
 * declined to run", and a runner that reads only exit codes reports the second as
 * the first. The counts forge prints beside them can tell the two apart.
 *
 * Both shapes are real output from forge 1.8.1, measured rather than assumed:
 *
 *   Suite result: ok. 0 passed; 0 failed; 12 skipped; finished in 1.66ms (2.22ms CPU time)
 *   Ran 1 test suite in 3.36ms (1.66ms CPU time): 0 tests passed, 0 failed, 12 skipped (12 total tests)
 *
 * Null is itself a finding, not a gap to paper over: a filter that matches nothing
 * prints no summary at all and still exits 0.
 */
function forgeTotals(text) {
  const total = text.match(/(\d+)\s+tests?\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+skipped/);
  if (total) return { passed: +total[1], failed: +total[2], skipped: +total[3] };

  const suites = [...text.matchAll(/Suite result:[^\n]*?(\d+) passed;\s*(\d+) failed;\s*(\d+) skipped/g)];
  if (suites.length === 0) return null;
  return suites.reduce(
    (sum, [, passed, failed, skipped]) => ({
      passed: sum.passed + Number(passed),
      failed: sum.failed + Number(failed),
      skipped: sum.skipped + Number(skipped),
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );
}

/**
 * Redirect one check's stdout and stderr into files under the workspace toolchain,
 * so the runner can read forge's own counts afterwards.
 *
 * A file, not a pipe: named pipes are forbidden in this sandbox (EPERM) while an
 * opened file descriptor is inherited normally. The files are truncated at every
 * run, so a stale file can never be mistaken for this run's output.
 */
function captureLogs(index) {
  const dir = resolve(TC, 'run-logs');
  mkdirSync(dir, { recursive: true });
  const stem = String(index).padStart(2, '0');
  const files = [resolve(dir, `${stem}.out`), resolve(dir, `${stem}.err`)];
  const fds = files.map((file) => openSync(file, 'w'));
  return {
    files,
    stdio: ['ignore', ...fds],
    fds,
    read: () => readFileSync(files[0], 'utf8') + readFileSync(files[1], 'utf8'),
  };
}

/** Print what a captured child wrote, so a captured check is no less visible than an inherited one. */
function replay(files) {
  for (const file of files) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
}

const CHECKS = [
  // --- fast, no prerequisites
  // `node: true` means the entry is a script path, not an executable. On Windows a
  // bare `.mjs` path is not runnable (spawnSync reports EFTYPE) and neither is a
  // `.js` path, so every entry states how it is launched rather than leaving the
  // runner to guess.
  { name: 'module graph links (no build step, so this is the only static check)', file: 'web/tools/check-modules.mjs', flags: ['--experimental-vm-modules'] },
  { name: 'vendored viem graph', file: 'web/tools/check-vendor.mjs', flags: ['--experimental-vm-modules'], args: ['web/vendor'] },
  { name: 'unit: wallet (EIP-1193 client, failure classes)', file: 'test/wallet.test.mjs' },
  { name: 'unit: vault (approval state machine, share math, parsing)', file: 'test/vault.test.mjs' },
  { name: 'unit: render (DOM, via a strict stub)', file: 'test/render.test.mjs', flags: ['--experimental-vm-modules'] },
  {
    // The batcher pairs RPC responses to requests. If it ever pairs them wrongly,
    // every figure on the page is silently attached to the wrong question and
    // nothing throws -- so the pairing is tested directly, including with responses
    // returned out of order, which the JSON-RPC specification permits.
    name: 'unit: rpc batcher (pairing, partial failure)',
    file: 'test/rpc-batch.test.mjs',
  },
  {
    // The price chart. Its own arithmetic -- the scale, the empty-series guard, the
    // caption's wording -- is pure and tested here without a browser. The failure this
    // guards is specific: this vault's price is almost constant, so a naive
    // `(v - min) / (max - min)` divides by zero, every coordinate becomes NaN, and the
    // panel draws NOTHING for a perfectly healthy vault while throwing nothing.
    name: 'unit: chart (scale, empty series, captions)',
    file: 'web/test/chart.test.mjs',
  },
  { name: 'integration: deposit/redeem against a fake chain', file: 'test/integration.test.mjs' },

  // --- contracts, through forge
  { name: 'contracts: forge test (unit + fuzz + invariant)', forgeArgs: ['test'] },
  {
    // This one forks MAINNET, so its prerequisite is a mainnet endpoint in the
    // environment -- NOT the local chain the other `needs: 'chain'` checks use,
    // which is why `needs: 'chain'` here used to let it run and skip. A
    // prerequisite the runner cannot probe by calling it is declared as `envAny`
    // and checked before anything is spawned, so the skip is a stated outcome with
    // a remedy rather than a suite quietly skipping and being counted as a pass.
    name: 'contracts: fork test against mainnet USDC',
    forgeArgs: ['test', '--match-path', 'test/YieldVaultFork.t.sol'],
    envAny: ['MAINNET_RPC_URL', 'FORK_RPC_URL'],
    how: 'MAINNET_RPC_URL=<an Ethereum mainnet endpoint> node scripts/run-all.mjs  (TESTING.md level 5 shows it for forge directly)',
  },

  // --- needs a chain
  { name: 'deployed contract agrees with shareMath (the 10**offset term)', file: 'scripts/check-share-term.mjs', needs: 'chain' },

  // --- needs the dev server
  { name: 'dev server smoke test', file: 'web/tools/smoke-server.mjs', needs: 'server' },
  {
    // The only check that compares the PAGE against the CHAIN. Everything else
    // tests one side or the other; this is the one that would have caught the
    // wrong virtual-share term from the outside.
    name: 'page figures agree with the chain (independently computed)',
    file: 'scripts/check-page-vs-chain.mjs',
    needs: 'server',
  },
];

const NEED = {
  chain: { up: chainUp, label: `a chain at ${RPC}`, how: 'scripts/dev-chain.ps1' },
  server: { up: serverUp, label: `the dev server at ${DAPP}`, how: 'node tools/dev-server.mjs' },
};

let failed = 0;
let skipped = 0;
const results = [];

for (const [index, check] of CHECKS.entries()) {
  const need = check.needs ? NEED[check.needs] : null;
  if (need && !need.up) {
    skipped += 1;
    results.push(['SKIP', check.name, `needs ${need.label} -- start it with ${need.how}`]);
    console.log(`\n=== SKIP  ${check.name}\n    needs ${need.label}; start it with: ${need.how}`);
    continue;
  }

  // A prerequisite that is an environment variable cannot be probed -- an endpoint
  // exists only if the caller supplies one -- so the check declares which names
  // would satisfy it. Declared here rather than discovered afterwards, because a
  // suite that skips itself looks exactly like a suite that passes.
  if (check.envAny && !check.envAny.some((name) => process.env[name])) {
    const detail = `needs one of ${check.envAny.join(', ')} in the environment`;
    skipped += 1;
    results.push(['SKIP', check.name, detail]);
    console.log(`\n=== SKIP  ${check.name}\n    ${detail}; set it like:\n      ${check.how}`);
    continue;
  }

  console.log(`\n=== RUN   ${check.name}`);

  const forge = resolve(TC, 'foundry', process.platform === 'win32' ? 'forge.exe' : 'forge');

  let cmd;
  let args;
  let captured = null;
  if (check.forgeArgs) {
    if (!existsSync(forge)) {
      skipped += 1;
      results.push(['SKIP', check.name, `forge not found at ${forge}`]);
      console.log(`    SKIP: forge not found at ${forge}`);
      continue;
    }
    cmd = forge;
    args = check.forgeArgs;
    // Only `forge test` prints pass/fail/skip counts, so only it needs reading.
    if (check.forgeArgs[0] === 'test') captured = captureLogs(index);
  } else {
    // `process.execPath`, not the string "node": this process was launched from a
    // bundled runtime whose directory is on PATH only because the harness put it
    // there, and a child that rebuilds PATH loses it. spawnSync then reports
    // "'node' is not recognized", which reads as a broken check.
    cmd = process.execPath;
    args = [...(check.flags ?? []), resolve(REPO, check.file), ...(check.args ?? [])];
  }

  // PREPEND to PATH, never replace it. An earlier version assigned
  // `env.PATH = <toolchain>;${env.PATH}` after reading a PATH that a previous line
  // had already overwritten, which deleted the runtime directory.
  const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  env.PATH = `${resolve(TC, 'foundry')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
  env.FOUNDRY_CACHE_PATH = resolve(TC, 'forge-cache');
  env.USERPROFILE = resolve(TC, 'home');

  // shell:false with an argument array: no quoting to get wrong, no shell to
  // interpret a path containing spaces (and every path here does).
  const run = spawnSync(cmd, args, { cwd: REPO, stdio: captured ? captured.stdio : 'inherit', env, shell: false });

  for (const fd of captured?.fds ?? []) closeSync(fd);
  if (captured) replay(captured.files);

  if (run.error) {
    failed += 1;
    results.push(['FAIL', check.name, run.error.message]);
    console.log(`    could not start: ${run.error.message}`);
    continue;
  }

  // A forge check is judged by the counts forge printed, never by the exit code alone.
  const totals = captured ? forgeTotals(captured.read()) : null;

  if (run.status !== 0 || (totals && totals.failed > 0)) {
    failed += 1;
    const detail = run.status !== 0 ? `exit ${run.status}` : `${totals.failed} failed`;
    results.push(['FAIL', check.name, detail]);
    continue;
  }

  if (captured && !totals) {
    // Exit 0 with no summary at all: forge ran nothing (a filter matching no file
    // exits 0 and prints no counts) or its output no longer looks like this. Both
    // mean there is no evidence, so neither may be reported as a pass.
    failed += 1;
    results.push(['FAIL', check.name, 'no counts in forge output (nothing ran?)']);
    console.log('    FAIL: forge exited 0 but printed no test summary, so there is nothing to count');
    continue;
  }

  if (totals && totals.passed === 0 && totals.skipped > 0) {
    const detail = `forge reported 0 passed, ${totals.skipped} skipped`;
    skipped += 1;
    results.push(['SKIP', check.name, `${detail} -- skipped, not passed`]);
    console.log(`    SKIP: ${detail}; a skipped test proves nothing, so this is not a pass`);
    continue;
  }

  results.push(['ok', check.name, totals ? `${totals.passed} passed${totals.skipped ? `, ${totals.skipped} skipped` : ''}` : '']);
}

console.log('\n================================================');
for (const [status, name, detail] of results) {
  console.log(`  ${status.padEnd(4)} ${name}${detail ? `  (${detail})` : ''}`);
}
console.log('================================================');
console.log(`${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);

if (failed) {
  console.log('\nFAILED');
  process.exit(1);
}
if (skipped && !existsSync(resolve(REPO, 'deployments', 'local.json'))) {
  console.log('\n(offline run: no deployments/local.json, so the chain-dependent checks were skipped)');
}
console.log('\nOK');
