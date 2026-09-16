/**
 * Wiring: the only file that knows about both the chain and the DOM.
 *
 * Everything it uses is a value or a pure function from somewhere else --
 * `wallet.js` classifies failures, `vault.js` decides the approval steps,
 * `render.js` writes text. This file decides *when* to call them, which is the
 * part that genuinely needs a browser and therefore cannot be unit tested. It is
 * kept as small as it can be for exactly that reason. The click-by-click
 * checklist it is verified against is web/DESIGN.md §7.
 *
 * STARTUP ORDER MATTERS
 *
 *   1. Read /api/config. Without addresses there is nothing to read, and every
 *      later step depends on the chain ID in it. A failure here stops the page
 *      rather than half-starting it.
 *   2. Find a wallet. No wallet is a normal state, not an error.
 *   3. Read state. Before connecting, balances are read with no account, which
 *      is still useful: the vault's totals do not depend on who is asking.
 */
import * as viem from './viem.js';
import { Wallet, findProvider, sendAndTrack } from './wallet.js';
import { ERC20_MIN_ABI, deposit, formatUnits, parseAmount, readState, redeem, toUiError } from './vault.js';
import { makeBatchedClient } from './rpc-batch.js';
import {
  clearMessage,
  el,
  renderAccount,
  renderBusy,
  renderChain,
  renderControls,
  renderDeployment,
  renderLive,
  renderMessage,
  renderState,
  setText,
} from './render.js';

const app = {
  config: null,
  wallet: null,
  /** Read-only client over the same-origin proxy. Independent of any wallet, so
   *  the vault's own totals are readable before connecting -- and on a machine
   *  with no wallet installed at all. */
  publicClient: null,
  /** The last successful read. Kept so a failed refresh can label itself stale
   *  instead of blanking the page -- blanking looks like "you have nothing". */
  lastState: null,
  /**
   * There is deliberately NO remembered approval here.
   *
   * This object used to hold one, and it caused a reverted transaction: the page
   * believed an approval was still in place after the deposit had consumed it, and
   * sent a deposit with an allowance of zero. Approval state lives on the chain and
   * is read immediately before each write; a copy of it in the page can only ever
   * be a stale copy.
   */
  busy: false,
  /** A read is in flight. Guards against two reads racing to write the same DOM. */
  reading: false,
  explorerUrl: null,
};

const EXPLORER = (chainId) =>
  ({ 8453: 'https://basescan.org', 84532: 'https://sepolia.basescan.org', 1: 'https://etherscan.io' })[Number(chainId)] ?? null;

async function loadConfig() {
  const res = await fetch('/api/config', { cache: 'no-store' });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? '/api/config failed');
  if (!body.vault || !body.asset) throw new Error('/api/config returned no vault or asset address');
  return body;
}

/**
 * Keep the figures current without being asked.
 *
 * WHY POLLING RATHER THAN EVENTS
 *
 * Wallet events (`accountsChanged`, `chainChanged`) cover the user's own wallet and
 * nothing else. A vault's totals change when SOMEBODY ELSE deposits, redeems, or
 * reports yield -- and there is no event for that without an indexer, which is what
 * P4 is for. So the page reads on a timer.
 *
 * THE TIMER IS NOT ALWAYS RUNNING, and each rule is for a different reason:
 *
 *   - Hidden tab: no polling. A background tab re-reading a chain every few seconds
 *     is pure waste, and nobody is looking.
 *   - Becoming visible again: read IMMEDIATELY, then resume. Waiting out the
 *     remaining interval would show stale figures for up to one interval at exactly
 *     the moment the user came back to look at them.
 *   - While a transaction is in flight: no polling. The figures are being rewritten
 *     by the write path, and a poll landing in the middle would race it.
 *   - User can pause: some people want the page to hold still while they compare
 *     numbers, and a page that argues with you is worse than one that is manual.
 *
 * `setTimeout` chained rather than `setInterval`: a read that takes longer than the
 * interval would otherwise stack up requests, and the countdown shown to the user
 * needs a definite "next read at" anyway.
 */
/**
 * How often to look at the chain.
 *
 * MATCHED TO THE CHAIN, NOT TO A FEELING. This local chain produces a block every
 * 2 seconds, so reading faster than that can only ever return the same answer
 * twice -- and since the whole read is now ONE batched request, doing it at block
 * rate costs one request per block rather than the nine it used to.
 *
 * The countdown ticks four times per second purely so the indicator looks alive.
 * That tick touches nothing but text.
 */
