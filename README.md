# YieldVault

An ERC-4626 tokenised vault on Base Sepolia. Anyone can deposit a single ERC-20
asset and receive shares; the owner can contribute yield by transferring real
assets in, which raises the value of every share. Withdrawals are immediate, with
no queue, no cap, and no fee.

**Chain:** Base Sepolia (84532) · **Access:** non-custodial, no admin power over
user funds · **Self-written logic:** ~30 lines

**Live:** <https://wuzilin-web3.github.io/erc4626-vault/> — the dApp, served from
GitHub Pages, reading Base Sepolia directly. No server is involved: the addresses come
from `deployments/base-sepolia.json` at build time and the reads go to the public
endpoint. The one panel that needs the index service (price history) has no route from a
static host and says so rather than failing silently. Deployed contract:
[`0x7941438e…`](https://sepolia.basescan.org/address/0x7941438ee07bea4469ccd4bec583e9fb24037f35)
([deploy tx](https://sepolia.basescan.org/tx/0x91cf6315b578512db189f8429a0dc76f8131328e9a14e4b5dd522699b69c663d)).

```bash
forge build
forge test          # 46 tests: 32 unit, 9 invariants, 13 deployment checks (+12 fork, skipped offline)
```

Requires [Foundry](https://getfoundry.sh/). No network access is needed: the two
dependencies are vendored under `lib/`, and `foundry.toml` pins a compiler path.
The fork tests against real USDC need an RPC endpoint and skip without one.

---

## What this actually is

A minimal, correct implementation of ERC-4626 whose value is not the feature set
but the evidence around it: invariant tests that a mutation can break, a static
analysis report, two independent fuzzers, and a written record of what was
measured rather than assumed.

- `src/YieldVault.sol` — the whole contract
- `src/DeployValidation.sol` — the deploy-time checks, extracted so they are testable
- `script/Deploy.s.sol` — the deployment script, verified against a local chain
- `test/YieldVault.t.sol` — 32 unit and fuzz tests
- `test/YieldVault.invariants.t.sol` — the stateful handler and 9 invariants
- `test/DeployScript.t.sol` — 13 tests of the deployment script's checks
- `test/YieldVaultFork.t.sol` — 12 tests against the **real** USDC contract
- `REQUIREMENTS.md` — scope, acceptance criteria, and where it deviates from plan
- `ARCHITECTURE.md` — decisions with their rejected alternatives, the maths, and the invariants
- `TESTING.md` — how to reproduce every claim below

---

## Security posture, in one paragraph

The vault holds the assets. No party can move them except through `deposit`,
`mint`, `withdraw` and `redeem`, each of which pays out strictly according to the
caller's own share balance. **The owner's only privilege is `reportYield`, which
transfers assets *from* the owner *into* the vault and mints nothing.** It cannot
remove assets, cannot target a user, and cannot block a withdrawal. A fully
compromised owner key can send the vault money and can do nothing else, so the
upper bound on user loss from owner key compromise is zero — by construction, not
by operational care.

There is no proxy and no upgrade path, which means there is no upgrade authority.

---

## Design decisions worth knowing

These are the choices a reader is most likely to want to argue with. Each is
argued in full in `ARCHITECTURE.md`.

| Decision | Why |
|---|---|
| **`totalAssets()` is `balanceOf(address(this))`**, never a bookkeeping variable | This is the structural reason the vault can always pay out: what it reports is what it holds. A vault that tracks assets in a variable can drift into reporting more than it has, and then the last withdrawer cannot be paid. |
| **Shares are 18 decimals for every asset**, deviating from ERC-4626's "mirror the asset" recommendation | The offset that produces this is `18 - assetDecimals`, which simultaneously gives shares one predictable precision and sets the inflation-attack cost at `10**offset` — 10¹² for a 6-decimal asset such as USDC. Deriving it from the asset rather than hardcoding a number means the protection scales with the asset instead of needing to be re-reasoned per deployment. |
| **`reportYield` rather than an investment strategy** | The first round is about whether the vault conforms to the standard. Integrating Aave or Morpho would add protocol risk and fork-testing cost while testing a different question. |
| **No `pause`, no emergency withdrawal, no blacklist** | Each would be a privilege that can affect users. Their absence is why the custody answer is "nobody". |
| **OpenZeppelin's `ERC4626` is imported, not copied** | OpenZeppelin's own first rule is not to copy library source into business contracts. The self-written part is `reportYield`, the constructor, and `_decimalsOffset`. |

---

## Verified behaviour

One command runs every check, including the dApp's. A check whose prerequisite is missing is
reported as `SKIP` and does not fail the run, and a forge suite that skips its own tests is
reported as `SKIP` too rather than counted as a pass — **a skip proves nothing**, so the runner
prints the passed and skipped totals separately instead of one green number:

```
node scripts/run-all.mjs
================================================
  ok   module graph links (no build step, so this is the only static check)
  ok   vendored viem graph
  ok   unit: wallet (EIP-1193 client, failure classes)
  ok   unit: vault (approval state machine, share math, parsing)
  ok   unit: render (DOM, via a strict stub)
  ok   unit: rpc batcher (pairing, partial failure)
  ok   unit: chart (scale, empty series, captions)
  ok   integration: deposit/redeem against a fake chain
  ok   contracts: forge test (unit + fuzz + invariant)  (46 passed, 12 skipped)
  SKIP contracts: fork test against mainnet USDC  (needs one of MAINNET_RPC_URL, FORK_RPC_URL in the environment)
  ok   deployed contract agrees with shareMath (the 10**offset term)
  ok   dev server smoke test
  ok   page figures agree with the chain (independently computed)
================================================
12 passed, 0 failed, 1 skipped

OK
```

That capture is the whole suite with a local chain and the dev server up, against a **freshly started
demo vault** — the state `scripts/dev-chain.ps1` begins in, before anything has been deposited:
**12 passed, 0 failed, 1 skipped**, and the one skip there is the fork check. **The fork tests need
`MAINNET_RPC_URL` and skip without it** — `MAINNET_RPC_URL=<a mainnet endpoint> node
scripts/run-all.mjs` runs them (level 5 in `TESTING.md` does the same for forge alone). Run it
offline and the four checks that need a chain or the dev server skip as well; that run prints
**9 passed, 0 failed, 4 skipped**. Neither total says anything about the work that was skipped,
which is the point: this README used to paste `10 passed, 0 failed, 0 skipped` with the fork check
listed as `ok`, and that was the old runner, which could not tell a suite that ran from a suite that
skipped itself.

**And one check's verdict is state-dependent, which is why it is reported rather than passed.**
`check-share-term.mjs` measures the virtual-share term with a 1-unit deposit into an **empty** vault,
so on a demo chain that already holds assets it declines that one measurement and prints `SKIP:` with
the amounts it found; the run then reports **11 passed, 0 failed, 2 skipped** instead of calling that
check `ok`. `scripts/dev-chain.ps1` starts a chain where the measurement is available; a chain that
has been used for a demo needs a fresh deployment, not a weaker check.

The individual results behind that:

```
forge test                    46 passed, 0 failed, 12 skipped
                              (32 unit + 9 invariants + 13 deployment checks)
forge test --match-contract YieldVaultInvariantTest
                              256 runs x depth 64, 16,384 calls, 0 reverts
forge test --match-contract YieldVaultForkTest   (needs an RPC endpoint)
                              12 passed against the REAL mainnet USDC contract
slither . --filter-paths "lib/|test/" --exclude-dependencies
                              102 detectors, 18 contracts, 0 results   (TESTING.md, level 6)
slither .                     102 detectors, 18 contracts, 32 results -- all of them in
                              vendored OpenZeppelin (31 under lib/, 1 mixed-pragma notice
                              that also names src/)
medusa fuzz                   9 properties, ~1M calls, 0 failures

node test/wallet.test.mjs          33 passed
node test/vault.test.mjs           48 passed
node test/integration.test.mjs     14 passed
node test/rpc-batch.test.mjs       11 passed
node --experimental-vm-modules test/render.test.mjs   42 passed
node web/test/chart.test.mjs       35 passed
```

**The invariant suite was checked for teeth, not just for green.** Reversing one
rounding direction inside OpenZeppelin's `convertToAssets` (Floor → Ceil) makes
three tests fail with messages like `previewRedeem floor: 9331000 != 9330999`.
A suite that stays green under a deliberately introduced defect is not evidence,
and `TESTING.md` records how to reproduce that check.

**The inflation attack is executed, not described.** One test performs it against
a vault with the decimal offset and asserts the victim keeps their value; another
performs the same attack against a vault with no offset and asserts that the
victim *is* wiped out. The difference between the two runs is the protection.

**The real USDC contract is exercised, not mocked.** `test/YieldVaultFork.t.sol`
forks Ethereum mainnet and moves genuine USDC, because every other test uses a
mock this repository also wrote — and a mock cannot disagree with the code that
tests it. An earlier version of that test faked `transferFrom` with
`vm.mockCall`; it returned `true` without moving anything, so the vault minted
shares against assets it never received. `TESTING.md` records that, because the
mistake is more instructive than the fix.

### What is not verified

- **No Sourcify verification.** The vault *is* deployed on Base Sepolia — the address, the
  transaction and the block are in `deployments/base-sepolia.json` — but the source has not been
  verified anywhere: that record carries no `verifiedAt`, so "the bytecode at that address is this
  source" is a claim a reader can recompile and check, not one this repository has published.
- **No external audit.** Self-reviewed plus two automated tools.
- **The dApp has been driven through real MetaMask, but not by a stranger, and not on
  a public network.** What was done, and what it proves: with a genuine MetaMask
  extension loaded, an approve and a deposit were executed against the local vault, and
  every figure was checked against the chain independently rather than against the
  page's own claim — the asset `Transfer` log carried exactly `10_000_000` base units,
  the share delta equalled `assets * (totalSupply + 10**12) / (totalAssets + 1)`
  computed by hand, and the receipt was `status 1`. A rejected prompt was confirmed
  neutral rather than an error and cost nothing; an over-balance deposit sent no
  transaction; the redeem Max button filled `359.021905704231281673` rather than its
  base-unit form. What that does NOT cover: a public network, an account with real
  value, wallet versions other than 13.48, or an operator other than the one who built
  it. `web/DESIGN.md` §7 remains the checklist for a person meeting the page cold.
- **The dApp uses a mock ERC-20, not real USDC.** The local chain deploys
  `MockERC20`; real-USDC integration is what the mainnet fork test covers.
- **The fork test says nothing about Base Sepolia.** It forks mainnet because
  that is where the real USDC implementation lives.
- **Echidna and Halmos were not run.** Echidna is installed but cannot start in
  this environment; Halmos was not attempted.
- **The `reportYield` path cannot be exercised by a stranger.** It is
  `onlyOwner`, so on testnet only the deployer can demonstrate it.

---

## Layout

```
src/YieldVault.sol              the contract
src/DeployValidation.sol        the preflight/postflight checks the deploy script uses
script/Deploy.s.sol             deploy, then verify what was deployed
test/MockERC20.sol              a 6-decimal ERC-20 test double
test/YieldVault.t.sol           32 unit and fuzz tests
test/YieldVault.invariants.t.sol  stateful handler + 9 invariants
test/DeployScript.t.sol         13 checks on the deployment path
test/YieldVaultFork.t.sol       12 tests against real mainnet USDC
test/wallet.test.mjs            33 tests: the EIP-1193 client and failure classes
test/vault.test.mjs             48 tests: approval state machine, share math, parsing
test/integration.test.mjs       14 tests: deposit/redeem against a fake JSON-RPC chain
test/render.test.mjs            42 tests: the DOM layer, against a strict stub
test/rpc-batch.test.mjs         11 tests: RPC request/response pairing
web/test/chart.test.mjs         35 tests: the price chart's scale, empty series, captions
web/                            the wallet dApp — no build step; see web/DESIGN.md
  app/  index.html  style.css  vendor/  tools/  chart.js
deployments/                    deployment records — see its README
scripts/run-all.mjs             runs every check above and prints one verdict
scripts/dev-chain.ps1           local anvil + deploy, offline, state persisted
lib/forge-std                   vendored, v1.16.2
lib/openzeppelin-contracts      vendored, v5.7.0
foundry.toml                    build and fuzz configuration
medusa.json                     property-fuzzing configuration
```

`lib/` is committed rather than used as a git submodule so that the build works
with no network access. To switch to submodules, delete `lib/` and install
`foundry-rs/forge-std@v1.16.2` and `OpenZeppelin/openzeppelin-contracts@v5.7.0`.

### Running the dApp

```powershell
.\scripts\dev-chain.ps1     # anvil (offline, no fork) + deploy + write deployments/local.json
node tools\dev-server.mjs   # http://127.0.0.1:5173/
```

`dev-chain.ps1` starts a **fresh local chain, not a mainnet fork** — deliberately,
so the demo works with no network. State lives in `deployments/anvil-state.json`
(gitignored), so the vault and its balances survive a restart.

**`-Managed`** runs anvil in the foreground instead of detaching it. Use it wherever
anvil must be a managed child — a background job, a sandbox, CI — because those
reap a detached process as soon as the parent exits. In a normal terminal the
default (detached) is right: anvil should outlive the script.

If the demo ever comes up with an empty vault, the balances were lost rather than
the addresses — recover without redeploying, because `MockERC20.mint` is
permissionless:

```powershell
node scripts\fund-demo.mjs    # mint the demo supply again
node scripts\seed-demo.mjs    # top up a second holder, deposit, report yield
```

That is cheaper than a redeploy, which changes every address and therefore means
re-importing into MetaMask and re-adding the network. `web/DESIGN.md` §5 records
how the balances were lost in the first place (`--load-state` saves nothing).

---

## Related repositories

This repository is the **contract and its wallet dApp**: Solidity, its Foundry
tests, the zero-build front end, and the deployment records.

| Repository | Contains |
|---|---|
| **`erc4626-vault`** (this one) | The contract, its tests, the deployment script, `deployments/`, and the P3 wallet dApp |
| `erc4626-vault-dapp` | The TypeScript service: event indexer, SQLite database, query API (P4) |

The split is by **language and deployment surface**, not by "contract vs front
end", and it is worth being explicit that the dApp lives *here* rather than in the
`-dapp` repository, because the name suggests otherwise. The reason is the one that
makes the split useful: the vault is deployed once and is then immutable, so the
contract and the page that talks to it should be read together — the page's
correctness is a statement about this contract's behaviour, and `web/DESIGN.md`
documents the integration rather than a product.

The `-dapp` repository holds P4, which is a running service with a database and a
deployment of its own. It consumes `deployments/` from here: the address, the start
block and the source commit are published so the indexer has somewhere to begin.

---

## Roadmap

| Phase | Content | Where | State |
|---|---|---|---|
| P1 | Contract, unit tests, invariants, static analysis, two fuzzers | this repo | ✅ done |
| P2 | Deploy to Base Sepolia, verify on Sourcify, record the deployment | this repo | ▶ **deployed 2026-09-17** — vault `0x7941438ee07bea4469ccd4bec583e9fb24037f35`, tx `0x91cf6315…` in block 46,919,125, funded with 21 USDC of test assets; ⏳ Sourcify verification still open |
| P3 | Wallet dApp: connect, deposit, redeem, approve, and the five failure classes handled honestly | this repo, `web/` | ✅ code and tests done; ⏳ manual browser checklist not yet run |
| P4 | Event indexer, SQLite snapshot, query API, scheduled refresh | `erc4626-vault-dapp`, surfaced by `vault-console` | ✅ built and running — the workflow commits each new snapshot (`data/vault.sqlite`; four `data:` commits by `github-actions[bot]`, all 2026-09-17, read from the GitHub API), and the console is published at <https://wuzilin-web3.github.io/vault-console/>; ⏳ nothing is hosted as a service, so the snapshot lags the head between runs |

P2 was parked for as long as it took to pay for a funded key, and that was paid on 2026-09-17:
`script/Deploy.s.sol` performed its preflight against the real asset, deployed, and then verified
what it deployed, and the result is recorded in `deployments/`. Deploying for real also found a bug
no local run could — a public node answers `result: "0x"` for the vault's totals *at the deployment
block*, and the indexer's `BigInt(result)` threw on it; `deployments/README.md` records it. What
remains open is the verification half of the deliverable: nothing has been submitted to Sourcify,
so the record has no `verifiedAt`.

The vault is deployed on Base Sepolia now; every test that touches a token still uses a
mock (`MockERC20`) except the mainnet fork test, which runs only when a mainnet RPC endpoint is
supplied. Both are stated in `TESTING.md` rather than left to be discovered.

---

## Licence

MIT
