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
//   const tl = timeline({ bpm: /* the music's */, at: { … } });
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
//
// A beat sheet, if you keep one: what each stretch of the film is meant to
// do, in free words. Every field is optional and nothing checks it is "right";
// `film render` writes the list into the events file and `film probe` sets it
// beside what the picture did — "this segment was written to hold; the picture
// still moves 4.2–4.9 s" — as information, for you to keep or change.
//
//   tl.segment("hook", "search", { label: "the problem", hold: true, sound: "one low hit" });
//   tl.segment("search", "result", {
//     subject: "#search",        // a CSS selector (or a subject's name in the curves)
//     handoff: "matchcut",       // how it hands over to the next: carry | cut | matchcut | sound | your words
//   });
//   tl.segments()               // [{ from, to, label?, hold?, handoff?, subject?, sound? }], by from
//
// What the film uses that someone else made — a track, a sound, a font, a
// photo — and on what terms, if you keep a record of it. Nothing checks it or
// acts on it: `film render` writes it into the events file as "credits" (an
// empty list when there is none), for whoever publishes the film.
//
//   tl.credit({ what: "music: Night Drive", by: "A. Artist", licence: "CC BY 4.0",
//     url: "https://…", text: "Night Drive by A. Artist (CC BY 4.0)" });
//   tl.credits()                // [{ what?, by?, licence?, url?, text? }], as given
//   // or by hand: window.__film = { …, credits: [{ what: "font: Inter", licence: "OFL-1.1" }] }

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
 * One stretch of the film as the author means it, in seconds of page time.
 * `handoff` is how it hands over to what comes next, at `to`.
 * @typedef {object} FilmSegment
 * @property {number} from
 * @property {number} to
 * @property {string} [label]
 * @property {boolean} [hold] the picture is meant to hold still here
 * @property {"carry" | "cut" | "matchcut" | "sound" | string} [handoff]
 * @property {string} [subject] what the eye should be on: a CSS selector, or a name
 * @property {string} [sound]
 */

/**
 * Something the film uses that someone else made, and on what terms — every
 * field optional free words, for the record only.
 * @typedef {object} FilmCredit
 * @property {string} [what] e.g. "music: Night Drive", "font: Inter"
 * @property {string} [by]
 * @property {string} [licence] e.g. "CC0", "CC BY 4.0", "OFL-1.1", "bought, standard licence"
 * @property {string} [url]
 * @property {string} [text] the attribution line as it should appear, if one must
 */

/** a credit's known fields as strings; "license" is read as "licence"
 * @param {Record<string, unknown>} o @returns {FilmCredit} */
const creditOf = (o) => {
  /** @type {FilmCredit} */
  const c = {};
  /** @type {Record<string, unknown>} */
  const src = { ...o, licence: o.licence ?? o.license };
  for (const k of /** @type {const} */ (["what", "by", "licence", "url", "text"]))
    if (src[k] != null && src[k] !== "") c[k] = String(src[k]);
  return c;
};

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
  /** @type {FilmSegment[]} */
  const sheet = [];
  /** @type {FilmCredit[]} */
  const credited = [];
  const credits = () => credited.map((c) => ({ ...c }));
  /** the beat sheet, by `from` (same from: as declared) */
  const segments = () =>
    sheet
      .map((s, i) => /** @type {const} */ ([s, i]))
      .sort((a, b) => a[0].from - b[0].from || a[1] - b[1])
      .map(([s]) => ({ ...s }));

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
    /**
     * Say what a stretch of the film is meant to do — a line of a beat sheet,
     * every field optional free words (`hold` true or false). From and to are
     * moments' names or seconds. Returns the segment.
     * @param {string | number} from
     * @param {string | number} to
     * @param {{ label?: string, hold?: boolean, handoff?: string, subject?: string, sound?: string }} [o]
     */
    segment: (from, to, o = {}) => {
      const a = when(from);
      const b = when(to);
      if (!Number.isFinite(a) || !Number.isFinite(b))
        throw new Error(`timeline: segment ${from}–${to} is not between two times`);
      if (!(b > a)) throw new Error(`timeline: segment ${from}–${to} ends before it starts`);
      /** @type {FilmSegment} */
      const seg = { from: a, to: b };
      for (const k of /** @type {const} */ (["label", "handoff", "subject", "sound"]))
        if (o[k] != null) seg[k] = String(o[k]);
      if (o.hold != null) seg.hold = !!o.hold;
      sheet.push(seg);
      return { ...seg };
    },
    /** the beat sheet, by `from` */
    segments,
    /**
     * Keep a record of something the film uses that someone else made: what,
     * by whom, under what licence, where from, and the attribution line —
     * every field optional, nothing checked. Returns the credit.
     * @param {{ what?: string, by?: string, licence?: string, license?: string, url?: string, text?: string }} o
     */
    credit: (o) => {
      if (!o || typeof o !== "object") throw new Error("timeline: a credit is an object");
      const c = creditOf(/** @type {Record<string, unknown>} */ (o));
      if (!Object.keys(c).length)
        throw new Error("timeline: a credit says nothing (what, by, licence, url or text)");
      credited.push(c);
      return { ...c };
    },
    /** every credit, as given */
    credits,
    /** window.__film's `events`, `curves`, `segments` and `credits`, to spread into it */
    hooks: () => ({ events, curves: sample, segments, credits }),
    bpm,
    offset,
  };
}