const LIVE_INTERVAL_MS = 2_000;
const COUNTDOWN_TICK_MS = 250;

const live = {
  enabled: true,
  timer: null,
  countdown: null,
  nextAt: 0,
  lastAt: null,
  lastFailed: false,
};

function renderLiveNow() {
  if (live.lastFailed) return renderLive({ mode: 'stale' });
  if (!live.enabled) return renderLive({ mode: 'paused', at: live.lastAt });
  renderLive({ mode: 'live', at: live.lastAt, nextInMs: Math.max(0, live.nextAt - Date.now()) });
}

/**
 * Arm the next chain read.
 *
 * ONE TIMER PER JOB. An earlier version had a single `scheduleLive()` managing both
 * this timer and the countdown, and the countdown's callback called `scheduleLive()`
 * again on its way out -- which CLEARED AND RESTARTED THIS TIMER every 500ms. The
 * five-second read could therefore never fire: it was starved by its own countdown.
 *
 * The symptom was as confusing as it sounds. The indicator ticked "next in 5s",
 * "next in 4s"… and the figures never moved, while pressing Live caught up at once
 * (because that path reads directly instead of waiting for the timer). A page that
 * reports it is about to refresh, for ever, is worse than one that says it is idle.
 */
function armReadTimer() {
  clearTimeout(live.timer);
  live.timer = null;
  if (!live.enabled || document.hidden) return;
  live.nextAt = Date.now() + LIVE_INTERVAL_MS;
  live.timer = setTimeout(async () => {
    // Re-checked inside the callback, not only at arming time: the tab can be
    // hidden, or a transaction can start, between the two.
    if (document.hidden || app.busy) return armReadTimer();
    await refresh({ silent: true });
    armReadTimer();
  }, LIVE_INTERVAL_MS);
}

/** Redraw the countdown. Touches nothing on chain, so it is free. */
function armCountdown() {
  clearTimeout(live.countdown);
  live.countdown = null;
  if (!live.enabled || document.hidden) return renderLiveNow();
  live.countdown = setTimeout(() => {
    renderLiveNow();
    armCountdown();
  }, COUNTDOWN_TICK_MS);
  renderLiveNow();
}

function scheduleLive() {
  if (!live.enabled) {
    clearTimeout(live.timer);
    clearTimeout(live.countdown);
    live.timer = null;
    live.countdown = null;
    return renderLiveNow();
  }
  // Stopped while hidden: resumed by the visibilitychange handler, which also reads
  // at once rather than waiting out the interval.
  if (document.hidden) {
    clearTimeout(live.timer);
    clearTimeout(live.countdown);
    live.timer = null;
    live.countdown = null;
    return renderLiveNow();
  }
  armReadTimer();
  armCountdown();
}

/** Read now, then carry on with the schedule. */
async function refreshNow() {
  await refresh({ silent: true });
  scheduleLive();
}

/**
 * Turn the timer on or off.
 *
 * RESUMING READS IMMEDIATELY. An earlier version only re-armed the next tick, so
 * pressing Live after a pause left the page showing stale numbers for up to a full
 * interval -- at precisely the moment the user had asked it to be current. The same
 * applies to coming back to a hidden tab, which is the same wish expressed by
 * switching windows instead of pressing a button.
 */
function setLive(enabled) {
  live.enabled = enabled;
  const button = el('live-button');
  button.setAttribute('aria-pressed', String(enabled));
  button.className = enabled ? 'secondary' : 'secondary off';
  if (enabled) refreshNow();
  else scheduleLive();
}

/**
 * Stop every timer.
 *
 * Nothing in the page calls this -- the page lives as long as the tab does. It
 * exists because a self-rescheduling timer chain keeps a process alive, so any
 * harness that loads this module (the render tests do) would otherwise hang forever
 * rather than finish. A page that cannot be stopped is also a page that cannot be
 * tested, which is reason enough on its own.
 */
export function stopLive() {
  live.enabled = false;
  clearTimeout(live.timer);
  clearTimeout(live.countdown);
  live.timer = null;
  live.countdown = null;
}

