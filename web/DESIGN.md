# P3 — Wallet dApp: design

> **Status: implemented and tested to the wallet boundary; §7 not yet run.**
> Depends on: `ARCHITECTURE.md` §11 (the five failure classes), `deployments/README.md`
> (the record the dApp reads).

---

## 0. What this is, and what it deliberately is not

A wallet dApp that lets someone deposit into `YieldVault`, watch their share
balance, and withdraw — against a real chain, signing real transactions.

**It is not a React application, and that is a decision with a cost.** See §5.

---

## 1. Why there is no build step

The standard way to write this is Next.js plus wagmi. It is what a production
team would use, and it is what most reviewers would expect. It is not what is
here, for two reasons of different kinds.

**A constraint.** The npm registry is unreachable from the environment this was
built in, so `npm install wagmi` cannot run, and the network to a CDN proved
intermittent as well. A build pipeline could not be completed or debugged here.

**A judgement.** For a demonstration whose value is "can this person build a
correct contract integration", a zero-build page has properties a framework
bundle does not:

| | wagmi + Next.js | this |
|---|---|---|
| dependencies to run | ~300 packages | 27 vendored files |
| what a reviewer must do to read the logic | install, then navigate a framework | open one file |
| works offline | only after `npm install` | always |

The cost is real and is stated in §5 rather than hidden.

## 2. Shape

```
browser
  index.html          the page, no bundler
  style.css           one stylesheet, no framework
  app/
    main.js           wiring only: the one file that knows both the chain and the DOM
    wallet.js         EIP-1193 client: connect, chain, accounts, nonce-tracked send
    vault.js          the ERC-4626 calls, the approval state machine, the share math
    render.js         DOM only; no logic worth testing lives here
    viem.js           one re-export, so no module ever imports a hashed vendor file
  vendor/             27 files, verified to load and export correctly
  tools/
    dev-server.mjs    serves web/, exposes /api/config, proxies /api/rpc
    check-modules.mjs links the whole module graph without executing it
    check-vendor.mjs  verifies the vendored viem graph

node server
  tools/dev-server.mjs
```

`errors.js` and `chain.js` were in the first draft of this section and do not
exist: failure classification lives beside the client that produces the failures
(`wallet.js`), and the deployment record is read once by `main.js`. Splitting them
out would have been tidier in a diagram and worse in practice, because it would
have separated each failure class from the code that detects it.

The server exists for three reasons and no others:

1. **`file://` cannot do ES modules**, so the page needs an HTTP origin.
2. **`/api/config`** returns the deployed addresses, so no address is written
   into any source file. One source of truth: `deployments/local.json`.
3. **`/api/rpc` proxies JSON-RPC** so the page has a same-origin RPC. This avoids
   a CORS question entirely, and makes the local-only nature explicit.

It is not a backend in any other sense: no database, no auth, no state.

## 3. Reading and writing

| Data | Source | Why |
|---|---|---|
| `balanceOf`, `allowance`, `previewRedeem`, `totalAssets` | **direct `eth_call`** | authoritative and always current. Reading these through a cache is how a dApp shows someone a stale balance after their own transaction confirmed. |
| the connected account, chain, pending transaction | **EIP-1193 events** | `accountsChanged`, `chainChanged`, `disconnect` |

**Balances are never cached.** After a transaction confirms the page re-reads
from the chain, and the re-read is the only thing that updates the display. A
display updated from the transaction receipt instead would be showing what we
believe happened rather than what the chain says.

## 4. The five failure classes

These are fixed by `ARCHITECTURE.md` §11. Each needs a specific UI behaviour, and
each is a distinct code path — not one generic error handler.

| # | Trigger | Required behaviour | How it is told apart |
|---|---|---|---|
| 1 | transaction reverts | decode the reason and show it in words | viem decodes; if it cannot, show the selector rather than "failed" |
| 2 | user rejects in the wallet | treat as a **normal cancel**: return to idle, no error styling, no pending state left behind | EIP-1193 error code `4001` |
| 3 | allowance too low | two-step approve→deposit, and handle **"approved but the deposit was then rejected"** without asking for a second approval | read `allowance` first, and remember an approval that has already succeeded |
| 4 | transaction stuck or replaced | track the hash **and nonce**; if the wallet replaces the transaction, follow the new hash; always offer a block-explorer link | watch for a receipt under the old hash failing while the nonce is consumed |
| 5 | indexer lag | **not applicable until P4.** The page reads the chain directly, so there is no window in which it shows stale data. Recorded here so the omission is deliberate rather than forgotten. |

Category 3 is the one most dApps get wrong, because the interesting state is the
one in between: the approval transaction succeeded, so the user should not be
asked to approve again, but the deposit did not happen, so the operation is not
complete. That is a state machine with three states, not a boolean.

## 5. Known limitations, stated because they are real

- **Hand-written EIP-1193 handling is more error-prone than wagmi.** wagmi exists
  to manage exactly the state that is being managed by hand here: account
  switches, chain switches, disconnects, several wallets competing for
  `window.ethereum`. The paths below are tested; claiming parity with a library
  that has years of production edge cases behind it would not be honest.
- **No WalletConnect.** Only injected wallets (`window.ethereum`), so mobile
  wallets are out of scope.
- **No transaction history.** That is P4's indexer, not the dApp's job.
- **Deposit and withdraw are the whole feature set.** No mint/redeem variants in
  the UI even though the contract supports them, because the four ERC-4626 entry
  points are four ways to say two things and a demo that offers all four is
  showing its interface rather than its purpose.

