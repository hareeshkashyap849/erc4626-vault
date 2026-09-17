# Requirements — erc4626-vault

What this project is supposed to do, how each requirement is judged, and what it
deliberately does not do.

Every acceptance criterion is written so it can be checked by running something.
Where a requirement was later found to be unrealistic or was superseded, that is
recorded in §5 rather than quietly dropped.

---

## 0. Verified facts this project is built on

All measured against the chain, not copied from documentation. Checked
2026-09-15.

| Fact | Value | How it was checked |
|---|---|---|
| ERC-4626 status | **Final** (Standards Track: ERC) | [eips.ethereum.org/EIPS/eip-4626](https://eips.ethereum.org/EIPS/eip-4626) |
| ERC-4626 created | 2021-12-22 | same |
| ERC-4626 requires | EIP-20; EIP-2612 is **optional** (the header lists it under `Requires`, the body makes it a MAY) — see the correction below | `eips.ethereum.org/EIPS/eip-4626` **body**, not its header; corroborated against the deployed contract |
| Interface size | 12 methods: `asset`, `totalAssets`, `convertToShares`, `convertToAssets`, 4 × `max*`, 4 × `preview*`, `deposit`, `mint`, `withdraw`, `redeem` | same |
| Events | `Deposit(sender, owner)` and `Withdraw(sender, receiver, owner)`, all indexed | same |
| Test asset | Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `eth_getCode` returns 1798 bytes, so it is a contract |
| Test asset metadata | `symbol()` → `"USDC"`, `decimals()` → `6` | RPC `eth_call` |
| OpenZeppelin version | **v5.7.0** (2026-07-29) | GitHub releases API; source read at that tag |
| forge-std version | **v1.16.2** (2026-06-30) | GitHub releases API |

### 0.1 The EIP-2612 row above was wrong, and here is what is true

The table above previously read `ERC-4626 requires | EIP-20 and EIP-2612`. **That was wrong**, and it
was wrong in the direction that matters: "requires" would make a missing `permit` a conformance
failure, when in fact `YieldVault` is a conforming ERC-4626 vault without one. The row is corrected
rather than deleted, and the reason is recorded here.

Two sources, and they disagree with each other:

| Source | What it says |
|---|---|
| the EIP's **header metadata** | `Requires: EIP-20, EIP-2612` — which is where the wrong row came from |
| the EIP's **body** | *"EIP-4626 tokenized Vaults **MAY** implement EIP-2612 to improve the UX of approving shares on various integrations"* — a permission, not a requirement |

The body wins, and it can be checked rather than argued about: the specification the same document
gives is **12 methods** (`asset`, `totalAssets`, `convertToShares`, `convertToAssets`, 4 × `max*`,
4 × `preview*`, `deposit`, `mint`, `withdraw`, `redeem`), and **none of them is `permit`**. A
`Requires` line cannot oblige a contract to implement something the standard's own interface does
not name.

**Corroboration from the deployment.** `cast selectors` over the deployed runtime bytecode at
`0x7941438ee07bea4469ccd4bec583e9fb24037f35` returns **29 selectors** — the 12 ERC-4626 methods,
the ERC-20 surface on shares, `own*`/ownership transfer, and `reportYield`. There is **no `permit`,
no `nonces`, no `DOMAIN_SEPARATOR` and no `*WithAuthorization`** among them. The deployed contract
therefore behaves as the body says it may, and no reader of this document should expect a signature
path on this vault.

**What this does not change.** `D1`–`D11` are unaffected; `F1` ("Implement ERC-4626 in full") was
always scoped to the 12-method interface and is still met. The only thing that was ever wrong was the
strength of the word "requires".

### 0.2 The rounding directions, read from source rather than remembered

An earlier note in this project claimed "OpenZeppelin's `convertToAssets` rounds
up". **That was wrong**, and it would have produced tests asserting the opposite
of the standard. The values below were read from
`contracts/token/ERC20/extensions/ERC4626.sol` at tag `v5.7.0`:

| Function | Rounding |
|---|---|
| `convertToShares` | Floor |
| `convertToAssets` | Floor |
| `previewDeposit` | Floor |
| `previewRedeem` | Floor |
| `previewMint` | **Ceil** |
| `previewWithdraw` | **Ceil** |
| `maxWithdraw` | `previewRedeem(maxRedeem(owner))` |
| `maxRedeem` | `balanceOf(owner)` |
| `maxDeposit` / `maxMint` | `type(uint256).max` |

The single source of all of it (v5.7.0, where `_decimalsOffset()` defaults to 0):

```solidity
_convertToShares: assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), totalAssets() + 1, rounding)
_convertToAssets: shares.mulDiv(totalAssets() + 1, totalSupply() + 10 ** _decimalsOffset(), rounding)
```

Two consequences that shape the design:

1. **Both conversions round down**, matching the EIP's requirement that they
   "MUST both always round down".
2. The `+ 1` and the `10 ** _decimalsOffset()` term are the virtual assets and
   virtual shares that mitigate the inflation attack. They are not incidental, and
   the offset is a security parameter — see `ARCHITECTURE.md`.

Also read from source at that tag: `_deposit` calls `_transferIn` **before**
`_mint`, deliberately, so that an ERC-777-style token hook reenters before assets
move. That ordering is a correctness requirement, not a style choice.

And one fact found only by reading v5.7.0 rather than trusting the note:
`ERC4626`'s constructor calls `SafeERC20.tryGetDecimals(asset_)` and **falls back
to 18 if the asset does not report decimals**. For a 6-decimal asset whose
`decimals()` call somehow failed, that would silently change the vault's share
precision from 21 to 18. `YieldVault` reads the decimals itself and reverts if the
asset reports more than 18, so the vault cannot be constructed into a state where
its offset silently weakened the inflation protection.

---

## 1. Functional requirements

### 1.1 The vault

| # | Requirement | Acceptance criterion | Status |
|---|---|---|---|
| F1 | Implement ERC-4626 in full | All 12 interface methods present and callable; a call to any of them returns a value of the documented kind | Met |
| F2 | Be an ERC-20 for shares | `balanceOf`, `transfer`, `approve`, `transferFrom`, `allowance` behave per EIP-20; a transferred share carries an unchanged claim | Met |
| F3 | Accept a single ERC-20 asset | The asset address is fixed at construction and can never change | Met |
| F4 | Hold no bookkeeping total | `totalAssets()` equals `asset.balanceOf(address(this))` at all times, including after a direct donation | Met |
| F5 | Let the owner add yield | `reportYield(amount)` transfers `amount` from the owner into the vault and mints nothing | Met |
| F6 | Reject a zero-value yield report | `reportYield(0)` reverts with `YieldAmountZero`, so no event is emitted that looks like activity while changing nothing | Met |
| F7 | Be non-custodial | The only functions that move assets out are `withdraw` and `redeem`, and each pays strictly according to the caller's own share balance or an approval | Met |
| F8 | Have no authority that can affect users | No pause, no blacklist, no upgrade, no way to change a balance. Verified by reading the contract: it has exactly one owner-gated function | Met |
| F9 | Work for assets of any decimals ≤ 18 | Shares are 18 decimals regardless; construction reverts above 18 rather than silently weakening protection | Met |
| F10 | Survive the inflation attack | A new depositor keeps ≥ 99% of their deposit's value when the vault has been primed with a 1 wei deposit and a large donation | Met (INV-9) |

### 1.2 Non-goals for the contract

| # | Not doing | Why |
|---|---|---|
| N1 | Upgradability (any proxy) | A vault with no strategy has no upgrade requirement, and "no upgrade path" means "no upgrade authority". Adds an entire vulnerability class for a capability that is not wanted. |
| N2 | Integrating a yield protocol (Aave, Morpho, …) | Round one is about whether the vault itself conforms. An integration tests a different question and adds protocol risk plus fork-test cost. |
| N3 | A strategy abstraction layer | There is no strategy. An `IStrategy` interface would exist only for a future that is not planned. |
| N4 | `pause` / emergency withdrawal | Each is a privilege that can affect users. Their absence is why the custody answer is "nobody". |
| N5 | Blacklist / allowlist | Same reasoning. |
| N6 | Multiple assets | ERC-4626 is a single-asset standard. |
| N7 | Fees, performance or management | A fee is a claim on user yield and needs its own reasoning; it is not needed to demonstrate the standard. |
| N8 | Rebalancing or an oracle | Nothing to rebalance, no price needed. |
| N9 | Upgrading to a newer OpenZeppelin by copying its source in | OpenZeppelin's first rule is not to copy library source into business contracts. It is imported. |

---

## 2. Non-functional requirements

| Item | Requirement | How it is judged |
|---|---|---|
| Language | Solidity ≥ 0.8.24, pinned | `foundry.toml` pins 0.8.37 |
| Dependencies | As few as possible | Two: OpenZeppelin and forge-std, and forge-std is test-only |
| Self-written logic | Should be small | ~30 lines outside the constructor and helpers |
| Build | Must work offline | `lib/` is vendored; the compiler path is explicit |
| Cost | $0 | Local build and test only |
| Verification | Claims must be reproducible from the repository | `TESTING.md` gives the command for every number |

---

## 3. Deliverables

| # | Deliverable | Status |
|---|---|---|
| D1 | The contract | Done |
| D2 | Unit tests with an independent restatement of the maths | Done (32) |
| D3 | Stateful invariant tests | Done (9 invariants, 7 handler actions) |
| D4 | Evidence that the tests can fail | Done — the mutation check in `TESTING.md` level 2 |
| D5 | Static analysis report | Done — `slither . --filter-paths "lib/\|test/" --exclude-dependencies`, 0 results (`TESTING.md` level 6). A plain `slither .` reports **32**, all of them in the vendored OpenZeppelin tree under `lib/` (31 wholly there, one mixed-pragma notice that also names `src/`) |
| D6 | A second, independent fuzzer | Done — Medusa, 9 properties, 0 failures |
| D7 | Deployment to Base Sepolia with verified source | **Deployed 2026-09-17** — vault `0x7941438ee07bea4469ccd4bec583e9fb24037f35`, tx `0x91cf6315…` in block 46,919,125, funded with 21 USDC of test assets. **The "verified source" half is not done**: no Sourcify entry, so the record has no `verifiedAt` |
| D8 | A wallet dApp | **Done, in this repository's `web/`** — connect, deposit, redeem and approve, with the five failure classes handled and tested (`test/wallet.test.mjs`, 33 tests), published at <https://hareeshkashyap849.github.io/erc4626-vault/>. **The half that is still open is the manual browser checklist**, not the dApp (P3 below) |
| D9 | An event indexer, database and query API | **Done, in `erc4626-vault-dapp` and `vault-console`** — the indexer, the committed `data/vault.sqlite` snapshot and the query API, refreshed by a scheduled workflow that commits each new snapshot (four `data:` commits authored by `github-actions[bot]`, all 2026-09-17, read from the GitHub API). **The half that is still open is that none of it is hosted**: the snapshot is a file a cron updates, and between runs it lags the chain head |
| D10 | A fork test against the real USDC contract | **Done** (12 tests) — forking mainnet rather than Base Sepolia; see §5 |
| D11 | Tests for the deployment script itself | **Done** (13) — added because a script only ever run by hand is untested code |

---

## 4. How this is judged

| Item | Detail |
|---|---|
| Reviewer model | An engineer reading the contract in 15 minutes, then asking "how do you know?" |
| The answer to "how do you know" | Every number in the README is reproducible from `TESTING.md`, and every design decision in `ARCHITECTURE.md` names what it rejected |
| The weakness a reviewer will find | The source is not verified on Sourcify, so "this bytecode is this source" has to be checked by recompiling rather than read off a verification page — and there is no external audit. The deployment itself is live on Base Sepolia (testnet, 21 USDC of test assets). Stated up front rather than discovered. |

---

## 5. Deviations from this specification

| Planned | What shipped | Why |
|---|---|---|
| `_decimalsOffset()` returns 3 | Returns `18 - assetDecimals` — 12 for a 6-decimal asset | 3 gives an inflation-attack cost of 10³, which is only prohibitive if the victim deposits under about one dollar. Deriving the value from the asset makes the attack cost 10¹² for USDC while also making shares 18-decimal for every asset, so the protection scales with the asset instead of needing to be re-reasoned per deployment. |
| A `MockERC20` with fixed 6 decimals | A `MockERC20` with configurable decimals | The offset is derived from the asset's decimals, so testing only a 6-decimal asset would leave the derivation untested. A test covers 18-decimal assets and construction reverting above 18. |
| Invariants stated against a ledger | Invariants stated against observable state | Two ledger-based versions produced failures that were artefacts of the test's own bookkeeping. Recorded in `TESTING.md` because the mistake is more instructive than the fix. |
| `reportYield` callable by anyone | `onlyOwner` | An open `reportYield` would let any address donate with an event that reads like a protocol action. Donations are still possible, just without the event. |
| Echidna as a third fuzzer | Medusa | Echidna cannot start in this environment (certificate-store access). Medusa is installed and working, and the same `property_*` functions are compatible with Echidna if it becomes available. |
| The fork test forks Base Sepolia | It forks **Ethereum mainnet** | Base Sepolia's USDC cannot be funded honestly. `vm.mockCall` was tried and rejected: it returned `true` from `transferFrom` without moving a balance, so the vault minted shares against assets it never received — a mock manufacturing confidence. `vm.deal` on Base Sepolia would rewrite a balance slot directly, bypassing the token logic the test exists to exercise. Mainnet USDC is reachable and can be funded for real, so the test moves genuine tokens. The cost is that it says nothing about Base Sepolia specifically. |
| Deployment checks as inline `require` statements | Extracted to `src/DeployValidation.sol` | A `require` inside `Script.run()` cannot be unit-tested: reaching it means deploying a contract, and `vm.startBroadcast` in a test is a dry run. The extracted functions are `public` rather than `internal` because an inlined library function reverts at the same call depth as `vm.expectRevert`, which Foundry cannot observe. |
