# Testing — base-yield-vault

How to reproduce every claim in the README, in four levels, and an explicit list
of what is **not** covered.

The point of listing the gaps is that a testing document claiming completeness is
not useful. Everything below can be run locally with no network access and no
API keys.

---

## Prerequisites

Foundry, and the workspace toolchain on `PATH`. From a clean checkout:

```bash
forge build          # compiles with the pinned solc; needs no network
forge test
```

`foundry.toml` sets `solc` to an absolute path inside this workspace's toolchain
because `solc-select` is broken in this environment (its Python module is
missing) and letting forge download a compiler would make the build depend on
network access. If you are elsewhere, change that one line to a version string
such as `"0.8.37"`.

---

## Level 1 — unit and fuzz tests

```bash
forge test
```

Expected: **32 passed, 0 failed**, plus the invariant suite below.

The tests check arithmetic against an independent restatement of OpenZeppelin's
conversion formula (`_expectedShares` / `_expectedAssets` and their ceil
variants) rather than against the vault's own output. A test that asks the
contract for an answer and then asserts the contract gave that answer proves
nothing; these recompute the value and compare.

Covered:

| Area | Tests |
|---|---|
| Decimal handling | 18 decimals for 6- and 18-decimal assets; construction reverts above 18 |
| First deposit | receives `assets * 10**offset` shares, so the offset costs the first depositor nothing |
| Rounding directions | all four previews and both conversions checked against independent floor/ceil implementations |
| Ceil ≥ floor | 25 samples including values that do not divide evenly |
| preview == executed | four pairs (deposit/mint/withdraw/redeem) |
| `reportYield` | raises share price, mints nothing, emits, rejects zero, rejects non-owner |
| Owner cannot take | the only owner call moves assets *in*; a full withdrawal still succeeds afterwards |
| Solvency | total supply never redeemable for more than assets + 1 wei |
| Last withdrawer | paid in full after others have exited |
| No free lunch | fuzzed deposit→redeem and mint→redeem round trips never profit |
| Inflation attack | executed against both an offset vault (victim keeps value) and a zero-offset vault (victim is wiped out) |
| Limits | `max*` functions, over-withdrawal, over-redemption |
| Third-party spend | withdraw without allowance reverts; with allowance succeeds and consumes it |
| Share transfer | a transferred share is worth exactly the same claim |
| Accounting | `totalAssets()` always equals the balance, including after a direct donation |

### Run one test with output

```bash
forge test --match-test test_InflationAttackFailsToStealTheNextDepositorsValue -vvv
```

---

## Level 2 — the tests have teeth (mutation check)

A suite that passes is only evidence if it can fail. This deliberately breaks the
library and confirms the suite notices.

```bash
# back up the vendored source
cp lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol /tmp/ERC4626.sol.bak

# reverse one rounding direction: convertToAssets Floor -> Ceil
sed -i 's/return _convertToAssets(shares, Math.Rounding.Floor);/return _convertToAssets(shares, Math.Rounding.Ceil);/' \
  lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol

forge test          # expect FAILURES, not a pass

# restore
cp /tmp/ERC4626.sol.bak lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol
forge test          # expect 32 passed again
```

Measured result: **3 tests fail**, including
`test_RoundingDirectionsMatchTheStandard` with
`previewRedeem floor: 9331000 != 9330999` and
`test_TotalSupplyNeverRedeemableForMoreThanAssetsPlusOneWei` with
`preview disagrees with the formula: 1821000000 != 1820999999`.

Two of those failures are exactly the assertions written for that purpose. That is
the difference between a suite that tests the rounding directions and a suite that
merely mentions them.

---

## Level 3 — stateful invariants

```bash
forge test --match-contract YieldVaultInvariantTest
```

Expected: **1 passed**, with a call table showing roughly 2,300 calls to each of
seven handler functions and **0 reverts**.

Configuration: 256 runs x depth 64, `fail_on_revert = false`. Reverts are expected
here — the fuzzer is supposed to try withdrawing more than it holds — so the
handler asserts its *preconditions* instead of letting them revert. See the
warning below for why that matters.

The nine invariants:

| # | Property |
|---|---|
| INV-1 | Total supply is never redeemable for more than total assets + 1 wei |
| INV-2 | `totalAssets()` always equals the asset balance |
| INV-3 | Assets with no shares outstanding are unclaimable |
| INV-4 | `totalSupply()` equals the net shares the app-facing paths created |
| INV-5 | Actor share balances sum to exactly `totalSupply()` |
| INV-6 | The vault never holds more than the total of all inflows |
| INV-7 | The vault never holds more than the asset's entire supply |
| INV-8 | The net share delta is never negative |
| INV-9 | A new depositor retains at least 99% of their deposit's value |

