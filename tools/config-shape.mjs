/**
 * The config object the page reads. ONE definition, two producers.
 *
 * The page has never contained an address: it reads them at runtime. In development
 * that came from `GET /api/config`, served by `tools/dev-server.mjs` out of
 * `deployments/local.json`. A static host has no server, so the same object is written
 * to a file at build time instead -- and if the two producers derived it separately,
 * the published page and the local page would drift in exactly the fields that decide
 * which contract is called.
 *
 * So the derivation lives here, and both callers pass in the one thing that differs:
 * where reads are sent. In development that is the same-origin `/api/rpc` proxy; on a
 * static host it is the public endpoint in the record, because there is no proxy and
 * a browser can reach it directly (measured: `sepolia.base.org` answers CORS with `*`,
 * answers a real OPTIONS preflight for a JSON POST with 204/POST/content-type, and
 * accepts the nine-call batch this page sends).
 */

/**
 * @param record  a deployment record, as written by the deploy script
 * @param readRpcUrl  where the PAGE sends its reads: an absolute URL on a static host,
 *                    a page-relative path when a proxy is in front
 * @param candlesUrl  where the page asks for price history, or `null` when there is no
 *                    route to the index service at all (a static host). `null` is
 *                    deliberate and not a default: the page then says it has no route,
 *                    instead of blaming a service it never contacted.
 */
export function deriveConfig(record, { readRpcUrl, candlesUrl = 'api/candles' }) {
  return {
    ...record,
    // Derived here, not required from the record.
    //
    // `chainName` and `walletRpcUrl` were added to the deploy script after the first
    // local.json was written, so a record from an older script lacks them -- and the page
    // then cannot call `wallet_addEthereumChain` at all, which shows up as "switch
    // network did nothing" rather than as a missing field. Defaulting them means an old
    // record still works.
    //
    // `walletRpcUrl` must be ABSOLUTE in every environment: a wallet is told this URL
    // directly, and a wallet cannot use a page-relative path.
    chainName: record.chainName ?? `Chain ${record.chainId}`,
    walletRpcUrl: record.walletRpcUrl ?? record.rpcUrl,
    rpcUrl: readRpcUrl,
    candlesUrl,
  };
}

/**
 * Refuse a record that cannot address a contract.
 *
 * An absent or malformed address must be fatal HERE rather than at the first read: a
 * page built from a record with no vault renders the same as a page whose chain is
 * down, and those need different fixes.
 */
export function assertUsableRecord(record, source) {
  const problems = [];
  if (!record || typeof record !== 'object') problems.push('it is not an object');
  else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(record.vault ?? '')) problems.push(`vault is not an address: ${record.vault}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(record.asset ?? '')) problems.push(`asset is not an address: ${record.asset}`);
    if (!Number.isInteger(record.chainId)) problems.push(`chainId is not an integer: ${record.chainId}`);
  }
  if (problems.length) throw new Error(`${source} is not usable as a deployment record:\n  - ${problems.join('\n  - ')}`);
  return record;
}
