# P3 — Wallet dApp: design

> **Status: design agreed, implementation in progress.**
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
  app/…
    wallet.js         EIP-1193 client: connect, chain, accounts, send
    chain.js          reads deployments/local.json via the server
    vault.js          the ERC-4626 calls, and the approval state machine
    errors.js         the five failure classes, decoded to something readable
    render.js         DOM only; no logic worth testing lives here
  vendor/viem/        27 files, verified to load and export correctly

node server
  tools/dev-server.mjs   serves web/, exposes /api/config, proxies /api/rpc
```

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

The wallet layer is the risky part, so it is the part with tests. There is no
headless browser available, so the tests exercise the layer directly:

| Behaviour | How it is checked |
|---|---|
| the approval state machine | unit tests over the three states, including the approve-succeeded/deposit-rejected case |
| error classification | each of the five classes fed a representative EIP-1193 or viem error and checked for the right classification |
| the chain guard | a wrong-chain result is refused before any write is attempted |
| the ABI and addresses | read from `/api/config` and checked against the deployment record |
| the page renders and draws | a DOM smoke test, in the same spirit as the indexer project's dashboard check |

**Not tested:** real wallet interactions. That needs a person clicking approve in
a browser, and it is the manual checklist in §7.

## 7. Manual checklist, for the human with the wallet

Each line is something only a person with a browser wallet can confirm:

1. connect → the account and chain appear
2. switch the wallet to a different chain → the page says so **before** any write
3. `approve` → a wallet prompt appears, and the allowance updates afterwards
4. deposit → shares appear, and the balance is re-read from the chain, not assumed
5. **reject** the deposit in the wallet → no error is shown, state returns to idle
6. deposit again immediately → **no second approval is requested** (class 3)
7. redeem everything → the balance returns to what it was, minus rounding
