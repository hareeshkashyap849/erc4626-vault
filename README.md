# YieldVault

An ERC-4626 tokenised vault on Base Sepolia. Anyone can deposit a single ERC-20
asset and receive shares; the owner can contribute yield by transferring real
assets in, which raises the value of every share. Withdrawals are immediate, with
no queue, no cap, and no fee.

**Chain:** Base Sepolia (84532) · **Access:** non-custodial, no admin power over
user funds · **Self-written logic:** ~30 lines

```bash
forge build
forge test          # 32 unit tests + 9 invariants
```

Requires [Foundry](https://getfoundry.sh/). No network access is needed: the two
dependencies are vendored under `lib/`, and `foundry.toml` pins a compiler path.

---

## What this actually is

A minimal, correct implementation of ERC-4626 whose value is not the feature set
but the evidence around it: invariant tests that a mutation can break, a static
analysis report, and a written record of what was measured rather than assumed.

- `src/YieldVault.sol` — the whole contract
- `test/YieldVault.t.sol` — 32 unit and fuzz tests
- `test/YieldVault.invariants.t.sol` — the stateful handler and 9 invariants
- `REQUIREMENTS.md` — scope, acceptance criteria, and where it deviates from plan
- `ARCHITECTURE.md` — decisions with their rejected alternatives, the maths, and
  the invariants
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

```
forge test                    32 unit tests, 9 invariants — all pass
forge test --match-contract YieldVaultInvariantTest
                              256 runs x depth 64, 16,384 calls, 0 reverts
slither .                     102 detectors, 17 contracts, 0 results
medusa fuzz                   9 properties, ~1.1M calls, 0 failures
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

### What is not verified

- **Not deployed anywhere.** There is no live address and no verified contract.
  Saying otherwise would be a lie.
- **No test against the real USDC contract.** The tests use a 6-decimal mock.
  Running the same assertions against Base Sepolia's actual USDC via a fork is
  P2 and has not been done.
- **No external audit.** Self-reviewed plus two automated tools.
- **Echidna and Halmos were not run.** Echidna is installed but cannot start in
  this environment (certificate-store access); Halmos was not attempted.
- **The `reportYield` path cannot be exercised by a stranger.** It is
  `onlyOwner`, so on testnet only the deployer can demonstrate it.

---

## Layout

```
src/YieldVault.sol              the contract
test/MockERC20.sol              a 6-decimal ERC-20 test double
test/YieldVault.t.sol           32 unit and fuzz tests
test/YieldVault.invariants.t.sol  stateful handler + 9 invariants
deployments/                    deployment records — see its README
lib/forge-std                   vendored, v1.16.2
lib/openzeppelin-contracts      vendored, v5.7.0
foundry.toml                    build and fuzz configuration
medusa.json                     property-fuzzing configuration
```

`lib/` is committed rather than used as a git submodule so that the build works
with no network access. To switch to submodules, delete `lib/` and install
`foundry-rs/forge-std@v1.16.2` and `OpenZeppelin/openzeppelin-contracts@v5.7.0`.

---

## Related repositories

This repository is the **contract only**: Solidity, its tests, and the deployment
records. One language, and one command to verify it.

| Repository | Contains |
|---|---|
| **`erc4626-vault`** (this one) | The contract, its tests, the deployment script, and `deployments/` |
| `erc4626-vault-dapp` | The TypeScript application: wallet dApp, event indexer, SQLite database, query API |

The split is by **language and deployment surface**, not by "contract vs front
end". The vault is deployed once and is then immutable, so this repository stops
changing after P2 while the application keeps being developed. That is what makes
"the code you are reading is the code on chain" a checkable statement rather than
a claim: the address, the start block and the source commit are published in
`deployments/` for the other repository to consume.

---

## Roadmap

| Phase | Content | Repository |
|---|---|---|
| P1 ✅ | Contract, unit tests, invariants, static analysis, two fuzzers | this one |
| P2 | Deploy to Base Sepolia, verify on Sourcify, fork test against real USDC, record the deployment | this one |
| P3 | Wallet dApp: connect, deposit, withdraw, approve, and the five failure classes handled honestly | `erc4626-vault-dapp` |
| P4 | Event indexer, SQLite snapshot, query API, scheduled refresh | `erc4626-vault-dapp` |

Only P1 is complete. Nothing is deployed, and the test suite uses a mock asset
rather than real USDC — both stated in `TESTING.md` rather than left to be
discovered.

---

## Licence

MIT
