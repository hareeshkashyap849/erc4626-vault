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
import { ApprovalState, ERC20_MIN_ABI, deposit, parseAmount, readState, redeem, toUiError } from './vault.js';
import {
  clearMessage,
  el,
  renderAccount,
  renderBusy,
  renderChain,
  renderControls,
  renderDeployment,
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
  /** The approval half of the state machine. Reset whenever a write fails, so a
   *  failure never leaves the page believing an approval is in place. */
  approval: ApprovalState.IDLE,
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
  } catch (err) {
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

async function onWalletState(state) {
  renderAccount(state.account);
  renderChain({ chainId: state.chainId, expectedChainId: app.config.chainId, expectedChainName: app.config.chainName ?? `chain ${app.config.chainId}` });
  await refresh({ silent: true });
}

async function connect() {
  clearMessage();
  try {
    if (!app.wallet) throw new Error('no EIP-1193 wallet found. Install MetaMask (or another browser wallet) and reload.');
    await app.wallet.connect();
    renderMessage({ tone: 'info', title: 'Connected', detail: `Reading from ${app.config.rpcUrl}` });
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
    // Only a successful approval moves the state machine. A reverted approve --
    // an ERC-20 that returns false rather than reverting, for instance -- leaves
    // the allowance untouched, so claiming otherwise would skip a needed approval.
    if (reportWrite(result, { okTitle: 'Approval confirmed', okDetail: 'The vault can now move that many tokens.', revertTitle: 'The approval was refused' })) {
      app.approval = ApprovalState.APPROVED;
    } else {
      app.approval = ApprovalState.IDLE;
    }
    await refresh({ silent: true });
  } catch (err) {
    app.approval = ApprovalState.IDLE;
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
    const result = await deposit(viem, {
      provider: app.wallet.provider,
      vault: app.config.vault,
      asset: app.config.asset,
      account,
      amount,
      approvalState: app.approval,
      onStage: (stage, info) => {
        if (stage === 'plan') {
          if (info.step === 'approve') setBusy(true, 'waiting for the approval prompt');
          else setBusy(true, 'waiting for the deposit prompt');
        } else if (stage === 'approved') {
          // The approval landed, so a second deposit must not approve again.
          app.approval = ApprovalState.APPROVED;
          setBusy(true, 'approved — waiting for the deposit prompt');
        } else {
          setBusy(true, `${stage}${info.stage ? ` ${info.stage}` : ''}${info.hash ? ` ${info.hash}` : ''}`);
        }
      },
    });
    reportWrite(result, {
      okTitle: 'Deposit confirmed',
      okDetail: 'Balances below were re-read from the chain, not from the receipt.',
      revertTitle: 'The deposit was refused',
    });
    await refresh({ silent: true });
  } catch (err) {
    // The approval may well have succeeded before the deposit was refused. The
    // state machine is only reset for classes where it is genuinely unknown;
    // otherwise the user is asked to approve twice for no reason.
    const classified = toUiError(err);
    if (classified.title !== 'Cancelled') app.approval = ApprovalState.IDLE;
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
  renderChain({ chainId: null, expectedChainId: app.config.chainId, expectedChainName: app.config.chainName ?? `chain ${app.config.chainId}` });

  const provider = findProvider();
  if (!provider) {
    renderMessage({ tone: 'warn', title: 'No browser wallet detected', detail: 'The vault totals below are still real reads. Connect a wallet to deposit or redeem.' });
    setText('control-hint', 'install a browser wallet (for example MetaMask) and reload to deposit or redeem');
    // Still worth reading: the vault's totals do not need an account, and
    // "the vault holds 40 tokens" is the one fact a visitor can check without
    // any wallet at all.
    await refresh({ silent: false });
    return;
  }

  app.wallet = new Wallet(provider);
  app.wallet.subscribe(onWalletState);
  try {
    await app.wallet.refresh();
  } catch {
    // Some wallets refuse eth_accounts until the origin is granted. That is not
    // fatal: the user can press Connect.
  }

  el('connect-button').addEventListener('click', connect);
  el('switch-chain-button').addEventListener('click', switchChain);
  el('refresh-button').addEventListener('click', () => refresh());
  el('deposit-button').addEventListener('click', doDeposit);
  el('approve-button').addEventListener('click', doApprove);
  el('redeem-button').addEventListener('click', doRedeem);
  el('redeem-max-button').addEventListener('click', fillMaxRedeem);

  for (const id of ['deposit-amount', 'redeem-amount']) {
    el(id).addEventListener('input', syncControls);
  }

  await refresh({ silent: true });
  syncControls();
}

// A module-level failure is reported into the page rather than the console: a
// blank page and a console nobody opened is not a failure report.
start().catch((err) => {
  renderMessage({ tone: 'error', title: 'The page failed to start', detail: err?.stack ?? String(err) });
});
