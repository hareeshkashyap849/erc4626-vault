/**
 * EIP-1193 wallet client.
 *
 * The riskiest layer in the dApp, and therefore the one with tests. wagmi exists
 * to manage exactly this state -- account changes, chain changes, disconnects,
 * competing providers, replaced transactions -- and this is a hand-written
 * version of that. It is written to be testable rather than convenient: both the
 * provider and the viem module are injected, so the whole layer runs in Node
 * against a fake provider with no browser and no network.
 *
 * WHAT IT IS RESPONSIBLE FOR
 *
 *   - finding and connecting to an injected wallet
 *   - refusing to write while the wallet is on the wrong chain
 *   - following a transaction until it is mined, INCLUDING the case where the
 *     wallet replaces it (the user pressed "speed up"), which produces a
 *     different hash for the same nonce
 *   - classifying every failure, because the five failure classes in
 *     ARCHITECTURE.md §11 each need a different thing said to the user
 */

/** EIP-1193 user-rejected. The one error code that is defined by the spec. */
export const USER_REJECTED = 4001;

/**
 * Failure classes. Every caught error is mapped to exactly one, because the UI
 * behaviour differs per class and a single catch-all cannot serve them.
 *
 *   rejected    - the user said no. A normal cancel, not an error.
 *   chain       - wrong network. Must be caught BEFORE any write is attempted.
 *   allowance   - the token transfer was not approved for this amount.
 *   revert      - the contract refused. Has a decodable reason, usually.
 *   funds       - not enough ETH for gas, or not enough tokens.
 *   replaced    - the transaction was superseded by another with the same nonce.
 *   unknown     - anything else. Reported verbatim rather than smoothed over.
 */
export const FailureClass = Object.freeze({
  REJECTED: 'rejected',
  CHAIN: 'chain',
  ALLOWANCE: 'allowance',
  REVERT: 'revert',
  FUNDS: 'funds',
  REPLACED: 'replaced',
  UNKNOWN: 'unknown',
});

/** Find an injected provider. Returns null rather than throwing. */
export function findProvider(win = globalThis) {
  const eth = win?.ethereum;
  if (!eth) return null;
  // Several wallets can inject at once. `providers` lists them; the first is the
  // one the user made primary in their browser.
  if (Array.isArray(eth.providers) && eth.providers.length) return eth.providers[0];
  return eth;
}

/** Hex helpers, kept local so this module does not depend on viem for them. */
export const hexToBigInt = (h) => (h == null ? 0n : BigInt(h));
export const bigIntToHex = (v) => '0x' + v.toString(16);

/**
 * Pull the most useful message out of whatever the wallet or viem threw.
 *
 * Walk outward-in collecting codes, and return the OUTERMOST message: viem wraps
 * provider errors and puts a readable summary on the outside with the raw
 * provider text nested under it. Returning the innermost message instead gives
 * the user "leaf" when the useful sentence was "top" -- which is why the
 * direction here is deliberate rather than incidental.
 *
 * All messages are returned as well, for callers that want to match on any part
 * of the chain rather than just the summary.
 */
export function errorDetails(err) {
  const codes = [];
  const messages = [];
  let node = err;
  for (let depth = 0; node && depth < 6; depth++) {
    if (typeof node.code === 'number' || typeof node.code === 'string') codes.push(Number(node.code));
    if (typeof node.shortMessage === 'string') messages.push(node.shortMessage);
    if (typeof node.message === 'string') messages.push(node.message);
    if (node.data && typeof node.data.message === 'string') messages.push(node.data.message);
    node = node.cause;
  }
  return { codes, message: messages[0] ?? String(err), messages };
}

/**
 * Decide which failure class an error belongs to.
 *
 * Deliberately conservative: only patterns that are unambiguous are matched, and
 * everything else falls through to UNKNOWN with the original message intact.
 * Guessing that some unfamiliar error is "a revert" would hide it behind a tidy
 * explanation that happens to be wrong.
 */
export function classify(err) {
  const { codes, message } = errorDetails(err);
  const m = message.toLowerCase();

  if (codes.includes(USER_REJECTED) || /user (rejected|denied|cancell?ed)|rejected by user/.test(m)) {
    return { class: FailureClass.REJECTED, message, codes };
  }
  if (/chain mismatch|wrong (network|chain)|chainid.*(mismatch|expected)|does not match the target chain/.test(m)) {
    return { class: FailureClass.CHAIN, message, codes };
  }
  if (/insufficient (funds|balance)|exceeds balance|transfer amount exceeds/.test(m)) {
    return { class: FailureClass.FUNDS, message, codes };
  }
  if (/allowance|insufficient allowance|erc20: insufficient/.test(m)) {
    return { class: FailureClass.ALLOWANCE, message, codes };
  }
  if (/replacement transaction underpriced|transaction was replaced|replaced by/.test(m)) {
    return { class: FailureClass.REPLACED, message, codes };
  }
  if (/execution reverted|revert|call exception/.test(m)) {
    return { class: FailureClass.REVERT, message, codes };
  }
  return { class: FailureClass.UNKNOWN, message, codes };
}

