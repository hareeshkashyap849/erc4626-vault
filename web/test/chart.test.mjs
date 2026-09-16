/**
 * Front-end chart tests.
 *
 * These run without a browser, so they cannot prove the chart LOOKS right. What they
 * can prove is the part that was wrong in this codebase before and would be wrong
 * again silently: the arithmetic that decides whether anything is drawn at all, and
 * the wording that decides what the panel CLAIMS.
 *
 * The specific failure this file exists for: this vault's price is almost constant --
 * every yield report raises the totals proportionally and mints nothing, so the price
 * moves by less than one part in 10^5 and rounds to the same 6-decimal string. A
 * naive scale divides by (max - min) = 0, produces NaN coordinates, and draws a BLANK
 * chart for a perfectly healthy vault. Nothing throws. Nothing logs. The panel just
 * looks like there is no data, which is a different and worse claim than "the price
 * has not moved".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clear,
  describe as describeView,
  hasMovement,
  load,
  plotFor,
  render,
  slotWidth,
  timeLabel,
  toNumber,
  unavailableDetail,
  viewOf,
} from '../app/chart.js';

// ── a DOM double, deliberately no weaker than what the code needs ────────────
//
// `mblode-agent-skills/skills/ui-verification` and the design playbook both say the
// same thing: a double that is LESS capable than the real object turns a real bug into
// a test-harness error, and the harness error is what gets debugged. This one covers
// every method `render` and `clear` call, and it records children so a test can count
// what was drawn.
class FakeNode {
  tagName;
  attributes = {};
  children = [];
  textContent = null;
  constructor(tagName) {
    this.tagName = tagName;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i === -1) throw new Error('removeChild: not a child');
    this.children.splice(i, 1);
    return child;
  }
  /** Every descendant, depth first -- so a test can ask what was drawn. */
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  byClass(cls) {
    return this.all().filter((n) => (n.attributes.class ?? '').split(/\s+/).includes(cls));
  }
}

function fakeDocument() {
  return {
    createElementNS: (_ns, tag) => new FakeNode(tag),
  };
}

