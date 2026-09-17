# Architecture — erc4626-vault

How the pieces fit together, the decisions that would be expensive to reverse,
the maths everything depends on, and the invariants the tests encode.

Written to be checkable: every claim about behaviour can be verified by reading
the named file or running the named command in `TESTING.md`.

---

## 0. Shape of the system

```
                    ┌─────────────────────────────────────────────┐
   anyone ─────────▶│  YieldVault (ERC-4626 + ERC-20)             │
   (block explorer) │  Base Sepolia                               │
                    │                                             │
                    │  inherits OpenZeppelin's ERC4626            │
                    │  (imported, never copied)                   │
                    │                                             │
                    │  self-written: constructor,                 │
                    │    _decimalsOffset, reportYield             │
                    └───────────────┬─────────────────────────────┘
                                    │ holds
                                    ▼
                    ┌─────────────────────────────┐
                    │  the asset (test USDC, 6 dp) │  ← the only external dependency
                    └─────────────────────────────┘
```

**One contract, one external dependency.** No proxy, no strategy, no oracle, no
keeper, no off-chain component, no admin contract.

The trust boundary is a single line: the vault calls `transfer` and
`transferFrom` on the asset. Crossing it means trusting the asset contract to
behave like an ERC-20. It is the only thing outside this repository the vault
depends on.

### 0.1 Components

| Component | Kind | Responsibility | Where | Who can change it |
|---|---|---|---|---|
| `YieldVault` | on-chain contract | Holds the asset, accounts for shares | Base Sepolia | **nobody** — no proxy, no upgrade |
| `MockERC20` | contract, **test only** | Stands in for the asset in tests | never deployed | n/a |
| the asset | external dependency | The token being held | Base Sepolia (already exists) | its issuer, **not us** |

Self-written code is about 30 lines. That is not a shortcoming: implementing the
whole of ERC-4626's MUST requirements in 30 lines, and being able to explain why
no more is needed, demonstrates more judgement than 500 lines of bespoke
accounting.

---

## 1. Security posture

| Question | Answer |
|---|---|
| Where do user funds live? | **In the vault contract.** Not in a multisig, not with an operator, not with us. |
| Who can move funds unilaterally? | **Nobody.** Only `deposit`, `mint`, `withdraw` and `redeem` move assets out, and each pays strictly according to the caller's own share balance or an explicit approval. |
| Who holds upgrade authority? | **There is none.** No proxy, no initializer, no admin slot. |
| Is there an emergency withdrawal function? | **No.** Deliberately not — see §2. |
| Can an admin change a user's balance or shares? | **No.** No function writes `_balances`. |
| Can an admin block withdrawals? | **No.** There is no pause. |
| What is the worst case if the owner key is fully compromised? | The attacker can call `reportYield`, which moves the *owner's own* assets *into* the vault. That is the entire capability. **User loss ceiling: zero.** |

> This is the most valuable property in the project, and it comes from structure
> rather than from careful key management. A vault where the admin's only power is
> to donate is a vault where an admin compromise is not a user-funds event.

### 1.1 Assumptions and their consequences

| Assumption | Consequence if violated | Mitigation |
|---|---|---|
| The asset behaves like an ERC-20 | Accounting could diverge from reality | `SafeERC20` for all transfers, so a token returning `false` reverts instead of being recorded as a success. `totalAssets()` reads the balance, so the vault cannot claim assets it does not hold. |
| The asset does not rebase or take a transfer fee | A rebasing asset would change the share price for everyone without any event | Out of scope: the vault is for standard ERC-20s. A fee-on-transfer asset would be detected by the tests' assertion that a deposit moves exactly `amount` into the vault. |
| An ERC-777-style hook cannot exploit ordering | Reentrancy during a deposit or withdrawal | OpenZeppelin already orders `_transferIn` before `_mint` and `_burn` before `_transferOut` precisely for this. Not re-implemented here. |
| The chain does not reorg away a deposit | A user could keep shares for assets that returned to them | Testnet scope. Production would need a confirmation policy, which belongs to the application, not the vault. |

### 1.2 Single points of failure

| # | Single point | Consequence | Mitigation | Accepted |
|---|---|---|---|---|
| 1 | The asset contract (its issuer can freeze, pause or upgrade) | The vault's holdings could be frozen, so withdrawals would revert | **None possible.** This is the inherent cost of holding someone else's token. Must be stated as a known limitation. | yes (valueless test assets) |
| 2 | Base's sequencer | Transactions could be censored or delayed | None — inherent to an L2 | yes |
| 3 | The owner key | **See above: cannot harm users** | Structural | yes |
| 4 | The deployer address | No residual privilege | Nothing to mitigate | yes |

