/**
 * List the external import specifiers in the vendored bundle.
 *
 * The bundle is not self-contained. The question that decides the architecture
 * is how many things it needs: two or three can be vendored alongside it, while
 * a hundred make the no-build approach the wrong shape and a hand-written
 * JSON-RPC client the right one.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(process.argv[2], 'utf8');

// Every form an ES import can take in a bundled artifact.
const patterns = [
  /^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*export\s+[^'"]*from\s*['"]([^'"]+)['"]/gm,
];

const found = new Map();
for (const re of patterns) {
  for (const m of source.matchAll(re)) {
    const spec = m[1];
    found.set(spec, (found.get(spec) ?? 0) + 1);
  }
}

const specs = [...found.keys()].sort();
console.log(`external specifiers: ${specs.length}`);
for (const s of specs) {
  const isRelative = s.startsWith('.') || s.startsWith('/');
  const isData = s.startsWith('data:');
  console.log(`  ${isRelative ? 'rel ' : isData ? 'data' : 'ABS '} ${s}   x${found.get(s)}`);
}

const absolute = specs.filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('data:'));
console.log('');
console.log(`absolute (would need an import map or vendoring): ${absolute.length}`);
if (absolute.length) console.log(absolute.join('\n'));