/** The code calls the global `document`; install the double for the duration. */
function withDocument(fn) {
  const g = globalThis;
  const saved = g.document;
  g.document = fakeDocument();
  try {
    return fn();
  } finally {
    g.document = saved;
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

const candle = (
  startsAt,
  open,
  high,
  low,
  close,
  points = 1,
  firstBlock = startsAt,
  lastBlock = firstBlock,
) => ({ startsAt, endsAt: startsAt + 60, open, high, low, close, points, firstBlock, lastBlock });

/** Three candles that move. */
const MOVING = [
  candle(1_000_000, '1.10', '1.15', '1.09', '1.14'),
  candle(1_000_060, '1.14', '1.14', '1.08', '1.09'),
  candle(1_000_120, '1.09', '1.20', '1.09', '1.19'),
];

/**
 * What this vault actually produces: a price that rounds to the same string.
 *
 * Taken from the real series -- blocks 5744..6243 all report `1.1`, which is why the
 * live reconciliation of OHLC says "the price did not move in this window".
 */
const FLAT = [
  candle(1_000_000, '1.1', '1.1', '1.1', '1.1', 30),
  candle(1_000_060, '1.1', '1.1', '1.1', '1.1', 29),
  candle(1_000_120, '1.1', '1.1', '1.1', '1.1', 30),
];

// ── plotFor: the flat series ─────────────────────────────────────────────────

test('a FLAT series still produces a usable scale, not a division by zero', () => {
  // This is the bug the file is written around. Without the zero-range guard,
  // `(v - min) / (max - min)` is 0/0 = NaN, and NaN coordinates draw nothing.
  const plot = plotFor(FLAT);
  const y = plot.y(toNumber('1.1'));
  assert.ok(Number.isFinite(y), `y must be finite for a flat series, got ${y}`);
  assert.ok(y > 0 && y < 1, `y must be inside the plot area, got ${y}`);
  assert.ok(Number.isFinite(plot.min) && Number.isFinite(plot.max), 'the scale must be finite');
  assert.ok(plot.max > plot.min, 'the scale must have a positive span');
});

test('the flat series is centred, so it reads as "no movement" rather than "at the floor"', () => {
  // Expanding the range symmetrically is a claim: the value is in the middle of a
  // window the code invented. Anchoring it at the bottom instead would look like a
  // series that has collapsed and is now pinned to zero.
  const plot = plotFor(FLAT);
  const y = plot.y(toNumber('1.1'));
  assert.ok(Math.abs(y - 0.5) < 1e-9, `a flat series must be centred, got y=${y}`);
});

test('a flat series at zero is still drawable', () => {
  // `Math.abs(min) * 0.001` is 0 when the value is 0, so the spread has to fall back
  // to an absolute magnitude. Without that, a vault that has never held anything
  // divides by zero again.
  const plot = plotFor([candle(1, '0', '0', '0', '0')]);
  const y = plot.y(0);
  assert.ok(Number.isFinite(y), `y must be finite at zero, got ${y}`);
  assert.ok(plot.max > plot.min, 'the scale must have a positive span at zero');
});

test('a moving series maps low to the bottom and high to the top, with margin', () => {
  const plot = plotFor(MOVING);
  const yLow = plot.y(toNumber('1.08')); // the overall low
  const yHigh = plot.y(toNumber('1.20')); // the overall high
  assert.ok(yLow < yHigh, 'a lower price must map to a smaller y-fraction');
  assert.ok(yLow > 0, 'the low must not sit exactly on the edge');
  assert.ok(yHigh < 1, 'the high must not sit exactly on the edge');
});

test('every value in the series maps inside 0..1', () => {
  const plot = plotFor(MOVING);
  for (const c of MOVING) {
    for (const v of [c.open, c.high, c.low, c.close]) {
      const y = plot.y(toNumber(v));
      assert.ok(y >= 0 && y <= 1, `${v} mapped to ${y}, outside the plot area`);
    }
  }
});

test('an empty series gets a valid scale rather than NaN', () => {
  const plot = plotFor([]);
  assert.ok(Number.isFinite(plot.min) && Number.isFinite(plot.max));
  assert.ok(Number.isFinite(plot.y(123)));
});

// ── toNumber is for drawing only ─────────────────────────────────────────────

test('toNumber reads a plain and a grouped decimal', () => {
  assert.equal(toNumber('1.1'), 1.1);
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber(''), 0, 'an unreadable value must not become NaN in a coordinate');
});

test('toNumber refuses to invent a number for something that is not one', () => {
  // NaN in an SVG coordinate makes the element disappear. A zero draws a visible but
  // wrong bar, which is the lesser evil AND is visible -- but neither should happen,
  // so the caller must never pass a non-number. This pins the fallback.
  assert.equal(toNumber('not-a-number'), 0);
});

// ── viewOf / describe: what the panel claims ─────────────────────────────────

test('a response with candles becomes ready, and keeps the exact strings', () => {
  const view = viewOf({
    candles: MOVING,
    count: 3,
    pointsPulled: 90,
    pointsSkipped: 0,
    bucketSeconds: 60,
    limit: 5000,
    maxLimit: 5000,
    seriesFromBlock: 168,
  });
  assert.equal(view.mode, 'ready');
  assert.equal(view.candles.length, 3);
  // The strings are what the tooltip prints, so rounding them here would make the
  // tooltip disagree with the API for no reason.
  assert.equal(view.candles[0].high, '1.15');
});

test('a response with no candles is empty, NOT unavailable', () => {
  // The distinction matters: "the service answered and has no history" is a fact about
  // the vault; "we could not reach the service" is a fact about us. Conflating them
  // tells the user to wait for data that is never coming.
  const view = viewOf({
    candles: [],
    count: 0,
    pointsPulled: 0,
    pointsSkipped: 0,
    bucketSeconds: 60,
    limit: 5000,
    maxLimit: 5000,
    seriesFromBlock: null,
  });
  assert.equal(view.mode, 'empty');
});

test('a malformed candles field does not throw', () => {
  const view = viewOf({ candles: undefined, count: 0 });
  assert.equal(view.mode, 'empty');
});

test('describe for a flat window says the price did not move', () => {
  const text = describeView({ mode: 'ready', detail: '', candles: FLAT, bucketSeconds: 60 });
  assert.match(text, /did not move/, `a flat window must say so, got: ${text}`);
  assert.match(text, /3 60s candles/);
});

test('describe for a moving window does NOT claim the price was flat', () => {
  const text = describeView({ mode: 'ready', detail: '', candles: MOVING, bucketSeconds: 60 });
  assert.doesNotMatch(text, /did not move/);
});

test('describe for an unavailable service repeats the reason and never says "no data"', () => {
  const text = describeView({
    mode: 'unavailable',
    detail: 'The index service is not reachable (ECONNREFUSED).',
    candles: [],
    bucketSeconds: 0,
  });
  assert.match(text, /not reachable/);
  assert.doesNotMatch(text, /no data/i, 'an unreachable service is not an absence of data');
});

test('describe for a stale view says the reading is old', () => {
  const text = describeView({ mode: 'stale', detail: '', candles: MOVING, bucketSeconds: 60 });
  assert.match(text, /last reading/);
});

test('hasMovement is false only when nothing changed', () => {
  assert.equal(hasMovement(FLAT), false);
  assert.equal(hasMovement(MOVING), true);
  assert.equal(hasMovement([]), false);
  // A wick but no body still counts: the price touched a different value.
  assert.equal(hasMovement([candle(1, '1', '1.1', '1', '1')]), true);
});

// ── unavailableDetail: sentences, not codes ──────────────────────────────────

test('unavailableDetail explains a refused connection without a raw exception', () => {
  const s = unavailableDetail(undefined, 'ECONNREFUSED');
  assert.match(s, /not reachable/);
  assert.match(s, /ECONNREFUSED/);
  // It must also say the rest of the page is fine, because that is the user's real
  // question when a panel goes blank.
  assert.match(s, /balances above do not/);
});

test('unavailableDetail distinguishes a missing endpoint from a server error', () => {
  assert.match(unavailableDetail(404, 'Not Found'), /does not serve/);
  assert.match(unavailableDetail(500, 'Internal Server Error'), /error \(500\)/);
  assert.match(unavailableDetail(400, 'Bad Request'), /refused the request \(400\)/);
});

// ── slotWidth ────────────────────────────────────────────────────────────────

test('slotWidth stays inside its slot and never exceeds the cap', () => {
  assert.ok(slotWidth(3) <= 1 / 3, 'a slot must not overflow its share of the width');
  assert.ok(slotWidth(100) < 0.01);
  assert.ok(slotWidth(1000) > 0, 'a lot of candles must still draw something');
  assert.equal(slotWidth(0), 0);
});

test('timeLabel is zero-padded so the axis lines up', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  const label = timeLabel(Math.floor(d.getTime() / 1000));
  assert.match(label, /^\d{2}:\d{2}$/, `got ${label}`);
});

