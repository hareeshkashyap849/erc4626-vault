/**
 * The price chart.
 *
 * WHAT THIS IS FOR, AND WHY IT IS NOT JUST A NUMBER
 *
 * The page already shows the share price as one figure. A figure answers "what is it
 * now"; a chart answers "what has it been", which is the question a vault's depositor
 * actually has -- because this vault's whole promise is that the price only goes up.
 * A single number cannot show a promise being kept.
 *
 * THE DATA COMES FROM THE INDEX SERVICE, NOT FROM THE CHAIN
 *
 * A node will answer "what are the totals now" and will not cheaply answer "what were
 * they at every block since deployment". That history is P4's job, and the page
 * reaches it through the same-origin `/api/candles` proxy the dev server provides.
 *
 * That makes the chart the one panel on this page with a DEPENDENCY THE CHAIN DOES NOT
 * IMPLY: the vault can be perfectly healthy while the index service is down. So the
 * failure path is a first-class state here, not an afterthought --
 * `renderChart` has an explicit `unavailable` mode, and the note never says "no data"
 * for something that is really "we could not ask".
 *
 * LIVE UPDATES ARE RE-READS, NOT ANIMATION
 *
 * `refreshNow()` on this module re-fetches. There is no interpolation between points
 * and no smoothing: the previous version of the sibling wallet code had a "refresh"
 * that only reset a timer, and a chart is exactly where that bug is invisible, because
 * a stale chart looks like a chart.
 *
 * THE DRAWING IS DELIBERATELY PLAIN SVG
 *
 * No canvas, no charting library, no build step -- the repository's front end loads the
 * module that is on disk. A library would also want to own the axis and the tooltip,
 * and the parts worth getting right here are the ones a library cannot check for us:
 * that the candles come from exact integers, and that an unavailable service says so.
 */

/** One candle, as `/api/candles` returns it: every value a decimal string. */
/** The response body, narrowed to what this module uses. */
/** How the chart should be drawn. `unavailable` is not an error state to hide. */
const EMPTY_VIEW = { mode: 'empty', detail: '', candles: [], bucketSeconds: 0 };

/**
 * A decimal string to a Number, for DRAWING ONLY.
 *
 * This is the one place a float is allowed, and it is allowed because geometry is a
 * float: SVG coordinates are floats, pixels are floats, and no reader can see the
 * 17th significant digit of a y position. The exact values stay strings and are what
 * the tooltip and the caption print -- so a high that is one base unit above the open
 * still reads as a different number even though it draws as the same pixel.
 *
 * Anything that compares or aggregates prices must NOT use this. `chart.ts` on the
 * service side does that in integers, and that is the point of its existence.
 */
