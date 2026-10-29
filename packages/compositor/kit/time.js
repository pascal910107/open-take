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
//     handoff: "whip",           // how it hands over to the next, at "result"
//   });
//   tl.segment("result", "end", { handoff: { kind: "depth", outDur: 0.25 } });  // with its options
//   tl.segments()               // [{ from, to, label?, hold?, handoff?, seam?, carry?, subject?, sound? }], by from
//
// What crosses a boundary, if you say: `carry` names the one thing that lives
// through the cut at the segment's end — a CSS selector, or a function of t
// giving its box ({ x, y, width, height, opacity? }, frame px) for what is
// drawn on a canvas. `film render` then follows that thing frame by frame,
// from 1 s before the boundary to 0.4 s after, and says what it did:
// carried (it was still there 0.25 s past the boundary, or filled the frame,
// and moved or changed size on the way), anchored (it stayed, unchanged), or
// bare (gone, or fading out, by then) — facts, not a grade. Its box is what
// is drawn of it: a clip-path inset() or circle() counts.
//
//   tl.segment(0, 7.05, { handoff: "the pressed button grows into the next scene's ground", carry: "#cta" });
//   tl.segment(7.05, 9, { handoff: "cut" });   // a hard cut, on purpose
//
// A handoff is your own words, or a seam's kind from kit/seams.js — "curve",
// "whip", "depth", "inverse", "push", "dip", or "cut" for a hard cut on
// purpose (and the names they go by: "pushCut", "into the lens"). Given the
// seams module, `scenes(…, { tl, seams })` below performs a kind at the
// boundary between the two scenes that meet there; words stay words, for you
// to build.
// A boundary whose segment names no kind is left as it is: nothing is added
// that the film did not ask for.
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
//
// Where a value on screen comes from, if the film shows the product's data —
// a part of components.json (`ref`, `field`), the live page it shows on
// (`url`), or a note that it is not the product's: "demo" (made-up records a
// viewer can tell are made up), "illustrative" (a figure for the idea, not a
// reading). Nothing checks it or acts on it: `film render` writes the list
// into the events file as "sources", and `film probe` sets it beside the
// numbers and strings it reads in the film's own text, as information.
// `label` is what on screen it covers: the text as shown, or words for it;
// `text` the strings it covers when the label is words, `selector` the
// film's elements whose text it covers. kit/media.js `readValues(url, { tl })`
// declares every value it reads, so a component rebuilt from real values
// needs no line of its own. `film render` asks for the list once, when the
// page is ready: declare (and read values) before that, not in __render.
//
//   tl.source("$3,376", { ref: "result:e149", field: "number" });
//   tl.source("six sample rows", { note: "demo", selector: "#table" });
//   tl.source("monthly price", { url: "https://…/pricing", text: "$16" });
//   tl.sources()                // [{ label, ref?, field?, file?, url?, note?, text?, selector? }], as given
//
// Scenes, if the film has them: which element shows when. Hidden by
// visibility, so what is in a hidden scene keeps its layout (a saved screen
// can still be measured and lifted from) and what was lifted out of it hides
// with it; each start is a cut on the timeline, for the score and the probe.
//
//   const sc = scenes({ result: [7.2, 16.8], search: [21.6, 31.2] }, { tl });  // ids of elements
//   sc.show(t);                 // in __render(t): "result" shown 7.2–16.8 s, hidden otherwise
//
// Given kit/seams.js, a boundary whose segment names a seam's kind is handed
// over that way — the scene ending there is one side, the one starting the
// other — and show(t) writes both sides while the seam is open:
//
//   import * as seams from "./kit/seams.js";
//   const sc = scenes({ rows: [0, 4], map: [4, 10.6], hex: [10.6, 15] }, { tl, seams });
//   tl.segment(0, 4, { handoff: "depth" });          // 4.0 s: the rows into the lens, the map out of it
//   tl.segment(4, 10.6, { handoff: "the panel slides away" });   // words: yours to build
//   tl.segment(10.6, 15, { handoff: { kind: "whip", dir: "up" } });
//   window.__render = (t) => { sc.show(t); /* the rest */ };
//
// A curve or a whip with no `dir` travels so the incoming scene arrives from
// the side its subject is on (the segment's `subject`), else to the left.

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
 * @property {string} [handoff] a seam's kind (kit/seams.js), or your own words
 * @property {Record<string, number | string>} [seam] the seam's options, when the handoff was
 *   given as { kind, …options }
 * @property {string} [carry] what lives through the boundary at `to`: a CSS selector, or
 *   "(a function)" when it was given as one — `film render` follows it across
 * @property {string} [subject] what the eye should be on: a CSS selector, or a name
 * @property {string} [sound]
 */

