// @ts-check
// Cutting on the music — open-take's film kit. Plain functions of numbers: a
// grid of the music's beats and bars to put cuts on, the framing that makes a
// subject land in the next shot where it left the last one, and the cuts
// declared as events for the score. Nothing here cuts on its own; where and
// how often the film cuts is yours.
//
//   import { grid, matchCut, cuts, density } from "./kit/cut.js";
//   import { throughCamera } from "./kit/media.js";
//
//   // from `open-take film beats music.mp3` (fetched before window.__film is set)
//   const g = grid(await (await fetch("music.beats.json")).json());
//   // or a pulse of your own: grid({ bpm: /* the music's */, offset: /* s */ })
//   g.bar(4)                                  // when bar 4 starts (s)
//   g.snap(3.1)                               // the nearest beat to 3.1 s
//   g.snap(3.1, { to: "onset", within: 0.08 })// the nearest onset, if one is that near
//   g.between(8, 12, { to: "bar" })           // the bar lines in [8, 12)
//
//   // the subject left the last shot here (picture px) …
//   const left = throughCamera(app.box("#export"), camA, tCut);
//   // … so frame the next shot to put its own copy of it in the same place
//   camB.cut(matchCut(left, result.box, { width: 1920, height: 1080 }), tCut, { keepInside: false });
//
//   // a section that holds, one that bursts, one that breathes — on the grid
//   const times = density(g, [
//     { from: 0, to: g.bar(4), intent: "hold" },
//     { from: g.bar(4), to: g.bar(8), intent: "burst" },
//     { from: g.bar(8), to: g.bar(10), intent: { every: [4, 0.5] } },   // faster and faster
//   ]);
//   cuts(tl, times);                          // tl.event(t, "cut") each: `film render` keeps them

/** @typedef {{ x: number, y: number, width: number, height: number }} Box  a region, in one place's own px */
/** @typedef {Box | { x: number, y: number, w: number, h: number }} BoxLike */
/** @typedef {{ cx: number, cy: number, w: number }} View  what a camera shows: its centre and width, in its content's px */

/**
 * `<name>.beats.json` as `open-take film beats` writes it (the fields used here).
 * @typedef {object} BeatsJson
 * @property {1} version
 * @property {number} duration
 * @property {{ bpm: number | null, periodS?: number, confidence?: number }} tempo
 * @property {number[]} beats
 * @property {number[]} downbeats
 * @property {{ beatsPerBar: number | null }} [meter]
 * @property {{ t: number, end: number, energy: number, label?: string }[]} [sections]
 * @property {number[]} [drops]
 * @property {number[]} [onsets]
 */

/** "beat", "half" (eighths), "quarter" (sixteenths), "bar", or what the music has: "onset", "section", "drop" */
/** @typedef {"beat" | "half" | "quarter" | "bar" | "onset" | "section" | "drop"} To */

