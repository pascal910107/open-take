// @ts-check
// One timeline for the picture and the sound — open-take's film kit. Keep the
// film's moments in one plain module that the page and the score (a Node
// script) both import: when a moment moves, its sound moves with it, and
// nothing has to be copied by hand. It holds names and times only; how the
// film is built around them is yours.
//
//   // timeline.js — yours
//   import { timeline } from "./kit/time.js";
//   export const tl = timeline({ at: { hook: 0, search: 2.5, result: 4 } });
//
//   tl.t("search")              // 2.5
//   tl.local(t, "search", 0.6)  // 0 → 1 through the 0.6 s after "search"
//
// A pulse is there if the film has one — its tempo is the film's to choose,
// from its music or from nothing at all; none is assumed:
//
//   const tl = timeline({ bpm: 96, at: { … } });
//   tl.beat(8)                  // when the 8th beat falls (s)
//   tl.snap(3.1)                // the nearest beat to 3.1 s
//
// What happens in the picture, and how fast it moves, can be said here too,
// for the score: `film render` writes them beside the film as
// <film>.events.json (kit/audio.mjs readEvents reads it), so a click's sound
// lands on the click, pans to where it is on the stage, and a whoosh can
// follow the camera's speed rather than a guess.
//
//   tl.event("search", "click", { x: 640, y: 380, force: 0.6 });
//   tl.event(tl.t("search") + 0.12, "key", { label: "s" });
//   tl.curve("zoom", (t) => cam.at(t).scale);                     // any number of t
//   tl.curve("camSpeed", speed((t) => cam.at(t)));                // content px/s, by difference
//   window.__film = { duration: tl.t("end"), audio: "score.wav", ...tl.hooks() };
//
//   tl.events()                 // the moments (kind "mark") and the events, in time order

/**
 * One thing that happens in the film, in seconds; where on the stage (CSS px)
 * and how hard (0..1), if it says.
 * @typedef {object} FilmEvent
 * @property {number} t
 * @property {string} kind "click", "key", "land", "cut", "mark", or any word of yours
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [force]
 * @property {string} [label]
 * @property {string} [id] the moment's name, on the moments `events()` lists
 */

/**
 * @param {object} opts
 * @param {Record<string, number>} [opts.at] named moments (s)
 * @param {number} [opts.bpm] a pulse, if the film has one
 * @param {number} [opts.offset] when beat 0 falls (s)
 */