/**
 * Cut times from a list of numbers, or of events (those of kind "cut"), or of
 * a camera's moves (kit/camera.js `cam.moves()`: those of kind "cut", at
 * their `t0`), or a function that gives any of these when asked — ascending,
 * finite only.
 * @param {CutList | (() => CutList) | undefined} cuts
 * @returns {number[]}
 * @typedef {readonly (number | { t?: number, t0?: number, kind?: string })[]} CutList
 */
export function cutTimes(cuts) {
  const list = typeof cuts === "function" ? cuts() : cuts;
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("cuts: a list of times (s) or of events");
  /** @type {number[]} */
  const out = [];
  for (const c of list) {
    const t = typeof c === "number" ? c : c && c.kind === "cut" ? (c.t ?? c.t0) : Number.NaN;
    if (t != null && Number.isFinite(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/**
 * How fast something moves at t (units a second): `fn` gives a number, an
 * { x, y } point (a camera's view also counts its width, `w`), or [x, y];
 * the speed is measured across `h` s either side.
 *
 * At a hard cut the picture does not travel from one framing to the next, it
 * replaces it — so given `cuts` (times, or events of kind "cut", or a
 * function that gives them: `tl.events` for the cuts declared on the
 * timeline, `cam.moves` for a camera's own `cam.cut`s), each shot is measured on its
 * own: within `h` of a cut the difference is taken one-sided, inside the
 * shot t is in. The speed holds the shot's own value up to the cut, and the
 * next shot starts from its own first frames; the jump between the two
 * framings never shows up as a spike. A cut at time c belongs to the shot
 * that starts at c. Without `cuts` it differences straight across.
 *
 *   tl.curve("camSpeed", speed((t) => cam.at(t), 1 / 240, { cuts: cam.moves }));
 *   // cuts on the timeline too: { cuts: () => [...tl.events(), ...cam.moves()] }
 *
 * @param {(t: number) => number | number[] | { x?: number, y?: number, cx?: number, cy?: number, w?: number }} fn
 * @param {number} [h]
 * @param {{ cuts?: CutList | (() => CutList) }} [o]
 * @returns {(t: number) => number}
 */
export function speed(fn, h = 1 / 240, { cuts } = {}) {
  if (!(h > 0)) throw new Error(`speed: h is a time step above 0 (got ${h})`);
  /** @param {ReturnType<typeof fn>} v @returns {number[]} */
  const vec = (v) => {
    if (typeof v === "number") return [v];
    if (Array.isArray(v)) return v;
    return [v.x ?? v.cx ?? 0, v.y ?? v.cy ?? 0, v.w ?? 0];
  };
  // a fixed list is read once; a function is asked each time (cuts declared later count)
  const fixed = typeof cuts === "function" ? null : cutTimes(cuts);
  /** how far before a cut the shot ends (s): the last instant of the old picture */
  const edge = h * 1e-3;
  return (t) => {
    let lo = Math.max(0, t - h);
    let hi = t + h;
    const cs = fixed ?? cutTimes(cuts);
    for (const c of cs) {
      if (c <= t) lo = Math.max(lo, c);
      else hi = Math.min(hi, c - edge);
    }
    const span = hi - lo;
    if (!(span > 0)) return 0;
    const a = vec(fn(lo));
    const b = vec(fn(hi));
    let d = 0;
    for (let i = 0; i < a.length; i++) d += ((b[i] ?? 0) - (a[i] ?? 0)) ** 2;
    return Math.sqrt(d) / span;
  };
}
