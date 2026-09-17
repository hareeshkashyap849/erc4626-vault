# Testing — erc4626-vault

How to reproduce every claim in the README, in six levels, and an explicit list
of what is **not** covered.

The point of listing the gaps is that a testing document claiming completeness is
not useful. Everything except level 5 runs with no network access and no API
keys.

---

## Prerequisites

Foundry, and the workspace toolchain on `PATH`. From a clean checkout:

```bash
forge build          # compiles with the pinned solc; needs no network
forge test
```

Expected: **46 passed, 0 failed, 12 skipped**. The skipped ones are the fork
tests, which need an RPC endpoint; see level 5.

`foundry.toml` sets `solc` to an absolute path inside this workspace's toolchain
because `solc-select` is broken in this environment (its Python module is
missing) and letting forge download a compiler would make the build depend on
network access. If you are elsewhere, change that one line to a version string
such as `"0.8.37"`.

---

## Level 1 — unit and fuzz tests (32)

```bash
forge test --match-contract YieldVaultTest
```

The tests check arithmetic against an independent restatement of OpenZeppelin's
conversion formula (`_expectedShares` / `_expectedAssets` and their ceil
variants) rather than against the vault's own output. A test that asks the
contract for an answer and then asserts the contract gave that answer proves
nothing; these recompute the value and compare.

| Area | What is checked |
|---|---|
| Decimal handling | 18 decimals for 6- and 18-decimal assets; construction reverts above 18 |
| First deposit | receives `assets * 10**offset` shares, so the offset costs the first depositor nothing |
| Rounding directions | all four previews and both conversions against independent floor/ceil implementations |
| Ceil ≥ floor | 25 samples, including values that do not divide evenly |
| preview == executed | four pairs (deposit / mint / withdraw / redeem) |
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

```bash
forge test --match-test test_InflationAttackFailsToStealTheNextDepositorsValue -vvv
```

---

## Level 2 — the tests have teeth (mutation check)

A suite that passes is only evidence if it can fail. This deliberately breaks the
library and confirms the suite notices.

```bash
cp lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol /tmp/ERC4626.sol.bak

# reverse one rounding direction: convertToAssets Floor -> Ceil
sed -i 's/return _convertToAssets(shares, Math.Rounding.Floor);/return _convertToAssets(shares, Math.Rounding.Ceil);/' \
  lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol

forge test          # expect FAILURES, not a pass

cp /tmp/ERC4626.sol.bak lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol
forge test          # expect 46 passed again
```

Measured: **3 tests fail**, including `test_RoundingDirectionsMatchTheStandard`
with `previewRedeem floor: 9331000 != 9330999` and
`test_TotalSupplyNeverRedeemableForMoreThanAssetsPlusOneWei` with
`preview disagrees with the formula: 1821000000 != 1820999999`.

Two of those failures are exactly the assertions written for that purpose. That is
the difference between a suite that tests the rounding directions and a suite that
merely mentions them.

---

## Level 3 — stateful invariants (9)

```bash
forge test --match-contract YieldVaultInvariantTest
```

Expected: **1 passed**, with a call table showing roughly 2,300 calls to each of
seven handler functions and **0 reverts**.

Configuration: 256 runs x depth 64, `fail_on_revert = false`. Reverts are expected
here — the fuzzer is supposed to try withdrawing more than it holds — so the
handler asserts its *preconditions* instead of letting them revert. See below for
why that distinction matters.

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

Both were found by reading tool output rather than by reading code.

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

## Level 4 — the deployment script (13)

```bash
forge test --match-contract DeployValidationTest
```

A deployment script that has only ever been run by hand is untested code with a
convincing appearance, and its failures are the quiet kind. A vault deployed
against an 18-decimal asset instead of a 6-decimal one deploys successfully, has
the right owner, reports `decimals() == 18` as documented, and looks entirely
healthy on a block explorer — while `_decimalsOffset()` is 0 instead of 12, so
the inflation-attack cost is silently reduced by a factor of 10¹².

The checks therefore live in `src/DeployValidation.sol` as functions over
primitives, so they can be unit-tested. Inline `require` statements in
`Script.run()` cannot be: reaching them means deploying a contract, and
`vm.startBroadcast` inside a test is a dry run.

Two facts worth recording about writing those tests:

- **A library function must be `public`, not `internal`, to be tested with
  `vm.expectRevert`.** An `internal` library function is inlined into its caller,
  so its revert happens at the same call depth as the cheatcode and Foundry
  reports `call didn't revert at a lower depth than cheatcode call depth`. The
  visibility here is a testability requirement, not a style choice.
- **The script has been executed for real** — against a local `anvil` chain, and then against Base
  Sepolia with a funded key on 2026-09-17. The public deployment is recorded in
  `deployments/base-sepolia.json`; the local runs are what proved the checks fire before any real
  ETH was at stake.

### Running the script locally

```bash
anvil &
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # anvil key 0
forge script script/DeployTestAsset.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
export ASSET_ADDRESS=<the address it printed>
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

---

## Level 5 — the real USDC contract (12)

```bash
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
  forge test --match-contract YieldVaultForkTest
