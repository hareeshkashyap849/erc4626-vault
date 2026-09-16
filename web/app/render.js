/**
 * Rendering.
 *
 * Deliberately dumb: every function here takes a plain object and writes text
 * into an element that already exists. No state lives in this file, and nothing
 * here reads the chain. That split is what makes the page's behaviour testable
 * without a browser and visible without a debugger -- if a number on screen is
 * wrong, the bug is in what was passed in, not in how it was formatted.
 *
 * THE ONE RULE: a figure is either freshly read or explicitly labelled stale.
 * This file has no way to invent a value. If a reader sees an amount, something
 * read it.
 */

import { formatUnits } from './vault.js';

/** Fail loudly on a missing element. A silently blank panel is a bug that ships. */
export function el(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found;
}

export function setText(id, text) {
  el(id).textContent = text;
}

export function shortenAddress(address) {
  if (!address || address.length < 10) return address ?? '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Render the read state.
 *
 * `stale` is passed in rather than tracked here: this function is told whether
 * the numbers it is drawing are current, and shows a marker if they are not.
 * The alternative -- quietly drawing the last known values as if they were live
 * -- is how a dApp ends up showing a balance that no longer exists.
 */
export function renderState(state, { symbol, decimals, stale = false } = {}) {
  const assetDecimals = state.assetDecimals ?? decimals ?? 6;
  const shareDecimals = state.shareDecimals ?? 18;

  setText('asset-symbol', symbol ?? '—');
  setText('wallet-balance', `${formatUnits(state.walletBalance ?? 0n, assetDecimals)} ${symbol ?? ''}`.trim());
  setText('allowance', formatUnits(state.allowance ?? 0n, assetDecimals));
  setText('share-balance', formatUnits(state.shares ?? 0n, shareDecimals));
  setText('share-value', formatUnits(state.shareValue ?? 0n, assetDecimals));
  setText('max-withdraw', formatUnits(state.maxWithdraw ?? 0n, assetDecimals));
  setText('total-assets', `${formatUnits(state.totalAssets ?? 0n, assetDecimals)} ${symbol ?? ''}`.trim());
  setText('total-supply', formatUnits(state.totalSupply ?? 0n, shareDecimals));

  // An empty vault has no share price. Showing "1.0" would be a lie told for
  // tidiness: there is no price until someone deposits.
  setText('share-price', state.sharePrice === null || state.sharePrice === undefined ? 'n/a (vault is empty)' : state.sharePrice);

  const staleNode = el('stale-marker');
  staleNode.hidden = !stale;
  if (stale) staleNode.textContent = 'these figures are from an earlier read';
}

/** Show the account, or the not-connected state. */
export function renderAccount(address) {
  const node = el('account');
  if (!address) {
    node.textContent = 'not connected';
    node.className = 'account disconnected';
    return;
  }
  node.textContent = address;
  node.title = address; // full address on hover: truncated text is not copyable
  node.className = 'account connected';
}

/**
 * The network line, and the wrong-chain guard.
 *
 * THREE STATES, NOT TWO, and the difference is the whole point:
 *
 *   not connected   there is no wallet, or it has not been asked yet. We do not
 *                   know what chain the user is on, so we cannot call it wrong.
 *   connected, ok   the wallet is on the chain this deployment is on
 *   connected, bad  the wallet is somewhere else -- only THIS state shows the guard
 *
 * An earlier version collapsed the first state into the third: `chainId === null`
 * took the "bad" branch, which both painted the network red on a page that had not
 * been connected yet AND returned before hiding the guard below. Since the guard's
 * text is static markup in index.html, it stayed on screen permanently. The page
 * opened looking broken before the user had done anything, which is the worst
 * possible first impression for a page whose point is error handling.
 */
export function renderChain({ chainId, expectedChainId, expectedChainName, connected = true }) {
  const node = el('chain');
  const guard = el('wrong-chain-guard');

  if (!connected || chainId === undefined || chainId === null) {
    node.textContent = 'not connected';
    // Deliberately NOT the "bad" class: unknown is not the same as wrong, and
    // colouring it red teaches the user to ignore red.
    node.className = 'chain';
    guard.hidden = true;
    return;
  }

  const ok = Number(chainId) === Number(expectedChainId);
  node.textContent = ok ? `${expectedChainName} (${chainId})` : `wrong network: chain ${chainId}, expected ${expectedChainId}`;
  node.className = ok ? 'chain ok' : 'chain bad';

  // The guard's wording is set here rather than in index.html so it can name the
  // network the user is being asked for. Static text could not.
  if (!ok) {
    const detail = el('wrong-chain-detail');
    detail.textContent = `Your wallet is on chain ${chainId}; this vault is deployed on ${expectedChainName} (chain ${expectedChainId}).`;
  }
  guard.hidden = ok;
}

/**
 * Empty a node of everything it contains.
 *
 * WHY NOT ONE LINE OF ASSIGNMENT
 *
 * `textContent = ''` does NOT remove element children -- it only clears text
 * nodes -- so a message that had been appended as `<strong>Failed</strong>` kept
 * that element after being "cleared", and still read "Failed" to a screen reader.
 *
 * The obvious fix, `node.children.length = 0`, is WORSE: `children` is a read-only
 * `HTMLCollection`, so assigning to `.length` throws
 * "Cannot set property length of #<HTMLCollection> which has only a getter". It is
 * a silent no-op in a test double whose `children` is a plain array, and a hard
 * TypeError in a browser -- and because this runs on EVERY message path, the whole
 * notification system was dead in a real browser while every test was green.
 *
 * `removeChild` in a loop is correct, is supported everywhere, and does not depend
 * on `replaceChildren` (which is fine too, but is newer and there is no reason to
 * require it here).
 */
function emptyNode(node) {
  node.textContent = '';
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Build a <div> with a class and some text. */
function makeDiv(className, text) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  return div;
}

/**
 * Show a message.
 *
 * The tone is set by the failure class, not by the severity of the text. A user
 * rejecting a transaction in their own wallet is not an error and must not be
 * painted red -- doing so trains people to ignore red, and it misrepresents a
 * decision they just made deliberately.
 */
export function renderMessage({ tone = 'info', title = '', detail = '', hash = null, explorerUrl = null } = {}) {
  const node = el('message');
  node.className = `message ${tone}`;
  emptyNode(node);

  const heading = document.createElement('strong');
  heading.textContent = title;
  node.appendChild(heading);

  if (detail) node.appendChild(makeDiv('message-detail', detail));

  if (hash) {
    const wrap = makeDiv('message-hash', explorerUrl ? '' : hash);
    if (explorerUrl) {
      const link = document.createElement('a');
      link.href = `${explorerUrl.replace(/\/$/, '')}/tx/${hash}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = hash;
      wrap.appendChild(link);
    }
    node.appendChild(wrap);
  }

  node.hidden = false;
}

export function clearMessage() {
  const node = el('message');
  node.hidden = true;
  emptyNode(node);
  node.className = 'message';
}

/**
 * Drive the buttons from the current facts.
 *
 * Disabled-with-a-reason, not disabled-and-silent: a greyed-out button with no
 * explanation is the second most common way a dApp wastes someone's time.
 *
 * `redeemBlock` is passed in by the caller rather than computed here, because
 * deciding it needs the share price and this file deliberately does no
 * arithmetic of its own. It is the one blocking condition the caller knows and
 * this function cannot.
 */
export function renderControls({ hasWallet = true, connected, correctChain, busy, amountIsValid, sharesToRedeem, hint = null }) {
  // Ordered most-fundamental first, so the hint names the earliest thing that is
  // missing rather than the last. "Connect a wallet first" is useless advice to
  // someone who has not installed one.
  const blocked = !hasWallet
    ? 'no browser wallet detected — the vault figures above are still real reads'
    : !connected
      ? 'connect a wallet first'
      : !correctChain
        ? 'switch to the right network first'
        : busy
          ? 'a transaction is in progress'
          : null;

  // When blocked, everything is disabled; otherwise each button answers to its
  // own input. Two separate reasons, so they are not collapsed into one flag.
  el('deposit-button').disabled = blocked !== null || !amountIsValid;
  el('redeem-button').disabled = blocked !== null || !sharesToRedeem;
  // The approve button is a manual override for the automatic first step of a
  // deposit. It exists because someone may want to approve without depositing,
  // not because the deposit flow needs it.
  el('approve-button').disabled = blocked !== null || !amountIsValid;

  el('control-hint').textContent = blocked ?? hint ?? (amountIsValid ? '' : 'enter an amount to deposit');
}

/** One place that decides what the busy state looks like. */
export function renderBusy(busy, stage = '') {
  const node = el('busy');
  node.hidden = !busy;
  if (busy) node.textContent = stage ? `working: ${stage}` : 'working…';
}

/**
 * The deployment panel: where this page is pointed, read from /api/config.
 *
 * Shown in full rather than trimmed, because the single most useful thing a
 * reader can do with these two addresses is paste them into an explorer or a
 * `cast call`. A shortened address that cannot be copied is decoration.
 */
export function renderDeployment(config) {
  setText('vault-address', config.vault ?? '—');
  setText('asset-address', config.asset ?? '—');
  setText('chain-id', String(config.chainId ?? '—'));
  setText('deploy-block', config.deployBlock === undefined || config.deployBlock === null ? 'unknown' : String(config.deployBlock));

  const note = config.note ? String(config.note) : '';
  const record = config.source ? ` (read from ${config.source})` : '';
  setText('deployment-note', `${note}${record}`);
}