/** how long before a boundary a carry is followed (s): a thing becoming the
 *  next scene mostly does it on the way in */
export const CARRY_BEFORE = 1;
/** …and after it */
export const CARRY_AFTER = 0.4;

/** the curves a carry is written as, in the events file: `carry@<boundary s>:<field>`
 *  @param {number} at @param {"x" | "y" | "w" | "h" | "o" | "fw" | "fh"} field */
export const carryCurve = (at, field) => `carry@${+at.toFixed(3)}:${field}`;

/**
 * The part of a box a clip-path inset() or circle() leaves drawn (px of the
 * box as laid out, scaled to the box as drawn); the box as it is otherwise.
 * @param {Element} el @param {DOMRect} r
 */
function clipped(el, r) {
  const clip = getComputedStyle(el).clipPath;
  const lw = /** @type {HTMLElement} */ (el).offsetWidth || r.width;
  const lh = /** @type {HTMLElement} */ (el).offsetHeight || r.height;
  const kx = lw ? r.width / lw : 1;
  const ky = lh ? r.height / lh : 1;
  /** @param {string} v @param {number} of */
  const len = (v, of) =>
    v.endsWith("%") ? (Number.parseFloat(v) / 100) * of : Number.parseFloat(v) || 0;
  const inset = /^inset\(([^)]*?)(?:\s+round\b[^)]*)?\)/.exec(clip);
  if (inset) {
    const v = (inset[1] ?? "").trim().split(/\s+/);
    const [t = "0", rt = t, b = t, l = rt] = v;
    const T = len(t, lh),
      R = len(rt, lw),
      B = len(b, lh),
      L = len(l, lw);
    return {
      left: r.left + L * kx,
      top: r.top + T * ky,
      width: Math.max(0, (lw - L - R) * kx),
      height: Math.max(0, (lh - T - B) * ky),
    };
  }
  const circle =
    /^circle\(\s*([\d.]+(?:px|%))(?:\s+at\s+([\d.]+(?:px|%))\s+([\d.]+(?:px|%)))?/.exec(clip);
  if (circle) {
    const rad = len(circle[1] ?? "0", Math.hypot(lw, lh) / Math.SQRT2);
    const cx = circle[2] ? len(circle[2], lw) : lw / 2;
    const cy = circle[3] ? len(circle[3], lh) : lh / 2;
    return {
      left: r.left + (cx - rad) * kx,
      top: r.top + (cy - rad) * ky,
      width: 2 * rad * kx,
      height: 2 * rad * ky,
    };
  }
  return r;
}

/**
 * Where a carry is at this instant, in frame px, and how visible: its box
 * (after every transform), the opacity it is drawn at (its own and every
 * ancestor's multiplied; 0 when it or one of them is hidden or not shown),
 * and the frame's size. Null outside a page.
 * @param {string | ((t: number) => unknown)} what
 * @param {number} t
 */
