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

/**
 * Write a figure, with the exact value kept alongside it.
 *
 * TWO THINGS ARE TRUE AT ONCE ABOUT BIG NUMBERS ON THIS PAGE:
 *
 *   a share balance is 2727300000000000000000 base units, which formats to
 *   "2727.300000000000000001" -- precise, and unreadable
 *
 *   a wallet shows the SAME balance as "2727.3", because it rounds to about six
 *   significant figures, and a user who retypes that number gets a deposit that is
 *   refused for being one base unit too large
 *
 * So neither display is sufficient alone. This writes a grouped, easier-to-scan
 * figure (`5,455.199997`) and puts the full-precision string in `data-exact`, which
 * a hover reveals and which the browser tests assert against. Nothing is rounded
 * away: the exact value is always present, one attribute away.
 */
export function setFigure(id, value, { suffix = '', exact = null } = {}) {
  const node = el(id);
  const precise = exact ?? value;
  node.textContent = `${group(value)}${suffix ? ` ${suffix}` : ''}`;
  node.dataset.exact = precise;
  node.title = suffix ? `${precise} ${suffix}` : precise;
}

/**
 * Insert thousands separators into the integer part only.
 *
 * Deliberately string manipulation rather than `toLocaleString`: the value arrives
 * as a decimal string from `formatUnits`, and converting it to a Number would
 * destroy the precision that the whole page is careful about. A grouped display is
 * cosmetic; it must not be the step that loses a digit.
 */