### Two traps this suite fell into, and what they teach

Both were found by looking at tool output rather than by reading code.

**1. Reverts hide unexecuted code.** The first version of the handler had no
allowance for the vault owner, so all ~2,400 `reportYield` calls reverted. With
`fail_on_revert = false` the fuzzer treats a revert as an uninteresting input, so
the campaign reported all-green while the yield path was **never executed once**.
The fix is that the handler now asserts its preconditions, which fails loudly
instead of reverting quietly. The call table is the diagnostic: a handler function
showing 100% reverts is a function that is not being tested.

**2. An invariant is only as trustworthy as what it measures.** Two earlier
versions of INV-6/INV-7 compared against a snapshot taken at construction and
against ghost counters maintained by the handler. Both produced failures that
were artefacts of the bookkeeping rather than defects in the vault. The surviving
formulations are stated in terms of observable state and need no ledger at all.
If an invariant fails and you cannot explain the number, the invariant is the
thing to suspect.

---

## Level 4 — independent tools

### Static analysis

```bash
slither . --filter-paths "lib/|test/" --exclude-dependencies
```

Measured: **17 contracts, 102 detectors, 0 results.**

Two notes on getting a clean run:

- `solc-select` must find a writable home. Set `VIRTUAL_ENV` to a workspace
  directory, or slither fails on import because it cannot write `~/.solc-select`.
- Foundry's linter and slither disagree about `immutable` naming. Foundry wants
  `SCREAMING_SNAKE_CASE`, slither's `naming-convention` detector wants
  `mixedCase`. The field here is `_decimalOffset`, i.e. slither's preference won,
  because a security tool's output should not need a footnote explaining a false
  positive.

### Property fuzzing with Medusa

```bash
medusa fuzz --config medusa.json \
  --compilation-target "test/YieldVault.invariants.t.sol" --timeout 300
```

Measured: **9 properties PASSED, 0 failed**, approximately 1.1 million calls at
~13,000 calls/second, 70 corpus entries, 0 failures.

Three configuration facts that are not obvious and cost real time to find:

1. **`propertyTestPrefixes` must be set.** Medusa does not know Forge's
   `invariant_` convention. The properties are therefore exposed twice — as
   `invariant_*` for Forge and `property_*` for Medusa — but both call the same
   internal `_holds*` function, so the two tools cannot disagree about what a
   property means.
2. **`property_*` must return `bool`.** A property written with assertions and no
   return value is silently reclassified as an *assertion test*, and Medusa then
   reports success having checked none of your properties. This is a silent
   failure mode; check the test summary for "Property Test" lines.
3. **`--compilation-target` is required.** Without it Medusa passes `.` to
   crytic-compile, which resolves the Foundry framework and compiles only `src/`
   — the test contracts are absent from the artifact and no test is discovered.

Additionally, the test contract must deploy its handler **in the constructor**,
not in `setUp()`: Medusa and Echidna deploy the contract themselves and never call
`setUp()`. A handler built in `setUp()` is the zero address under those tools, so
every property calls into nothing and all of them fail — which looks like a broken
vault rather than a broken harness. A deliberate probe
(`property_HandlerIsDeployed`) was what identified it.

The same `property_*` functions work under Echidna, which is not installed
working in this environment.

---

## What is *not* covered

- **No fork test against real USDC.** The tests use a 6-decimal mock. This is the
  single largest gap: it means the suite proves the vault works with *this* token,
  not with USDC. On-chain USDC has behaved non-standardly before. P2 covers it.
- **Nothing is deployed.** No testnet deployment, no verification, no live
  address. There is no deployment script yet.
- **No external audit or review.** Self-review plus two automated tools.
- **Echidna and Halmos are not part of the evidence.** Echidna cannot start in
  this environment; Halmos was not attempted.
- **`reportYield` cannot be demonstrated by a third party** on testnet, since it
  is `onlyOwner`.
- **No gas optimisation work.** Gas was not measured against any target.
- **INV-9's 99% threshold is a judgement call**, not a derived bound. It is loose
  enough to tolerate dust and tight enough to catch the inflation attack, which
  costs a depositor essentially everything; nothing in between is tested.