/** @param {unknown} v @returns {v is number} */
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** @param {readonly number[]} xs @param {number} t  the index of the last x ≤ t (−1 before the first) */
function floorIndex(xs, t) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (/** @type {number} */ (xs[mid]) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Times laid on a list of marks, with a length per step beyond its ends:
 * at(n) for any n (fractional between marks, extrapolated past them), and
 * indexOf(t), its inverse.
 * @param {readonly number[]} marks sorted
 * @param {number} step
 * @param {number} origin the time of mark 0 when there are no marks
 */
function ruler(marks, step, origin) {
  const n = marks.length;
  /** @param {number} i */
  const at = (i) => {
    if (!n) return origin + i * step;
    if (i <= 0) return /** @type {number} */ (marks[0]) + i * step;
    if (i >= n - 1) return /** @type {number} */ (marks[n - 1]) + (i - (n - 1)) * step;
    const k = Math.floor(i);
    const a = /** @type {number} */ (marks[k]);
    const b = /** @type {number} */ (marks[k + 1]);
    return a + (b - a) * (i - k);
  };
  /** @param {number} t */
  const indexOf = (t) => {
    if (!n) return (t - origin) / step;
    const first = /** @type {number} */ (marks[0]);
    const last = /** @type {number} */ (marks[n - 1]);
    if (t <= first) return (t - first) / step;
    if (t >= last) return n - 1 + (t - last) / step;
    const k = floorIndex(marks, t);
    const a = /** @type {number} */ (marks[k]);
    const b = /** @type {number} */ (marks[k + 1]);
    return k + (t - a) / (b - a);
  };
  return { at, indexOf };
}

/**
 * The music's grid, to put cuts and moves on: from a beats file (`open-take
 * film beats`), or from a pulse you give — `{ bpm, offset }`, offset the time
 * of beat 0, and `beatsPerBar` (default 4; from a beats file, its own).
 * Beats and bars are numbered from 0; any number works, fractional ones fall
 * between (beat(2.5) is the "and" of beat 2), and past the music's ends the
 * grid carries on at its tempo. A beats file's beats follow the music where
 * its tempo moves; a pulse's are even.
 * @param {BeatsJson | { bpm: number, offset?: number, beatsPerBar?: number, onsets?: number[] }} src
 */
export function grid(src) {
  if (!src || typeof src !== "object")
    throw new Error("grid: give it a beats file's JSON or { bpm }");
  /** @type {BeatsJson | null} */
  const file = "beats" in src && Array.isArray(src.beats) ? src : null;
  /** @type {number[]} */
  let beats = [];
  /** @type {number[]} */
  let downbeats = [];
  let beatsPerBar = 4;
  let offset = 0;
  let period = Number.NaN;
  if (file) {
    beats = file.beats.filter(finite);
    downbeats = (file.downbeats ?? []).filter(finite);
    if (file.meter?.beatsPerBar) beatsPerBar = file.meter.beatsPerBar;
    const { bpm, periodS } = file.tempo ?? {};
    if (finite(periodS)) period = periodS;
    else if (finite(bpm) && bpm > 0) period = 60 / bpm;
    const first = beats[0];
    const last = beats[beats.length - 1];
    if (!(period > 0) && first != null && last != null && beats.length >= 2)
      period = (last - first) / (beats.length - 1);
    if (!(period > 0))
      throw new Error(
        "grid: this beats file found no tempo — give a pulse of your own: grid({ bpm })",
      );
    offset = first ?? 0;
  } else {
    const p = /** @type {{ bpm: number, offset?: number, beatsPerBar?: number }} */ (src);
    if (!(finite(p.bpm) && p.bpm > 0))
      throw new Error(`grid: bpm is beats a minute, above 0 (got ${p.bpm})`);
    period = 60 / p.bpm;
    offset = p.offset ?? 0;
    if (!finite(offset)) throw new Error(`grid: offset is the time of beat 0 (got ${p.offset})`);
    beatsPerBar = p.beatsPerBar ?? 4;
  }
  if (!(Number.isInteger(beatsPerBar) && beatsPerBar > 0))
    throw new Error(`grid: beatsPerBar is a whole number above 0 (got ${beatsPerBar})`);
  const B = ruler(beats, period, offset);
  // without downbeats, bar 0 starts on beat 0
  const D = downbeats.length ? ruler(downbeats, period * beatsPerBar, 0) : null;
  /** @param {number} n */
  const bar = (n) => (D ? D.at(n) : B.at(n * beatsPerBar));
  /** @param {number} t */
  const barOf = (t) => (D ? D.indexOf(t) : B.indexOf(t) / beatsPerBar);
  /** @type {unknown[]} */
  const given = "onsets" in src && Array.isArray(src.onsets) ? src.onsets : [];
  const onsets = given.filter(finite).sort((a, b) => a - b);
  const sections = (file?.sections ?? []).map((x) => x.t).filter(finite);
  const drops = (file?.drops ?? []).filter(finite);

  /** the marks of a kind around t: the one at or before it and the one after
   *  @param {To} to @param {number} t @returns {[number, number] | null} */
  const around = (to, t) => {
    /** @param {number} i @param {(i: number) => number} at */
    const pair = (i, at) =>
      /** @type {[number, number]} */ ([at(Math.floor(i + 1e-9)), at(Math.floor(i + 1e-9) + 1)]);
    switch (to) {
      case "beat":
        return pair(B.indexOf(t), B.at);
      case "half":
        return pair(B.indexOf(t) * 2, (i) => B.at(i / 2));
      case "quarter":
        return pair(B.indexOf(t) * 4, (i) => B.at(i / 4));
      case "bar":
        return pair(barOf(t), bar);
      case "onset":
      case "section":
      case "drop": {
        const xs = to === "onset" ? onsets : to === "section" ? sections : drops;
        if (!xs.length) return null;
        const k = floorIndex(xs, t);
        return [xs[Math.max(0, k)] ?? Number.NaN, xs[Math.min(xs.length - 1, k + 1)] ?? Number.NaN];
      }
      default:
        throw new Error(
          `grid: "${to}" is not something to snap to — beat, half, quarter, bar, onset, section or drop`,
        );
    }
  };

  /** the nearest mark of a kind to t (default the nearest beat); null when the music has none of that kind
   *  @param {number} t @param {To} [to] */
  const nearest = (t, to = "beat") => {
    const p = around(to, t);
    if (!p) return null;
    const [a, b] = p;
    return Math.abs(b - t) < Math.abs(t - a) ? b : a;
  };

  return {
    /** seconds a beat */
    period,
    beatsPerBar,
    /** when beat n falls (s) @param {number} n */
    beat: (n) => B.at(n),
    /** when bar n starts (s) @param {number} n */
    bar,
    /** the beat t falls on, counting from 0 (fractional between beats) @param {number} t */
    beatOf: (t) => B.indexOf(t),
    /** the bar t falls in, counting from 0 (fractional within it) @param {number} t */
    barOf,
    nearest,
    /**
     * t moved onto the nearest mark of a kind (default a beat). With `within`
     * (s), only when one is that near; otherwise t as it was.
     * @param {number} t
     * @param {{ to?: To, within?: number }} [o]
     */
    snap: (t, o = {}) => {
      const to = o.to ?? "beat";
      const v = nearest(t, to);
      if (v == null || !finite(v)) return t;
      return o.within != null && Math.abs(v - t) > o.within ? t : v;
    },
    /**
     * Every mark of a kind (default the beats) in [a, b).
     * @param {number} a @param {number} b @param {{ to?: To }} [o]
     */
    between: (a, b, o = {}) => {
      const to = o.to ?? "beat";
      if (to === "onset" || to === "section" || to === "drop") {
        const xs = to === "onset" ? onsets : to === "section" ? sections : drops;
        return xs.filter((x) => x >= a && x < b);
      }
      const per = to === "half" ? 2 : to === "quarter" ? 4 : 1;
      const index = to === "bar" ? barOf : (/** @type {number} */ t) => B.indexOf(t) * per;
      const at = to === "bar" ? bar : (/** @type {number} */ i) => B.at(i / per);
      /** @type {number[]} */
      const out = [];
      for (let i = Math.ceil(index(a) - 1e-9); ; i++) {
        const t = at(i);
        if (t >= b - 1e-9) break;
        if (t >= a - 1e-9) out.push(t);
      }
      return out;
    },
    /** the music's own marks, as the beats file has them (empty from a pulse) */
    beats,
    downbeats,
    onsets,
    sections,
    drops,
  };
}

/** @param {BoxLike} b @returns {Box} */
function boxOf(b) {
  const r = /** @type {any} */ (b);
  const box = { x: r.x, y: r.y, width: r.width ?? r.w, height: r.height ?? r.h };
  if (![box.x, box.y, box.width, box.height].every(finite) || !(box.width > 0 && box.height > 0))
    throw new Error(
      `a box is { x, y, width, height } with a size above 0 (got ${JSON.stringify(b)})`,
    );
  return box;
}

/**
 * A match cut: the framing for the incoming shot that puts a subject where,
 * and as big as, it was in the picture when the last shot left it. `from` is
 * where it showed then, in picture px (through a camera: media.js
 * throughCamera(box, cam, t)); `to` is its box in the incoming shot's layer;
 * `view` the picture's size. Returns the view ({ cx, cy, w }) for camera.js
 * — `cam.cut(v, t, { keepInside: false })`, since keeping inside the content
 * may move it off the match — or apply it yourself: scale = view.width / w.
 * `fit` says what "as big" means when the two boxes differ in shape: "area"
 * (default; the same area), "width", "height", "contain" (inside the old
 * box), "cover" (over it). Centres always meet.
 * @param {BoxLike} from
 * @param {BoxLike} to
 * @param {{ width: number, height: number }} view
 * @param {{ fit?: "area" | "width" | "height" | "contain" | "cover" }} [o]
 * @returns {View}
 */
export function matchCut(from, to, view, o = {}) {
  const a = boxOf(from);
  const b = boxOf(to);
  if (!(view && view.width > 0 && view.height > 0))
    throw new Error("matchCut: view is the picture's { width, height }");
  const sx = a.width / b.width;
  const sy = a.height / b.height;
  const fit = o.fit ?? "area";
  const s =
    fit === "width"
      ? sx
      : fit === "height"
        ? sy
        : fit === "contain"
          ? Math.min(sx, sy)
          : fit === "cover"
            ? Math.max(sx, sy)
            : fit === "area"
              ? Math.sqrt(sx * sy)
              : Number.NaN;
  if (!(s > 0))
    throw new Error(
      `matchCut: fit is "area", "width", "height", "contain" or "cover" (got ${fit})`,
    );
  // picture = (content − view's left/top edge) · s, centre onto centre
  const w = view.width / s;
  return {
    cx: b.x + b.width / 2 + (view.width / 2 - (a.x + a.width / 2)) / s,
    cy: b.y + b.height / 2 + (view.height / 2 - (a.y + a.height / 2)) / s,
    w,
  };
}

/**
 * Declare cuts on a timeline (kit/time.js): tl.event(t, "cut", …) for each, so
 * `film render` lists them as the page's cuts in <film>.events.json and the
 * score can hear them. Each is a time or { t, label?, x?, y?, force? }. With
 * `grid`, each is first snapped onto it — to `to`, default the beat (`within`, as grid.snap).
 * Returns the times declared, in order.
 * @param {{ event: (at: number, kind: string, o?: object) => number }} tl
 * @param {(number | { t: number, label?: string, x?: number, y?: number, force?: number })[]} list
 * @param {{ grid?: ReturnType<typeof grid>, to?: To, within?: number }} [o]
 */
export function cuts(tl, list, o = {}) {
  if (!tl || typeof tl.event !== "function")
    throw new Error("cuts: give it the timeline (kit/time.js) to declare them on");
  if (!Array.isArray(list)) throw new Error("cuts: give it a list of times");
  return list
    .map((c) => {
      const { t, ...rest } = typeof c === "number" ? { t: c } : c;
      if (!finite(t)) throw new Error(`cuts: ${JSON.stringify(c)} is not at a time`);
      const at =
        o.grid && o.to
          ? o.grid.snap(t, { to: o.to, within: o.within })
          : o.grid
            ? o.grid.snap(t, { within: o.within })
            : t;
      return tl.event(at, "cut", rest);
    })
    .sort((a, b) => a - b);
}

/** the words `density` reads, as beats between cuts (Infinity: no cut but the section's first) */
export const PACE = Object.freeze({
  hold: Infinity,
  calm: 8,
  steady: 4,
  pulse: 2,
  burst: 1,
  flurry: 0.5,
});

/**
 * Cut times for a run of sections, on the grid — one way to turn "this part
 * holds, this one bursts" into times; call it if it helps, change what it
 * gives, or place every cut by hand. Each section is { from, to, intent }:
 * `intent` a word (PACE: hold, calm 8 beats, steady 4, pulse 2, burst 1,
 * flurry ½), a number of beats between cuts, or { every } — a number, or
 * [first, last] to change pace across the section evenly in log (a build:
 * [4, 0.5]). Every cut lands on the grid (to a quarter beat when the pace is
 * under a beat, else a half), or with `on: "onset"` on the nearest onset
 * within a quarter beat when there is one. A section's own start is a cut
 * unless `start: false`. Returns the times, in order, each once.
 * @param {ReturnType<typeof grid>} g
 * @param {{ from: number, to: number, intent: keyof typeof PACE | number | { every: number | [number, number] }, on?: "grid" | "onset", start?: boolean }[]} sections
 * @returns {number[]}
 */
export function density(g, sections) {
  if (!g || typeof g.beatOf !== "function")
    throw new Error("density: give it a grid (cut.js grid)");
  /** @type {number[]} */
  const out = [];
  for (const s of sections) {
    if (!(finite(s.from) && finite(s.to) && s.to > s.from))
      throw new Error(
        `density: a section runs from one time to a later one (got ${s.from}–${s.to})`,
      );
    const i = s.intent;
    /** @type {[number, number]} */
    let every;
    if (typeof i === "string") {
      if (!(i in PACE))
        throw new Error(
          `density: "${i}" is not one of ${Object.keys(PACE).join(", ")} — or give a number of beats`,
        );
      const v = PACE[/** @type {keyof typeof PACE} */ (i)];
      every = [v, v];
    } else if (typeof i === "number") every = [i, i];
    else if (i && typeof i === "object" && "every" in i)
      every = Array.isArray(i.every) ? [i.every[0], i.every[1]] : [i.every, i.every];
    else
      throw new Error(
        `density: intent is a word, a number of beats, or { every } (got ${JSON.stringify(i)})`,
      );
    if (!every.every((v) => v > 0))
      throw new Error(`density: beats between cuts are above 0 (got ${every})`);
    const place = (/** @type {number} */ t, /** @type {number} */ pace) => {
      const step = pace < 1 ? "quarter" : "half";
      const onGrid = g.snap(t, { to: step });
      if (s.on !== "onset") return onGrid;
      return g.snap(onGrid, { to: "onset", within: g.period / 4 });
    };
    if (s.start !== false) out.push(s.from);
    if (!Number.isFinite(every[0]) && !Number.isFinite(every[1])) continue;
    let b = g.beatOf(s.from);
    const span = s.to - s.from;
    for (let guard = 0; guard < 10000; guard++) {
      const t0 = g.beat(b);
      const u = Math.max(0, Math.min(1, (t0 - s.from) / span));
      const [e0, e1] = every;
      const pace =
        Number.isFinite(e0) && Number.isFinite(e1) ? e0 * (e1 / e0) ** u : Math.min(e0, e1);
      b += pace;
      const t = place(g.beat(b), pace);
      if (t >= s.to - 1e-6) break;
      if (t > s.from + 1e-6) out.push(t);
    }
  }
  return [...new Set(out.map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
}