**The contract layer has no single point of failure.** Both real ones — the asset
issuer and the L2 sequencer — sit outside the contract and are the inherent cost
of "hold a stablecoin on an L2". Being able to say that precisely is more useful
than claiming the system is secure.

### 1.3 What "exit" looks like

- Withdrawal is immediate: no queue, no delay, no cap, no fee.
- If every holder withdrew at once, they would be served one by one and **the
  last one would still be paid** — see INV-1. There is no first-come-first-served
  run.
- There is no state in which funds are locked by the contract: it never lends,
  stakes, or otherwise encumbers the assets, so `totalAssets()` is always
  redeemable by construction.
- The only exit cost is gas, plus rounding of at most a few wei in the vault's
  favour, which is what the standard requires.

---

## 2. Decisions that would be expensive to reverse

| Decision | Chosen | Rejected | Why rejected |
|---|---|---|---|
| **Chain** | Base Sepolia | Ethereum Sepolia, multiple testnets | Base has a real test USDC — ERC-4626 needs an actual ERC-20 to hold — and Base is a live L2 with an active ecosystem. Multiple chains is round two. |
| **Upgradability** | **Not upgradable** | UUPS, Transparent proxy | A proxy adds storage-layout collisions, initializer hijacking and selector clashes. This vault has no strategy and no integrations, so it has no upgrade requirement — and "no upgrade path" means "no upgrade authority", which takes the custody answer to zero. Trading complexity for an unwanted capability is the definition of over-engineering. |
| **Custody** | **Fully non-custodial** | Operator-managed, multisig custody | ERC-4626 is a non-custodial standard. Adding custody turns "owner key compromise is harmless" into "owner key compromise is fatal". |
| **Permission model** | **`Ownable`, for `reportYield` only** | `AccessControl`, multisig + timelock, no permissions at all | One role, so multiple roles would be theatre. A timelock exists to delay dangerous operations, and `reportYield` can only add assets — there is nothing dangerous to delay. Some trusted caller is needed so that arbitrary addresses cannot emit protocol-looking events. |
| **Standard** | **ERC-4626 Final + ERC-20** | Bespoke share accounting | The standard *is* the interface contract. Hand-rolling it would make the vault un-integrable and would discard the verifiable claim "this implementation satisfies every MUST in the EIP". |
| **Yield source** | **Owner reports it** | Aave/Morpho integration, a bespoke strategy | An integration tests a different question and adds protocol risk plus fork-testing cost. |
| **`_decimalsOffset()`** | **`18 - assetDecimals`** (12 for a 6-decimal asset) | 0 (OpenZeppelin default), 1, 3, 6 | 0 makes the inflation attack cheap. A small fixed value such as 3 gives an attack cost of 10³, which is only prohibitive for deposits under roughly one dollar — see §3.3 for the arithmetic. Deriving the offset from the asset gives 10¹² for USDC and makes the protection follow the asset rather than a hardcoded guess, at the cost of shares no longer mirroring the asset's decimals (documented below). |
| **`reportYield` mechanism** | **Transfer real assets in** | Track a virtual `_totalAssets` variable | A virtual variable lets `totalAssets()` exceed the real balance, so redemptions revert — the classic self-inflicted vault bug, and the exact failure INV-2 catches. Transferring assets is its own accounting. |
| **Zero-value reports** | **Rejected** | Allow them | A zero report would emit an event that looks like activity while changing nothing. |
| **Price storage** | Raw fields only; conversions computed on read | Price precomputed at write time | If the conversion turned out to be wrong, raw data can be recomputed. Errors must not be frozen into state. (This applies to the sibling indexer project; here the same principle shows up as "the vault stores shares, not a share price".) |

### 2.1 OpenZeppelin imported, not copied

The vault imports `ERC4626`, `ERC20`, `SafeERC20`, `Ownable`, `IERC20` and
`IERC20Metadata`. It copies none of them. OpenZeppelin's own first guideline is
that library source does not belong inside a business contract, and a
hand-copied `ERC4626` would silently stop receiving upstream fixes.

The only consequence to be aware of is that the vault's behaviour is partly
OpenZeppelin's behaviour, which is why `REQUIREMENTS.md` §0.2 records the
rounding directions **read from source at the pinned tag** rather than
remembered.

