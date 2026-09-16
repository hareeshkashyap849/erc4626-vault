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
import {
  clearMessage,
  el,
  renderAccount,
  renderBusy,
  renderChain,
  renderControls,
  renderDeployment,
  renderLastRead,
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

/** Re-read everything the page shows. One read, so the figures cannot disagree. */
async function refresh({ silent = false } = {}) {
  const account = app.wallet?.state.account ?? null;

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
    renderState(state, { stale: false });
    // Refresh re-reads and redraws; when nothing changed on chain the pixels are
    // identical, so this line is the only evidence the press did anything.
    renderLastRead(new Date());
  } catch (err) {
    // A failed read must never look like a fresh one: the timestamp is replaced by
    // a warning, so "the chain went away" cannot be mistaken for "nothing changed".
    renderLastRead(new Date(), { failed: true });
    if (!silent) {
      if (app.lastState) {
        renderState(app.lastState, { stale: true });
        renderMessage({ tone: 'warn', title: 'Showing older figures', detail: `The latest read failed: ${err?.shortMessage ?? err?.message ?? err}` });
      } else {
        renderMessage({ tone: 'error', title: 'Cannot read the vault', detail: `${err?.shortMessage ?? err?.message ?? err}\n\nIf this is the local chain, is anvil still running?` });
      }
    }
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

function fillMaxRedeem() {
  // `shares`, not `maxWithdraw`: the redeem input takes shares, and those are
  // different units. Using maxWithdraw here would look plausible and be wrong by
  // the share price on every vault that has earned anything.
  el('redeem-amount').value = String(app.lastState?.shares ?? 0n);
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
  // Built from the page's own origin, not from config.rpcUrl: the dev server
  // replaces rpcUrl with the relative "/api/rpc" on purpose, and viem's http()
  // needs something with an origin to resolve against.
  app.publicClient = viem.createPublicClient({ transport: viem.http(`${location.origin}/api/rpc`) });

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
