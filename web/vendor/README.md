# vendor/ — why there is a copy of viem in this repository

These 27 files are **viem 2.56.5, bundled for the browser, with their whole
dependency graph rewritten to local paths.** They are committed on purpose.

## Why not npm

The npm registry is unreachable from the environment this was built in, so
`npm install viem` cannot run. And even with a working registry, the browser
cannot consume a `node_modules` tree: viem's ESM output is a graph of hundreds of
relative imports, each a separate request, none of which works offline.

## Why not an import map to a CDN

That works and is less code, but it makes the dApp require the internet at run
time. The chain was just moved off a mainnet fork specifically so the demo would
survive a dropped connection; re-introducing an internet dependency in the front
end would undo that.

## Why not hand-write a JSON-RPC client

It would remove the dependency entirely, and it is genuinely tempting. It is also
roughly 500 lines of EIP-1193 plumbing, ABI encoding and error decoding, written
with no test budget left to find the bugs in it. Three vendored files are
strictly less risk than a hand-rolled replacement of the layer most likely to
have subtle faults.

## What is actually in here

| | |
|---|---|
| viem | 2.56.5 |
| source | `https://cdn.jsdelivr.net/npm/viem@2.56.5/+esm` at fetch time |
| files | 27 |
| size | ~650 KB |
| also included | `abitype`, `ox`, `@noble/hashes`, `@noble/curves`, `@scure/base`, `@scure/bip32`, `@scure/bip39`, `isows` |

The version matches the one already exercised against Base mainnet and Base
Sepolia in `test/YieldVaultFork.t.sol`, which is worth having: the fork tests and
the dApp are then talking about the same client.

**The filenames are hashes of the original paths**, because two packages can
contain the same basename and a collision would silently substitute one module
for another.

## Regenerating

```bash
node web/tools/vendor-graph.mjs "/npm/viem@2.56.5/+esm" web/vendor
```

Then verify — **do not skip this.** A vendored graph that fails to link looks
identical from the outside to one that works, and the browser reports only that a
module could not be loaded:

```bash
node --experimental-vm-modules web/tools/check-vendor.mjs web/vendor
```

It parses and links the whole graph, checks the exports the dApp needs, and runs
a few pure functions to confirm this is viem rather than a stub.

## Upgrading viem

Change the version in the fetch command, regenerate, re-run the check, and re-run
`forge test --match-contract YieldVaultForkTest` so the contract-facing client and
the browser client are not silently different versions.
