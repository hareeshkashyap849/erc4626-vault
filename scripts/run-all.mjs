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
 * Each check is a child process with `stdio: 'inherit'`. Piped stdio is not used
 * because this sandbox forbids named pipes, so capturing a child's output through
 * a pipe fails with EPERM. Inherited stdio has no such problem, and the exit code
 * is still the child's own.
 *
 * A check whose PREREQUISITE is missing reports SKIP and does not fail the run --
 * the offline path is a supported way to work on this project. A check that runs
 * and fails, fails the run.
 *
 * Run: node scripts/run-all.mjs [--offline]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
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
  { name: 'contracts: fork test against mainnet USDC', forgeArgs: ['test', '--match-path', 'test/YieldVaultFork.t.sol'], needs: 'chain' },

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

for (const check of CHECKS) {
  const need = check.needs ? NEED[check.needs] : null;
  if (need && !need.up) {
    skipped += 1;
    results.push(['SKIP', check.name, `needs ${need.label} -- start it with ${need.how}`]);
    console.log(`\n=== SKIP  ${check.name}\n    needs ${need.label}; start it with: ${need.how}`);
    continue;
  }

  console.log(`\n=== RUN   ${check.name}`);

  const tc = resolve(REPO, '..', '..', 'toolchain');
  const forge = resolve(tc, 'foundry', process.platform === 'win32' ? 'forge.exe' : 'forge');

  let cmd;
  let args;
  if (check.forgeArgs) {
    if (!existsSync(forge)) {
      skipped += 1;
      results.push(['SKIP', check.name, `forge not found at ${forge}`]);
      console.log(`    SKIP: forge not found at ${forge}`);
      continue;
    }
    cmd = forge;
    args = check.forgeArgs;
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
  env.PATH = `${resolve(tc, 'foundry')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;
  env.FOUNDRY_CACHE_PATH = resolve(tc, 'forge-cache');
  env.USERPROFILE = resolve(tc, 'home');

  // shell:false with an argument array: no quoting to get wrong, no shell to
  // interpret a path containing spaces (and every path here does).
  const run = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit', env, shell: false });

  if (run.error) {
    failed += 1;
    results.push(['FAIL', check.name, run.error.message]);
    console.log(`    could not start: ${run.error.message}`);
    continue;
  }
  if (run.status === 0) {
    results.push(['ok', check.name, '']);
  } else {
    failed += 1;
    results.push(['FAIL', check.name, `exit ${run.status}`]);
  }
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
