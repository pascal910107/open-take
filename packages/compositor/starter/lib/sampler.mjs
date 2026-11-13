// sampler.mjs — recorded instruments for a score written in Node with kit/audio.mjs.
//
// Reads samples/manifest.json (instrument → licence, credit, and its samples:
// file, velocity layer, round robin, root note and its tuning in cents) and
// plays notes and hits as kit Channels at 48 kHz. A note takes the recorded
// note nearest the pitch, in the velocity layer nearest `vel`, corrects the
// recording's own tuning, and plays it at the rate that makes the pitch (kit
// `varispeed`: pitch and length together, as a tape, without aliasing); it is
// held `dur` s and released over `release` s on a raised cosine, so nothing
// clicks. A hit (a drum) takes the next round robin of its layer. Decoded
// files and rendered notes are cached, so a repeated pattern costs one
// resample. samples/NOTICE.txt has each instrument's licence; credits() lists
// the ones the score used, ready for tl.credit on the page.
//
//   sampler(dir?)                       the instruments in dir (default: ../samples beside this file)
//   S.note(bus, name, midi, at, o)      a pitched note into bus at film time at (s)
//   S.hit(bus, name, at, o)             a drum hit into bus at film time at
//   S.sound(name, midi, o)              the note (or, for a drum, the hit) as Channels, for kit play()
//   S.instruments                       the manifest's instruments, by name
//   S.credits()                         [{ what, licence, text }] for every instrument used so far
//   n("C#4")                            a note name as a MIDI number (61)
//
// Options. note/sound: vel 0..1 (0.7), dur s held (1), release s (0.25),
// attack s fade-in (0.002), layer (a layer's name, instead of vel), rr (a round
// robin; drums otherwise take the next). note/hit also take what kit play()
// takes: gain, pan, send, align ("onset" lines the recorded attack up with
// at), and hit takes semitones. send is an object, not a number: with
// `const room = space(LEN)` from kit/audio.mjs, `send: { bus: room.send,
// amount: 0.15 }`; mix `room.wet()` into the master once at the end.
//
// kit diagnose() on a bus can call the strike of a harp, marimba or vibes
// note "a click" about 3 ms after the note's time: that is the instrument's
// own attack against the silence before it, not a cut (attack: 0.01 softens
// it, and the strike with it).
//
// The smallest score — one bar: a chord and a drum pattern. Run from the film
// folder: node score.mjs → score.wav
//
//   import { buses, buffer, mix, normalize, diagnose, loudness, writeWav } from "./kit/audio.mjs";
//   import { sampler, n } from "./lib/sampler.mjs";
//
//   const S = sampler();                                  // ./samples, beside lib/
//   const LEN = 3, beat = 60 / 120, at0 = 0.25;           // 120 BPM: one bar, 0.25–2.25 s
//   const B = buses(LEN, ["keys", "drums"]);
//   for (const name of ["D3", "F#3", "A3", "C#4", "E4"])  // Dmaj9, held for the bar
//     S.note(B.keys, "piano", n(name), at0, { vel: 0.55, dur: 4 * beat, release: 0.6, gain: 0.5 });
//   for (let i = 0; i < 4; i++) {
//     S.hit(B.drums, "pk_kick", at0 + i * beat, { vel: i === 0 ? 0.9 : 0.6, gain: 0.6, align: "onset" });
//     S.hit(B.drums, "pk_hat", at0 + (i + 0.5) * beat, { vel: 0.3, gain: 0.3, pan: 0.3, align: "onset" });
//   }
//   S.hit(B.drums, "pk_snare", at0 + 1 * beat, { vel: 0.7, gain: 0.5, align: "onset" });
//   S.hit(B.drums, "pk_snare", at0 + 3 * beat, { vel: 0.7, gain: 0.5, align: "onset" });
//
//   const master = buffer(LEN);
//   for (const [name, bus] of Object.entries(B)) {
//     for (const f of diagnose(name, bus)) console.log(f.stem, f.kind, f.at, f.message);
//     mix(master, bus);
//   }
//   const out = normalize(master);                        // −16 LUFS, true peak ≤ −1 dBTP
//   writeWav("score.wav", out);
//   console.log(loudness(out), out.report);
//   console.log(JSON.stringify(S.credits()));             // on the page: for (const c of [...]) tl.credit(c)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, varispeed, play } from "../kit/audio.mjs";

/** @typedef {import("../kit/audio.mjs").Channels} Channels */
/** @typedef {import("../kit/audio.mjs").Signal} Signal */
/**
 * One recording in manifest.json.
 * @typedef {{ file: string, layer: string, rr?: string, ch?: number, root?: number | null, cents?: number }} Sample
 */