function group(text) {
  const [whole, fraction] = String(text).split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
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
 *
 * `symbol` and `decimals` default to what the READ STATE already carries, which is
 * read from the chain. They were originally option-only, and `main.js` passed
 * neither -- so the Asset field rendered an em dash while `readState` was holding
 * the real symbol the whole time. A screenshot caught it; no test did, because
 * every test supplied the option itself.
 */
export function renderState(state, { symbol = undefined, decimals = undefined, stale = false, hasAccount = false } = {}) {
  const assetDecimals = state.assetDecimals ?? decimals ?? 6;
  const shareDecimals = state.shareDecimals ?? 18;
  const assetSymbol = symbol ?? state.symbol ?? '';

  setText('asset-symbol', assetSymbol || '—');
  setFigure('wallet-balance', formatUnits(state.walletBalance ?? 0n, assetDecimals), { suffix: assetSymbol });
  setFigure('allowance', formatUnits(state.allowance ?? 0n, assetDecimals));
  setFigure('share-balance', formatUnits(state.shares ?? 0n, shareDecimals));
  setFigure('share-value', formatUnits(state.shareValue ?? 0n, assetDecimals));
  setFigure('max-withdraw', formatUnits(state.maxWithdraw ?? 0n, assetDecimals));
  setFigure('total-assets', formatUnits(state.totalAssets ?? 0n, assetDecimals), { suffix: assetSymbol });
  setFigure('total-supply', formatUnits(state.totalSupply ?? 0n, shareDecimals));

  /**
   * Say out loud what fraction of the vault the user owns.
   *
   * A user saw "Your shares 268" beside "Total shares 768" and asked why the two
   * differ -- a completely reasonable question, because nothing on the page said
   * the vault has more than one depositor. They are different numbers by
   * definition: one is your slice, the other is the whole pie. Saying so takes one
   * line, and its absence made a correct page look broken.
   *
   * `hasAccount` is passed in rather than inferred: with no account connected the
   * page does not know whose slice to describe, and the per-account figures are all
   * zero, so it must stay silent rather than announce "you hold none".
   */
  const totalShares = state.totalSupply ?? 0n;
  const heldShares = state.shares ?? 0n;
  const percentNode = el('share-percent');
  if (percentNode) {
    if (!hasAccount || totalShares === 0n) {
      percentNode.textContent = '';
    } else if (heldShares === 0n) {
      percentNode.textContent = '(none — the vault has other depositors)';
    } else {
      // Counted in hundredths of a percent, so the comparison stays in integers --
      // and so the wording can distinguish "0.00%" from "less than 0.01%", which is
      // the difference between a rounding artefact and a real holding.
      const hundredthsOfPercent = (heldShares * 1_000_000n) / totalShares;
      percentNode.textContent =
        hundredthsOfPercent === 0n
          ? '(less than 0.01% of all shares)'
          : `(${(Number(hundredthsOfPercent) / 10_000).toFixed(2)}% of all shares)`;
    }
  }

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
 * TWO KINDS OF DISABLED, and they need different words.
 *
 *   BLOCKED   something is missing that the user must supply elsewhere -- a
 *             wallet, a connection, the right network. Nothing they type helps.
 *   NOT READY the button is waiting on the input box next to it. The user is one
 *             keystroke away, and the hint should say which keystroke.
 *
 * The first version used one message for both: "enter an amount to deposit" shown
 * while the amount box was EMPTY. That reads as an instruction to do something the
 * user has not done, and a real user reasonably concluded the page was unfinished
 * and the buttons were broken. The empty box is the normal starting state; the page
 * should describe it, not scold it.
 *
 * `hint` from the caller still wins when it has something more specific to say
 * (for example, that the vault is short of liquidity for a full redemption).
 */
export function renderControls({ hasWallet = true, connected, correctChain, busy, amountIsValid, sharesToRedeem, hint = null }) {
  // Ordered most-fundamental first, so the hint names the earliest thing that is
  // missing rather than the last.
  const blocked = !hasWallet
    ? 'no browser wallet detected — the vault figures above are still real reads'
    : !connected
      ? 'connect a wallet first'
      : !correctChain
        ? 'switch to the right network first'
        : busy
          ? 'a transaction is in progress'
          : null;

  // Only one button can be the one the user is looking at, so the hint describes
  // whichever input is empty. Deposit is the primary action, so it speaks first.
  const notReady = !amountIsValid ? 'type an amount in the Deposit box to enable the button' : !sharesToRedeem ? 'type an amount in the Redeem box to enable the button' : null;

  el('deposit-button').disabled = blocked !== null || !amountIsValid;
  el('redeem-button').disabled = blocked !== null || !sharesToRedeem;
  // The approve button is a manual override for the automatic first step of a
  // deposit. It exists because someone may want to approve without depositing,
  // not because the deposit flow needs it.
  el('approve-button').disabled = blocked !== null || !amountIsValid;

  el('control-hint').textContent = blocked ?? hint ?? notReady ?? '';
}

/** One place that decides what the busy state looks like. */
export function renderBusy(busy, stage = '') {
  const node = el('busy');
  node.hidden = !busy;
  if (busy) node.textContent = stage ? `working: ${stage}` : 'working…';
}

/**
 * The "live / paused / stale" indicator.
 *
 * Three states, and they must not look alike, because the whole point of the
 * indicator is that a reader can tell at a glance whether the figures in front of
 * them are current:
 *
 *   live    reading on a timer; says when the last read happened and when the next
 *           one is due, so "nothing has changed on chain" cannot look like a freeze
 *   paused  the user turned it off; says so, and says how to turn it back on
 *   stale   the last read FAILED; says so in the warning colour, because a page
 *           showing old numbers without saying they are old is the failure this
 *           whole line exists to prevent
 */
export function renderLive({ mode = 'live', at = null, nextInMs = null, detail = '' } = {}) {
  const dot = el('live-dot');
  const status = el('live-status');
  if (!dot || !status) return;

  dot.className = `live-dot ${mode}`;

  if (mode === 'stale') {
    status.textContent = detail || 'lost contact with the chain — the figures above may be out of date';
    return;
  }

  const when = at ? at.toLocaleTimeString() : null;
  if (mode === 'paused') {
    status.textContent = `${when ? `read at ${when} · ` : ''}live updates paused — press Live to resume`;
    return;
  }

  // `Math.ceil` so it never reads "in 0s" while still waiting.
  const due = nextInMs === null ? '' : ` · next in ${Math.max(1, Math.ceil(nextInMs / 1000))}s`;
  status.textContent = `${when ? `read at ${when}` : 'reading…'}${due}`;
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