### 2.2 Shares are 18 decimals, deliberately deviating from the EIP's advice

ERC-4626 strongly recommends that `decimals()` mirror the asset's. This vault
does not: shares are 18 decimals for every asset.

That is the by-product of choosing the offset as `18 - assetDecimals`. The
recommendation exists so that integrations do not misread magnitudes, and it is
satisfied in spirit here (shares have at least as much precision as the asset,
never less). The benefit is that the offset — which is a security parameter, not a
cosmetic one — scales with the asset automatically.

**This is recorded as a known deviation rather than hidden**, because a reviewer
comparing the vault against the EIP will notice it.

---

## 3. The maths

Everything the vault does reduces to two multiplications and a division.

### 3.1 The conversion identity

With `S = totalSupply()`, `A = totalAssets()`, and `o = _decimalsOffset()`:

```
shares = assets * (S + 10**o) / (A + 1)      rounded down  (deposit, redeem, convertTo*)
assets = shares * (A + 1) / (S + 10**o)      rounded down or up per function
```

The `10**o` and the `1` are *virtual* shares and assets: they are added to the
real figures for the purpose of the division and are never minted or held. Three
consequences follow, and each is load-bearing:

**1. Solvency.** With `S` real shares outstanding, the most they can be redeemed
for is:

```
S * (A + 1) / (S + 10**o)   ≤   S * (A + 1) / S   =   A + 1
```

So total redemptions can never exceed the vault's assets plus one wei. The single
permitted wei is the virtual asset unit, and it is an artefact of the mechanism
rather than a debt. This is INV-1, and it is why the vault can always pay out.

**2. The first depositor is not penalised.** Against an empty vault (`S = 0`,
`A = 0`), `shares = assets * 10**o`. Since shares have `18` decimals and the
offset makes up the difference, a deposit of `x` whole units receives `x * 10**18`
shares — exactly what a naive 1:1 vault would give.

**3. The inflation attack cost is `10**o`.** See §3.3.

### 3.2 Rounding directions

| Function | Direction | Why it is that way |
|---|---|---|
| `previewDeposit` / `deposit` | Floor | Rounding shares down favours the vault, i.e. existing holders |
| `previewRedeem` / `redeem` | Floor | Rounding assets down favours the vault |
| `previewMint` / `mint` | Ceil | Rounding the *cost* up favours the vault |
| `previewWithdraw` / `withdraw` | Ceil | Rounding the *shares burned* up favours the vault |
| `convertToShares` / `convertToAssets` | Floor | EIP-mandated |

**Every direction favours the vault, never the caller.** If any single one were
reversed, a caller could extract value from existing holders by repeating the
operation, which is why INV-2 exists and why the mutation check in `TESTING.md`
level 2 is part of the evidence: reversing one of them does in fact fail the
suite.

### 3.3 The inflation attack and why the offset is sized the way it is

The attack: deposit the minimum (1 wei) to become the only shareholder, then
*donate* a large amount directly to the vault. `totalAssets()` rises with no
shares minted, so the share price inflates. The next depositor's share count
rounds down — potentially to zero — and the attacker, holding the only shares,
owns both the donation and the victim's deposit.

With the offset in place, a victim depositing `a` against a manipulated state of
`S = 1`, `A = d` (the donation) receives:

```
shares = a * (1 + 10**o) / (d + 1)
```

For that to round to zero, `d` must be on the order of `a * 10**o`. So the
attacker must risk roughly `10**o` times what they hope to steal, and the stolen
amount is bounded by the victim's deposit. With `o = 12` (a 6-decimal asset),
attacker cost exceeds attainable gain by a factor of 10¹² — the attack is not
merely unprofitable but absurd.

With `o = 0` the same attack costs roughly what it steals, and it works. **Both
halves of that claim are executed as tests**, not asserted: one test performs the
attack against the offset vault and checks the victim keeps their value; another
performs it against a zero-offset vault and checks the victim is wiped out. The
difference between the two runs is the protection, which is the only way to show
that the parameter is load-bearing rather than decorative.

### 3.4 Where the vault reads the asset's decimals

`_decimalsOffset()` returns a value cached in an `immutable` at construction:

```solidity
uint8 assetDecimals = IERC20Metadata(address(asset_)).decimals();
if (assetDecimals > SHARE_DECIMALS) revert AssetDecimalsTooHigh(assetDecimals);
_decimalOffset = SHARE_DECIMALS - assetDecimals;
```

