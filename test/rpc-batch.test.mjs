/**
 * Tests for the JSON-RPC batcher.
 *
 * WHY THIS NEEDS ITS OWN TESTS
 *
 * The batcher sits between the page and the chain and pairs responses to requests.
 * If it ever pairs them WRONG, every figure on the page is silently attached to the
 * wrong question -- `totalAssets` showing the share supply, a balance showing an
 * allowance -- and nothing would throw. That is the worst possible failure shape:
 * plausible numbers, no error, and every downstream test still green because they
 * all go through the same broken pairing.
 *
 * So the pairing gets tested directly, including with the responses deliberately
 * returned in the WRONG ORDER, which the JSON-RPC specification permits.
 *
 * Run: node test/rpc-batch.test.mjs
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { batchTransport } from '../web/app/rpc-batch.js';

/** A fake fetch that records what it was asked and replies as instructed. */
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url, payload });
    const body = responder(payload, calls.length);
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- the basics

test('a single request is sent on its own, not wrapped in an array', async () => {
  const fetchFn = fakeFetch((payload) => ({ jsonrpc: '2.0', id: payload.id, result: '0x1' }));
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const result = await request({ method: 'eth_chainId', params: [] });

  assert.equal(result, '0x1');
  assert.equal(fetchFn.calls.length, 1, 'one HTTP request');
  assert.ok(!Array.isArray(fetchFn.calls[0].payload), 'sent as an object, not an array of one');
});

test('several requests in the same tick become ONE HTTP request', async () => {
  const fetchFn = fakeFetch((payload) =>
    payload.map((r) => ({ jsonrpc: '2.0', id: r.id, result: `result-for-${r.method}` })),
  );
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const results = await Promise.all([
    request({ method: 'totalAssets', params: [] }),
    request({ method: 'totalSupply', params: [] }),
    request({ method: 'decimals', params: [] }),
  ]);

  assert.deepEqual(results, ['result-for-totalAssets', 'result-for-totalSupply', 'result-for-decimals']);
  assert.equal(fetchFn.calls.length, 1, 'three reads, one request -- the entire point');
  assert.equal(fetchFn.calls[0].payload.length, 3);
});

test('requests in DIFFERENT ticks are sent separately', async () => {
  const fetchFn = fakeFetch((payload) => (Array.isArray(payload) ? payload : [payload]).map((r) => ({ jsonrpc: '2.0', id: r.id, result: 'x' })));
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 5 });

  await request({ method: 'a', params: [] });
  await new Promise((r) => setTimeout(r, 20));
  await request({ method: 'b', params: [] });

  assert.equal(fetchFn.calls.length, 2, 'nothing to batch with means nothing to batch');
});

/**
 * @dev The mis-pairing test. The JSON-RPC specification does NOT guarantee that a
 * batch response is in the same order as the request, so a batcher that pairs by
 * position is wrong even though it passes every test written against an
 * order-preserving fake.
 */
test('responses are matched by id, not by position', async () => {
  // Deliberately reversed, and with unrelated ids to make positional matching fail
  // loudly rather than accidentally succeed.
  const fetchFn = fakeFetch((payload) =>
    [...payload].reverse().map((r, i) => ({ jsonrpc: '2.0', id: r.id, result: `value-${r.method}-${i}` })),
  );
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const [assets, supply] = await Promise.all([request({ method: 'totalAssets', params: [] }), request({ method: 'totalSupply', params: [] })]);

  assert.equal(assets, 'value-totalAssets-1', 'totalAssets must get its own answer');
  assert.equal(supply, 'value-totalSupply-0', 'totalSupply must get its own answer');
  assert.notEqual(assets, supply, 'if these are equal the pairing is positional and broken');
});

test('a batch response with shuffled ids still pairs correctly', async () => {
  let seen = [];
  const fetchFn = fakeFetch((payload) => {
    seen = payload.map((r) => r.id);
    // Shuffle deterministically: reverse.
    return [...payload].reverse().map((r) => ({ jsonrpc: '2.0', id: r.id, result: `id-${r.id}` }));
  });
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const methods = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const results = await Promise.all(methods.map((m) => request({ method: m, params: [] })));

  results.forEach((value, i) => {
    assert.equal(value, `id-${seen[i]}`, `${methods[i]} got the wrong response`);
  });
  assert.equal(new Set(results).size, methods.length, 'every answer must be distinct');
});

// ------------------------------------------------------------------- errors

test('one failing call does not fail the others in its batch', async () => {
  const fetchFn = fakeFetch((payload) =>
    payload.map((r) => (r.method === 'bad' ? { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'execution reverted' } } : { jsonrpc: '2.0', id: r.id, result: 'fine' })),
  );
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const [good, bad, alsoGood] = await Promise.allSettled([
    request({ method: 'good', params: [] }),
    request({ method: 'bad', params: [] }),
    request({ method: 'alsoGood', params: [] }),
  ]);

  assert.equal(good.status, 'fulfilled');
  assert.equal(good.value, 'fine');
  assert.equal(alsoGood.status, 'fulfilled', 'a neighbour failing must not take this down');
  assert.equal(bad.status, 'rejected');
  assert.match(bad.reason.message, /execution reverted/);
  assert.equal(bad.reason.code, -32000, 'the RPC error code is preserved -- classification depends on it');
});

test('a missing response rejects only the request that is missing', async () => {
  const fetchFn = fakeFetch((payload) => payload.filter((r) => r.method !== 'lost').map((r) => ({ jsonrpc: '2.0', id: r.id, result: 'ok' })));
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const [kept, lost] = await Promise.allSettled([request({ method: 'kept', params: [] }), request({ method: 'lost', params: [] })]);

  assert.equal(kept.status, 'fulfilled');
  assert.equal(lost.status, 'rejected');
  assert.match(lost.reason.message, /no response for lost/);
});

test('a transport failure rejects every request in the batch', async () => {
  const fetchFn = async () => {
    throw new Error('connection refused');
  };
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const results = await Promise.allSettled([request({ method: 'a', params: [] }), request({ method: 'b', params: [] })]);

  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  for (const r of results) assert.match(r.reason.message, /connection refused/);
});

test('a non-array response is still matched by id', async () => {
  // Some endpoints answer a single-element batch with a bare object.
  const fetchFn = fakeFetch((payload) => {
    const first = Array.isArray(payload) ? payload[0] : payload;
    return { jsonrpc: '2.0', id: first.id, result: 'bare' };
  });
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  assert.equal(await request({ method: 'solo', params: [] }), 'bare');
});

// ------------------------------------------------------------------ hygiene

test('every request gets a distinct id', async () => {
  const fetchFn = fakeFetch((payload) => (Array.isArray(payload) ? payload : [payload]).map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.id })));
  const request = batchTransport({ rpcUrl: '/rpc', fetchFn, windowMs: 1 });

  const ids = await Promise.all(Array.from({ length: 20 }, () => request({ method: 'x', params: [] })));
  assert.equal(new Set(ids).size, 20, 'duplicate ids would make responses unpairable');
});

test('the batcher refuses to be constructed without an endpoint or a fetch', () => {
  assert.throws(() => batchTransport({ fetchFn: () => {} }), /needs an rpcUrl/);
  assert.throws(() => batchTransport({ rpcUrl: '/rpc', fetchFn: null }), /needs a fetch/);
});