function carryBox(what, t) {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const fw = window.innerWidth;
  const fh = window.innerHeight;
  if (typeof what === "function") {
    const b =
      /** @type {{ x?: number, y?: number, w?: number, h?: number, width?: number, height?: number, opacity?: number } | null} */ (
        what(t)
      );
    if (!b || typeof b !== "object") return { x: 0, y: 0, w: 0, h: 0, o: 0, fw, fh };
    const w = b.width ?? b.w ?? 0;
    const h = b.height ?? b.h ?? 0;
    return { x: b.x ?? 0, y: b.y ?? 0, w, h, o: b.opacity ?? 1, fw, fh };
  }
  const el = document.querySelector(what);
  if (!el) return { x: 0, y: 0, w: 0, h: 0, o: 0, fw, fh };
  const r = clipped(el, el.getBoundingClientRect());
  let o = 1;
  for (let n = /** @type {Element | null} */ (el); n && o > 0; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none") o = 0;
    else o *= Number.parseFloat(cs.opacity) || 0;
    if (n === el && cs.visibility !== "visible") o = 0;
  }
  return { x: r.left, y: r.top, w: r.width, h: r.height, o, fw, fh };
}

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

/**
 * Where something on screen comes from — at least one of `ref`, `url` or
 * `note`; for the record only.
 * @typedef {object} FilmSource
 * @property {string} label what on screen it covers: the text as shown, or words for it
 * @property {string} [ref] a part of components.json, "<state>:<element id>"
 * @property {string} [field] which of the part's values
 * @property {string} [file] the components.json it was read from, as the page fetched it
 * @property {string} [url] where the value shows in the live product
 * @property {string} [note] "demo", "illustrative", or your own words
 * @property {string[]} [text] the strings on screen it covers (beside the label)
 * @property {string} [selector] the film's elements whose text it covers (CSS)
 */

/** a source's known fields as given; null when it names no ref, url or note
 * @param {string} label @param {Record<string, unknown>} o @returns {FilmSource | null} */