/**
 * One instrument in manifest.json.
 * @typedef {{ license: string, credit?: string[], drum?: boolean, channels?: number, samples: Sample[] }} Instrument
 */
/**
 * What note, sound and hit take (see Options above).
 * @typedef {{ vel?: number, dur?: number, release?: number, attack?: number, layer?: string | number, rr?: number,
 *   gain?: import("../kit/audio.mjs").Auto, pan?: import("../kit/audio.mjs").Auto,
 *   send?: { bus: Channels, amount?: import("../kit/audio.mjs").Auto }, align?: "start" | "onset" | "peak" | number,
 *   semitones?: number }} NoteOptions
 */

const DYN = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"];
/** a layer's place, softest first: numbers as numbers, dynamics in order @param {string} l */
const layerRank = (l) => (/^\d+$/.test(l) ? Number(l) : DYN.includes(l) ? DYN.indexOf(l) : 0);

/**
 * The instruments in `dir` (a folder holding manifest.json and the
 * instruments' folders). `const S = sampler();` or `sampler("samples")`
 * @param {string} [dir]
 * @param {{ sampleRate?: number }} [o]
 */
export function sampler(dir = fileURLToPath(new URL("../samples", import.meta.url)), { sampleRate = 48000 } = {}) {
  /** @type {{ instruments: Record<string, Instrument> }} */
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  /** @type {Map<string, Channels>} */
  const files = new Map(); // file → decoded channels
  /** @type {Map<string, Channels>} */
  const rendered = new Map(); // file|pitch|dur|… → a note ready to play
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Map<string, number>} */
  const turns = new Map(); // name|layer → the next round robin

  /** @param {string} file @returns {Channels} */
  const decoded = (file) => {
    if (!files.has(file)) files.set(file, load(join(dir, file), { sampleRate, channels: 2 }));
    return /** @type {Channels} */ (files.get(file));
  };
  /** @param {string} name */
  const inst = (name) => {
    const I = manifest.instruments[name];
    if (!I) {
      const names = Object.keys(manifest.instruments).join(", ");
      throw new Error(`sampler: no instrument "${name}" in ${dir}/manifest.json (there are: ${names})`);
    }
    used.add(name);
    return I;
  };
  /** the layer asked for, or the one nearest vel (0..1) among the instrument's, softest first
   *  @param {Instrument} I @param {number} vel @param {string | number | undefined} layer @returns {string} */
  const layerFor = (I, vel, layer) => {
    const layers = [...new Set(I.samples.map((s) => s.layer))].sort((a, b) => layerRank(a) - layerRank(b));
    if (layer != null) {
      if (!layers.includes(String(layer))) throw new Error(`sampler: no layer "${layer}" (there are: ${layers.join(", ")})`);
      return String(layer);
    }
    return /** @type {string} */ (layers[Math.min(layers.length - 1, Math.max(0, Math.round(vel * (layers.length - 1))))]);
  };
  /** round robin: the one asked for, or the next of this pool
   *  @param {Sample[]} pool @param {string} key @param {number | undefined} rr @returns {Sample} */
  const pick = (pool, key, rr) => {
    if (rr == null) {
      rr = turns.get(key) ?? 0;
      turns.set(key, rr + 1);
    }
    return /** @type {Sample} */ (pool[rr % pool.length]);
  };

  /** cut src to what dur + release need at `rate`, play it at rate, release from dur, fade the start in
   *  @param {string} file @param {number} rate @param {{ dur?: number, release: number, attack: number }} o
   *  @returns {Channels} */
  function shape(file, rate, { dur, release, attack }) {
    const src = decoded(file);
    const total = /** @type {Signal} */ (src[0]).length;
    const need = dur == null ? total : Math.min(total, Math.ceil((dur + release) * rate * sampleRate) + 64);
    const cut = Object.assign(src.map((c) => c.subarray(0, need)), { sampleRate });
    const out = Math.abs(rate - 1) < 1e-6 ? Object.assign(cut.map((c) => Float32Array.from(c)), { sampleRate }) : varispeed(cut, rate);
    const n = /** @type {Signal} */ (out[0]).length;
    const h = dur == null ? n : Math.min(n, Math.round(dur * sampleRate));
    const r = Math.max(1, Math.round(release * sampleRate));
    for (const c of out)
      for (let i = h; i < n; i++) {
        const u = (i - h) / r;
        /** @type {number} */ (c[i]) *= u >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * u)); // raised cosine: no corner, no click
      }
    // a short fade in: a recording cut at its start may begin mid-cycle
    const fin = Math.max(1, Math.round(attack * sampleRate));
    for (const c of out) for (let i = 0; i < Math.min(fin, n); i++) /** @type {number} */ (c[i]) *= 0.5 * (1 - Math.cos((Math.PI * i) / fin));
    const len = dur == null ? n : Math.min(n, h + r);
    return Object.assign(out.map((c) => c.slice(0, len)), { sampleRate });
  }

  /**
   * The sound of `name` at MIDI note `midi` (fractional allowed) as Channels.
   * A drum (or midi null) gives its hit, whole unless dur is given.
   * `play(bus, S.sound("vibes", 74, { vel: 0.5, dur: 0.4 }), t, { gain: 0.4 })`
   * @param {string} name @param {number | null} midi @param {NoteOptions} [o]
   * @returns {Channels}
   */
  function sound(name, midi, { vel = 0.7, dur, release = 0.25, attack = 0.002, layer, rr } = {}) {
    const I = inst(name);
    const L = layerFor(I, vel, layer);
    const inLayer = I.samples.filter((s) => s.layer === L);
    if (I.drum || midi == null) {
      const s = pick(inLayer, `${name}|${L}`, rr);
      const key = `hit|${s.file}|${dur}|${release}`;
      if (!rendered.has(key)) rendered.set(key, shape(s.file, 1, { dur, release, attack: 0.001 }));
      return /** @type {Channels} */ (rendered.get(key));
    }
    const pitched = /** @type {(Sample & { root: number })[]} */ (inLayer.filter((s) => s.root != null));
    if (!pitched.length) throw new Error(`sampler: "${name}" has no pitched samples in layer ${L}`);
    const best = pitched.reduce((a, b) => (Math.abs(b.root - midi) < Math.abs(a.root - midi) ? b : a));
    const pool = pitched.filter((s) => s.root === best.root);
    const s = /** @type {Sample & { root: number }} */ (rr == null ? pool[0] : pool[rr % pool.length]);
    const rate = 2 ** ((midi - s.root) / 12 - (s.cents ?? 0) / 1200);
    const held = dur ?? 1;
    const key = `${s.file}|${midi}|${held}|${release}|${attack}`;
    if (!rendered.has(key)) rendered.set(key, shape(s.file, rate, { dur: held, release, attack }));
    return /** @type {Channels} */ (rendered.get(key));
  }

  /**
   * A pitched note of `name` into `bus` at film time `at`; returns where it
   * sounds ({ start, end }, s). `S.note(B.keys, "piano", n("A3"), 2.5, { vel: 0.5, dur: 1.2, gain: 0.5, pan: -0.2 })`
   * @param {Channels} bus @param {string} name @param {number} midi @param {number} at @param {NoteOptions} [o]
   */
  function note(bus, name, midi, at, { vel, dur, release, attack, layer, rr, gain, pan, send, align } = {}) {
    return play(bus, sound(name, midi, { vel, dur, release, attack, layer, rr }), at, { gain, pan, send, align });
  }

  /**
   * A drum hit into `bus` at film time `at`: its velocity layer, the next round
   * robin. `S.hit(B.drums, "pk_kick", 4.0, { vel: 0.8, align: "onset" })`
   * @param {Channels} bus @param {string} name @param {number} at @param {NoteOptions} [o]
   */
  function hit(bus, name, at, { vel, layer, rr, dur, release, gain, pan, send, align, semitones } = {}) {
    return play(bus, sound(name, null, { vel, layer, rr, dur, release }), at, { gain, pan, send, align, semitones });
  }

  /**
   * What the score used that others recorded, one entry per source, for the
   * page's tl.credit. `for (const c of S.credits()) console.log(JSON.stringify(c))`
   */
  function credits() {
    /** @type {Map<string, { names: string[], licence: string, text: string }>} */
    const by = new Map();
    for (const name of used) {
      const I = /** @type {Instrument} */ (manifest.instruments[name]);
      const text = (I.credit ?? []).join("; ");
      const k = `${I.license}|${text}`;
      if (!by.has(k)) by.set(k, { names: [], licence: I.license, text });
      by.get(k)?.names.push(name);
    }
    return [...by.values()].map((c) => ({ what: `samples: ${c.names.join(", ")}`, licence: c.licence, text: c.text }));
  }

  return { note, hit, sound, credits, instruments: manifest.instruments };
}

/** a note name as a MIDI number: n("C4") === 60, n("F#3") === 54, n("Bb2") === 46 @param {string} name */
export function n(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`n: ${name} is not a note name`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[/** @type {"C" | "D" | "E" | "F" | "G" | "A" | "B"} */ (m[1])];
  return base + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12 * (Number(m[3]) + 1);
}
