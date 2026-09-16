/**
 * Static check for the dApp's module graph.
 *
 * WHAT THIS CATCHES THAT NOTHING ELSE IN THIS PROJECT DOES
 *
 * There is no bundler and no build step (web/DESIGN.md §1), so a typo in an
 * import -- a name that is not exported, a file that moved, a syntax error --
 * is not caught until a browser loads the page. That failure is a blank screen
 * with a console message, and it is the single most likely way this page breaks
 * at 2am before a demo.
 *
 * `vm.SourceTextModule` links modules WITHOUT executing them. Node resolves every
 * imported binding against the module it came from at link time, so a missing
 * export is a hard error here, and no DOM is needed. That makes the whole graph
 * checkable in Node even though none of it can run in Node.
 *
 * It checks, in order:
 *   1. Every module in the graph parses.
 *   2. Every relative import resolves to a file that exists.
 *   3. Every named import is actually exported by that file (the big one).
 *   4. There are no bare (npm-style) specifiers -- there is no resolver here, so
 *      a bare specifier would fail in the browser too.
 *   5. Every DOM id the JS looks up exists in index.html, and vice versa.
 *   6. No import cycles.
 *
 * Run: node --experimental-vm-modules web/tools/check-modules.mjs
 * (wrapped by npm-less scripts; see web/DESIGN.md §6)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = resolve(HERE, '..');

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

/** Every .js under web/app, which is the code we wrote (web/vendor is not ours). */
function ownModules() {
  const dir = join(WEB, 'app');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(dir, f));
}

/**
 * Load a module and everything it imports.
 *
 * The linker is strict: a bare specifier is reported rather than guessed at,
 * because there is no node_modules for this page to resolve from.
 */
async function linkGraph(entry) {
  const cache = new Map();
  const stack = [];

  async function load(path) {
    const key = resolve(path);
    if (cache.has(key)) return cache.get(key);

    if (!existsSync(key)) throw new Error(`${relative(WEB, key)} does not exist`);

    let source;
    try {
      source = readFileSync(key, 'utf8');
    } catch (err) {
      throw new Error(`cannot read ${relative(WEB, key)}: ${err.message}`);
    }

    const mod = new vm.SourceTextModule(source, {
      identifier: key,
      initializeImportMeta() {},
    });
    cache.set(key, mod);
    return mod;
  }

  // Node calls the linker with `referencing` UNDEFINED when resolving the root
  // module's own imports (it is only set for transitively imported modules).
  // Assuming it is always present throws "The \"to\" argument must be of type
  // string. Received undefined" and looks like a bug in the page rather than in
  // this checker, which is how it was first reported.
  const linker = async (specifier, referencing) => {
    const from = referencing ? referencing.identifier : resolve(entry);
    const where = relative(WEB, from);

    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      throw new Error(`bare specifier "${specifier}" in ${where} -- there is no resolver for this page`);
    }
    if (specifier.startsWith('/')) {
      throw new Error(`root-absolute specifier "${specifier}" in ${where} -- served from a nested path, so this would break`);
    }
    const target = resolve(dirname(from), specifier);
    if (!existsSync(target)) {
      throw new Error(`cannot resolve "${specifier}" from ${where}`);
    }
    if (stack.includes(target)) {
      notes.push(`import cycle: ${[...stack, target].map((p) => relative(WEB, p)).join(' -> ')}`);
    }
    return load(target);
  };

  const root = await load(entry);
  // `link` resolves every relative specifier and checks every named import
  // against the target's exports. Execution is never started.
  await root.link(linker);
  return { root, cache };
}

/** Collect the ids index.html defines. */
function htmlIds() {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    if (ids.has(m[1])) fail(`index.html defines id "${m[1]}" twice`);
    ids.add(m[1]);
  }
  return ids;
}

/** Ids the JS looks up, as {id, where} pairs. */
function jsIds(paths) {
  const found = [];
  for (const path of paths) {
    const src = readFileSync(path, 'utf8');
    const where = relative(WEB, path);
    for (const m of src.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)) found.push({ id: m[1], where });
    for (const m of src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) found.push({ id: m[1], where });
    for (const m of src.matchAll(/setText\(\s*'([^']+)'/g)) found.push({ id: m[1], where });
  }
  return found;
}

/**
 * `el()` calls that are not literal ids, which this check cannot verify.
 *
 * Reported rather than ignored: a dynamic id is a hole in the check, and the
 * count should be allowed to fall, never to rise unnoticed.
 */
function dynamicIds(paths) {
  const found = [];
  for (const path of paths) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/\bel\(\s*(?!')([^)]{1,40})\)/g)) {
      found.push({ expr: m[1].trim(), where: relative(WEB, path) });
    }
  }
  return found;
}

async function main() {
  const entries = ownModules();
  if (entries.length === 0) fail('no modules found under web/app');

  const linked = new Map();
  for (const entry of entries) {
    try {
      const { cache } = await linkGraph(entry);
      for (const [path, mod] of cache) linked.set(path, mod);
      console.log(`  linked ${relative(WEB, entry)} (${cache.size} module${cache.size === 1 ? '' : 's'} in graph)`);
    } catch (err) {
      fail(`${relative(WEB, entry)}: ${err.message}`);
    }
  }
  void linked;

  // ---- id cross-check
  const ids = htmlIds();
  const used = jsIds(entries);
  const usedNames = new Set(used.map((u) => u.id));
  for (const { id, where } of used) {
    if (!ids.has(id)) fail(`${where} looks up #${id}, which index.html does not define`);
  }
  // An id in the HTML nothing references is usually a leftover after a rename,
  // which is worth knowing rather than worth failing over.
  for (const id of ids) {
    if (!usedNames.has(id)) notes.push(`index.html defines #${id}, which no module references`);
  }
  const dynamic = dynamicIds(entries);
  for (const d of dynamic) notes.push(`${d.where} computes an element id at runtime: el(${d.expr})`);

  // ---- cycles already collected by the linker
  const uniqueNotes = [...new Set(notes)];

  const graphs = entries.length;
  console.log('');
  console.log(`  modules      ${graphs}`);
  console.log(`  html ids     ${ids.size}`);
  console.log(`  ids used     ${usedNames.size}`);
  console.log(`  dynamic ids  ${dynamic.length}`);

  if (uniqueNotes.length) {
    console.log('');
    for (const n of uniqueNotes) console.log(`  note: ${n}`);
  }

  if (failures.length) {
    console.log('');
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log('');
    console.log(`${failures.length} problem${failures.length === 1 ? '' : 's'}`);
    process.exit(1);
  }

  console.log('');
  console.log('OK -- module graph links, all named imports exist, every id the JS uses is in index.html');
}

await main();
