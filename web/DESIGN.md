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
here, and the reason is **a choice, not a constraint** — which is a correction.

**CORRECTION (2026-09-16).** This section previously said the npm registry was
unreachable and that a build pipeline therefore could not be completed here. That
claim was wrong, and it has since been measured:

```
fetch() direct to registry.npmjs.org   HTTP 200   (no proxy needed)
npm view playwright version            1.63.0
npm install playwright-core            succeeds in ~19s
```

npm was never unreachable. An earlier attempt failed with `EPERM`, which is this
sandbox refusing the **named pipe** that `npm.cmd` needs when spawned through a
shell — a limit on how npm was invoked, not on npm. The working invocation is
`node E:/nodejs/node_modules/npm/bin/npm-cli.js <args> --cache <inside workspace>`.

So the honest position is: **a build step was possible and was declined.** Recording
a preference as an environmental impossibility made a reversible decision look
forced, and would have stopped anyone revisiting it. The judgement below stands on
its own without the false constraint.

**A judgement.** For a demonstration whose value is "can this person build a
correct contract integration", a zero-build page has properties a framework
bundle does not:

| | wagmi + Next.js | this |
|---|---|---|
| dependencies to run | ~300 packages | 27 vendored files |
| what a reviewer must do to read the logic | install, then navigate a framework | open one file |
| works offline | only after `npm install` | always |
| what it demonstrates | that a framework was used | the EIP-1193 and ERC-4626 layers underneath it |

The last row is the actual argument. wagmi exists to manage exactly the state this
page manages by hand, so using it would hide the part being demonstrated. That is a
reason to decline it **for this project**; it is not a reason to decline it for a
client project, where the trade is usually the other way.

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
2. **`api/config`** returns the deployed addresses, so no address is written
   into any source file. One source of truth: `deployments/local.json`.
3. **`api/rpc` proxies JSON-RPC** so the page has a same-origin RPC, which avoids
   a CORS question entirely and makes the local-only nature explicit.

It is not a backend in any other sense: no database, no auth, no state.

### 2.1 The same page, published without a server

None of those three reasons is a reason the page *needs a server* — only a reason the
developer experience has one. So the page is also published to GitHub Pages by
`.github/workflows/pages.yml`, and the differences are three lines of configuration
rather than a second implementation:

| | dev server | static host |
|---|---|---|
| addresses | `api/config`, read from the record per request | `api/config`, a FILE written at build time by `scripts/build-static-site.mjs` |
| reads | same-origin `api/rpc` proxy (`rpcUrl: '/api/rpc'`) | the public endpoint directly (`rpcUrl: 'https://sepolia.base.org'`) |
| price history | `/api/candles` forwarded to the index service | **no route** — `candlesUrl: null` |

The config *shape* is shared (`tools/config-shape.mjs`) precisely so the two cannot
drift in the fields that decide which contract is called.

Two measured facts make the middle row work, and neither was assumed: `sepolia.base.org`
answers with `Access-Control-Allow-Origin: *` and answers an OPTIONS preflight for a JSON
POST with `204`/`POST`/`content-type`, and it accepts the nine-call JSON-RPC batch
`readState` sends (verified in full, not sampled). Probe:
`probe-rpc-capabilities.mjs`.

The bottom row is why `candlesUrl` exists as an explicit `null` rather than a default
path. A static page has no proxy, and the honest statement is "this page has no route to
the index service", not "the index service answered 404" — the second sends a reader to
debug a service that was never contacted. The panel says the first.

