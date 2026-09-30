// The tempo map: music that follows the picture.
//
// A film already cut has its structural moments where the picture needs them
// — a chapter lands, the payoff reveals. A track with one fixed tempo lands its
// downbeats wherever the arithmetic puts them. Film scorers solve this with a
// click track whose tempo changes between sync points; this is that solver.
//
// Each span between two anchors becomes a whole number of eighth notes, so
// every anchor falls exactly on a downbeat. The choice per span trades three
// costs: distance from the target tempo, the tempo change from the previous
// span (the audible one), and bar oddness (a whole bar is free, a half bar
// cheap, a stray eighth dear — the arrangement hides an odd remainder in the
// breath before the next hit). Dynamic programming picks the cheapest chain;
// the target itself is searched over a small set around the style's tempo.
//
// Pure: same anchors → same map.

export type TempoSpan = {
  /** the downbeat this span starts on (seconds) */
  atS: number;
  /** span length in eighth notes */
  eighths: number;
  /** tempo inside the span (quarter notes per minute) */
  bpm: number;
};

export type TempoMap = {
  /** the tempo the solver aimed for */
  targetBpm: number;
  spans: TempoSpan[];
  /** anchors that were too close to a neighbour to carry their own span;
   *  they still exist on the picture — foley marks them, not the downbeat */
  dropped: number[];
};

export type TempoOpts = {
  /** the style's home tempo; the solver searches ±12 % around it */
  bpm?: number;
  /** hard bounds on any span's tempo, as a fraction of the target */
  range?: number;
  /** fix the target instead of searching */
  fixed?: boolean;
};

const oddness = (e: number) => (e % 8 === 0 ? 0 : e % 4 === 0 ? 0.04 : e % 2 === 0 ? 0.1 : 0.25);

function solveFor(bounds: number[], target: number, range: number) {
  const n = bounds.length - 1;
  const cands: number[][] = [];
  for (let i = 0; i < n; i++) {
    const d = bounds[i + 1]! - bounds[i]!;
    const lo = Math.ceil((d * target * (1 - range)) / 30);
    const hi = Math.floor((d * target * (1 + range)) / 30);
    const c: number[] = [];
    for (let e = Math.max(4, lo); e <= hi; e++) c.push(e);
    if (!c.length) return undefined;
    cands.push(c);
  }
  // cost[i][k]: cheapest chain ending with span i using candidate k
  const cost: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < n; i++) {
    const d = bounds[i + 1]! - bounds[i]!;
    cost.push([]);
    from.push([]);
    cands[i]!.forEach((e, k) => {
      const bpm = (30 * e) / d;
      const own = 30 * (bpm / target - 1) ** 2 + oddness(e);
      if (i === 0) {
        cost[i]![k] = own;
        from[i]![k] = -1;
        return;
      }
      const dp = bounds[i]! - bounds[i - 1]!;
      let best = Number.POSITIVE_INFINITY;
      let arg = -1;
      cands[i - 1]!.forEach((ep, kp) => {
        const bp = (30 * ep) / dp;
        const c = cost[i - 1]![kp]! + 120 * (bpm / bp - 1) ** 2;
        if (c < best) {
          best = c;
          arg = kp;
        }
      });
      cost[i]![k] = best + own;
      from[i]![k] = arg;
    });
  }
  let k = cost[n - 1]!.indexOf(Math.min(...cost[n - 1]!));
  const total = cost[n - 1]![k]!;
  const eighths: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    eighths[i] = cands[i]![k]!;
    k = from[i]![k]!;
  }
  return { total, eighths };
}

/**
 * Solve the tempo map for downbeats at `anchorsS` (the first is where the
 * music starts). Spans too short to hold four eighths at the fastest allowed
 * tempo are merged into their predecessor, and the merged anchor is reported
 * in `dropped`. A `protect`ed anchor (a payoff, a big hit) outranks the
 * implicit first and last boundary, which outrank the rest, so its neighbour
 * goes instead — except when two protected anchors are closer than one span
 * can be: then one of them must go, and the last boundary is the one kept.
 */
export function solveTempo(
  anchorsS: number[],
  opts: TempoOpts = {},
  protect: number[] = [],
): TempoMap {
  const home = opts.bpm ?? 120;
  const range = opts.range ?? 0.12;
  if (!(range > 0 && range < 1)) throw new Error("solveTempo: range must be within (0, 1)");
  if (!(home > 0)) throw new Error("solveTempo: bpm must be positive");
  const bounds = [...new Set(anchorsS.map((a) => Math.round(a * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
  const dropped: number[] = [];
  const isProtected = (t: number) => protect.some((p) => Math.abs(p - t) < 0.002);
  const minSpan = (4 * 30) / (home * (1 + range));
  // merge spans that cannot hold four eighths
  for (;;) {
    let shortest = -1;
    let len = Number.POSITIVE_INFINITY;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const d = bounds[i + 1]! - bounds[i]!;
      if (d < minSpan && d < len) {
        len = d;
        shortest = i;
      }
    }
    if (shortest < 0) break;
    // who goes: an anchor the caller protected outranks the implicit ends
    // (first and last boundary), which outrank the rest; on a tie the later
    // one goes — unless it is the last boundary, which the span chain needs
    const rank = (i: number) =>
      isProtected(bounds[i]!) ? 2 : i === 0 || i === bounds.length - 1 ? 1 : 0;
    const a = shortest;
    const b = shortest + 1;
    const victim =
      rank(a) !== rank(b) ? (rank(a) < rank(b) ? a : b) : b === bounds.length - 1 ? a : b;
    dropped.push(bounds[victim]!);
    bounds.splice(victim, 1);
  }
  if (bounds.length < 2) return { targetBpm: home, spans: [], dropped };

  const targets = opts.fixed
    ? [home]
    : [0.9, 0.93, 0.965, 1, 1.035, 1.07, 1.1].map((k) => Math.round(home * k * 10) / 10);
  let best: { target: number; total: number; eighths: number[] } | undefined;
  for (const target of targets) {
    const r = solveFor(bounds, target, range);
    if (!r) continue;
    // a mild preference for the style's own tempo
    const total = r.total + 40 * (target / home - 1) ** 2;
    if (!best || total < best.total) best = { target, total, eighths: r.eighths };
  }
  if (!best) {
    // no chain fits the range: widen once, then give up on the tightest span
    const wide = solveFor(bounds, home, range * 2);
    if (!wide) return { targetBpm: home, spans: [], dropped };
    best = { target: home, total: wide.total, eighths: wide.eighths };
  }
  const spans = best.eighths.map((e, i) => {
    const d = bounds[i + 1]! - bounds[i]!;
    return { atS: bounds[i]!, eighths: e, bpm: Math.round(((30 * e) / d) * 1000) / 1000 };
  });
  return { targetBpm: best.target, spans, dropped };
}

/** Seconds of one eighth note inside a span. */
export const eighthS = (span: TempoSpan) => 30 / span.bpm;
