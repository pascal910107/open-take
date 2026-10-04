// @ts-check
// One timeline for the picture and the sound — open-take's film kit. Keep the
// film's moments in one plain module that the page and the score (a Node
// script) both import: when a moment moves, its sound moves with it, and
// nothing has to be copied by hand. It holds names and times only; how the
// film is built around them is yours.
//
//   // timeline.js — yours
//   import { timeline } from "./kit/time.js";
//   export const tl = timeline({ bpm: 120, at: { hook: 0, search: 2.5, result: 4 } });
//
//   tl.t("search")              // 2.5
//   tl.local(t, "search", 0.6)  // 0 → 1 through the 0.6 s after "search"
//   tl.beat(8)                  // when the 8th beat falls (s)
//   tl.snap(3.1)                // the nearest beat to 3.1 s
//   tl.events()                 // [{ id, t }] in time order — for the score

/**
 * @param {object} opts
 * @param {Record<string, number>} [opts.at] named moments (s)
 * @param {number} [opts.bpm] a pulse, if the film has one
 * @param {number} [opts.offset] when beat 0 falls (s)
 */
export function timeline({ at = {}, bpm, offset = 0 } = {}) {
  for (const [id, t] of Object.entries(at))
    if (!Number.isFinite(t)) throw new Error(`timeline: "${id}" is not a time (${t})`);
  const beatLen = bpm ? 60 / bpm : null;
  /** @param {string} id */
  const t = (id) => {
    const v = at[id];
    if (v == null) throw new Error(`timeline: no moment named "${id}"`);
    return v;
  };
  const needBeat = () => {
    if (beatLen == null) throw new Error("timeline: no bpm was given");
    return beatLen;
  };
  return {
    /** the time of a named moment (s) */
    t,
    /** 0 before the moment, 1 once `dur` has passed, linear between */
    /** @param {number} now @param {string} id @param {number} dur */
    local: (now, id, dur) => Math.max(0, Math.min(1, (now - t(id)) / dur)),
    /** whether now lies in [from, to) — names or seconds */
    /** @param {number} now @param {string | number} from @param {string | number} to */
    between: (now, from, to) => {
      const a = typeof from === "string" ? t(from) : from;
      const b = typeof to === "string" ? t(to) : to;
      return now >= a && now < b;
    },
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
    /** every named moment, in time order */
    events: () =>
      Object.entries(at)
        .map(([id, s]) => ({ id, t: s }))
        .sort((a, b) => a.t - b.t),
    bpm,
    offset,
  };
}