export function timeline({ at = {}, bpm, offset = 0 } = {}) {
  for (const [id, t] of Object.entries(at))
    if (!Number.isFinite(t)) throw new Error(`timeline: "${id}" is not a time (${t})`);
  if (bpm != null && !(bpm > 0 && Number.isFinite(bpm)))
    throw new Error(`timeline: bpm is beats a minute, a number above 0 (got ${bpm})`);
  const beatLen = bpm ? 60 / bpm : null;
  /** @param {string} id */
  const t = (id) => {
    const v = at[id];
    if (v == null) throw new Error(`timeline: no moment named "${id}"`);
    return v;
  };
  /** a moment's name or a time in seconds, as a time @param {string | number} when */
  const when = (when) => (typeof when === "string" ? t(when) : when);
  const needBeat = () => {
    if (beatLen == null) throw new Error("timeline: no bpm was given");
    return beatLen;
  };
  /** @type {FilmEvent[]} */
  const declared = [];
  /** @type {Map<string, (t: number) => number>} */
  const curves = new Map();

  /** every named moment and declared event, in time order (same time: as declared) */
  const events = () =>
    /** @type {FilmEvent[]} */ ([
      ...Object.entries(at).map(([id, s]) => ({ t: s, kind: "mark", label: id, id })),
      ...declared.map((e) => ({ ...e })),
    ])
      .map((e, i) => /** @type {const} */ ([e, i]))
      .sort((a, b) => a[0].t - b[0].t || a[1] - b[1])
      .map(([e]) => e);
  /** every curve at t; a curve that gives no finite number is left out @param {number} now */
  const sample = (now) => {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [name, fn] of curves) {
      const v = fn(now);
      if (Number.isFinite(v)) out[name] = v;
    }
    return out;
  };

  return {
    /** the time of a named moment (s) */
    t,
    /** 0 before the moment, 1 once `dur` has passed, linear between */
    /** @param {number} now @param {string} id @param {number} dur */
    local: (now, id, dur) => Math.max(0, Math.min(1, (now - t(id)) / dur)),
    /** whether now lies in [from, to) — names or seconds */
    /** @param {number} now @param {string | number} from @param {string | number} to */
    between: (now, from, to) => now >= when(from) && now < when(to),
    /** when beat n falls (s) */
    /** @param {number} n */
    beat: (n) => offset + n * needBeat(),
    /** the nearest beat to a time (s) */
    /** @param {number} s */
    snap: (s) => {
      const len = needBeat();
      return offset + Math.round((s - offset) / len) * len;
    },
    /** the beat a time falls in, counting from 0 */
    /** @param {number} s */
    beatOf: (s) => Math.floor((s - offset) / needBeat() + 1e-9),
    /**
     * Say that something happens: at a moment's name or a time (s), of a kind
     * you name. Returns its time, so a page can use it too.
     * @param {string | number} at
     * @param {string} kind
     * @param {{ x?: number, y?: number, force?: number, label?: string }} [o]
     */
    event: (at, kind, o = {}) => {
      const s = when(at);
      if (!Number.isFinite(s))
        throw new Error(`timeline: event "${kind}" is not at a time (${at})`);
      if (typeof kind !== "string" || !kind) throw new Error("timeline: an event needs a kind");
      /** @type {FilmEvent} */
      const e = { t: s, kind };
      for (const k of /** @type {const} */ (["x", "y", "force"])) {
        const v = o[k];
        if (v == null) continue;
        if (!Number.isFinite(v))
          throw new Error(`timeline: event "${kind}" at ${s}s: ${k} is ${v}`);
        e[k] = k === "force" ? Math.max(0, Math.min(1, v)) : v;
      }
      if (o.label != null) e.label = String(o.label);
      declared.push(e);
      return s;
    },
    /** every named moment (kind "mark", with its name as `id` and `label`) and
     *  every declared event, in time order */
    events,
    /**
     * A number that changes over the film — a zoom, a speed, a level — for the
     * score to follow. `film render` samples it once a frame. Named again, it
     * is replaced.
     * @param {string} name
     * @param {(t: number) => number} fn
     */
    curve: (name, fn) => {
      if (typeof fn !== "function")
        throw new Error(`timeline: curve "${name}" is not a function of t`);
      curves.set(name, fn);
    },
    /** every curve at t, by name */
    curves: sample,
    /** window.__film's `events` and `curves`, to spread into it */
    hooks: () => ({ events, curves: sample }),
    bpm,
    offset,
  };
}

/**
 * How fast something moves at t (units a second): `fn` gives a number, an
 * { x, y } point (a camera's view also counts its width, `w`), or [x, y];
 * the speed is measured across `h` s either side.
 * @param {(t: number) => number | number[] | { x?: number, y?: number, cx?: number, cy?: number, w?: number }} fn
 * @param {number} [h]
 * @returns {(t: number) => number}
 */
export function speed(fn, h = 1 / 240) {
  if (!(h > 0)) throw new Error(`speed: h is a time step above 0 (got ${h})`);
  /** @param {ReturnType<typeof fn>} v @returns {number[]} */
  const vec = (v) => {
    if (typeof v === "number") return [v];
    if (Array.isArray(v)) return v;
    return [v.x ?? v.cx ?? 0, v.y ?? v.cy ?? 0, v.w ?? 0];
  };
  return (t) => {
    const a = vec(fn(Math.max(0, t - h)));
    const b = vec(fn(t + h));
    const span = t + h - Math.max(0, t - h);
    let d = 0;
    for (let i = 0; i < a.length; i++) d += ((b[i] ?? 0) - (a[i] ?? 0)) ** 2;
    return Math.sqrt(d) / span;
  };
}