Doing it once at construction rather than inside the view path matters: `decimals()`
is called by every integration and every preview, and a version that read the
asset each time would make a hot path depend on an external call. It would also be
vulnerable to a token that changes its `decimals()` after deployment.

---

## 4. Invariants the tests encode

"The tests pass" is not evidence. "These properties hold across 16,000 random
call sequences" is. All nine are checked by Forge's stateful fuzzer and again by
Medusa; `TESTING.md` gives the commands and the measured numbers.

| # | Invariant | Why it matters |
|---|---|---|
| INV-1 | Total supply is never redeemable for more than total assets + 1 wei | This is solvency. If it fails, the last withdrawer cannot be paid — the failure that only appears at the end of a queue. |
| INV-2 | `totalAssets()` always equals `asset.balanceOf(address(this))` | The vault must never report a number it cannot pay. A ledger-based implementation drifts here. |
| INV-3 | Assets with zero shares outstanding are unclaimable | Documents that "assets but no shares" is a legitimate state (direct donations), and that such assets belong to nobody until someone deposits. |
| INV-4 | `totalSupply()` equals the net shares the app-facing paths created | If any path mints or burns outside deposit/mint/withdraw/redeem, supply and the external record diverge. |
| INV-5 | Actor share balances sum to exactly `totalSupply()` | Catches shares minted to an address the accounting does not know about. |
| INV-6 | The vault never holds more than the total of all inflows | A violation means value was created. |
| INV-7 | The vault never holds more than the asset's entire supply | Same idea, in a form that needs no bookkeeping at all. |
| INV-8 | The net share delta is never negative | `reportYield` must mint nothing, so shares cannot be destroyed without a matching burn. |
| INV-9 | A new depositor retains ≥ 99% of their deposit's value | The anti-inflation property, stated directly. |

### 4.1 A note on how INV-6 and INV-7 are written

Two earlier formulations compared against a snapshot taken at construction and
against counters maintained by the test handler. Both produced failures that were
artefacts of the test's own bookkeeping rather than defects in the vault.

The survivors are stated in terms of observable state and need no ledger: the
vault's balance against the asset's total supply, and the vault's balance against
the sum of recorded inflows. **An invariant is only as trustworthy as the thing it
is measured against**, and if a property fails with a number you cannot explain,
the property is the first suspect.

---

## 5. Failure modes

| # | Scenario | Trigger | Behaviour | User loss | Plan |
|---|---|---|---|---|---|
| 1 | Any admin action against users | — | **Structurally impossible**: the only owner function adds assets | none | §1 |
| 2 | Owner key compromised | Key leak | Attacker can send the vault money and nothing else | **none** | structural |
| 3 | The asset is frozen by its issuer | Regulatory action or incident | The vault cannot transfer out, so withdrawals revert | up to 100% (theoretical) | **no mitigation**, stated as a known limitation |
| 4 | Rounding direction implemented wrongly | Implementation error | A caller could extract value repeatedly | the vault drains | INV-1/INV-2/INV-9 plus the mutation check |
| 5 | Inflation attack on a primed vault | Attacker donates to skew the share price | Later depositors are diluted | the later depositor's deposit | offset of `18 - assetDecimals`; INV-9; both attack tests |
| 6 | Share price manipulated by a direct donation | Anyone transfers the asset in | Share price rises for all holders | none — it is a gift | INV-2 (donations raise `totalAssets`, which is the balance) |
| 7 | Malicious asset reenters through an ERC-777 hook | Hooked asset | Ordering matters | potentially inconsistent state | rely on OpenZeppelin's ordering (`_transferIn` before `_mint`); noted in `REQUIREMENTS.md` §0.2 |
| 8 | Non-standard asset silently returns `false` | Old-style ERC-20 | A failed transfer would look like a success | accounting diverges from reality | `SafeERC20` reverts instead |
| 9 | Asset rebases or charges a transfer fee | Non-standard asset | Share price moves without an event | unclear | out of scope; the tests assert exact transfer amounts, so such an asset would fail the suite |
| 10 | Chain congestion | Base congestion | Slower and more expensive transactions | time only | none needed |
| 11 | Upgrade goes wrong | **Not applicable** — there is no upgrade | — | none | — |
| 12 | Oracle failure or manipulation | **Not applicable** — there is no oracle | — | none | — |

---

## 6. Anti-over-engineering check

**Contract count: one**, plus one test-only mock. ERC-4626 is a single-contract
standard, and any split would exist to serve a future that is not planned.