Two URL details matter for a host that serves the page from a subpath
(`https://<user>.github.io/<repo>/`), and both were wrong before this deploy existed:
the config is fetched as `api/config` (relative) rather than `/api/config`, and reads go
to `new URL(config.rpcUrl, location.href)`. A leading slash resolves against the domain
root, which would have produced a blank page with a console message and nothing in the
code to explain it.

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
- **The chart's panel is turned off in `test/render.test.mjs`, and the reason is not
  fixed.** Loading `main.js` with the chart wiring makes that suite pass all 42
  assertions and then **never exit** — green output and a hung process, which is the
  worst signal available. What is established: it is this module's chart path (removing
  it restores a 0.5s exit); it is **not** the interval (commenting out only
  `startChartTimer()` still hangs); it is **not** a missing stub route (`/api/candles`
  is stubbed now, still hangs); and it is **not** a page defect — the chart has its own
  34 tests, `/api/candles` reconciles against an independent recomputation of the
  database, and the page loads and draws in a real browser. The mechanism is unknown and
  is written down rather than guessed at. The harness sets
  `__DISABLE_LIVE_CHART__ = true`; when the hang is found, that switch and this bullet
  both go.
- **The chart needs the index service, which is a separate repository.** The vault can
  be perfectly healthy while the panel says "not reachable". That is by design and the
  caption says so, but it means the page has one dependency the chain does not imply.

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

**Not tested:** MetaMask itself. The page runs in a real browser under automation
(§6, "A real browser, driven from Node"), but the wallet is a fake that forwards to
the chain — so anything specific to MetaMask's own UI is still §7's job.

### A real browser, driven from Node

`web/tools/browser-test.mjs` runs the page in **actual Chrome** — real CSS, real
event dispatch, real `HTMLCollection` semantics — driven over the DevTools Protocol.
No dependency is installed: Chrome is already on the machine, CDP is a WebSocket
carrying JSON, and node 24 has a global `WebSocket`. `web/tools/lib/cdp.mjs` is the
entire client.

Only `window.ethereum` is faked, because a real MetaMask needs a human to press
Approve. The fake is a genuine EIP-1193 provider that **forwards to anvil**: reads
go to the real chain unmodified, and writes are signed by anvil's unlocked account
and really execute. The page, the DOM, the CSS, the module loader, the dev server
and the chain are all real, and the vault's state really changes.

What it verifies that nothing else could:

| Check | Why only a browser can see it |
|---|---|
| the wrong-chain guard is not *visible* | asserts the **computed style**, not `element.hidden`. Those two disagreed, and did so in production |
| the Asset field shows the symbol | the value comes from `main.js`'s call, not from `renderState`'s own contract |
| the deposit is approve-then-deposit, in order | counted from the wallet's request log, in a real event loop |
| a rejected deposit is neutral, not an error | asserts the rendered **class**, not the classification table |
| failure class 3: the retry costs ONE transaction | the standing allowance is read back afterwards as arithmetic proof |
| no uncaught exceptions or console errors | collected via `Runtime.exceptionThrown` |

It deposits for real, then reverts an `evm_snapshot` — and **checks that the revert
held**, because an earlier version printed "reverted" while anvil's periodic state
dump quietly overwrote it. A cleanup that is reported but did not happen is worse
than no cleanup at all.

**Sandbox requirement:** Chromium will not start unless it can create mojo IPC
named pipes. Under a confined sandbox it dies with
`FATAL platform_channel.cc: Check failed: 拒绝访问 (0x5)`, and **no Chrome flag
avoids it** — the denial is the OS sandbox, not Chrome's own. So the browser test is
deliberately *not* wired into the repository's top-level aggregate test runner, which
must pass in a confined shell.

### Two bugs that only a screenshot found

1. **The wrong-chain banner was visible from page load.** The HTML carries `hidden`
   and `renderChain` sets it correctly — but the UA stylesheet implements `hidden`
   as `display: none`, and `.guard { display: flex }` outranks it. Every test
   asserting `element.hidden === true` passed while the banner sat on screen. Fixed
   with a global `[hidden] { display: none !important }`; the browser test now
   asserts `getComputedStyle(...).display`.
2. **The Asset field showed an em dash.** `renderState` took `symbol` as an
   *option* and `main.js` passed no options, so the value `readState` had already
   read from the chain was dropped on the floor. Every unit test supplied the option
   itself and therefore never touched the page's real call. `renderState` now falls
   back to `state.symbol`.

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