function wireLive() {
  el('live-button').addEventListener('click', () => setLive(!live.enabled));

  // Coming back to the tab: read at once, then resume the timer. `visibilitychange`
  // is the reliable one; `focus` covers the case of switching windows without the
  // document ever becoming hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(live.timer);
      clearTimeout(live.countdown);
      renderLiveNow();
      return;
    }
    refreshNow();
  });
  window.addEventListener('focus', () => {
    // Only if the last read is old enough to be worth repeating, or every click on
    // the window would fire a request.
    if (live.enabled && Date.now() - (live.lastAt?.getTime() ?? 0) > LIVE_INTERVAL_MS) refreshNow();
  });

  setLive(true);
}

/** Re-read everything the page shows. One read, so the figures cannot disagree. */
async function refresh({ silent = false } = {}) {
  const account = app.wallet?.state.account ?? null;

  // One read at a time. The timer, the visibility handler, the focus handler and the
  // Refresh button can all ask for a read, and two overlapping reads would race to
  // write the same DOM -- the later one winning with the earlier one's data.
  if (app.reading) return;
  app.reading = true;

  try {
    // `account: null` is not a degraded read: the vault's totals do not depend on
    // who is asking, and the per-account figures come back as zero.
    const state = await readState(viem, {
      publicClient: app.publicClient,
      vault: app.config.vault,
      asset: app.config.asset,
      account,
    });
    app.lastState = state;
    // `hasAccount` tells renderState whether the per-account figures mean anything.
    // With no account connected they are all zero, and "you hold none" would be a
    // claim about a person the page has not met.
    renderState(state, { stale: false, hasAccount: Boolean(account) });
    live.lastAt = new Date();
    live.lastFailed = false;
  } catch (err) {
    // A failed read must never look like a fresh one. The indicator switches to a
    // warning, so "the chain went away" cannot be mistaken for "nothing changed".
    live.lastFailed = true;
    if (!silent) {
      if (app.lastState) {
        renderState(app.lastState, { stale: true, hasAccount: Boolean(account) });
        renderMessage({ tone: 'warn', title: 'Showing older figures', detail: `The latest read failed: ${err?.shortMessage ?? err?.message ?? err}` });
      } else {
        renderMessage({ tone: 'error', title: 'Cannot read the vault', detail: `${err?.shortMessage ?? err?.message ?? err}\n\nIf this is the local chain, is anvil still running?` });
      }
    }
  } finally {
    app.reading = false;
    renderLiveNow();
  }
  syncControls();
}

/** Every control's enabled state, computed in one place from the current facts. */
function syncControls() {
  const state = app.wallet?.state ?? { connected: false, chainId: null, account: null };
  const assetDecimals = app.lastState?.assetDecimals ?? 6;
  const shareDecimals = app.lastState?.shareDecimals ?? 18;

  let amountIsValid = false;
  try {
    amountIsValid = parseAmount(el('deposit-amount').value, assetDecimals) > 0n;
  } catch {
    amountIsValid = false;
  }

  let sharesToRedeem = false;
  let enteredShares = 0n;
  try {
    enteredShares = parseAmount(el('redeem-amount').value, shareDecimals);
    sharesToRedeem = enteredShares > 0n;
  } catch {
    sharesToRedeem = false;
  }

  // The vault can hold assets it cannot pay out immediately (that is what the
  // invariants allow), so a redemption of more than `maxWithdraw` is worth
  // saying out loud before the wallet prompt rather than after the revert.
  const hint =
    enteredShares > 0n && app.lastState && app.lastState.shares > 0n && enteredShares >= app.lastState.shares && app.lastState.shareValue > app.lastState.maxWithdraw
      ? `the vault can pay out ${app.lastState.maxWithdraw} right now -- redeeming everything may revert`
      : null;

  renderControls({
    // No provider at all is its own reason. Without this, the redeem button would
    // be enabled on a page with no wallet, and pressing it would throw a bare
    // "no EIP-1193 provider" instead of saying what to do.
    hasWallet: Boolean(app.wallet),
    connected: Boolean(state.connected && state.account),
    correctChain: Number(state.chainId) === Number(app.config.chainId),
    busy: app.busy,
    amountIsValid,
    sharesToRedeem,
    hint,
  });
}

function setBusy(busy, stage = '') {
  app.busy = busy;
  renderBusy(busy, stage);
  syncControls();
}