const sourceOf = (label, o) => {
  /** @type {FilmSource} */
  const s = { label };
  for (const k of /** @type {const} */ (["ref", "field", "file", "url", "note", "selector"])) {
    const v = o[k];
    if (v != null && v !== "") s[k] = String(v);
  }
  const text = o.text == null ? [] : Array.isArray(o.text) ? o.text : [o.text];
  const strings = text.filter((x) => x != null && x !== "").map(String);
  if (strings.length) s.text = strings;
  return s.ref || s.url || s.note ? s : null;
};

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
  /** what each carry follows, at the boundary it crosses
   *  @type {{ at: number, what: string | ((t: number) => unknown) }[]} */
  const carriers = [];
  /** @type {FilmCredit[]} */
  const credited = [];
  const credits = () => credited.map((c) => ({ ...c }));
  /** @type {FilmSource[]} */
  const declaredSources = [];
  const sources = () =>
    declaredSources.map((x) => (x.text ? { ...x, text: [...x.text] } : { ...x }));
  /** the beat sheet, by `from` (same from: as declared) */
  const segments = () =>
    sheet
      .map((s, i) => /** @type {const} */ ([s, i]))
      .sort((a, b) => a[0].from - b[0].from || a[1] - b[1])
      .map(([s]) => (s.seam ? { ...s, seam: { ...s.seam } } : { ...s }));

  /** events whose label is known only once the film is written — a cut
   *  `scenes` declared, labelled by the seam performed there */
  /** @type {WeakMap<FilmEvent, () => string>} */
  const lateLabels = new WeakMap();
  /** @param {FilmEvent} e */
  const labelled = (e) => {
    const late = lateLabels.get(e);
    return late ? { ...e, label: late() } : { ...e };
  };

  /** every named moment and declared event, in time order (same time: as declared) */
  const events = () =>
    /** @type {FilmEvent[]} */ ([
      ...Object.entries(at).map(([id, s]) => ({ t: s, kind: "mark", label: id, id })),
      ...declared.map(labelled),
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
    for (const c of carriers) {
      if (now < c.at - CARRY_BEFORE - 1e-6 || now > c.at + CARRY_AFTER + 1e-6) continue;
      /** @type {ReturnType<typeof carryBox>} */
      let b = null;
      try {
        b = carryBox(c.what, now);
      } catch {
        // a selector the page cannot read, or a box function that threw: this
        // carry is left out here, the film's other curves are not
      }
      if (!b) continue;
      for (const [k, v] of Object.entries(b))
        if (Number.isFinite(v)) out[carryCurve(c.at, /** @type {"x"} */ (k))] = v;
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
     * @param {{ x?: number, y?: number, force?: number, label?: string, labelOf?: () => string }} [o]
     *   labelOf: the label, asked each time the events are read (a cut `scenes` declares,
     *   named after the seam performed there)
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
      if (typeof o.labelOf === "function") lateLabels.set(e, o.labelOf);
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
     * @param {{ label?: string, hold?: boolean, handoff?: string | { kind: string, [k: string]: unknown },
     *   carry?: string | ((t: number) => { x: number, y: number, width: number, height: number, opacity?: number } | null),
     *   subject?: string, sound?: string }} [o]
     *   carry: what lives through the boundary at `to` — a CSS selector, or a
     *   function of t giving its box in frame px (a canvas's own drawing);
     *   `film render` follows it 0.4 s each side and says what it did
     */
    segment: (from, to, o = {}) => {
      const a = when(from);
      const b = when(to);
      if (!Number.isFinite(a) || !Number.isFinite(b))
        throw new Error(`timeline: segment ${from}–${to} is not between two times`);
      if (!(b > a)) throw new Error(`timeline: segment ${from}–${to} ends before it starts`);
      /** @type {FilmSegment} */
      const seg = { from: a, to: b };
      const h = o.handoff;
      if (h != null && typeof h === "object") {
        const { kind, ...opts } = /** @type {{ kind?: unknown, [k: string]: unknown }} */ (h);
        if (typeof kind !== "string" || !kind)
          throw new Error(
            `timeline: segment ${from}–${to}: a handoff given as an object needs its kind`,
          );
        seg.handoff = kind;
        /** @type {Record<string, number | string>} */
        const seam = {};
        for (const [k, v] of Object.entries(opts))
          if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "string") seam[k] = v;
        if (Object.keys(seam).length) seg.seam = seam;
      } else if (h != null) seg.handoff = String(h);
      for (const k of /** @type {const} */ (["label", "subject", "sound"]))
        if (o[k] != null) seg[k] = String(o[k]);
      if (o.carry != null) {
        if (typeof o.carry === "function") seg.carry = "(a function)";
        else if (typeof o.carry === "string" && o.carry.trim()) seg.carry = o.carry.trim();
        else
          throw new Error(
            `timeline: segment ${from}–${to}: carry is a CSS selector, or a function of t giving a box`,
          );
        // two segments ending together name one boundary: the first carry is the one followed
        // (the report reads the same one), a second would only overwrite its curves
        if (!carriers.some((c) => Math.abs(c.at - b) < 1e-6))
          carriers.push({ at: b, what: typeof o.carry === "function" ? o.carry : seg.carry });
      }
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
    /**
     * Say where something on screen comes from: a part of components.json
     * (`ref`, and which of its values, `field`), the live page it shows on
     * (`url`), or a `note` — "demo", "illustrative" or your words. `label` is
     * what on screen it covers (the text as shown, or words for it); `text`
     * the strings it covers, `selector` the film's elements whose text it
     * covers. Nothing is checked; returns the source.
     * @param {string} label
     * @param {{ ref?: string, field?: string, file?: string, url?: string, note?: "demo" | "illustrative" | string,
     *   text?: string | string[], selector?: string }} o
     */
    source: (label, o) => {
      if (typeof label !== "string" || !label.trim())
        throw new Error("timeline: a source needs a label — what on screen it covers");
      if (!o || typeof o !== "object")
        throw new Error(`timeline: source "${label}" needs { ref }, { url } or { note }`);
      const s = sourceOf(label, /** @type {Record<string, unknown>} */ (o));
      if (!s)
        throw new Error(
          `timeline: source "${label}" says nothing of where it comes from — a ref (a part of components.json), a url, or a note ("demo", "illustrative")`,
        );
      declaredSources.push(s);
      return s.text ? { ...s, text: [...s.text] } : { ...s };
    },
    /** every source, as given */
    sources,
    /** window.__film's `events`, `curves`, `segments`, `credits` and `sources`, to spread into it */
    hooks: () => ({ events, curves: sample, segments, credits, sources }),
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

/**
 * Scenes: which element shows when — each a name (an element's id, or a
 * selector) and when it is on, [from, to) in s, or a list of such spans for
 * a scene that comes back. `show(t)` sets each one's visibility: hidden off
 * its spans, inherited on them (so a scene inside a hidden one stays hidden)
 * — never display, so what is inside keeps its layout. Scenes may overlap.
 * With `tl`, each start after 0 is declared a "cut" there (labelled with the
 * scene's name). `el`: how a name finds its element (default by id, or by
 * selector when it looks like one). `seams`, the kit/seams.js module (with a
 * `tl` that keeps a beat sheet): each boundary whose segment ending there
 * names a seam's kind (its `kindOf`) is performed by show(t), and its cut is
 * labelled "seam: <kind>"; `view`, the picture's size for a whip (default
 * 1920×1080).
 * @param {Record<string, [number, number] | [number, number][]>} map
 * @param {{ tl?: { event: (at: number, kind: string, o?: { label?: string, labelOf?: () => string }) => number,
 *     segments?: () => FilmSegment[] },
 *   el?: (name: string) => { style: { visibility: string } } | null,
 *   seams?: { seams: typeof import("./seams.js").seams, kindOf: (name: unknown) => string | null },
 *   view?: { width: number, height: number } }} [o]
 */
export function scenes(map, o = {}) {
  /** @type {{ name: string, spans: [number, number][] }[]} */
  const list = Object.entries(map).map(([name, v]) => {
    if (!Array.isArray(v) || !v.length)
      throw new Error(`scenes: "${name}" needs [from, to] (s), or a list of them`);
    const spans = /** @type {[number, number][]} */ (
      Array.isArray(v[0]) ? v : [/** @type {[number, number]} */ (v)]
    );
    for (const sp of spans) {
      const [a, b] = sp;
      if (!Number.isFinite(a) || !Number.isFinite(b))
        throw new Error(`scenes: "${name}" is on between two times (got ${JSON.stringify(sp)})`);
      if (!(b > a)) throw new Error(`scenes: "${name}" ends (${b}) before it starts (${a})`);
    }
    return { name, spans: spans.map(([a, b]) => /** @type {[number, number]} */ ([a, b])) };
  });
  const kit = o.seams ?? null;
  if (kit && (typeof kit.seams !== "function" || typeof kit.kindOf !== "function"))
    throw new Error(
      'scenes: seams is the kit/seams.js module — import * as seams from "./kit/seams.js"',
    );
  const withSeams = !!kit && !!o.tl && typeof o.tl.segments === "function";
  if (o.tl)
    for (const sc of list)
      for (const [a] of sc.spans)
        if (a > 0)
          o.tl.event(a, "cut", {
            label: sc.name,
            ...(withSeams ? { labelOf: () => seamAt(a) ?? sc.name } : {}),
          });
  /** @type {Map<string, { style: { visibility: string } }>} */
  const found = new Map();
  /** @param {string} name */
  const elOf = (name) => {
    const had = found.get(name);
    if (had) return had;
    const el = o.el
      ? o.el(name)
      : (document.getElementById(name) ??
        (/^[#.[]|[\s>:]/.test(name) ? document.querySelector(name) : null));
    if (!el) throw new Error(`scenes: no element for the scene "${name}" (an id, or a selector)`);
    found.set(name, /** @type {{ style: { visibility: string } }} */ (el));
    return /** @type {{ style: { visibility: string } }} */ (el);
  };
  /** the scenes on at t, by name @param {number} t */
  const at = (t) =>
    list.filter((sc) => sc.spans.some(([a, b]) => t >= a && t < b)).map((sc) => sc.name);
  const view = o.view ?? { width: 1920, height: 1080 };
  /** @type {ReturnType<typeof import("./seams.js").seams> | null} */
  let performed = null;
  /** how many segments the sheet held when the seams were built */
  let builtFrom = -1;
  /** the boundaries the beat sheet names a kind at, as seams() takes them —
   *  read when first needed and again whenever the sheet has grown since (it
   *  may be written after the scenes, or after a first show(t)) */
  const boundaryList = () => {
    if (!withSeams) return [];
    const sheet = o.tl?.segments ? o.tl.segments() : [];
    /** @type {{ at: number, from: string, to: string, kind: string, [k: string]: unknown }[]} */
    const out = [];
    for (const sc of list)
      for (const [a] of sc.spans) {
        if (!(a > 0)) continue;
        const seg = sheet.find((x) => Math.abs(x.to - a) < 1e-6 && kit?.kindOf(x.handoff));
        if (!seg) continue;
        const from =
          list.find((x) => x !== sc && x.spans.some(([, b]) => Math.abs(b - a) < 1e-6)) ??
          list.find(
            (x) =>
              x !== sc &&
              x.spans.some(([p, q]) => a - 1e-6 >= p && a - 1e-6 < q) &&
              !x.spans.some(([p, q]) => a >= p && a < q),
          );
        if (!from) continue;
        const kind = /** @type {string} */ (kit?.kindOf(seg.handoff));
        const opts = { ...(seg.seam ?? {}) };
        if (!("dir" in opts) && (kind === "curve" || kind === "whip")) {
          const next = sheet.find((x) => Math.abs(x.from - a) < 1e-6 && x.subject);
          const d = dirToward(next?.subject ?? seg.subject, view);
          if (d) opts.dir = d;
        }
        out.push({ ...opts, at: a, from: from.name, to: sc.name, kind });
      }
    return out;
  };
  const seamsHere = () => {
    const n = o.tl?.segments ? o.tl.segments().length : 0;
    if (!performed || n !== builtFrom) {
      performed = /** @type {NonNullable<typeof kit>} */ (kit).seams(null, boundaryList(), {
        view,
        // the same element show(t) finds for the scene
        el: (name) => /** @type {Element} */ (/** @type {unknown} */ (elOf(String(name)))),
      });
      builtFrom = n;
    }
    return performed;
  };
  /** the label of the seam performed at a boundary, if one is @param {number} a */
  const seamAt = (a) => {
    const s = seamsHere()
      .list()
      .find((x) => Math.abs(x.at - a) < 1e-6);
    return s ? `seam: ${s.kind}` : null;
  };
  return {
    /** every scene and its spans, as given */
    list: () => list.map((sc) => ({ name: sc.name, spans: sc.spans.map((sp) => [...sp]) })),
    at,
    /** the seams performed at the boundaries, given the seams module: [{ at, kind, from, to, span }] */
    seams: () => (withSeams ? seamsHere().list() : []),
    /** show the scenes on at t and hide the rest — and, given the seams module,
     *  write both sides of every seam open at t; returns the names shown
     *  @param {number} t */
    show(t) {
      const on = at(t);
      for (const sc of list)
        elOf(sc.name).style.visibility = on.includes(sc.name) ? "inherit" : "hidden";
      if (withSeams) seamsHere().apply(t);
      return on;
    },
  };
}

/**
 * The way a cut on the curve or a whip travels so the incoming scene arrives
 * from the side its subject is on — a subject right of the middle comes in
 * from the right, so the strip travels left. Null when the subject is not
 * found or sits in the middle.
 * @param {string | undefined} subject a CSS selector
 * @param {{ width: number, height: number }} view
 * @returns {"left" | "right" | "up" | "down" | null}
 */
function dirToward(subject, view) {
  if (!subject || typeof document === "undefined") return null;
  let el = null;
  try {
    el = document.querySelector(subject);
  } catch {
    return null;
  }
  if (!el) return null;
  const r = clipped(el, el.getBoundingClientRect());
  if (!(r.width > 0 && r.height > 0)) return null;
  const dx = (r.left + r.width / 2 - view.width / 2) / view.width;
  const dy = (r.top + r.height / 2 - view.height / 2) / view.height;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.08) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "left" : "right";
  return dy > 0 ? "up" : "down";
}