/** What the UI should show for each class. Kept next to the classification so
 *  the two cannot drift. */
export function describeFailure(classified) {
  switch (classified.class) {
    case FailureClass.REJECTED:
      return { tone: 'neutral', title: 'Cancelled', detail: 'You rejected the request in your wallet. Nothing was sent.' };
    case FailureClass.CHAIN:
      return { tone: 'error', title: 'Wrong network', detail: 'Your wallet is on a different chain than this vault. Switch networks and try again.' };
    case FailureClass.ALLOWANCE:
      return { tone: 'error', title: 'Approval needed', detail: 'The vault is not approved to move that many tokens yet.' };
    case FailureClass.REVERT:
      return { tone: 'error', title: 'The contract refused it', detail: classified.message };
    case FailureClass.FUNDS:
      return { tone: 'error', title: 'Not enough funds', detail: classified.message };
    case FailureClass.REPLACED:
      return { tone: 'warn', title: 'Transaction replaced', detail: 'Your wallet replaced this transaction with another one.' };
    default:
      return { tone: 'error', title: 'Failed', detail: classified.message };
  }
}

/**
 * A connected wallet: account, chain, and the events that change them.
 *
 * Chain changes are surfaced rather than swallowed. A dApp that silently keeps
 * working after the user switches networks is a dApp that will eventually send a
 * transaction to the wrong one.
 */
export class Wallet {
  #provider;
  #listeners = new Set();
  #state = { account: null, chainId: null, connected: false };

  // Declared here because private fields must be declared in the class body, not
  // introduced by assignment inside the constructor. Assigning them only in the
  // constructor is a syntax error, which is how this was found.
  #onAccountsChanged;
  #onChainChanged;
  #onDisconnect;