function showError(err) {
  const ui = toUiError(err);
  renderMessage({ tone: ui.tone, title: ui.title, detail: ui.detail });
  // One exception is worth not swallowing: an unknown failure is shown with its
  // raw text, because that is the case where the message is the only clue.
  if (ui.title === 'Failed' && ui.raw) {
    renderMessage({ tone: 'error', title: ui.title, detail: `${ui.detail}\n\nraw: ${ui.raw}` });
  }
}

/**
 * What the network line and the wrong-chain guard should show.
 *
 * One place, so the two call sites cannot disagree about whether an unconnected
 * wallet counts as "wrong chain". It does not: with no account there is no chain
 * to be wrong about, and the page must not open in a red error state.
 */
function chainView(state) {
  return {
    chainId: state.chainId,
    expectedChainId: app.config.chainId,
    expectedChainName: app.config.chainName ?? `chain ${app.config.chainId}`,
    connected: Boolean(state.connected && state.account),
  };
}

async function onWalletState(state) {
  renderAccount(state.account);
  renderChain(chainView(state));
  await refresh({ silent: true });
}

async function connect() {
  clearMessage();

  // Look for a provider BEFORE the try, and report its absence as information
  // rather than as a failure. Throwing here would route through classify(), which
  // cannot recognise this message and would return UNKNOWN -- painting a red error
  // for something the user did not do wrong and may not be able to fix at all.
  // "No wallet installed" is a fact about the environment, not a fault.
  if (!app.wallet) {
    const provider = findProvider();
    if (provider) {
      await attachWallet(provider);
    } else {
      renderMessage({
        tone: 'warn',
        title: 'No browser wallet found',
        detail:
          'MetaMask injects itself into the page, so it may take a moment after install or enable. This page checks for it automatically — press Connect wallet again in a few seconds. If it never appears, check that the extension is enabled for this site, then reload.',
      });
      return;
    }
  }

  try {
    await app.wallet.connect();
    // Saying which network the page is reading from is more useful than saying
    // "connected", because the next thing the user needs is to be on the right one.
    const { chainId } = app.wallet.state;
    renderMessage({
      tone: 'info',
      title: 'Connected',
      detail:
        Number(chainId) === Number(app.config.chainId)
          ? `Reading from chain ${chainId}.`
          : `Your wallet is on chain ${chainId}; this vault is on ${app.config.chainId}. Switch networks to deposit.`,
    });
  } catch (err) {
    // A refused connect prompt is a decision, not a fault.
    showError(err);
  }
}

async function switchChain() {
  clearMessage();
  try {
    await app.wallet.switchChain(app.config.chainId, {
      chainName: app.config.chainName ?? `Chain ${app.config.chainId}`,
      rpcUrl: app.config.walletRpcUrl ?? app.config.rpcUrl,
      blockExplorerUrl: app.explorerUrl ?? undefined,
    });
  } catch (err) {
    showError(err);
  }
}

/**
 * Report the outcome of a write.
 *
 * A MINED TRANSACTION IS NOT A SUCCESSFUL ONE. A revert is still mined, still
 * costs gas, and still produces a receipt with `status: 0x0` -- so `sendAndTrack`
 * returns it rather than throwing, and treating a returned result as success
 * (which this page did until the integration test exercised the path) reports
 * "Deposit confirmed" for a transaction that moved nothing. The user then sees an
 * unchanged balance and a success message, which is worse than an error.
 */
function reportWrite(result, { okTitle, okDetail, revertTitle }) {
  if (result.status === 'success') {
    renderMessage({ tone: 'ok', title: okTitle, detail: okDetail, hash: result.hash, explorerUrl: app.explorerUrl });
    return true;
  }
  if (result.status === 'reverted') {
    renderMessage({
      tone: 'error',
      title: revertTitle,
      detail: 'The transaction was mined but the contract refused it, so nothing changed. Gas was still spent.',
      hash: result.hash,
      explorerUrl: app.explorerUrl,
    });
    return false;
  }
  if (result.status === 'replaced') {
    renderMessage({
      tone: 'warn',
      title: 'Transaction replaced',
      detail: 'Your wallet replaced this transaction with another one with the same nonce, so this receipt is not the one that landed.',
      hash: result.hash,
      explorerUrl: app.explorerUrl,
    });
    return false;
  }
  // 'pending': still in the mempool at the timeout. Not a failure, and not a
  // success either -- saying either would be a guess.
  renderMessage({
    tone: 'warn',
    title: 'Still pending',
    detail: 'The transaction was sent but had not been mined when the page stopped waiting. It may still confirm.',
    hash: result.hash,
    explorerUrl: app.explorerUrl,
  });
  return false;
}