**Abstractions deliberately left out:**

- ❌ an `IStrategy` interface — there is no strategy
- ❌ an oracle adapter — there is no price
- ❌ a proxy or upgrade framework — no upgrade requirement
- ❌ an access-control matrix — one role
- ❌ a pause mechanism — would be a privilege that can affect users
- ❌ a fee module — would be a claim on user yield, needing its own reasoning

**Reuse over invention:** `ERC4626`, `ERC20`, `SafeERC20`, `Ownable`, `IERC20`,
`IERC20Metadata` and `mulDiv` are all imported from OpenZeppelin. Nothing is
copied.

**The self-written surface** is the constructor, `_decimalsOffset`, `reportYield`,
one event, two custom errors, and one constant — **28 non-comment lines** in a
147-line file whose remainder is NatSpec. Everything else is inherited.

> The reverse test: a vault with fifteen modules, a strategy abstraction and
> upgradeability is the problem. It would show that the author could not tell
> "demonstrating capability" from "accumulating technology".

---

## 7. Deployment plan (B + C), and why the numbers are what they are

This section was written before the deployment, and the plan below is the one that was executed:
the vault is live on Base Sepolia, and `deployments/base-sepolia.json` records it. What follows is
the plan and the measurements behind its parameters, because those parameters were initially wrong
in a way that is worth documenting.

### 7.1 The constraint

No free hosting tier will run a long-lived process — Render sleeps a web service
after 15 idle minutes, Railway's free credit is about $1/month, Koyeb gives
0.1 vCPU. So the indexer **cannot be a resident process**; it has to be scheduled.
That is a constraint, not a preference, and the design follows from it:

- **B**: the API performs a bounded catch-up on startup, because the container
  filesystem is rebuilt on every wake.
- **C**: a GitHub Actions cron indexes new blocks and commits an updated SQLite
  snapshot into the repository. Actions is free for public repositories.

The vault already supports this: it is deployed once and emits events forever, so
a checkpointed indexer can resume cheaply.

### 7.2 The parameters, and the mistake that produced them

Base produces a block every **2.000 seconds** (measured from 11,223 blocks of real
`timestamp` data). So:

| Interval | Blocks |
|---|---|
| 30 minutes | **900** |
| 15 minutes | 450 |
| 5 minutes | 150 |

The first version of this plan used a **30-minute cron** with
`MAX_CATCHUP_BLOCKS=300` and `MAX_CATCHUP_SECONDS=8`. Those three numbers are
individually reasonable and jointly impossible: the catch-up bound covers 10
minutes of blocks, so it can never close a 30-minute gap, and every catch-up would
time out. The deployment would have been, in effect, a snapshot that was always
up to 30 minutes stale — with catch-up present in the code and never working.

Corrected: **5-minute cron** (150 blocks), `MAX_CATCHUP_BLOCKS=300` (a 2× margin),
`MAX_CATCHUP_SECONDS=20`.

The lesson is not "use 5 minutes". It is that **two timer parameters can each look
sane and be jointly broken**, and the only way to see it is to put the numbers
side by side and convert between units.

#### 7.2.1 The same mistake again, in the other direction, found by a real run

The correction above fixed the *block* bound and left the *time* bound broken: the
indexer converted `MAX_CATCHUP_SECONDS` into blocks using the **chain's** block time
(2.000 s), so a 20-second budget meant **9 blocks** — against the 150 a cron interval
produces. Every scheduled run would have indexed 9 blocks, reported `TRUNCATED`, and
looked successful, while the snapshot fell behind by ~141 blocks every 5 minutes and
by ~40,000 blocks a day.

Measured, not deduced. With the workflow's own values
(`MAX_CATCHUP_BLOCKS=300`, `MAX_CATCHUP_SECONDS=20`) against `sepolia.base.org`:

```
scanned   9 block(s)  46919860..46919868
chain     head 46919918
elapsed   1767ms
TRUNCATED a bound stopped this run before the head; the next run continues
```

The head had advanced 58 blocks during the 90 seconds before that run, and 9 were
indexed. The first correction checked one parameter against the cron interval; this
one survived because the second parameter was compared with the chain's clock rather
than with the indexer's own throughput.

Corrected: the budget is converted at the **measured scan rate of the indexer**
(`web3-development-execute/projects/erc4626-vault-dapp/src/indexer/bounds.ts`, with the
conversion unit-tested), and `MAX_CATCHUP_SECONDS` is **one cron interval (300 s)** so
it cannot become the binding constraint again. Re-measured with the same workflow
values and a real 111-block gap: 111 blocks scanned, caught up, no truncation.