  constructor(provider) {
    if (!provider || typeof provider.request !== 'function') {
      throw new Error('not an EIP-1193 provider: no request() method');
    }
    this.#provider = provider;

    // Bound once so they can be removed again; an unremovable listener is how a
    // hot-reloading page ends up with five of them.
    this.#onAccountsChanged = (accounts) => {
      const account = accounts && accounts.length ? accounts[0] : null;
      // Some wallets report an empty array on disconnect rather than emitting
      // `disconnect`, so an empty list is treated as disconnection.
      this.#set({ account, connected: Boolean(account) });
    };
    this.#onChainChanged = (chainIdHex) => {
      this.#set({ chainId: Number(hexToBigInt(chainIdHex)) });
    };
    this.#onDisconnect = () => {
      this.#set({ account: null, connected: false });
    };

    provider.on?.('accountsChanged', this.#onAccountsChanged);
    provider.on?.('chainChanged', this.#onChainChanged);
    provider.on?.('disconnect', this.#onDisconnect);
  }

  get state() {
    return { ...this.#state };
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(fn) {
    this.#listeners.add(fn);
    fn(this.state);
    return () => this.#listeners.delete(fn);
  }

  #set(patch) {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn(this.state);
  }

  /** Ask for accounts, which is what opens the wallet's connect prompt. */
  async connect() {
    const accounts = await this.#provider.request({ method: 'eth_requestAccounts' });
    const account = Array.isArray(accounts) ? accounts[0] ?? null : null;
    if (!account) throw new Error('the wallet returned no account');
    const chainId = Number(hexToBigInt(await this.#provider.request({ method: 'eth_chainId' })));
    this.#set({ account, chainId, connected: true });
    return this.state;
  }

  /** Re-read account and chain without prompting. Used on page load, where a
   *  prompt would be wrong: the user has not asked to do anything yet. */
  async refresh() {
    const accounts = await this.#provider.request({ method: 'eth_accounts' });
    const account = Array.isArray(accounts) ? accounts[0] ?? null : null;
    const chainId = Number(hexToBigInt(await this.#provider.request({ method: 'eth_chainId' })));
    this.#set({ account, chainId, connected: Boolean(account) });
    return this.state;
  }

  /**
   * Refuse to write on the wrong chain.
   *
   * Called before every write rather than only on connect, because a wallet can
   * change networks between two clicks -- and the window between clicking
   * "deposit" and the wallet showing its prompt is exactly when it happens.
   */
  assertChain(expectedChainId) {
    if (this.#state.chainId === null) throw new Error('wallet is not connected');
    if (Number(this.#state.chainId) !== Number(expectedChainId)) {
      const err = new Error(`chain mismatch: wallet is on ${this.#state.chainId}, expected ${expectedChainId}`);
      err.code = -32000;
      throw err;
    }
  }

  /** Ask the wallet to switch chains. Not all wallets support this. */
  async switchChain(chainId, { chainName, rpcUrl, nativeCurrency, blockExplorerUrl } = {}) {
    const hex = '0x' + Number(chainId).toString(16);
    try {
      await this.#provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (err) {
      const { codes } = errorDetails(err);
      // 4902 is the EIP-3085 "unknown chain" code: the wallet has never seen it.
      if (codes.includes(4902) && rpcUrl) {
        await this.#provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hex,
              chainName: chainName ?? `Chain ${chainId}`,
              rpcUrls: [rpcUrl],
              nativeCurrency: nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
              ...(blockExplorerUrl ? { blockExplorerUrls: [blockExplorerUrl] } : {}),
            },
          ],
        });
        return;
      }
      throw err;
    }
  }

  /** The raw provider, for the rare places that need it. */
  get provider() {
    return this.#provider;
  }

  destroy() {
    this.#provider.removeListener?.('accountsChanged', this.#onAccountsChanged);
    this.#provider.removeListener?.('chainChanged', this.#onChainChanged);
    this.#provider.removeListener?.('disconnect', this.#onDisconnect);
    this.#listeners.clear();
  }
}

/**
 * Send a transaction via the wallet and follow it until it is mined.
 *
 * Handles the case a naive implementation misses: if the wallet REPLACES the
 * transaction -- the user pressed "speed up", which resends the same nonce with
 * a higher fee -- then the original hash never gets a receipt and a loop that
 * only polls that hash waits forever. So the nonce is what is tracked, and the
 * hash is what is reported.
 *
 * @param provider EIP-1193 provider
 * @param tx       {from, to, data, value?}
 * @param onStage  called with 'sent' | 'mined' | 'replaced' and the current hash
 */
export async function sendAndTrack(provider, tx, { onStage = () => {}, pollMs = 1000, timeoutMs = 180_000 } = {}) {
  const accounts = await provider.request({ method: 'eth_accounts' });
  const from = tx.from ?? (Array.isArray(accounts) ? accounts[0] : null);
  if (!from) throw new Error('no account available to send from');

  let hash;
  try {
    hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: tx.to, data: tx.data, ...(tx.value !== undefined ? { value: bigIntToHex(BigInt(tx.value)) } : {}) }],
    });
  } catch (err) {
    // Rejection happens here: the user closed or declined the prompt.
    throw Object.assign(new Error(errorDetails(err).message), { cause: err, classified: classify(err) });
  }
  onStage('sent', hash);

  // The nonce this transaction occupies. Anything mined at this nonce is either
  // our transaction or a replacement of it -- never a different one.
  let nonce = null;
  try {
    const pendingCount = await provider.request({
      method: 'eth_getTransactionCount',
      params: [from, 'pending'],
    });
    nonce = hexToBigInt(pendingCount);
  } catch {
    // Not fatal. Without a nonce we simply cannot detect replacement, and the
    // loop below degrades to polling the hash.
  }

  const started = Date.now();
  for (;;) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      return { hash, receipt, status: receipt.status === '0x1' ? 'success' : 'reverted' };
    }

    if (nonce !== null) {
      const current = hexToBigInt(await provider.request({ method: 'eth_getTransactionCount', params: [from, 'latest'] }));
      if (current > nonce) {
        // The nonce is consumed but our hash has no receipt: something else
        // landed in this slot. Find it so the user can be shown what happened.
        const replacedBy = await findTransactionAtNonce(provider, from, nonce);
        return { hash: replacedBy ?? hash, replaced: true, status: 'replaced', originalHash: hash };
      }
    }

    if (Date.now() - started > timeoutMs) {
      return { hash, status: 'pending', timedOut: true };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Look up the transaction that actually occupies a nonce, if the node keeps it. */
async function findTransactionAtNonce(provider, from, nonce) {
  try {
    const count = hexToBigInt(await provider.request({ method: 'eth_getBlockTransactionCountByNumber', params: ['latest'] }));
    for (let i = 0n; i < count; i++) {
      const candidate = await provider.request({
        method: 'eth_getTransactionByBlockNumberAndIndex',
        params: ['latest', bigIntToHex(i)],
      });
      if (candidate && candidate.from?.toLowerCase() === from.toLowerCase() && hexToBigInt(candidate.nonce) === nonce) {
        return candidate.hash;
      }
    }
  } catch {
    // Not every node supports these. Replacement detection then reports only
    // that the nonce moved on, which is still better than waiting forever.
  }
  return null;
}
