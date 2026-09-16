# Deployments

This directory is the **interface between this repository and anything that
consumes the contract** — the wallet dApp, the event indexer, or a person reading
along with a block explorer.

Nothing is deployed yet. The format below is fixed now so that P2 has a place to
write, and so that the second repository has something specific to depend on.

---

## Files

| File | Chain | Status |
|---|---|---|
| `base-sepolia.json` | Base Sepolia (84532) | **not yet deployed** |

## The record format

```json
{
  "chainId": 84532,
  "network": "base-sepolia",
  "address": "0x...",
  "deployBlock": 12345678,
  "deployTxHash": "0x...",
  "deployer": "0x...",
  "owner": "0x...",
  "asset": {
    "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "symbol": "USDC",
    "decimals": 6
  },
  "sourceCommit": "<the commit this bytecode was built from>",
  "verifiedAt": "https://repo.sourcify.dev/contracts/full_match/84532/0x.../",
  "abi": [ ... ]
}
```

## Two fields carry more weight than the rest

**`deployBlock`** is not decoration. The indexer's start block must be the block
the contract was deployed in, and getting it wrong is a **silent** failure rather
than a loud one: an indexer pointed at a block before deployment finds no events
and reports success, and one pointed after the deployment misses every early
event. Writing it down here, next to the address, means the indexer has a single
authoritative source instead of a number copied out of a chat log.

**`sourceCommit`** is what makes the address *trustworthy* rather than merely
*known*. Anyone can read the bytecode at the address and compare it against
whatever `src/YieldVault.sol` says; without the commit sha they cannot tell which
version of the source produced it. With it, the claim "the deployed contract is
this code" becomes checkable by a third party without asking us.

Sourcify verification is preferred over a block-explorer submission because it
needs no API key and no account, so it cannot silently expire or be tied to a
person. `verifiedAt` points at the Sourcify record.

## Why the ABI is committed rather than published as a package

The consumers are in this project's sibling repository, and they need the ABI to
decode `Deposit` and `Withdraw`. Publishing an npm package for a single contract
would add a registry account, a release process and a versioning scheme to keep
in sync — more machinery than the problem has. A JSON file in a known location,
copied by a short script, is enough, and it keeps the contract repository free of
anything that has to be released.

## Build settings, because verification depends on them

Sourcify (and any block explorer) recompiles the source and compares bytecode.
Matching source is not enough — **the compiler version and every optimisation
setting must match too**, or the bytecode differs and verification fails for a
reason that looks like a source mismatch. So the settings are recorded here rather
than left implicit in `foundry.toml`:

| Setting | Value |
|---|---|
| Solidity | **0.8.37** (`0.8.37+commit.f401782d`) |
| Optimizer | enabled |
| Optimizer runs | 200 |
| `via_ir` | false |
| EVM version | `cancun` |
| Metadata bytecode hash | Foundry's default (`ipfs`) |

Any change to these after deployment would make the deployed contract
unverifiable against the repository, which is one more reason the repository stops
changing once P2 is done.

### A wrinkle for anyone reproducing the build

`foundry.toml` pins `solc` to an **absolute path** inside the development
workspace, because `solc-select` is broken in that environment and a downloaded
compiler would make the build depend on network access. On any other machine that
path does not exist. Replace that one line with a version string:

```toml
solc = "0.8.37"
```

and install that exact version. The path is a local workaround, not part of the
build's definition; the *version* is what verification depends on.

## What is deliberately not here

- **No private keys and no `.env`.** The deployment script reads its key from the
  environment; nothing secret is committed, and `.gitignore` covers `.env*`.
- **No build output.** The verified source is reconstructable from the commit and
  the settings above.
- **No addresses for chains we have not deployed to.** An empty record would look
  like a deployment that failed.