// ── render: the SVG is actually built ────────────────────────────────────────

test('render draws a wick and a body for every candle, plus gridlines', () => {
  withDocument(() => {
    const svg = new FakeNode('svg');
    render(svg, { mode: 'ready', detail: '', candles: MOVING, bucketSeconds: 60 });
    const node = svg;
    assert.equal(node.byClass('chart-wick').length, 3, 'one wick per candle');
    assert.equal(node.byClass('chart-body').length, 3, 'one body per candle');
    assert.equal(node.byClass('chart-grid').length, 3, 'three gridlines');
    // A wick carries the classes together: `chart-wick up`.
    assert.equal(node.byClass('up').length + node.byClass('down').length, 6);
  });
});

test('render produces FINITE coordinates for the flat series', () => {
  // The end-to-end version of the divide-by-zero check: not just that `plotFor`
  // returns a number, but that no NaN reaches an attribute. A NaN in `y` makes the
  // element invisible, so this is the difference between a flat line and a blank panel.
  withDocument(() => {
    const svg = new FakeNode('svg');
    render(svg, { mode: 'ready', detail: '', candles: FLAT, bucketSeconds: 60 });
    const node = svg;
    for (const el of node.all()) {
      for (const [k, v] of Object.entries(el.attributes)) {
        assert.doesNotMatch(v, /NaN|undefined|Infinity/, `${el.tagName}.${k} = ${v}`);
      }
    }
  });
});

test('render gives an open === close candle a visible body height', () => {
  // A doji is a real candle, not missing data. A zero-height rect draws nothing, which
  // reads as a gap in the series.
  withDocument(() => {
    const svg = new FakeNode('svg');
    render(svg, { mode: 'ready', detail: '', candles: [candle(1, '1.1', '1.1', '1.1', '1.1')], bucketSeconds: 60 });
    const body = svg.byClass('chart-body')[0];
    assert.ok(Number(body.attributes.height) > 0, `a doji must have height, got ${body.attributes.height}`);
  });
});

test('render draws a placeholder, not an empty SVG, when there is nothing to show', () => {
  for (const mode of ['empty', 'unavailable']) {
    withDocument(() => {
      const svg = new FakeNode('svg');
      render(svg, { mode, detail: 'because', candles: [], bucketSeconds: 0 });
      const node = svg;
      const text = node.all().find((n) => n.tagName === 'text');
      assert.ok(text, `${mode} must draw an explicit placeholder`);
      assert.equal(text.textContent, mode === 'unavailable' ? 'chart unavailable' : 'no history yet');
      assert.equal(node.byClass('chart-body').length, 0);
    });
  }
});