The lesson this time is sharper: **a budget in seconds is only meaningful with the unit
it is converted by.** "20 seconds" was right as wall clock and wrong as chain time, and
nothing in either number said which one the code used.

### 7.3 What a catch-up actually costs (measured)

Public Base RPC endpoints are not interchangeable:

| Endpoint | `eth_getLogs` (300 blocks) | Block-timestamp batch | Per-block fallback |
|---|---|---|---|
| `base-rpc.publicnode.com` | 205 ms | **437 ms** | 177 ms/call |
| `mainnet.base.org` | 406 ms | **not supported** | 317 ms/call |
| `base.drpc.org` | refuses the range | — | — |

And historical ranges are a separate capability: against a window ~11,000 blocks
behind the head, `publicnode` answers `-32602 Archive requests require a personal
token`, `drpc` refuses ranges over 10,000 blocks, and only `mainnet.base.org`
served it.

Two conclusions:

1. The timestamp batch is the path that dominates a large backfill, and
   `publicnode` is both the fastest at it and the only endpoint that supports it —
   so it stays first.
2. A catch-up of 300 blocks costs roughly **0.65 s** end to end (205 ms of logs
   plus 437 ms of batched timestamps), or about 12.5 s on the per-block fallback.
   `MAX_CATCHUP_SECONDS=20` therefore has ample margin on both paths.

**That second conclusion does not hold for the endpoint the cron actually uses.** Every
row in the table above is a **Base mainnet** endpoint, and section 7.2.1's parameter was
set from the 0.65 s figure as if it transferred. It does not: the scheduled indexer runs
against **`sepolia.base.org`**, where the same work measured **111 blocks in 23,069 ms** —
about **4.8 blocks/s**, or ~65 s for 300 blocks, roughly 100× the 0.65 s the table
suggests. The same endpoint gave 29 blocks in 1,958 ms for a smaller range, so the rate
also falls as the range grows.

A cost measured on one endpoint is not a budget for another. The measured Sepolia rate is
now the default the budget is converted with (rounded down to 4 blocks/s), and the
per-endpoint measurement belongs in this table rather than in an extrapolation:

| Endpoint | Range | Measured |
|---|---|---|
| `sepolia.base.org` (Base Sepolia, the cron's endpoint) | 111 blocks | 23,069 ms → **4.8 blocks/s** |
| `sepolia.base.org` (Base Sepolia) | 29 blocks | 1,958 ms → 14.8 blocks/s |
| `base-rpc.publicnode.com` (Base mainnet) | 300 blocks | 205 ms + 437 ms → 0.65 s |

### 7.4 What the README must say once deployed

- Data lags by up to ~10 minutes (cron interval plus scheduler delay).
- The first request after a sleep may take 30–60 seconds.
- **What production would do instead**: a long-lived indexer or a managed
  pipeline writing to Postgres. The indexer is already written for that model —
  it checkpoints, resumes, is idempotent, and rolls back reorganisations. Only the
  hosting differs.

These statements must match what `/api/health` actually reports. A README that
claims a 10-minute lag while the API reports a growing `snapshotAge` is worse than
no claim at all.

---

## 8. Where this is known to be incomplete

- **The source is not verified.** The vault *is* deployed on Base Sepolia —
  `0x7941438ee07bea4469ccd4bec583e9fb24037f35`, tx `0x91cf6315…` in block 46,919,125, and a
  `script/Deploy.s.sol` that deploys and then checks what it deployed — but nothing has been
  submitted to Sourcify, so the link between the deployed bytecode and `src/YieldVault.sol` is
  reproducible by a reader rather than published.
- **No fork test against real USDC.** The suite uses a 6-decimal mock, so it
  proves the vault works with *this* token rather than with USDC. This is the
  largest gap in the evidence.
- **No external audit or review.**
- **Echidna and Halmos are not part of the evidence.** Echidna cannot start in
  this environment; Halmos was not attempted.
- **`reportYield` has no third-party demonstration path**, being `onlyOwner`.
  A reviewer can read it, not exercise it.
- **INV-9's 99% threshold is a judgement**, not a derived bound.
- **The deviation from the EIP's decimals advice** is a conscious trade recorded
  in §2.2 rather than an oversight, but it is still a deviation and an integrator
  should know.