async function doApprove() {
  clearMessage();
  if (app.busy) return;
  const account = app.wallet?.state.account;
  try {
    app.wallet.assertChain(app.config.chainId);
    const amount = parseAmount(el('deposit-amount').value, app.lastState?.assetDecimals ?? 6);
    setBusy(true, 'approving');
    const data = viem.encodeFunctionData({ abi: ERC20_MIN_ABI, functionName: 'approve', args: [app.config.vault, amount] });
    const result = await sendAndTrack(app.wallet.provider, { to: app.config.asset, data, from: account }, { onStage: (stage, hash) => setBusy(true, `approval ${stage}${hash ? ` ${hash}` : ''}`) });
    reportWrite(result, { okTitle: 'Approval confirmed', okDetail: 'The vault can now move that many tokens.', revertTitle: 'The approval was refused' });
    await refresh({ silent: true });
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

async function doDeposit() {
  clearMessage();
  if (app.busy) return;
  const account = app.wallet?.state.account;
  try {
    app.wallet.assertChain(app.config.chainId);
    const amount = parseAmount(el('deposit-amount').value, app.lastState?.assetDecimals ?? 6);
    setBusy(true, 'deposit');
    // No remembered approval is passed in. `deposit()` reads the allowance and
    // decides from that, because a remembered flag cannot know that an approval was
    // consumed by the deposit which used it, nor that it covered a smaller amount.
    const result = await deposit(viem, {
      provider: app.wallet.provider,
      vault: app.config.vault,
      asset: app.config.asset,
      account,
      amount,
      onStage: (stage, info) => {
        if (stage === 'plan') {
          setBusy(true, info.step === 'approve' ? 'waiting for the approval prompt' : 'waiting for the deposit prompt');
        } else if (stage === 'approved') {
          setBusy(true, 'approved — waiting for the deposit prompt');
        } else {
          setBusy(true, `${stage}${info.stage ? ` ${info.stage}` : ''}${info.hash ? ` ${info.hash}` : ''}`);
        }
      },
    });

    // The approval step can fail on its own; `deposit()` returns that result rather
    // than throwing, with `blockedBy` set, so the message can name the step that
    // stopped instead of blaming the deposit.
    if (result.blockedBy === 'insufficient-balance') {
      // Named amounts, because the interesting case is being one base unit short:
      // a vault with yield in it does not hold round numbers, so an account that
      // reads "5850" may hold 5849.999999 and a deposit of 5850 cannot work.
      renderMessage({
        tone: 'warn',
        title: 'Not enough tokens',
        detail:
          `This deposit needs ${formatUnits(result.needed, app.lastState?.assetDecimals ?? 6)} but the wallet holds ` +
          `${formatUnits(result.held, app.lastState?.assetDecimals ?? 6)}. Nothing was sent, so no gas was spent.`,
      });
    } else if (result.blockedBy === 'approval-not-confirmed') {
      reportWrite(result, {
        okTitle: 'Approval confirmed',
        okDetail: '',
        revertTitle: 'The approval was refused, so no deposit was sent',
      });
    } else {
      reportWrite(result, {
        okTitle: 'Deposit confirmed',
        okDetail: 'Balances below were re-read from the chain, not from the receipt.',
        revertTitle: 'The deposit was refused',
      });
    }
    await refresh({ silent: true });
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

async function doRedeem() {
  clearMessage();
  if (app.busy) return;
  const account = app.wallet?.state.account;
  try {
    app.wallet.assertChain(app.config.chainId);
    const shares = parseAmount(el('redeem-amount').value, app.lastState?.shareDecimals ?? 18);
    setBusy(true, 'redeem');
    const result = await redeem(viem, {
      provider: app.wallet.provider,
      vault: app.config.vault,
      account,
      shares,
      onStage: (stage, info) => setBusy(true, `redeem ${info?.stage ?? stage}${info?.hash ? ` ${info.hash}` : ''}`),
    });
    reportWrite(result, {
      okTitle: 'Redemption confirmed',
      okDetail: 'Balances below were re-read from the chain.',
      revertTitle: 'The redemption was refused',
    });
    await refresh({ silent: true });
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

/**
 * Fill the Redeem box with the whole share balance, as a DECIMAL number.
 *
 * TWO BUGS HERE, and the second was worse than the first.
 *
 * 1. `String(state.shares)` is the raw base-unit count -- 5409090899330578546053
 *    for 5409.090899330578546053 shares. Every other amount on the page is a
 *    decimal, so the box showed a 22-digit integer that no one could read, and
 *    `parseAmount` would happily convert it back, which is why the mistake was not
 *    obvious from the error alone. `formatUnits` is the fix, and the Deposit Max
 *    button already did this correctly -- the two were written separately, which is
 *    exactly how one of them came out wrong.
 *
 * 2. THE REASON IT MATTERED: the raw count is the same DIGITS as the correct decimal
 *    value, so `parseAmount` accepted it and the page sent a redeem for 5.4e21
 *    shares against a balance of 5.4e21 base units -- a number 1e18 times too large.
 *    The transaction was mined and reverted, costing gas. A cosmetic-looking bug was
 *    a paid revert, and only a browser could show the difference.
 */
function fillMaxRedeem() {
  // `shares`, not `maxWithdraw`: the redeem input takes SHARES, and maxWithdraw is
  // in asset units. Using it here would look plausible and be wrong by the share
  // price on any vault that has earned something.
  const shares = app.lastState?.shares ?? 0n;
  const decimals = app.lastState?.shareDecimals ?? 18;
  el('redeem-amount').value = formatUnits(shares, decimals);
  syncControls();
}

/**
 * Fill the Deposit box with the exact wallet balance.
 *
 * WHY THIS BUTTON EXISTS
 *
 * A wallet displays fewer decimals than the chain holds. MetaMask showed a user
 * "5850" while the chain held 5849.999999, because it rounds to four decimals and
 * hides the rest. They typed the number on their screen, asked to deposit it, and
 * were refused -- correctly, since 5850 is one base unit more than they had.
 *
 * The page cannot know what a wallet's own UI displays. What it CAN do is offer the
 * exact figure, so nobody has to retype a number they read off another window. This
 * is the standard fix for the standard problem, and it also spares the user from
 * discovering that a vault with reported yield never holds round numbers.
 */
function fillMaxDeposit() {
  el('deposit-amount').value = formatUnits(app.lastState?.walletBalance ?? 0n, app.lastState?.assetDecimals ?? 6);
  syncControls();
}

/**
 * Attach the wallet, if there is one.
 *
 * Called at startup AND again if a provider appears later, because MetaMask
 * injects `window.ethereum` asynchronously: a page that loaded first sees no
 * provider, and the user who then installs or enables the extension would find a
 * page that never notices.
 *
 * Idempotent -- the guard on `app.wallet` means a second call is a no-op.
 */
async function attachWallet(provider) {
  if (app.wallet) return app.wallet;
  app.wallet = new Wallet(provider);
  app.wallet.subscribe(onWalletState);
  try {
    await app.wallet.refresh();
  } catch {
    // Some wallets refuse eth_accounts until the origin is granted. Not fatal:
    // the user can press Connect.
  }
  return app.wallet;
}

/**
 * Wait for a provider to appear, then attach it.
 *
 * WHY THIS IS NOT JUST A RETRY BUTTON
 *
 * The failure this fixes was seen in a real browser: MetaMask was installed, the
 * page had been loaded a moment earlier, so `findProvider()` returned null -- and
 * the old code returned early from `start()`, which meant the Connect button never
 * got a click handler at all. Clicking it did nothing, with no message, and no way
 * to recover except reloading. "Install a wallet and reload" is a bad instruction
 * to give someone who has just installed a wallet.
 *
 * EIP-6963 wallets also announce themselves with an `eip6963:announceProvider`
 * event; the plain `ethereum#initialized` event is what MetaMask fires. Both are
 * listened for, and a slow poll covers wallets that do neither.
 */
function watchForWallet({ timeoutMs = 30_000, intervalMs = 300 } = {}) {
  let settled = false;

  // Declared before `stop` uses them. `onProvider` can run synchronously from the
  // event listener at the bottom of this function, and `stop` then reads `expiry`
  // -- if `expiry` were declared below, that read would be a temporal-dead-zone
  // ReferenceError thrown from inside a listener, where it is invisible, and the
  // poll would keep running forever.
  let timer = null;
  let expiry = null;

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    if (expiry !== null) clearTimeout(expiry);
    window.removeEventListener('ethereum#initialized', onProvider);
    window.removeEventListener('eip6963:announceProvider', onProvider);
  };

  const onProvider = async () => {
    if (settled || app.wallet) return;
    const provider = findProvider();
    if (!provider) return;
    settled = true;
    stop();
    await attachWallet(provider);
    renderMessage({ tone: 'info', title: 'Wallet detected', detail: 'Press Connect wallet to continue.' });
    setText('control-hint', '');
    await refresh({ silent: true });
    syncControls();
  };

  // `unref` where it exists so a waiting poll does not hold a Node process open.
  // In a browser it is absent and this is a no-op; in the tests it is the
  // difference between a 0.3s suite and a 30s one, because setTimeout's full
  // timeout keeps the event loop alive.
  timer = setInterval(onProvider, intervalMs);
  timer.unref?.();
  expiry = setTimeout(() => {
    if (!app.wallet) stop();
  }, timeoutMs);
  expiry.unref?.();

  window.addEventListener('ethereum#initialized', onProvider);
  window.addEventListener('eip6963:announceProvider', onProvider);

  return stop;
}

/**
 * Wire the controls.
 *
 * Separate from `start()`, and called unconditionally, because the previous
 * structure put this AFTER an early `return` for the no-wallet case -- so the
 * page's buttons were inert exactly when the user most needed feedback. The reads
 * work with no wallet at all, so there is no reason for the controls to be dead.
 */
function wireControls() {
  el('connect-button').addEventListener('click', connect);
  el('switch-chain-button').addEventListener('click', switchChain);
  el('refresh-button').addEventListener('click', () => refresh());
  el('deposit-button').addEventListener('click', doDeposit);
  el('approve-button').addEventListener('click', doApprove);
  el('redeem-button').addEventListener('click', doRedeem);
  el('redeem-max-button').addEventListener('click', fillMaxRedeem);
  // The exact balance, so nobody has to retype a rounded number off their wallet.
  el('deposit-max-button').addEventListener('click', fillMaxDeposit);

  for (const id of ['deposit-amount', 'redeem-amount']) {
    el(id).addEventListener('input', syncControls);
  }

  // Starts the timer, the countdown, and the pause button.
  wireLive();
}

async function start() {
  try {
    app.config = await loadConfig();
  } catch (err) {
    renderMessage({ tone: 'error', title: 'Cannot load the deployment config', detail: `${err.message}\n\nStart the chain and deploy first: scripts/dev-chain.ps1` });
    setText('control-hint', 'the page cannot start without a deployment record');
    return;
  }

  app.explorerUrl = EXPLORER(app.config.chainId);
  // BATCHED, not one request per read. `readState` wants nine values, and viem
  // issues nine requests for them -- fine at a five-second poll and unacceptable at
  // a one-second one. The batcher collects everything asked for in the same tick and
  // sends it as a single JSON-RPC array, so the page can poll at roughly the rate
  // the chain produces blocks. See web/app/rpc-batch.js for why this rather than
  // Multicall3.
  app.publicClient = makeBatchedClient(viem, { rpcUrl: `${location.origin}/api/rpc` });

  renderDeployment(app.config);
  renderAccount(null);
  // Nothing is connected yet, so the network is UNKNOWN, not wrong. This is the
  // first thing a visitor sees; showing the wrong-chain guard here told them the
  // page was broken before they had done anything.
  renderChain(chainView({ account: null, chainId: null, connected: false }));

  // Wired BEFORE the provider check, so the buttons work in every case.
  wireControls();

  const provider = findProvider();
  if (provider) {
    await attachWallet(provider);
  } else {
    renderMessage({
      tone: 'warn',
      title: 'No browser wallet detected yet',
      detail: 'The vault totals below are real reads from the chain, so they work without a wallet. If you have just installed MetaMask, this page will notice it on its own in a moment — or press Connect wallet.',
    });
    setText('control-hint', 'deposit and redeem need a browser wallet; the vault figures above do not');
    // Watches for MetaMask appearing, so someone who installs it while this page
    // is open does not have to know to reload.
    watchForWallet();
  }

  await refresh({ silent: false });
  syncControls();
}

// A module-level failure is reported into the page rather than the console: a
// blank page and a console nobody opened is not a failure report.
start().catch((err) => {
  renderMessage({ tone: 'error', title: 'The page failed to start', detail: err?.stack ?? String(err) });
});
