# YieldVault

An ERC-4626 tokenised vault on Base Sepolia. Anyone can deposit a single ERC-20
asset and receive shares; the owner can contribute yield by transferring real
assets in, which raises the value of every share. Withdrawals are immediate, with
no queue, no cap, and no fee.

**Chain:** Base Sepolia (84532) · **Access:** non-custodial, no admin power over
user funds · **Self-written logic:** ~30 lines

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

One command runs every check, including the dApp's:

```
node scripts/run-all.mjs
   10 passed, 0 failed, 0 skipped

  ok   module graph links            ok   unit: vault (state machine, share math)
  ok   vendored viem graph           ok   unit: render (DOM stub)
  ok   unit: wallet                  ok   integration: deposit/redeem vs a fake chain
  ok   contracts: forge test         ok   contracts: fork test vs real mainnet USDC
  ok   deployed contract agrees with shareMath
  ok   dev server smoke test
```

The individual results behind that:

```
forge test                    46 passed, 0 failed, 12 skipped
                              (32 unit + 9 invariants + 13 deployment checks)
forge test --match-contract YieldVaultInvariantTest
                              256 runs x depth 64, 16,384 calls, 0 reverts
forge test --match-contract YieldVaultForkTest   (needs an RPC endpoint)
                              12 passed against the REAL mainnet USDC contract
slither .                     102 detectors, 18 contracts, 0 results
medusa fuzz                   9 properties, ~1M calls, 0 failures

node test/wallet.test.mjs          33 passed
node test/vault.test.mjs           47 passed
node test/integration.test.mjs     11 passed
node --experimental-vm-modules test/render.test.mjs   19 passed
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

- **Not deployed anywhere.** There is no live address and no verified contract.
  The deployment script runs and has been exercised against a local chain, but it
  has not been run against a funded account on a public network.
- **No external audit.** Self-reviewed plus two automated tools.
- **The wallet dApp has never been used in a browser.** Every layer up to the
  wallet boundary is tested — the deposit path is driven end to end against a fake
  JSON-RPC chain, and `render.js` is exercised against a DOM stub — but no human
  has yet clicked Approve in a real wallet on the real page. That is the manual
  checklist in `web/DESIGN.md` §7, and until it is walked the honest description is
  "implemented and tested to the wallet boundary", not "working".
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
test/vault.test.mjs             47 tests: approval state machine, share math, parsing
test/integration.test.mjs       11 tests: deposit/redeem against a fake JSON-RPC chain
test/render.test.mjs            19 tests: the DOM layer, against a strict stub
web/                            the wallet dApp — no build step; see web/DESIGN.md
  app/  index.html  style.css  vendor/  tools/
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
so the demo works with no network. Addresses persist across restarts through
`deployments/anvil-state.json`; re-running the deploy script without `-Force`
reuses them, and `web/DESIGN.md` §5 records what that costs.

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
| P2 | Deploy to Base Sepolia, verify on Sourcify, record the deployment | this repo | ⏸ **parked** — script and validation written and verified against a local chain; needs a funded key |
| P3 | Wallet dApp: connect, deposit, redeem, approve, and the five failure classes handled honestly | this repo, `web/` | ✅ code and tests done; ⏳ manual browser checklist not yet run |
| P4 | Event indexer, SQLite snapshot, query API, scheduled refresh | `erc4626-vault-dapp` | not started |

P2 is parked rather than abandoned: `script/Deploy.s.sol` performs a preflight
against the real asset, deploys, and then verifies what it deployed, and
`test/DeployScript.t.sol` covers that path. What is missing is a funded Base
Sepolia account, and that is a cost this project has not paid.

Nothing is deployed on a public network, and every test that touches a token uses
a mock (`MockERC20`) except the mainnet fork test. Both are stated in `TESTING.md`
rather than left to be discovered.

---

## Licence

MIT
