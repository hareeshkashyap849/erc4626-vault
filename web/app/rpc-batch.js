/**
 * A JSON-RPC batching transport.
 *
 * WHY THIS EXISTS
 *
 * `readState` needs eight values from the chain, and viem issues eight separate
 * HTTP requests for them. That is fine at a five-second poll and unacceptable at a
 * one-second one: the page would make eight requests a second to answer "has
 * anything changed", against a chain that produces a block every two seconds.
 *
 * JSON-RPC has an array form for exactly this. This transport collects requests that
 * arrive in the same tick, sends them as ONE array, and hands each response back to
 * the caller that asked for it. Eight requests become one; the page can then poll as
 * fast as the chain actually changes.
 *
 * WHY NOT `multicall`
 *
 * Multicall3 is the usual answer and it is better on mainnet -- one `eth_call`, no
 * JSON-RPC extension needed. It needs the Multicall3 contract to exist at its
 * canonical address, and this demo runs on a fresh local chain where nothing is
 * deployed unless our own scripts put it there. Relying on it would make the page
 * work on a real network and fail on the local one, which is backwards for a demo
 * whose whole point is working offline. Batching is supported by anvil, geth, and
 * every hosted provider, and needs nothing deployed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No retries, no timeouts beyond the caller's own, no reordering guarantees. An
 * error response is handed to the one request it belongs to, so a single failing
 * call does not fail the batch -- which matters because `readState` reads nine
 * things and one bad read should not blank the page.
 */

/** Wait this long for company before sending. One macrotask, essentially. */
const DEFAULT_WINDOW_MS = 8;

/**
 * @param rpcUrl  the JSON-RPC endpoint to POST batches to
 * @param fetchFn injected so tests can drive it without a network
 * @param windowMs how long to collect requests before flushing
 */
export function batchTransport({ rpcUrl, fetchFn = globalThis.fetch, windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!rpcUrl) throw new Error('batchTransport needs an rpcUrl');
  if (typeof fetchFn !== 'function') throw new Error('batchTransport needs a fetch implementation');

  let nextId = 1;
  let queue = [];
  let timer = null;

  const flush = async () => {
    timer = null;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;

    // A single request is sent on its own rather than wrapped in an array. Some
    // proxies and nodes handle the object form more reliably, and there is nothing
    // to gain from an array of one.
    const payload =
      batch.length === 1
        ? { jsonrpc: '2.0', id: batch[0].id, method: batch[0].method, params: batch[0].params }
        : batch.map((r) => ({ jsonrpc: '2.0', id: r.id, method: r.method, params: r.params }));

    let body;
    try {
      const res = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      body = await res.json();
    } catch (err) {
      // Every request in the batch fails with the same transport error, which is
      // what the caller would have seen individually.
      for (const r of batch) r.reject(err);
      return;
    }

    // The response to an array request is an array, and the order is not guaranteed
    // by the specification -- so responses are matched by id, never by position.
    const byId = new Map();
    if (Array.isArray(body)) {
      for (const entry of body) byId.set(entry.id, entry);
    } else {
      byId.set(body.id, body);
    }

    for (const r of batch) {
      const entry = byId.get(r.id);
      if (!entry) {
        r.reject(new Error(`no response for ${r.method} (id ${r.id}) in the batch`));
      } else if (entry.error) {
        r.reject(Object.assign(new Error(entry.error.message ?? 'rpc error'), { code: entry.error.code, data: entry.error.data }));
      } else {
        r.resolve(entry.result);
      }
    }
  };

  return async function request({ method, params }) {
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, method, params, resolve, reject });
      if (timer === null) timer = setTimeout(flush, windowMs);
    });
  };
}

/**
 * A viem-compatible transport built on the batcher.
 *
 * viem's `custom` transport expects a function that takes `{ method, params }` and
 * returns a promise of the raw result, which is exactly what the batcher provides.
 * Composing them means nothing else in the app changes.
 */
export function makeBatchedClient(viem, { rpcUrl, fetchFn, windowMs } = {}) {
  return viem.createPublicClient({
    transport: viem.custom({ request: batchTransport({ rpcUrl, fetchFn, windowMs }) }),
  });
}
