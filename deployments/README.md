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
| `local.json` | Anvil (31337) | disposable local chain; addresses change on every redeploy |
| `base-sepolia.json` | Base Sepolia (84532) | **deployed** — vault `0x7941438ee07bea4469ccd4bec583e9fb24037f35`, block 46,919,124, tx `0x91cf6315…`. Testnet only: no real funds, **not audited**, and the vault is not yet funded (totals are 0) |

The Base Sepolia record was validated against the chain by `../scripts/check-deployment-record.mjs`, which
checks the shape each reader needs *and* the on-chain facts: bytecode at the address, and `asset()`,
`owner()`, `decimals()` and `symbol()` matching what the record claims:

```
PASS  the endpoint is on the record's chain (record says 84532)  (endpoint says 84532)
PASS  there is bytecode at the vault address  (5070 bytes)
PASS  the vault's asset() equals the recorded asset  (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
PASS  the vault's owner() equals the recorded owner  (0x2aE746C0ff0295c2da1aC338656F247e9758E034)
PASS  the asset reports the recorded decimals  (6 on chain, record says 6)
PASS  the asset reports the recorded symbol  (USDC on chain, record says USDC)
```

**Deploying for real found a bug that no local run could.** The indexer read the vault's totals with
batched `eth_call`s and converted them with `BigInt(result)` after checking only that the reply *had* a
`result` field. A public node asked for those totals **at the deployment block** answers `result: "0x"` —
the contract is not in the state it serves for that height — and `BigInt('0x')` throws. Anvil never
answers that way, so every local run passed; the failure appears on the first block of the first real
deployment, and it is total. Fixed in `../erc4626-vault-dapp` (`decodeUintResult`, with tests).

## The record format

**One shape for both files, and `local.json` is the reference implementation.** An earlier version of
this file documented a *different* format for `base-sepolia.json` — `address` instead of `vault`, and
`asset` as an object with `symbol` and `decimals` — while the console reads `vault` and `asset` as
strings. Nothing had been deployed yet, so nothing caught it: the first testnet deployment would have
produced a record that `loadDeployment()` **refuses** ("The deployment record at … has no \"vault\""),
at the end of a deployment, on a machine that had just spent test ETH.

So the format below is the one shape, and the provenance fields the testnet record genuinely needs are
added **alongside** the ones the readers consume rather than replacing them:

```json
{
  "chainId": 84532,
  "network": "base-sepolia",
  "chainName": "Base Sepolia",
  "rpcUrl": "https://sepolia.base.org",
  "walletRpcUrl": "https://sepolia.base.org",

  "vault": "0x...",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "owner": "0x...",
  "deployBlock": 12345678,

  "deployTxHash": "0x...",
  "deployer": "0x...",
  "sourceCommit": "<the commit this bytecode was built from>",
  "verifiedAt": "https://repo.sourcify.dev/contracts/full_match/84532/0x.../",
  "assetSymbol": "USDC",
  "assetDecimals": 6,
  "note": "...",

  "abi": [ ... ]
}
```

**Which key belongs to which reader** — this is the part that has to stay true, because three programs
read this file and each one reads a different subset:

| Key | Who reads it | What happens if it is missing or wrong |
|---|---|---|
| `chainId` | the console's `loadDeployment()` and `next.config.ts` | the build refuses; the wallet would otherwise be pointed at a chain with no vault on it |
| `vault` | the console (as an address), the indexer (as the start of its range) | `loadDeployment()` throws, naming the file |
| `asset` | the console, to label amounts and read decimals | amounts render against the wrong decimals |
| `deployBlock` | the indexer's start block | **silent in both directions**: before deployment finds no events and reports success, after it misses the early ones |
| `rpcUrl` / `walletRpcUrl` | the dApp's server and its wallet configuration | the page reads through a proxy; a wallet needs a URL it can reach itself, so these are two different things and are named for their use |
| `sourceCommit` | a person, later | without it the address is *known* but not *trustworthy*: anyone can read the bytecode, but not which version of the source produced it |
| `abi` | the sibling dApp, to decode events | see below |

`../scripts/check-deployment-record.mjs` validates all of this — the required keys, plus the on-chain
facts if an RPC is reachable — and the runbook runs it **between** writing the record and pointing
anything else at it.

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