## 6. What must be tested, and how

There is no headless browser available, so the tests exercise the layers directly
rather than through the page:

| Behaviour | How it is checked | File |
|---|---|---|
| the approval state machine | unit tests over the three states | `test/vault.test.mjs` |
| the share arithmetic | unit tests against hand-computed ERC-4626 values | `test/vault.test.mjs` |
| amount parsing | unit tests, including the refusal to round | `test/vault.test.mjs` |
| error classification | each failure class fed a representative EIP-1193 or viem error | `test/wallet.test.mjs` |
| the chain guard | a wrong-chain result is refused before any write | `test/wallet.test.mjs` |
| **the deposit path end to end** | the real `deposit()` driven through a real viem client against a fake JSON-RPC chain that actually moves balances | `test/integration.test.mjs` |
| the module graph | every module parsed and linked in `vm.SourceTextModule` without executing, so a missing export or a moved file is an error rather than a blank page | `web/tools/check-modules.mjs` |
| the DOM ids | every id the JS looks up is checked against `index.html` | same |
| the vendored viem | the whole graph linked and evaluated, 21 required exports checked behaviourally | `web/tools/check-vendor.mjs` |

The integration test is the one that earns its keep. It is not a mock of our own
functions: it fakes only the JSON-RPC provider at the bottom, so ABI encoding, the
transport, the allowance read and the nonce tracking are all the shipped code. It
caught two bugs that unit tests could not have:

1. **A wrong virtual-share term.** `readState` used `10 ** shareDecimals` (10¹⁸)
   where ERC-4626 specifies `10 ** _decimalsOffset()` (10¹², because YieldVault
   sets the offset to `18 - assetDecimals`). The reported per-share value was
   24,038,462/25,000,000 of the truth — a 4% error that printed as a perfectly
   plausible number. It was found by asserting that `shareValue` and `maxWithdraw`
   agree, which they must, since OpenZeppelin defines `maxWithdraw(owner)` as
   `previewRedeem(maxRedeem(owner))`.
2. **A reverted transaction reported as success.** `sendAndTrack` returns
   `status: 'reverted'` rather than throwing, because a reverted transaction was
   still mined and still cost gas. `main.js` ignored the status and showed
   "Deposit confirmed" either way. The user would have seen a success message and
   an unchanged balance.

Both are now covered by regression tests. Neither was found by reading the code,
and the second was not found by any unit test — it needed the write path exercised
with a failing transaction.

**Not tested:** real wallet interactions, and the page in a real browser. That
needs a person clicking approve, and it is the manual checklist in §7.

### A test double that is too permissive is worse than no test

The most expensive bug in this file's history was three characters long, and every
test was green:

```js
node.children.length = 0;   // TypeError: Cannot set property length of
                            // #<HTMLCollection> which has only a getter
```

`children` is read-only in a browser. That line sat in `clearMessage`, which runs
on **every** message path, so nothing could report anything — the entire
notification system was dead. It was found by a person opening the page, not by
28 passing tests.

The tests were green because the DOM stub exposed `children` as a **plain array**,
and arrays accept `.length = 0`. The stub was more permissive than the DOM, so it
did not simulate the failure — it hid it.

Three lessons, all paid for:

1. **A stub must not be more capable than the thing it replaces.** When in doubt,
   be stricter. The temptation is always to make the double convenient.
2. **Reproducing a read-only collection faithfully is genuinely hard**, and the
   attempt is a rabbit hole: a getter-only property fails *silently* in sloppy
   mode (which is how bundled dependency code runs), and `Object.freeze` does not
   stop a sloppy-mode write either. Chasing fidelity here cost more than it was
   worth.
3. **So the forbidden line is caught statically instead.** A check that greps the
   app's source for `.children =` and `.children.length =` cannot be fooled by
   stub behaviour at all. It is worth being explicit that this is a *weaker* kind
   of test than executing the code — but for an API constraint, it is the reliable
   one, and it fails the moment someone writes the line again.

Teeth were verified rather than assumed: reintroducing the line makes the check
fail and name the file and line number. The behavioural test that accompanies it —
clear and re-render every shape of message without throwing — cannot catch the bug
on its own, because the fixed source no longer contains it, and that is exactly why
both kinds of check exist.

## 7. Manual checklist, for the human with the wallet

**Status: NOT YET RUN.** Everything below is written but unverified against a real
browser and a real wallet. Until someone walks this list, the honest description of
P3 is "implemented and tested up to the wallet boundary", not "working".

Each line is something only a person with a browser wallet can confirm:

1. connect → the account and chain appear
2. switch the wallet to a different chain → the page says so **before** any write,
   and the deposit button is disabled rather than sending a doomed transaction
3. deposit → a wallet prompt appears for the approval, then a second for the
   deposit, and the figures update afterwards
4. **reject the approval** → the page says "Cancelled" in a neutral tone, not an
   error, and the deposit button works again immediately
5. deposit again → it is back to two prompts, because the first approval was
   never granted
6. approve with the **Approve only** button → one prompt, then deposit → **one**
   prompt, not two (this is the "already approved" path)
7. **reject the deposit** after a successful approval → neutral message, and
   depositing again asks for **only** the deposit, never a second approval
   (failure class 3, the case that matters)
8. redeem everything → the balance returns to what it was, minus rounding