test('render replaces the previous drawing instead of appending to it', () => {
  // A chart that accumulates a candle per refresh grows without bound and eventually
  // shows history that is duplicated. `clear` is the guard.
  withDocument(() => {
    const svg = new FakeNode('svg');
    for (let i = 0; i < 5; i++) {
      render(svg, { mode: 'ready', detail: '', candles: MOVING, bucketSeconds: 60 });
    }
    assert.equal(svg.byClass('chart-body').length, 3, 'still three bodies after five renders');
  });
});

test('the tooltip carries the exact strings and the block range', () => {
  // This is where a one-base-unit move survives: the geometry may round it away, the
  // tooltip does not.
  withDocument(() => {
    const svg = new FakeNode('svg');
    render(svg, { mode: 'ready', detail: '', candles: [candle(1, '1.1', '1.100001', '1.1', '1.1', 7, 100, 106)], bucketSeconds: 60 });
    const title = svg.all().find((n) => n.tagName === 'title');
    assert.match(title.textContent, /1\.100001/);
    assert.match(title.textContent, /7 blocks/);
    assert.match(title.textContent, /100–106/);
  });
});

test('clear removes every child and tolerates an empty node', () => {
  const node = new FakeNode('svg');
  node.appendChild(new FakeNode('a'));
  node.appendChild(new FakeNode('b'));
  clear(node);
  assert.equal(node.children.length, 0);
  clear(node); // must not throw on an already-empty node
  assert.equal(node.children.length, 0);
});

// ── load: the failure paths ──────────────────────────────────────────────────

const jsonResponse = (body, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => body });

test('load returns ready for a good response', async () => {
  const view = await load(async () => jsonResponse({ candles: MOVING, count: 3, bucketSeconds: 60 }));
  assert.equal(view.mode, 'ready');
  assert.equal(view.candles.length, 3);
});

test('load returns unavailable when the fetch itself fails, and does not throw', async () => {
  // This is the realistic case: the index service is a separate process and is simply
  // not running. The page must survive it.
  const view = await load(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(view.mode, 'unavailable');
  assert.match(view.detail, /not reachable/);
});

test('load returns unavailable for an HTTP error, naming the status', async () => {
  const view = await load(async () => jsonResponse({}, 503));
  assert.equal(view.mode, 'unavailable');
  assert.match(view.detail, /503/);
});

test('load returns unavailable when the body is not JSON', async () => {
  const bad = { ok: true, status: 200, statusText: 'OK', json: async () => { throw new SyntaxError('bad json'); } };
  const view = await load(async () => bad);
  assert.equal(view.mode, 'unavailable');
  assert.match(view.detail, /not JSON|not reachable/);
});

test('load with an empty history is empty, not an error', async () => {
  const view = await load(async () => jsonResponse({ candles: [], count: 0, bucketSeconds: 60 }));
  assert.equal(view.mode, 'empty');
});

test('load asks for the same-origin proxy path by default', async () => {
  // The page must not hard-code the index service's host: the dev server proxies it so
  // the page stays same-origin, and a second hard-coded URL is a second thing to get
  // wrong at deploy time.
  const seen = [];
  await load(async (url) => {
    seen.push(String(url));
    return jsonResponse({ candles: [], count: 0, bucketSeconds: 60 });
  });
  assert.deepEqual(seen, ['/api/candles']);
});

test('every mode survives a render, so no state leaves the panel blank', () => {
  // A table of the states the page can be in. If a new one is added and not handled,
  // this is where it shows up rather than on a user's screen.
  const states = [
    { mode: 'empty', detail: '', candles: [], bucketSeconds: 0 },
    { mode: 'unavailable', detail: 'down', candles: [], bucketSeconds: 0 },
    { mode: 'stale', detail: '', candles: FLAT, bucketSeconds: 60 },
    { mode: 'ready', detail: '', candles: MOVING, bucketSeconds: 60 },
  ];
  withDocument(() => {
    for (const v of states) {
      const svg = new FakeNode('svg');
      render(svg, v);
      const node = svg;
      assert.ok(node.children.length > 0, `${v.mode} rendered nothing at all`);
      assert.ok(node.getAttribute('aria-label'), `${v.mode} has no accessible label`);
    }
  });
});