```

Expected: **12 passed**. Takes about two minutes, almost all of it network.

Every other test here uses `MockERC20`, which this repository also wrote. Passing
those proves the vault works with *our idea of* an ERC-20, not with USDC — and
USDC is not a plain ERC-20: it is a proxy in front of an upgradeable
implementation with its own behaviour. **A mock cannot disagree with the code that
tests it.**

This forks **Ethereum mainnet** and moves **real USDC**. With no fork URL
configured, all twelve skip, so the rest of the suite still works offline.

Covered: the real token's metadata; the vault built on the real token reporting
18-decimal shares; that funding genuinely moves the balance; the first deposit;
all six rounding directions; preview matching execution; solvency; the last
withdrawer paid in full; a fuzzed no-free-lunch property; the inflation attack
with a **real** donation and the payout verified in real tokens; the offset
derived from the real token; and `reportYield` moving real tokens.

### Three things that went wrong here, because the mistakes are the useful part

**1. A mock that lies about a transfer is worse than no test.** The first version
forked Base Sepolia and used `vm.mockCall` to fake `transferFrom` returning
`true`. It returned `true` *without moving any balance*, so the vault minted
shares against assets it never received and the share arithmetic came out wrong.
The failure looked like a vault bug; it was the test manufacturing confidence.
`vm.deal` on Base Sepolia's USDC would carry the same defect less obviously — it
rewrites a balance slot directly, bypassing the token logic the test exists to
exercise.

**2. Fork mainnet, not the testnet, when the point is the token.** Mainnet USDC is
reachable, and on a fork `vm.deal` funds an account with the real token in a way
`balanceOf` actually reports. That also answers a question Base Sepolia could not:
how the vault behaves against the implementation holding real money. It does
**not** test anything about Base Sepolia — USDC is the same implementation with
the same 6 decimals on both chains.

**3. The under-funded attacker, again.** `deal(USDC, attacker, 10_000e6)` then
`deposit(1)` then `transfer(10_000e6)` fails on the token's own balance check, one
wei short. The same mistake had already been made in the unit suite. The fix is
`deal(USDC, attacker, donation + 1)`. A test that fails on arithmetic it controls
wastes a debugging session on itself.

---

## Level 6 — independent tools

### Static analysis

```bash
slither . --filter-paths "lib/|test/" --exclude-dependencies
```

Measured: **18 contracts, 102 detectors, 0 results.**

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

Measured: **9 properties PASSED, 0 failed**, on the order of a million calls.

Four configuration facts that are not obvious and cost real time to find:

1. **`propertyTestPrefixes` must be set.** Medusa does not know Forge's
   `invariant_` convention. The properties are exposed twice — `invariant_*` for
   Forge and `property_*` for Medusa — but both call the same internal `_holds*`
   function, so the two tools cannot disagree about what a property means.
2. **`property_*` must return `bool`.** A property written with assertions and no
   return value is silently reclassified as an *assertion test*, and Medusa then
   reports success having checked none of your properties. Check the summary for
   "Property Test" lines.
3. **`--compilation-target` is required.** Without it Medusa passes `.` to
   crytic-compile, which resolves the Foundry framework and compiles only `src/`,
   leaving no test contracts in the artifact.
4. **The test contract must deploy its handler in the CONSTRUCTOR**, not in
   `setUp()`. Medusa and Echidna deploy the contract themselves and never call
   `setUp()`, so a handler built there is the zero address, every property calls
   into nothing, and all of them fail — which looks like a broken vault rather
   than a broken harness. A deliberate probe (`property_HandlerIsDeployed`) was
   what identified it.

The same `property_*` functions work under Echidna, which is not installed working
in this environment.

---

## What is *not* covered

- **No Sourcify verification.** The vault *is* deployed on Base Sepolia — live address, transaction
  and block in `deployments/base-sepolia.json`, funded with 21 USDC of test assets — but the source
  is not verified anywhere: that record has no `verifiedAt`, so a reader who wants to know that the
  deployed bytecode is this source has to recompile it. Every measurement in this file was taken on
  a local `anvil` chain or on a mainnet fork; the Base Sepolia facts that *are* machine-checked are
  checked by `scripts/check-deployment-record.mjs --rpc https://sepolia.base.org`.
- **No external audit or review.** Self-review plus two automated tools.
- **Echidna and Halmos are not part of the evidence.** Echidna cannot start in
  this environment; Halmos was not attempted.
- **The fork test says nothing about Base Sepolia.** It forks mainnet, because
  that is where the real USDC implementation lives. The vault is deployed on Base
  Sepolia, and the two chains share the USDC implementation — but that is an
  assumption rather than something asserted here.
- **`reportYield` cannot be demonstrated by a third party** on testnet, since it
  is `onlyOwner`.
- **No gas optimisation work.** Gas was not measured against any target.
- **INV-9's 99% threshold is a judgement call**, not a derived bound. It is loose
  enough to tolerate dust and tight enough to catch the inflation attack, which
  costs a depositor essentially everything; nothing in between is tested.