export function toNumber(decimal) {
  const n = Number(decimal.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Scale a set of candles to plot coordinates. Pure, so it can be checked directly. */
/**
 * The vertical scale for a set of candles.
 *
 * A FLAT SERIES MUST NOT BE DRAWN AS A FLAT LINE AT THE BOTTOM.
 *
 * This vault's price is deliberately almost constant -- every yield report mints
 * nothing and raises the totals proportionally, so the price moves by less than one
 * part in 10^5 and rounds to the same 6-decimal string. If `max === min` the scale is
 * degenerate and the naive `(v - min) / (max - min)` is a division by zero, which in
 * SVG is `NaN` and draws NOTHING -- a blank chart for a perfectly healthy vault.
 *
 * So a zero range is expanded around the value, which produces a centred flat line.
 * That is honest: it says "this did not move" rather than implying a range that is not
 * there, and it keeps the candles visible.
 *
 * A deliberate margin is applied so the extremes are not glued to the edges; without
 * it a candle's wick sits exactly on the border and reads as clipped.
 */
export function plotFor(candles, marginFraction = 0.08) {
  if (candles.length === 0) return { min: 0, max: 1, y: () => 0.5 };

  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    for (const v of [c.open, c.high, c.low, c.close]) {
      const n = toNumber(v);
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, y: () => 0.5 };

  if (max === min) {
    // Symmetric around the single value, at a magnitude a reader can see. 0.1% of the
    // value, or a millionth of a unit when the value is zero.
    const spread = Math.abs(min) > 0 ? Math.abs(min) * 0.001 : 1e-6;
    min -= spread;
    max += spread;
  } else {
    const pad = (max - min) * marginFraction;
    min -= pad;
    max += pad;
  }

  const span = max - min;
  return { min, max, y: (value) => (value - min) / span };
}

/**
 * Candle width in x-fraction, given a count.
 *
 * Capped so that a handful of candles do not become enormous bars: with three candles
 * a full-width bar says "this is all the data there is", which may be true, but with
 * two it stops looking like a chart at all.
 */
export function slotWidth(count, gapFraction = 0.35) {
  if (count <= 0) return 0;
  return Math.min(1 / count, 0.18) * (1 - gapFraction);
}

/** A short local time for an axis label, without pulling in a date library. */
export function timeLabel(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Does this candle carry any movement at all? Used to say so rather than imply it. */
export function hasMovement(candles) {
  return candles.some((c) => c.open !== c.close || c.high !== c.low);
}

/**
 * The caption under the chart. Says what the picture is, and what it is not.
 *
 * Written as a function so the wording is testable. The three things it must never do:
 * claim a range the data does not have, describe an unavailable service as "no data",
 * and let a reader believe the newest candle is current when the indexer has stopped.
 */
export function describe(view) {
  if (view.mode === 'unavailable') return view.detail;
  if (view.mode === 'empty') return 'No price history yet. The index service has not recorded a block with shares in it.';

  const n = view.candles.length;
  const first = view.candles[0];
  const last = view.candles[n - 1];
  const span = `${timeLabel(first.startsAt)}–${timeLabel(last.startsAt)}`;
  const parts = [
    `${n} ${view.bucketSeconds}s candle${n === 1 ? '' : 's'}, ${span}`,
    'blocks ' + first.firstBlock + '–' + last.lastBlock,
  ];
  if (!hasMovement(view.candles)) {
    parts.push('the price did not move in this window');
  }
  if (view.mode === 'stale') parts.push('the index service could not be reached for an update, so this is the last reading');
  return parts.join(' · ');
}

/**
 * Turn a successful response into a view.
 *
 * `stale` is reached by the caller, not here -- this only handles the served case.
 */
export function viewOf(body) {
  const candles = Array.isArray(body.candles) ? body.candles : [];
  if (candles.length === 0) {
    return { mode: 'empty', detail: '', candles: [], bucketSeconds: body.bucketSeconds ?? 0 };
  }
  return { mode: 'ready', detail: '', candles, bucketSeconds: body.bucketSeconds ?? 0 };
}

/** A human sentence for a failure that is not the user's fault and not silence. */
export function unavailableDetail(status, detail) {
  if (status === undefined) {
    return `The index service is not reachable${detail ? ` (${detail})` : ''}. The chart needs it; the balances above do not.`;
  }
  if (status === 404) return 'This build of the index service does not serve /api/candles, so the chart cannot be drawn.';
  if (status >= 500) return `The index service answered with an error (${status}). Try again, or check its logs.`;
  return `The index service refused the request (${status}).`;
}

// ── DOM ──────────────────────────────────────────────────────────────────────
//
// Everything above this line is pure. Everything below touches the document, and is
// written to be driven by a test double -- see the note on `mount` in main.js for why
// the double is required to be at least as capable as the real DOM.

/**
 * Draw a view into the SVG.
 *
 * The SVG is rebuilt on every draw rather than diffed. The element count is bounded by
 * the candle count, this runs once every few seconds at most, and a diffing layer here
 * would be another place for the picture and the data to disagree -- which is the one
 * failure this panel exists to make impossible.
 */
export function render(svg, view) {
  clear(svg);
  const NS = 'http://www.w3.org/2000/svg';
  const W = 1000; // viewBox units; the CSS decides the real size
  const H = 260;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');

  if (view.mode !== 'ready' || view.candles.length === 0) {
    // An explicit placeholder, sized so the panel does not jump when data arrives.
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', String(W / 2));
    t.setAttribute('y', String(H / 2));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'chart-placeholder');
    t.textContent = view.mode === 'unavailable' ? 'chart unavailable' : 'no history yet';
    svg.appendChild(t);
    svg.setAttribute('aria-label', t.textContent ?? '');
    return;
  }

  const plot = plotFor(view.candles);
  const slot = slotWidth(view.candles.length);
  const step = 1 / view.candles.length;

  // Gridlines at the extremes of the scale, so a reader can see what the range is
  // rather than assuming it starts at zero.
  for (const frac of [0, 0.5, 1]) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', String(W));
    line.setAttribute('y1', String(H * frac));
    line.setAttribute('y2', String(H * frac));
    line.setAttribute('class', 'chart-grid');
    svg.appendChild(line);
  }

  view.candles.forEach((c, i) => {
    // y is measured from the bottom in `plot`, from the top in SVG.
    const yOf = (v) => H - plot.y(toNumber(v)) * H;
    const centre = (i + 0.5) * step * W;
    const halfBody = (slot / 2) * W;
    const up = toNumber(c.close) >= toNumber(c.open);

    // The wick: high to low. Drawn first so the body covers its middle.
    const wick = document.createElementNS(NS, 'line');
    wick.setAttribute('x1', String(centre));
    wick.setAttribute('x2', String(centre));
    wick.setAttribute('y1', String(yOf(c.high)));
    wick.setAttribute('y2', String(yOf(c.low)));
    wick.setAttribute('class', `chart-wick ${up ? 'up' : 'down'}`);
    svg.appendChild(wick);

    // The body: open to close. A doji -- open === close -- would be a zero-height
    // rectangle and vanish, so it is given the minimum visible height. A candle that
    // draws as nothing reads as missing data, which is a different claim.
    const yOpen = yOf(c.open);
    const yClose = yOf(c.close);
    const top = Math.min(yOpen, yClose);
    const height = Math.max(Math.abs(yClose - yOpen), 1.5);
    const body = document.createElementNS(NS, 'rect');
    body.setAttribute('x', String(centre - halfBody));
    body.setAttribute('y', String(top));
    body.setAttribute('width', String(halfBody * 2));
    body.setAttribute('height', String(height));
    body.setAttribute('class', `chart-body ${up ? 'up' : 'down'}`);
    // The tooltip and the caption print the EXACT stored strings, not the pixel
    // positions: this is where a one-base-unit move is still visible to a reader.
    const title = document.createElementNS(NS, 'title');
    title.textContent =
      `${new Date(c.startsAt * 1000).toISOString()}\n` +
      `open  ${c.open}\nhigh  ${c.high}\nlow   ${c.low}\nclose ${c.close}\n` +
      `${c.points} block${c.points === 1 ? '' : 's'} (${c.firstBlock}–${c.lastBlock})`;
    body.appendChild(title);
    svg.appendChild(body);

    // The label is what a screen reader gets, since the picture is not readable.
    body.setAttribute('aria-label', `candle ${i + 1}: ${title.textContent}`);
  });

  const n = view.candles.length;
  const last = view.candles[n - 1];
  svg.setAttribute(
    'aria-label',
    `Share price, ${n} candles of ${view.bucketSeconds} seconds. ` +
      `From ${last.low} to ${last.high}. Latest close ${last.close}. ` +
      (hasMovement(view.candles) ? '' : 'The price did not move in this window.'),
  );
}

/**
 * Remove every child.
 *
 * NOT `svg.replaceChildren()`. The sibling wallet code shipped
 * `node.children.length = 0`, which throws -- `children` is a live HTMLCollection with
 * no setter -- and it threw inside a message handler, so the page silently stopped
 * responding to anything. `removeChild` in a loop works on every DOM and on the
 * doubles used by the tests, and it is obvious about what it does.
 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Fetch the candles and describe the outcome.
 *
 * Returns a view in every case -- it never throws, because a chart that takes the page
 * down with it is worse than a chart that says it is unavailable. The one thing it
 * will not do is return `ready` with an empty list: "there is no history" and "here is
 * the history" are different, and so is "we could not ask".
 */
export async function load(fetchImpl, url = '/api/candles') {
  let res;
  try {
    res = await fetchImpl(url, { cache: 'no-store' });
  } catch (err) {
    return { ...EMPTY_VIEW, mode: 'unavailable', detail: unavailableDetail(undefined, err instanceof Error ? err.message : String(err)) };
  }
  if (!res.ok) {
    return { ...EMPTY_VIEW, mode: 'unavailable', detail: unavailableDetail(res.status, res.statusText) };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    // The status is deliberately NOT passed here. The response arrived, so the
    // status was fine -- saying 'refused the request (200)' is a contradiction,
    // and a contradictory message sends the reader to the wrong place.
    return { ...EMPTY_VIEW, mode: 'unavailable', detail: unavailableDetail(undefined, 'the response was not JSON') };
  }
  return viewOf(body);
}
