// hud.js — the words a launch film keeps on screen, pinned to the screen and
// not to the camera: a status chip saying what the agent is doing now, a
// status line swept in under a mask, a voice with its caption spoken word by
// word, a prompt typed fast then slow in fresh ink and sent with a press
// and a burst of pixels, agents' cursor labels pinned to a thing on screen or
// to a point in 3D, a detection box with its number counting, a title out of
// blur. Measured on launch films that keep words on screen all the time; each
// default says which film and where (24 fps films: one frame is 1/24 s, `F`).
//
// Made once, then drawn from film time: `draw(t)` writes the element and
// returns `at(t)`, the same numbers for the same t in any order — except
// where a piece is pinned to the page's own layout (`pinTo`), which reads
// where the element is when asked, and where a word's ink is read from the
// scene drawn under it; nothing here keeps time. A count in frames (a letter a frame, a step every 2) is counted
// on the frame it lands on, at 24, 30 or 60 fps alike. `host` is a
// screen-space layer (`layer()` makes one: the frame's size, above the
// scenes, never moved by the camera), so a chip stays put across a cut while
// the pictures change under it. null gives numbers only.
//
//   import { layer, chip, voice, prompt } from "./lib/hud.js";
//   const hud = layer();
//   const status = chip(hud, { steps: [{ t: 1.2, text: "Drafting the blueprint" },
//                                      { t: 4.0, text: "Building pages" }], out: 7.5 });
//   const said = voice(hud, { t: 2.0, text: "Make it fly across the map", until: 4.4 });
//   const box = prompt(hud, { t: 4.4, text: said.text, type: { t: 4.4, from: said.chars(4.4) }, send: 6.1 });
//   window.__render = (t) => { status.draw(t); said.draw(t); box.draw(t); };
//   window.__film = { duration: 8, width: 1080, height: 1920, ... };
//
// The frame's size is read when a piece is first drawn (or its numbers first
// asked for): `o.frame`, else the page's `window.__film` width and height,
// else 1920 × 1080. So `window.__film` may be set after the pieces are made,
// as above, and an upright 1080 × 1920 film lays its words out upright.
//
//   layer(parent?, o?)          the screen-space layer the rest go in; `accent`: the film's own colour
//   chip(host, o)               a status chip: dot → capsule, text from the middle out (or typed),
//                               changing text in place or sliding across, retracting to a dot or a line;
//                               `avoid`: the product's rects it keeps clear of
//   counter(host, o)            a count or a clock kept on screen: fields that change in place, only
//                               the characters that changed moving; a number can run to its next value
//   clock(minutes, o)           minutes since midnight as "6:42 PM" or "18:42", for a counter's field
//   statusLine(host, o)         one to three lines swept in left to right under a soft mask, fresh
//                               colour settling to ink, rising in; a thinking shimmer; leaving upward
//   voice(host, o)              an orb and a caption spoken word by word, grey → white per word;
//                               chars(t) is how much has been said, for the prompt that carries it on
//   typeAt(t, t0, text, o)      a typing performance: fast then slow, each character's birth time
//   prompt(host, o)             a prompt box: typed text in fresh ink, a send button's press,
//                               a light wave and a pixel burst on send, the box closing in after
//   burst(host, o)              a burst of pixels round a point (the prompt's send uses one),
//                               inside the frame
//   agent(host, o)              an agent's cursor and name label, popping in, pinned to a point
//   pinTo(el, o)                a point of an element, in the frame, for agent's `at`
//   project(camera, p, o)       a three.js camera's view of a 3D point, in the frame, for `at`
//   detect(host, o)             a detection box: label typed, outline drawn, number counting up
//                               on a plate of its colour
//   title(host, o)              a title whose letters come out of blur one after another
//
// Sizes default to shares of the frame's short side — its height in a
// landscape film (the films' own), its width in an upright one: a chip's text
// 0.04, a caption 0.06, a prompt's text 0.03, an agent's name 0.018. A
// landscape film seen on an upright phone is about 390 px across, a fifth of
// 1920: a chip's 43 px shows at about 9 px there, a caption's 65 px at 13 px;
// agents' names (19 px → 4 px) are a texture of many hands at work, not text to
// read (`film probe`'s text lane says what the film's own words come to).
// The defaults keep out of each other's way: a chip low at the left (0.9 H),
// a caption above it (0.8 H) wrapping inside 0.86 W, a title wrapping inside
// 0.9 W, a status line made smaller until it fits across.
//
// One accent, the film's own: `layer(parent, { accent: "#d97757" })`, or the
// CSS custom property `--hud-accent` on the layer or anything it sits in
// (`:root { --hud-accent: var(--brand) }`). The chip's mark, the status
// line's fresh ink and mark, the voice's orb, the prompt's send button,
// fresh ink, light wave and burst, and an agent's label all take it, each
// piece's own option (`accent`, `fresh`, `orbColour`, `burst`, `colour`)
// over it. With none given they are drawn without a colour of their own —
// the ink, lighter while fresh; a grey orb; a dark label — and never in the
// colours of the films these were measured on (those had an orange send
// button, a cyan burst, a yellow-to-magenta sweep: theirs, not yours). A
// detection box keeps its red, yellow and green: they say low, middling and
// high, whatever the film.
//
// Colours are any CSS colour (#hex, rgb(), hsl(), a name). Words with no
// backing of their own — a status line, a caption, a title, a detection
// box's label — take their ink from the scene under them when no `ink` /
// `colour` is given: dark on a light scene, light on a dark one, read from
// the colours the page paints there as each frame is drawn; over a picture
// (an <img>, <video> or <canvas>) light with a soft shadow. The chip and the
// prompt carry their own dark glass, and a detection box's number its own
// plate of the box's colour.
//
// Nothing here blurs on its own except a title's letters: the master's
// shutter smears a chip sliding across or a box closing in. Its eases and
// clamp are lib/anim.js's, which sits beside it; an agent pinned to a point
// of lib/space.js's stage takes `at: (t) => st.toFrame(p, t)`.

import { clamp, ease, gsapEase, lerp, prog } from "./anim.js";

/** @typedef {{ width: number, height: number }} Frame */
/** @typedef {[number, number]} Pt  a point in the frame, px */
/** @typedef {Pt | ((t: number) => Pt | null)} Where  a point, or one read from film time (null: not on screen) */

/** one frame of the 24 fps films the numbers were measured on, in seconds */
export const F = 1 / 24;

/** a microsecond: a time that lands on a frame counts as on it, whatever the float error of t − t0 */
const EPS = 1e-6;
/** t has reached `edge` (a frame's time computed another way still counts) @param {number} t @param {number} edge */
const on = (t, edge) => t >= edge - EPS;
/** whole steps of `per` seconds in dt, the step that lands on a frame counted on that frame @param {number} dt @param {number} per */
const count = (dt, per) => Math.floor(dt / per + EPS);

const clamp01 = (/** @type {number} */ x) => clamp(x);
const { out2, out3, in2, in3 } = ease;
/** back.out: past 1 by about 10 % and back */
const backOut = /** @type {(u: number) => number} */ (gsapEase("back.out(1.7)"));
/** a number 0..1 from integers, the same every time @param {number} a @param {number} [b] */
const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const esc = (/** @type {string} */ s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const r1 = (/** @type {number} */ n) => Math.round(n * 10) / 10;

/** @type {Intl.Segmenter | null | undefined} */
let segmenter;
/** the characters a reader sees (an emoji, a flag, an accented letter: one each) @param {string} s @returns {string[]} */
function glyphs(s) {
  if (segmenter === undefined)
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  return segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s);
}

/** the frame: o.frame, else the page's __film size, else 1920 × 1080 @param {Frame} [f] @returns {Frame} */
function frameOf(f) {
  if (f) return f;
  const film = /** @type {{ __film?: { width?: number, height?: number } }} */ (globalThis).__film;
  return { width: film?.width ?? 1920, height: film?.height ?? 1080 };
}
/** the frame's short side: its height in a landscape film, its width in an upright one @param {Frame} fr */
const short = (fr) => Math.min(fr.width, fr.height);

/**
 * Sizes made from the frame, worked out when first asked for and again only
 * if the frame changes — so a page may declare `window.__film` after it made
 * its words.
 * @template T @param {Frame | undefined} f @param {(fr: Frame) => T} make @returns {() => T}
 */
function later(f, make) {
  let key = "";
  /** @type {T | undefined} */
  let got;
  return () => {
    const fr = frameOf(f);
    const k = `${fr.width}x${fr.height}`;
    if (k !== key || got === undefined) {
      key = k;
      got = make(fr);
    }
    return got;
  };
}

/** a point read at t @param {Where | undefined} w @param {number} t @returns {Pt | null} */
const where = (w, t) => (typeof w === "function" ? w(t) : (w ?? null));

// --- colours ------------------------------------------------------------------

const NAMED =
  "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 " +
  "black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 " +
  "chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff " +
  "darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 " +
  "darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 " +
  "darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f " +
  "darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 " +
  "dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc " +
  "ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 " +
  "honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa " +
  "lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff " +
  "lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a " +
  "lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de " +
  "lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa " +
  "mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee " +
  "mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa " +
  "mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 " +
  "orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee " +
  "palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 " +
  "purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 " +
  "sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd " +
  "slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 " +
  "thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 " +
  "yellowgreen:9acd32";
/** @type {Map<string, string> | null} */
let names = null;
/** @type {CanvasRenderingContext2D | null | undefined} */
let probeCtx;

/** @typedef {[number, number, number, number]} Rgba  0..255 each, alpha 0..1 */

/**
 * [r, g, b, a] of a CSS colour — #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(),
 * hsl()/hsla(), a named colour, `transparent`; in a page, anything else the
 * browser reads (color(), oklch() …). null when it is not one.
 * @param {string} c @returns {Rgba | null}
 */
export function readColour(c) {
  const s = String(c).trim().toLowerCase();
  if (s === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]+)$/.exec(s);
  if (hex) {
    let h = /** @type {string} */ (hex[1]);
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (/** @type {number} */ i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = /** @type {string} */ (fn[2]).split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (/** @type {string} */ p, /** @type {number} */ full) => (p.endsWith("%") ? (parseFloat(p) / 100) * full : parseFloat(p));
    const a = parts[3] == null ? 1 : num(parts[3], 1);
    /** @type {number[]} */
    let ch;
    if (/** @type {string} */ (fn[1]).startsWith("rgb")) ch = [0, 1, 2].map((i) => num(/** @type {string} */ (parts[i]), 255));
    else {
      const h = ((parseFloat(/** @type {string} */ (parts[0])) % 360) + 360) % 360;
      const sat = num(/** @type {string} */ (parts[1]), 1);
      const l = num(/** @type {string} */ (parts[2]), 1);
      const k = (/** @type {number} */ n) => (n + h / 30) % 12;
      const q = sat * Math.min(l, 1 - l);
      ch = [0, 8, 4].map((n) => 255 * (l - q * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    }
    if ([...ch, a].some((v) => !Number.isFinite(v))) return null;
    return [clamp(ch[0] ?? 0, 0, 255), clamp(ch[1] ?? 0, 0, 255), clamp(ch[2] ?? 0, 0, 255), clamp01(a)];
  }
  names ??= new Map(NAMED.split(" ").map((p) => /** @type {[string, string]} */ (p.split(":"))));
  const named = names.get(s);
  if (named) return readColour(`#${named}`);
  // anything else CSS knows: the browser's own reading of it
  if (typeof document !== "undefined") {
    if (probeCtx === undefined) probeCtx = document.createElement("canvas").getContext("2d");
    if (probeCtx) {
      probeCtx.fillStyle = "#010203";
      probeCtx.fillStyle = c;
      const got = String(probeCtx.fillStyle);
      if (got !== "#010203" && /^(#|rgb)/.test(got)) return readColour(got);
    }
  }
  return null;
}

/** a colour read, or a clear error @param {string} c @param {string} what @returns {Rgba} */
function colourOf(c, what) {
  const v = readColour(c);
  if (!v) throw new Error(`hud: ${what} "${c}" is not a colour it can read (#hex, rgb(), hsl() or a CSS name)`);
  return v;
}

/** two colours mixed at u, as rgb() (rgba() when either is see-through) @param {string} a @param {string} b @param {number} u */
function mix(a, b, u) {
  const A = colourOf(a, "colour");
  const B = colourOf(b, "colour");
  const ch = [0, 1, 2].map((i) => Math.round(lerp(/** @type {number} */ (A[i]), /** @type {number} */ (B[i]), u)));
  const al = lerp(A[3], B[3], u);
  return al >= 1 ? `rgb(${ch.join(", ")})` : `rgba(${ch.join(", ")}, ${Math.round(al * 1000) / 1000})`;
}

/** a colour at `alpha` of its own opacity, as rgba() @param {string} c @param {number} alpha */
function faded(c, alpha) {
  const [r, g, b, a] = colourOf(c, "colour");
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * alpha * 1000) / 1000})`;
}

/**
 * The film's accent for the pieces of a layer: `--hud-accent` as the layer
 * computes it (layer()'s `accent`, or the page's own CSS), null when there
 * is none or no page.
 * @param {HTMLElement | null} host @returns {string | null}
 */
function accentOf(host) {
  if (!host || typeof getComputedStyle !== "function") return null;
  const v = getComputedStyle(host).getPropertyValue("--hud-accent").trim();
  return v && readColour(v) ? v : null;
}

/** an accent with a lighter and a deeper tone of itself (a highlight, a shade) @param {string} c */
const tones = (c) => ({ light: mix(c, "#ffffff", 0.45), mid: c, deep: mix(c, "#000000", 0.35) });

/** black or white, whichever stands further from `c` (the WCAG contrast ratio) @param {string} c */
function inkOn(c) {
  const L = luminance(colourOf(c, "colour"));
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "#000000" : "#ffffff";
}

// --- the scene under the words --------------------------------------------------

/** the inks for words with no backing: on a light scene, on a dark one */
const INK = { onLight: "#1c1c21", onDark: "#f4f2f6" };

/** relative luminance 0..1 of a colour @param {Rgba} c */
function luminance(c) {
  const f = (/** @type {number} */ c8) => {
    const v = c8 / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/** the luminance the page paints at a point of the viewport; null under a picture or where it paints nothing it says @param {number} x @param {number} y */
function paintedAt(x, y) {
  for (const e of document.elementsFromPoint(x, y)) {
    if (e.closest(".hud-layer")) continue;
    if (/^(img|video|canvas|iframe|picture|object|embed|image)$/i.test(e.tagName)) return null;
    const cs = getComputedStyle(e);
    const img = cs.backgroundImage;
    if (img && img !== "none") {
      if (img.includes("url(")) return null;
      const stops = (img.match(/rgba?\([^)]*\)/g) ?? []).map(readColour).filter((c) => c != null && c[3] > 0.3);
      if (stops.length) return stops.reduce((s, c) => s + luminance(/** @type {Rgba} */ (c)), 0) / stops.length;
    }
    const bg = readColour(cs.backgroundColor);
    if (bg && bg[3] > 0.5) return luminance(bg);
  }
  return null;
}

/**
 * "light" or "dark": the scene behind these elements of the layer, from the
 * colours the page paints there; null when it cannot tell (a picture, or no page).
 * @param {(Element | null | undefined)[]} els @returns {"light" | "dark" | null}
 */
function sceneBehind(els) {
  if (typeof document === "undefined" || typeof document.elementsFromPoint !== "function") return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const e of els) {
    if (!e) continue;
    const q = e.getBoundingClientRect();
    l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  if (!Number.isFinite(l)) return null;
  /** @type {number[]} */
  const seen = [];
  for (const [u, v] of [[0.5, 0.5], [0.12, 0.3], [0.88, 0.3], [0.12, 0.75], [0.88, 0.75]]) {
    const L = paintedAt(lerp(l, r, /** @type {number} */ (u)), lerp(t, b, /** @type {number} */ (v)));
    if (L != null) seen.push(L);
  }
  if (!seen.length) return null;
  return seen.reduce((s, x) => s + x, 0) / seen.length > 0.36 ? "light" : "dark";
}

/** the ink for words on a scene, and the shadow that keeps light ink legible where the scene is not known @param {"light" | "dark" | null} scene */
const inkFor = (scene) =>
  scene === "light"
    ? { ink: INK.onLight, shadow: "none" }
    : { ink: INK.onDark, shadow: scene === "dark" ? "0 2px 18px rgba(0,0,0,0.35)" : "0 1px 3px rgba(0,0,0,0.55), 0 2px 16px rgba(0,0,0,0.45)" };

const FONT = `"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const CSS = `
.hud-layer { position: absolute; left: 0; top: 0; pointer-events: none; overflow: hidden; isolation: isolate; z-index: 50; }
.hud-layer * { box-sizing: border-box; }
.hud-chip { position: absolute; left: 0; top: 0; display: flex; align-items: center; white-space: nowrap;
  border-radius: 999px; font-weight: 600; letter-spacing: -0.01em; }
.hud-chip svg { flex: none; }
.hud-counter { position: absolute; left: 0; top: 0; display: flex; align-items: center; white-space: pre;
  border-radius: 999px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.hud-counter .hud-cell { position: relative; display: inline-block; }
.hud-counter .hud-cell > span { display: inline-block; }
.hud-counter .hud-cell > b { position: absolute; left: -1em; right: -1em; top: 0; text-align: center; font-weight: inherit; }
.hud-counter .hud-cell.hud-whole > b { left: 0; right: -60em; text-align: left; }
.hud-status { position: absolute; left: 0; top: 0; }
.hud-status .hud-line { position: absolute; left: 0; white-space: nowrap; line-height: 1.15; letter-spacing: -0.02em;
  -webkit-background-clip: text; background-clip: text; color: transparent; }
.hud-voice { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; }
.hud-orb { position: relative; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.hud-orb i { display: block; border-radius: 99px; background: #fff; }
.hud-caption { white-space: normal; text-align: center; line-height: 1.2; font-weight: 500; letter-spacing: -0.01em; }
.hud-prompt { position: absolute; left: 0; top: 0; overflow: hidden; }
.hud-prompt .hud-text { position: absolute; white-space: pre-wrap; overflow-wrap: break-word; }
.hud-prompt .hud-caret { display: inline-block; width: 0.08em; height: 1.05em; vertical-align: -0.17em; margin-left: 0.04em; }
.hud-prompt .hud-foot { position: absolute; display: flex; align-items: center; gap: 0.6em; font-weight: 500; }
.hud-prompt .hud-send { position: absolute; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; }
.hud-prompt .hud-wave { position: absolute; inset: 0; }
.hud-burst { position: absolute; left: 0; top: 0; }
.hud-agent { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.hud-agent span { position: absolute; white-space: nowrap; font-weight: 700; border-radius: 0.3em; }
.hud-detect { position: absolute; left: 0; top: 0; }
.hud-detect svg { position: absolute; left: 0; top: 0; overflow: visible; }
.hud-detect b { position: absolute; white-space: nowrap; line-height: 1; letter-spacing: -0.02em; }
.hud-title { position: absolute; left: 0; top: 0; white-space: normal; line-height: 1.05; }
.hud-title .hud-word { display: inline-block; white-space: nowrap; }
.hud-title span span { display: inline-block; white-space: pre; }
`;

/** the module's styles, once per document */
function styles() {
  if (typeof document === "undefined" || document.getElementById("hud-css")) return;
  const s = document.createElement("style");
  s.id = "hud-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** an element of class cls in parent @param {string} tag @param {string} cls @param {Element | null} parent @returns {HTMLElement} */
function mk(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

/** a layer() made without a frame takes the frame's size once it is known @param {HTMLElement | null} host @param {Frame} fr */
function fit(host, fr) {
  if (host?.dataset.hudFit !== "page") return;
  host.style.width = `${fr.width}px`;
  host.style.height = `${fr.height}px`;
}

/** an asterisk of six spokes, the agent's "working" mark @param {number} px @param {string} colour */
const star = (px, colour) =>
  `<svg width="${px}" height="${px}" viewBox="-12 -12 24 24"><g stroke="${esc(colour)}" stroke-width="2.6" stroke-linecap="round">` +
  [0, 30, 60, 90, 120, 150]
    .map((a) => {
      const c = Math.cos((a * Math.PI) / 180) * 10;
      const s = Math.sin((a * Math.PI) / 180) * 10;
      return `<line x1="${r1(-c)}" y1="${r1(-s)}" x2="${r1(c)}" y2="${r1(s)}"/>`;
    })
    .join("") +
  `</g></svg>`;

// --- the layer ----------------------------------------------------------------

/**
 * The screen-space layer the words go in: the frame's size at its top-left,
 * above everything the page has drawn so far, never under the camera. Put it
 * last in the page (or give it a higher zIndex) and keep the scenes and the
 * camera in elements of their own; then a chip, a caption or a label stays
 * where it is on screen through a cut, a push or a whip. Without `frame` it
 * takes the size `window.__film` declares, when the first piece in it draws.
 * `accent`: the film's own colour, which every piece in the layer takes for
 * its mark, fresh ink, button, orb or label (it is set as `--hud-accent` on
 * the layer; a page that sets that property in its own CSS needs no option).
 * @param {Element | null} [parent] default document.body
 * @param {{ frame?: Frame, z?: number, accent?: string }} [o]
 * @returns {HTMLElement | null}
 */
export function layer(parent, o = {}) {
  if (typeof document === "undefined") return null;
  styles();
  const el = mk("div", "hud-layer", parent ?? document.body);
  if (!o.frame) el.dataset.hudFit = "page";
  const fr = frameOf(o.frame);
  el.style.width = `${fr.width}px`;
  el.style.height = `${fr.height}px`;
  if (o.z != null) el.style.zIndex = String(o.z);
  if (o.accent) {
    colourOf(o.accent, "layer accent");
    el.style.setProperty("--hud-accent", o.accent);
  }
  return el;
}

// --- typing -------------------------------------------------------------------

// A prompt typed in a launch film (Df-JzBcCrDo 7.46–8.38 s, read frame by
// frame): characters on screen at each 24 fps frame from the first. A brief
// run-up, then 4–6 characters a frame, slowing to one every other frame at the
// end: 43 characters in 22 frames, 48 a second on average.
const MEASURED_TYPING = [0, 2, 3, 6, 10, 16, 20, 24, 27, 30, 32, 34, 35, 36, 36, 38, 39, 40, 40, 41, 41, 42, 43];

/** the measured typing as a progress 0..1 → share of the characters @param {number} u */
function typedShare(u) {
  const n = MEASURED_TYPING.length - 1;
  const x = clamp01(u) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const last = /** @type {number} */ (MEASURED_TYPING[n]);
  return lerp(/** @type {number} */ (MEASURED_TYPING[i]), /** @type {number} */ (MEASURED_TYPING[i + 1]), x - i) / last;
}

/**
 * @typedef {object} Typed  a typing performance at t
 * @property {number} n  characters on screen
 * @property {string} text  the text typed so far
 * @property {number} start  when the typing starts (t0)
 * @property {number} end  when the last character lands
 * @property {boolean} done
 * @property {(i: number) => number} born  when character i appeared (−Infinity for those there before)
 */

/**
 * A typing performance: `text` typed from t0, fast then slow as a person
 * types a request they know (curve "measured", the default: Df-JzBcCrDo's
 * prompt, 48 characters a second on average) or at an even rate (curve
 * "even": the one line the film wants read, Dfj2vYxC1pE's key command at one
 * character a 24 fps frame, `{ curve: "even", cps: 24 }`). `from`: characters
 * already there at t0 — a line a voice said in the shot before, carried on.
 * Characters are the ones a reader sees: an emoji is one.
 * `typeAt(t, 4.4, "Make it fly across the map", { from: 12 }).text`
 * @param {number} t @param {number} t0 @param {string} text
 * @param {{ cps?: number, curve?: "measured" | "even" | ((u: number) => number), from?: number }} [o]
 * @returns {Typed}
 */
export function typeAt(t, t0, text, o = {}) {
  const chars = glyphs(text);
  const len = chars.length;
  const from = Math.max(0, Math.min(len, Math.round(o.from ?? 0)));
  const rest = len - from;
  const cps = o.cps ?? (o.curve === "even" ? 24 : 48);
  if (!(cps > 0)) throw new Error(`hud.typeAt: cps is characters a second, above 0 (got ${cps})`);
  const dur = rest / cps;
  const curve = typeof o.curve === "function" ? o.curve : o.curve === "even" ? (/** @type {number} */ u) => u : typedShare;
  const typed = (/** @type {number} */ u) => Math.floor(rest * curve(u) + EPS);
  const nAt = (/** @type {number} */ tt) => from + (on(tt, t0) ? Math.min(rest, typed(prog(tt, t0, t0 + dur))) : 0);
  const n = nAt(t);
  const born = (/** @type {number} */ i) => {
    if (i < from) return -Infinity;
    // the first u at which character i is on screen (the curve only climbs)
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (from + typed(mid) > i) hi = mid;
      else lo = mid;
    }
    return t0 + hi * dur;
  };
  return { n, text: chars.slice(0, n).join(""), start: t0, end: t0 + dur, done: n >= len, born };
}

/**
 * Typed text as HTML, its newest characters in fresh ink cooling to `ink`:
 * Df-JzBcCrDo's prompts show the last 4–10 characters in its orange, white
 * within 4–8 frames (`freshFor` 6 frames, the default); its error line used
 * green. `fresh` is that colour — the film's accent; with none, the ink at
 * half strength, so new characters come in light and fill. Escaped; a caret
 * after it while `caret` is true.
 * @param {number} t @param {Typed} ty
 * @param {{ ink?: string, fresh?: string, freshFor?: number, caret?: boolean, caretColour?: string }} [o]
 */
export function inkHtml(t, ty, o = {}) {
  const ink = o.ink ?? "#f4f2f6";
  const fresh = o.fresh ?? faded(ink, 0.5);
  const freshFor = o.freshFor ?? 6 * F;
  const chars = glyphs(ty.text);
  let k = ty.n;
  while (k > 0 && t - ty.born(k - 1) < freshFor) k--;
  let html = esc(chars.slice(0, k).join(""));
  for (let i = k; i < ty.n; i++) {
    const age = t - ty.born(i);
    html += `<span style="color:${mix(fresh, ink, clamp01(age / freshFor))}">${esc(chars[i] ?? "")}</span>`;
  }
  if (o.caret) html += `<i class="hud-caret" style="background:${esc(o.caretColour ?? o.fresh ?? ink)}"></i>`;
  return html;
}

// --- status chip --------------------------------------------------------------

/**
 * @typedef {object} ChipStep  one thing the chip says, from t
 * @property {number} t
 * @property {string} text
 * @property {number} [x]  slide to here as it changes (frame px; default where it was)
 * @property {number} [y]
 */
/**
 * @typedef {object} ChipAt  the chip at t
 * @property {boolean} visible
 * @property {number} x @property {number} y  the anchor point in the frame
 * @property {number} scale  growing from a dot / shrinking back to one
 * @property {number} scaleY  1, or less while retracting to a line
 * @property {number} open  0 a circle … 1 the whole capsule (mode "open")
 * @property {string} text  what it shows
 * @property {number} step  which step's text (−1 before the first)
 * @property {number} spin  the icon's turn, degrees
 * @property {number} ink  how much of the text shows, 0..1 (less while the capsule is nearly shut)
 */
/** @typedef {{ x: number, y: number, w: number, h: number }} Box  a rect of the frame, px */

/**
 * A status chip: what the agent is doing now, in a few words ("Drafting the
 * blueprint"), low on the screen in screen space. It grows from a dot
 * (2 frames: Df-JzBcCrDo 19.79 s, a dot one frame, the circle the next),
 * opens into a capsule with its text revealed from the middle out
 * (6 frames, Df-JzBcCrDo 19.75–36.75 s), changes its text by closing
 * and reopening, can slide across the frame as it changes (about 990 px in
 * 7 frames there), and retracts — to a dot (exit "dot") or to a line
 * (exit "line", about 10 frames). mode "type" types its text instead, as
 * Dfj2vYxC1pE's chips do: about 125 characters a second in, deleted at about
 * 110 a second out, the capsule following the text; a change, or `out`,
 * deletes what is on screen then, typed in full or not.
 * Dark glass, white semi-bold text 0.04 of the short side (the films:
 * 0.03–0.05 H), a turning asterisk in the film's accent (the text's colour
 * with none); colours and size are options.
 * While the capsule closes and opens, the text's ends fade into the glass
 * about a letter's width inside its edge, so a frame caught in the 6 frames
 * of a change shows words thinning out toward the ends, never a letter cut
 * through by the capsule's edge (`at(t).ink` is how much of the text shows).
 * `avoid`: rects of the frame the chip keeps clear of — the product's
 * buttons, the line being read, a face: [{ x, y, w, h }], or a function of t
 * giving them (null entries skipped). For each step, at that step's time,
 * the chip takes its own place if it is clear by `gap` px; else the first
 * clear one of: low left, low right, low middle, high left, high right, high
 * middle (0.035 W in, 0.9 H or 0.1 H); else the one that covers least. It
 * slides there as it changes (7 frames), and stays until its next step, so
 * it never wanders mid-sentence. Its width is reckoned from its text (0.58
 * of the size a character), not read from the page, so the same t gives the
 * same place with or without one; a function reading the page's layout is
 * read for the step's time only if the page is drawn at it — give numbers,
 * or compute them from t. A step with its own x or y goes where it says.
 * @param {HTMLElement | null} host
 * @param {{ steps?: ChipStep[], t?: number, text?: string, out?: number, x?: number, y?: number,
 *   anchor?: "left" | "center" | "right", mode?: "open" | "type", exit?: "dot" | "line",
 *   size?: number, icon?: boolean, bg?: string, colour?: string, accent?: string, font?: string, frame?: Frame,
 *   avoid?: (Box | null)[] | ((t: number) => (Box | null)[]), gap?: number }} o
 *   steps: [{ t, text, x?, y? }] in time order (or t and text for one); out: when it retracts;
 *   x, y: its anchor (default 0.035 W, 0.9 H, its left end); anchor: which end of it x is;
 *   gap: how far it keeps from what it avoids (default 0.3 of its height)
 */
export function chip(host, o) {
  const steps = o.steps ?? [{ t: o.t ?? 0, text: o.text ?? "" }];
  const first = steps[0];
  if (!first) throw new Error("hud.chip: give it steps [{ t, text }] or t and text");
  const mode = o.mode ?? "open";
  const exitKind = o.exit ?? "dot";
  const anchor = o.anchor ?? "left";
  const geo = later(o.frame, (fr) => {
    const size = o.size ?? Math.round(0.04 * short(fr));
    return { fr, size, h: Math.round(size * 1.9), x0: o.x ?? Math.round(0.035 * fr.width), y0: o.y ?? Math.round(0.9 * fr.height) };
  });
  const grow = 2 * F; // dot → circle (Df-JzBcCrDo 19.79 s)
  const openDur = 6 * F; // text from the middle out (Df-JzBcCrDo)
  const closeDur = 4 * F;
  const shrink = 3 * F; // circle → dot → gone
  const lineDur = 10 * F; // retracting to a line (Df-JzBcCrDo)
  const slide = 7 * F; // sliding across as it changes (Df-JzBcCrDo f544–551)
  const typeCps = 125; // Dfj2vYxC1pE: in at ~125 characters a second
  const delCps = 110; // out at ~110

  /** the chip's width with `text` in it, reckoned (no page needed) @param {string} text @param {number} size @param {number} h */
  const widthOf = (text, size, h) =>
    Math.round(h * 0.72 + (o.icon === false ? 0 : size * 1.35) + 0.58 * size * glyphs(text).length);
  /** how much of box a the rect b covers, px² @param {Box} a @param {Box} b */
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  /** where step i sits when it keeps clear of `avoid`: its anchor point, or null to stay where the chip is
   *  @param {number} i @returns {Pt | null} */
  const clearOf = (i) => {
    if (!o.avoid) return null;
    const st = /** @type {ChipStep} */ (steps[i]);
    const { fr, size, h, x0, y0 } = geo();
    const rects = /** @type {Box[]} */ ((typeof o.avoid === "function" ? o.avoid(st.t) : o.avoid).filter(Boolean));
    const w = widthOf(st.text, size, h);
    const gap = o.gap ?? Math.round(0.3 * h);
    const left = (/** @type {number} */ ax) => (anchor === "left" ? ax : anchor === "center" ? ax - w / 2 : ax - w);
    const mx = Math.round(0.035 * fr.width);
    const lo = Math.round(0.9 * fr.height), hi = Math.round(0.1 * fr.height);
    /** @type {[number, number][]} the box's left and its middle line: its own place, then the six */
    const spots = [[left(x0), y0], [mx, lo], [fr.width - mx - w, lo], [(fr.width - w) / 2, lo], [mx, hi], [fr.width - mx - w, hi], [(fr.width - w) / 2, hi]];
    let best = /** @type {[number, number]} */ (spots[0]);
    let least = Infinity;
    for (const sp of spots) {
      const grown = { x: sp[0] - gap, y: sp[1] - h / 2 - gap, w: w + 2 * gap, h: h + 2 * gap };
      const covered = rects.reduce((sum, r) => sum + overlap(grown, r), 0);
      if (covered < least) {
        least = covered;
        best = sp;
      }
      if (covered === 0) break;
    }
    return [anchor === "left" ? best[0] : anchor === "center" ? best[0] + w / 2 : best[0] + w, best[1]];
  };
  /** where it is at t: each step's slide from the place before @param {number} t @returns {Pt} */
  const place = (t) => {
    let { x0: x, y0: y } = geo();
    for (let i = 0; i < steps.length; i++) {
      const s = /** @type {ChipStep} */ (steps[i]);
      if (!on(t, s.t)) break;
      const clear = s.x == null && s.y == null ? clearOf(i) : null;
      // it first shows where it is clear; later steps slide there
      const u = clear && i === 0 ? 1 : out3(prog(t, s.t, s.t + slide));
      x = lerp(x, s.x ?? clear?.[0] ?? x, u);
      y = lerp(y, s.y ?? clear?.[1] ?? y, u);
    }
    return [x, y];
  };
  /** the step current at t @param {number} t */
  const stepAt = (t) => {
    let i = 0;
    while (i + 1 < steps.length && on(t, /** @type {ChipStep} */ (steps[i + 1]).t)) i++;
    return i;
  };
  /** mode "type": the text on screen at t while step i is current — what was there at the change deleted, then the new text typed
   *  @param {number} t @param {number} i @returns {string} */
  const typed = (t, i) => {
    const cur = /** @type {ChipStep} */ (steps[i]);
    const text = glyphs(cur.text);
    if (i === 0) return text.slice(0, count(Math.max(0, t - first.t - grow), 1 / typeCps)).join("");
    const was = glyphs(typed(cur.t, i - 1));
    const left = was.length - count(t - cur.t, 1 / delCps);
    if (left > 0) return was.slice(0, left).join("");
    const gone = cur.t + was.length / delCps;
    return text.slice(0, count(Math.max(0, t - gone), 1 / typeCps)).join("");
  };

  /** @param {number} t @returns {ChipAt} */
  const at = (t) => {
    const a = shape(t);
    // the text shows in full once the capsule has opened past its fading ends (about a third of the way)
    return { ...a, ink: !a.visible ? 0 : mode === "type" ? 1 : clamp01(a.open / 0.35) };
  };
  /** @param {number} t @returns {Omit<ChipAt, "ink">} */
  const shape = (t) => {
    const [x, y] = place(t);
    const spin = (t * 300) % 360;
    const none = { visible: false, x, y, scale: 0, scaleY: 1, open: 0, text: "", step: -1, spin };
    if (!on(t, first.t)) return none;
    const i = stepAt(t);
    const cur = /** @type {ChipStep} */ (steps[i]);
    const prev = steps[i - 1];
    const out = o.out ?? Infinity;
    const scale = out2(prog(t, first.t, first.t + grow));
    if (mode === "type") {
      if (on(t, out)) {
        // what is on screen at `out` is deleted, then the circle shrinks away
        const iOut = stepAt(out);
        const shown = glyphs(typed(out, iOut));
        const left = Math.max(0, shown.length - count(t - out, 1 / delCps));
        const empty = out + shown.length / delCps;
        if (on(t, empty + shrink)) return none;
        return { visible: true, x, y, scale: 1 - in2(prog(t, empty, empty + shrink)), scaleY: 1, open: 1, text: shown.slice(0, left).join(""), step: iOut, spin };
      }
      return { visible: true, x, y, scale, scaleY: 1, open: 1, text: typed(t, i), step: i, spin };
    }
    // "open": the capsule opens from the middle, the text uncovered with it
    let open;
    let text = cur.text;
    let step = i;
    if (i === 0) open = out3(prog(t, first.t + grow, first.t + grow + openDur));
    else if (!on(t, cur.t + closeDur)) {
      open = 1 - in2(prog(t, cur.t, cur.t + closeDur));
      text = /** @type {ChipStep} */ (prev).text;
      step = i - 1;
    } else open = out3(prog(t, cur.t + closeDur, cur.t + closeDur + openDur));
    if (on(t, out)) {
      if (exitKind === "line") {
        if (on(t, out + lineDur)) return none;
        return { visible: true, x, y, scale, scaleY: lerp(1, 0.06, in3(prog(t, out, out + lineDur))), open, text, step, spin };
      }
      const shut = open * (1 - in2(prog(t, out, out + closeDur)));
      if (on(t, out + closeDur + shrink)) return none;
      return {
        visible: true, x, y,
        scale: scale * (1 - in2(prog(t, out + closeDur, out + closeDur + shrink))),
        scaleY: 1, open: shut, text, step, spin,
      };
    }
    return { visible: true, x, y, scale, scaleY: 1, open, text, step, spin };
  };

  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const el = mk("div", "hud-chip", host);
  el.style.visibility = "hidden";
  const icon = o.icon === false ? null : mk("span", "", el);
  const label = mk("span", "", el);
  /** @type {unknown} */
  let builtFor = null;
  let shown = "";
  /** @param {number} t */
  const draw = (t) => {
    const g = geo();
    if (builtFor !== g) {
      builtFor = g;
      fit(host, g.fr);
      Object.assign(el.style, {
        height: `${g.h}px`,
        padding: `0 ${Math.round(g.h * 0.42)}px 0 ${Math.round(g.h * 0.3)}px`,
        gap: `${Math.round(g.size * 0.4)}px`,
        background: o.bg ?? "rgba(22, 22, 28, 0.78)",
        color: o.colour ?? "#ffffff",
        fontFamily: o.font ?? FONT,
        fontSize: `${g.size}px`,
        backdropFilter: "blur(14px) saturate(1.3)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12), 0 6px 24px rgba(0,0,0,0.25)",
      });
      if (icon) {
        icon.innerHTML = star(Math.round(g.size * 0.95), o.accent ?? accentOf(host) ?? o.colour ?? "#ffffff");
        icon.style.display = "flex";
      }
    }
    const { h } = g;
    const a = at(t);
    // shown as its layer is: a layer put inside a scene is hidden with that scene
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (!a.visible) return a;
    if (a.text !== shown) label.textContent = shown = a.text;
    label.style.display = a.text ? "" : "none";
    if (icon) icon.style.transform = `rotate(${r1(a.spin)}deg)`;
    const w = el.offsetWidth;
    const ox = anchor === "left" ? 0 : anchor === "center" ? w / 2 : w;
    // mode "open" grows about its middle, "type" about its circle at the left
    const origin = mode === "open" ? "50% 50%" : `${h / 2}px 50%`;
    el.style.transformOrigin = origin;
    el.style.transform = `translate(${r1(a.x - ox)}px, ${r1(a.y - h / 2)}px) scale(${a.scale.toFixed(4)}, ${(a.scale * a.scaleY).toFixed(4)})`;
    const shut = mode === "open" && a.open < 1;
    el.style.clipPath = shut ? `inset(0 calc((100% - ${h}px) * ${((1 - a.open) / 2).toFixed(4)}) round ${h / 2}px)` : "";
    // the text's ends fade into the glass inside the capsule's closing ends: no letter is cut by its edge
    let mask = "";
    if (shut && a.text) {
      const cut = ((w - h) * (1 - a.open)) / 2;
      const soft = g.size * 1.1;
      const l0 = cut + h * 0.15 - label.offsetLeft;
      const r0 = w - cut - h * 0.15 - label.offsetLeft;
      const full = clamp01((r0 - l0) / (2 * soft));
      mask =
        full >= 1
          ? `linear-gradient(90deg, transparent ${r1(l0)}px, #000 ${r1(l0 + soft)}px, #000 ${r1(r0 - soft)}px, transparent ${r1(r0)}px)`
          : `linear-gradient(90deg, transparent ${r1(l0)}px, rgba(0,0,0,${full.toFixed(3)}) ${r1((l0 + r0) / 2)}px, transparent ${r1(Math.max(l0, r0))}px)`;
    }
    label.style.maskImage = mask;
    label.style.webkitMaskImage = mask;
    return a;
  };
  return { el, at, draw };
}

// --- counter ------------------------------------------------------------------

/**
 * Minutes since midnight as a clock reads them: `clock(1122)` → "6:42 PM",
 * `clock(1122, { h24: true })` → "18:42". For a counter's field, whose value
 * can then run from one time to the next.
 * @param {number} minutes @param {{ h24?: boolean }} [o]
 */
export function clock(minutes, o = {}) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  if (o.h24) return `${String(h).padStart(2, "0")}:${mm}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * @typedef {object} CounterField  one part of a counter
 * @property {{ t: number, text?: string, value?: number }[]} steps  what it says from each t: a text, or a
 *   number for `format`
 * @property {(n: number) => string} [format]  a value as text (default the number itself)
 * @property {number} [run]  seconds a value takes to run to the next (default 0: it changes at once)
 */

/**
 * A count or a clock kept on screen — "6:42 PM · 0 of 3 checks" — that
 * changes in place: the film's own measure of how far along it is, in a
 * corner, through every cut. `fields` sit side by side with `sep` between;
 * each has its own steps, so the clock can move on while the count stays.
 * When a field changes, only the characters that differ move — the old one
 * up and out, the new one up and in, 4 frames — and the rest stand still
 * (digits are set at one width, so nothing beside them shifts); a text of a
 * different length changes as a whole. A number with `run` counts to its
 * next value over that many seconds, a new figure every 2 frames (the step
 * the detection box's count was measured at), fast then slowing.
 * A status chip closes and reopens its whole capsule to change, which is
 * right for a sentence and wrong for a number that ticks: this is for the
 * number. Not measured on the films, which keep their counts inside the
 * product's own interface; the capsule and its 2-frame growth are the
 * chip's, top right by default (0.965 W, 0.1 H, its right end) where the
 * chip is low left. `bg: "none"` drops the glass and takes the ink from the
 * scene under it.
 * `counter(hud, { fields: [{ steps: [{ t: 1.6, value: 18 * 60 + 42 }, { t: 6.5, value: 21 * 60 + 15 }], format: clock, run: 0.5 },
 *   { steps: [{ t: 1.6, value: 0 }, { t: 8, value: 1 }], format: (n) => `${n} of 3 checks` }], out: 35 })`
 * @param {HTMLElement | null} host
 * @param {{ fields: CounterField[], sep?: string, t?: number, out?: number, x?: number, y?: number,
 *   anchor?: "left" | "center" | "right", size?: number, roll?: number, bg?: string, colour?: string,
 *   font?: string, frame?: Frame }} o
 *   t: when it appears (default its earliest step); out: when it goes (4 frames); x, y: its anchor;
 *   anchor: which end of it x is (default "right"); size: text px (default 0.036 of the short side);
 *   roll: seconds a changed character takes (default 4 frames of 24)
 */
export function counter(host, o) {
  if (!o.fields?.length || o.fields.some((f) => !f.steps?.length))
    throw new Error("hud.counter: give it fields [{ steps: [{ t, text }] }] (or { t, value } with a format)");
  const sep = o.sep ?? " · ";
  const roll = o.roll ?? 4 * F;
  const anchor = o.anchor ?? "right";
  const t0 = o.t ?? Math.min(...o.fields.map((f) => /** @type {{ t: number }} */ (f.steps[0]).t));
  const grow = 2 * F;
  const fade = 4 * F;
  const geo = later(o.frame, (fr) => {
    const size = o.size ?? Math.round(0.036 * short(fr));
    return { fr, size, h: Math.round(size * 1.9), x: o.x ?? Math.round(0.965 * fr.width), y: o.y ?? Math.round(0.1 * fr.height) };
  });
  /** what a step says, its value shown as `v` @param {CounterField} f @param {{ text?: string, value?: number }} st @param {number} [v] */
  const say = (f, st, v) => (st.value != null ? (f.format ? f.format(v ?? st.value) : String(v ?? st.value)) : (st.text ?? ""));
  /** one field at t @param {CounterField} f @param {number} t */
  const fieldAt = (f, t) => {
    let i = -1;
    while (i + 1 < f.steps.length && on(t, /** @type {{ t: number }} */ (f.steps[i + 1]).t)) i++;
    if (i < 0) return { text: "", was: "", p: 1, step: -1 };
    const cur = /** @type {{ t: number, text?: string, value?: number }} */ (f.steps[i]);
    const prev = f.steps[i - 1];
    const run = f.run ?? 0;
    if (prev && run > 0 && cur.value != null && prev.value != null) {
      // a new figure every 2 frames, the last on the frame the run ends
      const n = Math.max(1, Math.round(run / (2 * F)));
      const k = Math.min(n, count(t - cur.t, 2 * F) + 1);
      return { text: say(f, cur, Math.round(lerp(prev.value, cur.value, out2(k / n)))), was: "", p: 1, step: i };
    }
    return { text: say(f, cur), was: prev ? say(f, prev) : "", p: prev ? out2(prog(t, cur.t, cur.t + roll)) : 1, step: i };
  };
  /** @param {number} t */
  const at = (t) => {
    const { x, y } = geo();
    const out = o.out ?? Infinity;
    const fields = o.fields.map((f) => fieldAt(f, t));
    const shown = fields.filter((f) => f.step >= 0);
    return {
      visible: on(t, t0) && !on(t, out + fade) && shown.length > 0,
      x,
      y,
      scale: out2(prog(t, t0, t0 + grow)),
      opacity: 1 - prog(t, out, out + fade),
      text: shown.map((f) => f.text).join(sep),
      fields,
    };
  };
  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const el = mk("div", "hud-counter", host);
  el.style.visibility = "hidden";
  const plain = o.bg === "none";
  /** @type {unknown} */
  let builtFor = null;
  let lastHtml = "";
  /** @param {number} t */
  const draw = (t) => {
    const g = geo();
    if (builtFor !== g) {
      builtFor = g;
      fit(host, g.fr);
      Object.assign(el.style, { height: `${g.h}px`, fontFamily: o.font ?? FONT, fontSize: `${g.size}px` });
      if (!plain)
        Object.assign(el.style, {
          padding: `0 ${Math.round(g.h * 0.42)}px`,
          background: o.bg ?? "rgba(22, 22, 28, 0.78)",
          color: o.colour ?? "#ffffff",
          backdropFilter: "blur(14px) saturate(1.3)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12), 0 6px 24px rgba(0,0,0,0.25)",
        });
    }
    const a = at(t);
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (!a.visible) return a;
    let html = "";
    for (const f of a.fields) {
      if (f.step < 0) continue;
      if (html) html += esc(sep);
      const now = glyphs(f.text);
      const was = glyphs(f.was);
      const rolling = f.p < 1;
      // the same length: each character that differs changes on its own; else the field as a whole
      const each = rolling && was.length === now.length;
      /** one moving character over the one it replaces @param {string} neu @param {string} old */
      const cell = (neu, old, whole = false) =>
        `<span class="hud-cell${whole ? " hud-whole" : ""}"><b style="opacity:${(1 - f.p).toFixed(3)};transform:translateY(${(-0.35 * f.p).toFixed(3)}em)">${esc(old)}</b>` +
        `<span style="opacity:${f.p.toFixed(3)};transform:translateY(${(0.35 * (1 - f.p)).toFixed(3)}em)">${esc(neu)}</span></span>`;
      if (!rolling) html += esc(f.text);
      else if (each) html += now.map((c, i) => (c === was[i] ? esc(c) : cell(c, was[i] ?? ""))).join("");
      else html += cell(f.text, f.was, true);
    }
    if (html !== lastHtml) el.innerHTML = lastHtml = html;
    if (plain) {
      const { ink, shadow } = o.colour ? { ink: o.colour, shadow: "none" } : inkFor(sceneBehind([el]));
      el.style.color = ink;
      el.style.textShadow = shadow;
    }
    el.style.opacity = String(r1(a.opacity * 100) / 100);
    const w = el.offsetWidth;
    const ox = anchor === "left" ? 0 : anchor === "center" ? w / 2 : w;
    el.style.transformOrigin = anchor === "left" ? "0 50%" : anchor === "center" ? "50% 50%" : "100% 50%";
    el.style.transform = `translate(${r1(a.x - ox)}px, ${r1(a.y - g.h / 2)}px) scale(${a.scale.toFixed(4)})`;
    return a;
  };
  return { el, at, draw };
}

// --- status line --------------------------------------------------------------

/**
 * A status line: one to three lines of what is happening, each swept in left
 * to right under a soft-edged mask while the block rises into place, the
 * fresh ink behind the sweep's edge settling to the ink colour (the film's
 * went yellow → pink → magenta, its own colours; here a light tone of the
 * layer's accent, the accent, a deep tone of it — or `fresh`, three colours
 * — and with no accent the ink itself, faint at the edge and filling); then still,
 * a grey shimmer passing over it while it "thinks", and out by drifting up
 * faster and faster. opus55-monster-truck shot 5: line 1 swept 9.17–9.38 s,
 * line 2 9.38–9.63 s, the block up 175 px over 0.62 s (ease-out), the shimmer
 * 1 s left to right; shot 14 leaves upward, fading in its last 2 frames.
 * The ink is dark on a light scene (the film's own, white) and light on a
 * dark one, read from the scene under it, unless `ink` says.
 * @param {HTMLElement | null} host
 * @param {{ lines: string[], t: number, x?: number, y?: number, size?: number, sweep?: number,
 *   rise?: number, out?: number, exitDy?: number, exitDur?: number, shimmer?: [number, number],
 *   ink?: string, fresh?: [string, string, string], shimmerColour?: string, icon?: boolean,
 *   accent?: string, weight?: number, font?: string, frame?: Frame }} o
 *   x, y: the block's top-left at rest, its icon first and the lines after it (default 0.1 W,
 *   0.42 H); size: text px (default 0.048 of the short side, smaller if a line would run past
 *   the frame's right edge); sweep: seconds a line takes (default 0.23); out: when it leaves
 */
export function statusLine(host, o) {
  const sweep = o.sweep ?? 0.23;
  const exitDur = o.exitDur ?? 0.87;
  const settle = 0.6;
  const geo = later(o.frame, (fr) => ({
    fr,
    size: o.size ?? Math.round(0.048 * short(fr)),
    rise: o.rise ?? Math.round(0.162 * short(fr)),
    exitDy: o.exitDy ?? Math.round(0.064 * short(fr)),
    x: o.x ?? Math.round(0.1 * fr.width),
    y: o.y ?? Math.round(0.42 * fr.height),
  }));

  /** @param {number} t */
  const at = (t) => {
    const { x, y, rise, exitDy } = geo();
    const out = o.out ?? Infinity;
    const visible = on(t, o.t) && !on(t, out + exitDur);
    const lift = rise * (1 - out3(prog(t, o.t, o.t + 0.62)));
    const e = in3(prog(t, out, out + exitDur));
    const lines = o.lines.map((_, i) => {
      const s = o.t + i * sweep;
      return { p: out3(prog(t, s, s + sweep)), cool: prog(t, s + sweep, s + sweep + settle) };
    });
    const sh = o.shimmer ? prog(t, o.shimmer[0], o.shimmer[1]) : 0;
    const shimmer = o.shimmer && on(t, o.shimmer[0]) && !on(t, o.shimmer[1]) ? sh : null;
    return {
      visible,
      x,
      y: y + lift - exitDy * e,
      opacity: !on(t, out) ? 1 : 1 - prog(t, out + exitDur - 2 * F, out + exitDur),
      lines,
      shimmer,
    };
  };

  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const el = mk("div", "hud-status", host);
  el.style.visibility = "hidden";
  el.style.fontFamily = o.font ?? FONT;
  el.style.fontWeight = String(o.weight ?? 600);
  const ic = o.icon === false ? null : mk("div", "", el);
  const lineEls = o.lines.map((text) => {
    const l = mk("div", "hud-line", el);
    l.textContent = text;
    return l;
  });
  /** @param {number} size */
  const lay = (size) => {
    el.style.fontSize = `${size}px`;
    const lead = ic ? Math.round(size * 1.5) : 0;
    if (ic) {
      ic.innerHTML = star(Math.round(size * 1.05), mark);
      Object.assign(ic.style, { position: "absolute", left: "0px", top: `${Math.round(size * 0.08)}px` });
    }
    lineEls.forEach((l, i) => {
      l.style.left = `${lead}px`;
      l.style.top = `${Math.round(i * size * 1.2)}px`;
    });
    return lead;
  };
  /** @type {unknown} */
  let builtFor = null;
  /** the layer's accent, read when first drawn @type {string | null} */
  let accent = null;
  let mark = o.accent ?? "currentColor";
  /** @param {number} t */
  const draw = (t) => {
    const g = geo();
    if (builtFor !== g) {
      builtFor = g;
      fit(host, g.fr);
      accent = o.accent ?? accentOf(host);
      let lead = lay(g.size);
      if (o.size == null) {
        // made smaller until its longest line ends inside the frame (an upright film's narrow width)
        const room = g.fr.width * 0.95 - g.x;
        const wide = lead + Math.max(0, ...lineEls.map((l) => l.scrollWidth));
        if (wide > room && room > 0) lead = lay(Math.max(8, Math.floor((g.size * room) / wide)));
      }
    }
    const a = at(t);
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (!a.visible) return a;
    el.style.transform = `translate(${r1(a.x)}px, ${r1(a.y)}px)`;
    el.style.opacity = String(r1(a.opacity * 100) / 100);
    const scene = o.ink ? null : sceneBehind(lineEls);
    const { ink, shadow } = o.ink ? { ink: o.ink, shadow: "none" } : inkFor(scene);
    el.style.filter = shadow === "none" ? "" : "drop-shadow(0 1px 4px rgba(0,0,0,0.5))";
    // the fresh band, from the sweep's edge back: given, or the accent's tones, or the ink coming in faint
    const tone = accent ? tones(accent) : null;
    const [f1, f2, f3] = o.fresh ?? (tone ? [tone.light, tone.mid, tone.deep] : [faded(ink, 0.3), faded(ink, 0.55), faded(ink, 0.8)]);
    if (ic && mark !== (accent ?? ink)) {
      mark = accent ?? ink;
      lay(parseFloat(el.style.fontSize));
    }
    const shimmerColour = o.shimmerColour ?? (scene === "light" || o.ink ? "rgba(255,255,255,0.85)" : "rgba(110,110,122,0.9)");
    a.lines.forEach((ln, i) => {
      const l = /** @type {HTMLElement} */ (lineEls[i]);
      const edge = ln.p * 115;
      const mask = ln.p >= 1 ? "none" : `linear-gradient(90deg, #000 ${r1(edge - 15)}%, transparent ${r1(edge)}%)`;
      l.style.maskImage = mask;
      l.style.webkitMaskImage = mask;
      // the fresh band rides just behind the sweep's edge, then cools to ink
      const c3 = mix(f3, ink, ln.cool);
      const c2 = mix(f2, ink, ln.cool);
      const c1 = mix(f1, ink, ln.cool);
      const e = ln.p * 100;
      const fill = `linear-gradient(90deg, ${c3} ${r1(e - 45)}%, ${c2} ${r1(e - 20)}%, ${c1} ${r1(e)}%)`;
      const shine =
        a.shimmer == null
          ? ""
          : `linear-gradient(90deg, transparent ${r1(a.shimmer * 130 - 30)}%, ${shimmerColour} ${r1(a.shimmer * 130 - 15)}%, transparent ${r1(a.shimmer * 130)}%), `;
      l.style.backgroundImage = shine + fill;
    });
    return a;
  };
  return { el, at, draw };
}

// --- voice --------------------------------------------------------------------

/**
 * A voice: an orb that wakes, and a caption of what it says, word by word.
 * DdT1-vziRp3: the orb grows in 2 frames; each word turns grey → white in
 * 2 frames; words 3–16 frames apart, irregular, about 2.5 a second; the line
 * laid out at its final width from the start (no word pushes another); gone a
 * frame before the cut (`until`). The caption 0.06 of the short side, medium,
 * centred; the films hold it at 0.86–0.93 H where no chip is, and it sits at
 * 0.8 H here, above a chip's place, wrapping inside 0.86 W; the orb above it,
 * its bars moving as the words land. White on a dark scene, near black on a
 * light one (read from the scene under it), unless `colour` says. The orb is
 * the layer's accent (`orbColour` over it), grey with none.
 * `times`: each word's own time (from a voice track) in place of the drawn
 * gaps. `chars(t)` is how much of `text` has been said by t, so the next
 * shot's prompt box can carry the sentence on: prompt's `type.from`.
 * @param {HTMLElement | null} host
 * @param {{ t: number, text: string, times?: number[], until?: number, gaps?: [number, number],
 *   seed?: number, x?: number, y?: number, size?: number, orb?: boolean, colour?: string,
 *   grey?: string, orbColour?: string, font?: string, frame?: Frame }} o
 *   t: when the orb wakes (the first word 0.2 s later unless `times`); x, y: the middle of the
 *   caption's last line (default 0.5 W, 0.8 H)
 */
export function voice(host, o) {
  const words = o.text.split(/\s+/).filter(Boolean);
  const [g0, g1] = o.gaps ?? [3 * F, 16 * F];
  const seed = o.seed ?? 1;
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i < words.length; i++) {
    const given = o.times?.[i];
    if (given != null) times.push(given);
    else times.push(i === 0 ? o.t + 0.2 : /** @type {number} */ (times[i - 1]) + lerp(g0, g1, hash(i, seed)));
  }
  const until = o.until ?? (times[times.length - 1] ?? o.t) + 1.2;
  const geo = later(o.frame, (fr) => ({
    fr,
    size: o.size ?? Math.round(0.06 * short(fr)),
    cx: o.x ?? fr.width / 2,
    cy: o.y ?? Math.round(0.8 * fr.height),
  }));
  const BARS = 5;

  /** how many words are said by t @param {number} t */
  const said = (t) => {
    let k = 0;
    while (k < times.length && on(t, /** @type {number} */ (times[k]))) k++;
    return k;
  };
  /** the characters of `text` (spaces between words counted) said by t @param {number} t */
  const chars = (t) => {
    const k = said(t);
    return k === 0 ? 0 : glyphs(words.slice(0, k).join(" ")).length + (k < words.length ? 1 : 0);
  };

  /** @param {number} t */
  const at = (t) => {
    const { cx, cy } = geo();
    const visible = on(t, o.t) && !on(t, until - F);
    const orb = out2(prog(t, o.t, o.t + 2 * F));
    // the bars: what was just said, decaying in 0.22 s, jittered 12 times a second
    let act = 0.12;
    for (const wt of times) if (on(t, wt)) act = Math.max(act, Math.exp(-Math.max(0, t - wt) / 0.22));
    const tick = Math.floor(t * 12 + EPS);
    const bars = Array.from({ length: BARS }, (_, j) => {
      const shape = 1 - Math.abs(j - (BARS - 1) / 2) / BARS;
      return r1((0.22 + 0.78 * act * shape * (0.45 + 0.55 * hash(tick, j + 7 * seed))) * 100) / 100;
    });
    return {
      visible,
      x: cx,
      y: cy,
      orb,
      bars,
      words: words.map((w, i) => {
        const wt = /** @type {number} */ (times[i]);
        return { text: w, shown: on(t, wt), white: prog(t, wt, wt + 2 * F) };
      }),
      said: said(t),
    };
  };

  /** @type {{ el: HTMLElement | null, at: typeof at, draw: (t: number) => ReturnType<typeof at>, text: string, times: number[], chars: typeof chars, until: number }} */
  const api = { el: null, at, draw: at, text: words.join(" "), times, chars, until };
  if (!host || typeof document === "undefined") return api;
  styles();
  const el = mk("div", "hud-voice", host);
  el.style.visibility = "hidden";
  const orbEl = o.orb === false ? null : mk("div", "hud-orb", el);
  /** @type {HTMLElement[]} */
  const barEls = [];
  if (orbEl) for (let j = 0; j < BARS; j++) barEls.push(mk("i", "", orbEl));
  const cap = mk("div", "hud-caption", el);
  const wordEls = words.map((w, i) => {
    const s = mk("span", "", cap);
    s.textContent = i < words.length - 1 ? `${w} ` : w;
    return s;
  });
  let orbSize = 0;
  /** @type {unknown} */
  let builtFor = null;
  /** @param {number} t */
  api.draw = (t) => {
    const g = geo();
    const { size } = g;
    if (builtFor !== g) {
      builtFor = g;
      fit(host, g.fr);
      el.style.gap = `${Math.round(size * 0.35)}px`;
      orbSize = Math.round(size * 1.15);
      if (orbEl) {
        // the film's accent, lit from the upper left; with none, a grey that takes no side
        const c = o.orbColour ?? accentOf(host) ?? "#8d929b";
        const tone = tones(c);
        Object.assign(orbEl.style, {
          width: `${orbSize}px`,
          height: `${orbSize}px`,
          gap: `${Math.round(orbSize * 0.07)}px`,
          background: `radial-gradient(circle at 35% 30%, ${tone.light}, ${c} 55%, ${tone.deep})`,
          boxShadow: `0 0 ${Math.round(orbSize * 0.5)}px ${faded(c, 0.53)}`,
        });
        for (const b of barEls) b.style.width = `${Math.round(orbSize * 0.07)}px`;
      }
      Object.assign(cap.style, { fontFamily: o.font ?? FONT, fontSize: `${size}px`, maxWidth: `${Math.round(g.fr.width * 0.86)}px` });
    }
    const a = at(t);
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (!a.visible) return a;
    // centred on x, the caption's last line on y, the orb above it
    el.style.transform = `translate(calc(${r1(a.x)}px - 50%), calc(${r1(a.y)}px - 100% + ${Math.round(size * 0.6)}px))`;
    if (orbEl) orbEl.style.transform = `scale(${a.orb.toFixed(4)})`;
    barEls.forEach((b, j) => {
      b.style.height = `${Math.round(orbSize * 0.5 * (a.bars[j] ?? 0))}px`;
    });
    const scene = o.colour ? null : sceneBehind([cap]);
    const { ink, shadow } = o.colour ? { ink: o.colour, shadow: "0 2px 18px rgba(0,0,0,0.35)" } : inkFor(scene);
    const grey = o.grey ?? (scene === "light" ? "#a3a6ad" : "#8d929b");
    cap.style.textShadow = shadow;
    a.words.forEach((w, i) => {
      const s = /** @type {HTMLElement} */ (wordEls[i]);
      s.style.opacity = w.shown ? "1" : "0";
      s.style.color = mix(grey, ink, w.white);
    });
    return a;
  };
  api.el = el;
  return api;
}

// --- burst --------------------------------------------------------------------

/**
 * A burst of pixels round a point: a send's flash. DdT1-vziRp3 (9.375 s and
 * 26.08 s, the same both times): coloured squares covering 1.2 % of the
 * frame grow to 11–13 % in 5 frames, then thin out and draw back over 7–10
 * frames. Its largest squares there are about 0.07 H across, soft and few
 * among many smaller; drawn all that size, a dozen of them read as blocks,
 * not pixels, so a square here is 0.02 of the short side (about 25 across
 * the burst at its widest). The area is a share of a landscape frame of the
 * same short side, so an upright film's burst is as large against its width
 * as a landscape film's against its height; it never reaches past the
 * frame's edges (a send button near the edge gives a smaller burst). Drawn
 * on a canvas the frame's size in `host`, in `colour`: by default a light
 * tone of the layer's accent, near white with none (the film's was its own
 * cyan), a few of its pixels white.
 * @param {HTMLElement | null} host
 * @param {{ t: number, at: Where, colour?: string | (() => string), area?: number, cell?: number, seed?: number, frame?: Frame }} o
 *   colour: a CSS colour, or a function giving one when the burst is first drawn; area: the share of a landscape frame it covers at its widest (default 0.12); cell: a
 *   pixel's px (default 0.02 of the short side; 2 at the least)
 */
export function burst(host, o) {
  const geo = later(o.frame, (fr) => {
    const A = short(fr) ** 2 * (16 / 9);
    const asked = o.cell ?? Math.round(0.02 * short(fr));
    return {
      fr,
      rMin: Math.sqrt((0.012 * A) / Math.PI),
      rMax: Math.sqrt(((o.area ?? 0.12) * A) / Math.PI),
      cell: asked >= 2 ? asked : 2,
    };
  });
  const seed = o.seed ?? 3;
  const up = 5 * F;
  const down = 9 * F;
  /** @param {number} t */
  const at = (t) => {
    const { fr, rMin, rMax, cell } = geo();
    const p = where(o.at, t);
    const visible = p != null && on(t, o.t) && !on(t, o.t + up + down);
    const grown = !on(t, o.t + up) ? lerp(rMin, rMax, out2(prog(t, o.t, o.t + up))) : lerp(rMax, rMax * 0.7, prog(t, o.t + up, o.t + up + down));
    // inside the frame: no square past its nearest edge
    const room = p ? Math.min(p[0], fr.width - p[0], p[1], fr.height - p[1]) - cell : grown;
    const r = Math.max(Math.min(cell, grown), Math.min(grown, room));
    const level = 1 - prog(t, o.t + up, o.t + up + down);
    return { visible, x: p?.[0] ?? 0, y: p?.[1] ?? 0, r, level, tick: Math.floor(t * 24 + EPS) };
  };
  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const cv = /** @type {HTMLCanvasElement} */ (mk("canvas", "hud-burst", host));
  const ctx = cv.getContext("2d");
  if (typeof o.colour === "string") colourOf(o.colour, "burst colour");
  /** read when first drawn: the layer's accent may be set in the page's CSS @type {Rgba | null} */
  let rgb = null;
  const colour = () => {
    const acc = accentOf(host);
    const c = (typeof o.colour === "function" ? o.colour() : o.colour) ?? (acc ? mix(acc, "#ffffff", 0.3) : "#f4f2f6");
    return colourOf(c, "burst colour");
  };
  let dirty = false;
  /** @param {number} t */
  const draw = (t) => {
    const { fr, cell } = geo();
    if (cv.width !== fr.width || cv.height !== fr.height) {
      fit(host, fr);
      cv.width = fr.width;
      cv.height = fr.height;
    }
    const a = at(t);
    if (!ctx) return a;
    if (dirty) ctx.clearRect(0, 0, fr.width, fr.height);
    dirty = a.visible;
    if (!a.visible) return a;
    rgb ??= colour();
    const [cr, cg, cb] = rgb.map(Math.round);
    const n = Math.ceil(a.r / cell) + 1;
    const gx0 = Math.round(a.x / cell);
    const gy0 = Math.round(a.y / cell);
    for (let j = -n; j <= n; j++)
      for (let i = -n; i <= n; i++) {
        const px = (gx0 + i) * cell;
        const py = (gy0 + j) * cell;
        const d = Math.hypot(px - a.x, py - a.y) / a.r;
        const h1 = hash(gx0 + i + 1000 * seed, gy0 + j);
        // a ragged edge, sparser toward it, each pixel flickering on its own
        if (d > 0.55 + 0.45 * h1) continue;
        const flick = hash(i * 31 + j, a.tick + seed);
        if (flick < 0.25 + 0.5 * d) continue;
        const alpha = a.level * (1 - 0.6 * d) * (0.55 + 0.45 * flick);
        const hot = flick > 0.93 ? 1 : 0;
        ctx.fillStyle = hot ? `rgba(255,255,255,${alpha.toFixed(3)})` : `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`;
        ctx.fillRect(px - cell / 2, py - cell / 2, cell - 1, cell - 1);
      }
    return a;
  };
  return { el: /** @type {HTMLElement} */ (cv), at, draw };
}

// --- prompt box ---------------------------------------------------------------

/**
 * A prompt box: a request typed in, then sent. Df-JzBcCrDo's three: dark
 * glass 0.57–0.69 W wide, a 1 px light edge, brighter along the top, an
 * orange send button, the model's name in a small chip; text 0.024–0.035 H.
 * It rises 28 px (of a 1080 frame) into place in 3 frames; the text types on
 * `typeAt`'s measured curve in fresh ink (`inkHtml`). On `send`: the
 * button presses to 0.61× in 2 frames, holds 4 (its arrow turned to a
 * spark), lets go in 3 with no rebound; a light wave crosses the box right
 * to left (about 640 px of a 1920 frame in 8 frames: a third of the frame's
 * width); a burst of pixels leaves the button (DdT1-vziRp3); with
 * `collapse`, the box then closes in to 0.63 of its width, faster and faster
 * (863 → 540 px).
 * The film's button, fresh ink and wave are its orange and its burst cyan;
 * here all four are the layer's accent (`accent` over it; `fresh` and
 * `burst` each on their own), and with no accent the button is the ink's
 * colour with a dark arrow, the fresh ink the ink at half strength, the
 * wave and the burst near white.
 * `type.from` carries on a line said in the shot before (voice's chars(t)).
 * The films' prompt text is small (0.03 H: about 6.5 px on an upright phone)
 * and they push in on it; a box held still at the frame's size reads better
 * with `size` larger.
 * @param {HTMLElement | null} host
 * @param {{ t: number, text: string, type?: { t?: number, cps?: number, curve?: "measured" | "even" | ((u: number) => number), from?: number },
 *   send?: number, collapse?: boolean, out?: number, x?: number, y?: number, w?: number, size?: number,
 *   model?: string, placeholder?: string, ink?: string, fresh?: string, accent?: string, burst?: boolean | string,
 *   bg?: string, font?: string, frame?: Frame }} o
 *   x, y: its centre (default the frame's middle); w: its width (default 0.62 W, 0.86 W in an
 *   upright film); out: when it goes
 */
export function prompt(host, o) {
  const geo = later(o.frame, (fr) => {
    const size = o.size ?? Math.round(0.03 * short(fr));
    const w = o.w ?? Math.round((fr.width < fr.height ? 0.86 : 0.62) * fr.width);
    const h = Math.round(size * 6.2);
    const cx = o.x ?? fr.width / 2;
    const cy = o.y ?? fr.height / 2;
    const btn = Math.round(size * 1.45);
    const pad = Math.round(size * 1.2);
    /** @type {Pt} */
    const button = [cx + w / 2 - pad - btn / 2, cy + h / 2 - pad * 0.8 - btn / 2];
    return { fr, size, w, h, cx, cy, btn, pad, button, rise: Math.round((28 / 1080) * short(fr)), travel: fr.width / 3 };
  });
  const typeT = o.type?.t ?? o.t + 4 * F;
  const send = o.send ?? Infinity;
  const ink = o.ink ?? "#f4f2f6";
  /** the film's accent, read when first drawn; null: none @type {string | null} */
  let accent = o.accent ?? null;
  const flash =
    o.burst === false || !Number.isFinite(send)
      ? null
      : burst(host, {
          t: send,
          at: () => geo().button,
          ...(typeof o.burst === "string" ? { colour: o.burst } : o.accent ? { colour: mix(o.accent, "#ffffff", 0.3) } : {}),
          ...(o.frame ? { frame: o.frame } : {}),
        });

  /** @param {number} t */
  const at = (t) => {
    const { w, h, cx, cy, rise: lift, travel } = geo();
    const out = o.out ?? Infinity;
    const visible = on(t, o.t) && !on(t, out);
    const rise = lift * (1 - out3(prog(t, o.t, o.t + 3 * F)));
    const typed = typeAt(t, typeT, o.text, o.type ?? {});
    const d = t - send;
    const k = count(d, F); // whole frames since the send
    // the press: 2 frames in, 4 held, 3 out, no rebound (Df-JzBcCrDo 72.6–72.96 s)
    const press = k < 0 ? 1 : k < 2 ? lerp(1, 0.61, out2(clamp01(d / (2 * F)))) : k < 6 ? 0.61 : lerp(0.61, 1, out2(prog(d, 6 * F, 9 * F)));
    const wave = k >= 1 && k < 9 ? prog(d, F, 9 * F) : null;
    const width = o.collapse ? w * lerp(1, 0.63, in2(prog(d, 6 * F, 11 * F))) : w;
    return {
      visible,
      x: cx,
      y: cy + rise,
      w: width,
      h,
      typed,
      caret: visible && k < 0 && t < typed.end + 0.5 && on(t, typeT - 0.2),
      press,
      pressed: k >= 2 && k < 6,
      wave,
      // the wave's middle in the frame: from the box's right end, a third of the frame's width to the left
      waveX: wave == null ? null : cx + w / 2 - wave * travel,
      burst: flash ? flash.at(t) : null,
    };
  };

  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const el = mk("div", "hud-prompt", host);
  el.style.visibility = "hidden";
  const text = mk("div", "hud-text", el);
  const foot = mk("div", "hud-foot", el);
  const sendEl = mk("div", "hud-send", el);
  const wave = mk("div", "hud-wave", el);
  if (flash?.el) host.appendChild(flash.el); // the burst over the box, not under it
  /** @type {unknown} */
  let builtFor = null;
  let lastHtml = "";
  let lastIcon = "";
  /** @param {number} t */
  const draw = (t) => {
    const g = geo();
    if (builtFor !== g) {
      builtFor = g;
      const { size, w, h, btn, pad } = g;
      fit(host, g.fr);
      accent = o.accent ?? accentOf(host);
      const button = accent ?? ink;
      Object.assign(el.style, {
        height: `${h}px`,
        borderRadius: `${Math.round(size * 0.95)}px`,
        background: o.bg ?? "linear-gradient(180deg, rgba(40,37,46,0.92), rgba(22,20,27,0.94))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.09), 0 24px 60px rgba(0,0,0,0.35)",
        backdropFilter: "blur(18px)",
        fontFamily: o.font ?? FONT,
        fontSize: `${size}px`,
        color: ink,
      });
      // held to the box's right end at its full width, so a box closing in covers the text, not reflows it
      Object.assign(text.style, { width: `${w - 2 * pad - btn}px`, top: `${Math.round(pad * 0.85)}px`, right: `${pad + btn}px`, lineHeight: "1.3" });
      Object.assign(foot.style, { left: `${pad}px`, bottom: `${Math.round(pad * 0.8)}px`, fontSize: `${Math.round(size * 0.62)}px`, color: "rgba(230,228,236,0.8)" });
      foot.innerHTML =
        `<span style="display:flex;width:1.7em;height:1.7em;border-radius:50%;background:rgba(255,255,255,0.1);align-items:center;justify-content:center">+</span>` +
        (o.model ? `<span>${star(Math.round(size * 0.6), button)}</span><span>${esc(o.model)}</span>` : "");
      Object.assign(sendEl.style, {
        width: `${btn}px`, height: `${btn}px`, right: `${pad}px`, bottom: `${Math.round(pad * 0.8)}px`,
        background: button, color: inkOn(button), fontSize: `${Math.round(btn * 0.55)}px`,
      });
    }
    const a = at(t);
    flash?.draw(t);
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (!a.visible) return a;
    el.style.width = `${r1(a.w)}px`;
    // collapsing keeps the right end (the button) where it was
    el.style.transform = `translate(${r1(a.x + g.w / 2 - a.w)}px, ${r1(a.y - g.h / 2)}px)`;
    const html =
      a.typed.n === 0 && o.placeholder && !a.caret
        ? `<span style="opacity:0.45">${esc(o.placeholder)}</span>`
        : inkHtml(t, a.typed, { ink, ...(o.fresh || accent ? { fresh: /** @type {string} */ (o.fresh ?? accent) } : {}), caret: a.caret });
    if (html !== lastHtml) text.innerHTML = lastHtml = html;
    const icon = a.pressed ? "✦" : "↑";
    if (icon !== lastIcon) sendEl.textContent = lastIcon = icon;
    sendEl.style.transform = `scale(${a.press.toFixed(3)})`;
    if (a.wave == null || a.waveX == null) wave.style.background = "";
    else {
      const c = (100 * (a.waveX - (a.x + g.w / 2 - a.w))) / a.w;
      const light = faded(accent ? mix(accent, "#ffffff", 0.35) : "#ffffff", 0.5 * (1 - a.wave));
      wave.style.background = `linear-gradient(90deg, transparent ${r1(c - 14)}%, ${light} ${r1(c)}%, transparent ${r1(c + 14)}%)`;
    }
    return a;
  };
  return { el, at, draw };
}

// --- agent cursor labels ------------------------------------------------------

/**
 * A point of an element, in the frame: for `agent`'s `at`, so a label stays
 * on a thing while the camera moves it. ux, uy: where in its box (0..1,
 * default the middle). It reads the page's layout when called, not film
 * time: the point is where the element is at that moment, so draw the
 * scene for t before the agents pinned to it, and the agent's `at(t)` is
 * where the element was last laid out rather than a function of t alone.
 * `agent(hud, { name: "wrist_ik.R", t: 3, at: pinTo(card, { ux: 0.8, uy: 0.2 }) })`
 * @param {Element} el @param {{ ux?: number, uy?: number, host?: Element | null }} [o]
 *   host: the layer the frame is measured from (default the page's top-left)
 * @returns {(t: number) => Pt | null}
 */
export function pinTo(el, o = {}) {
  return () => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    const h = o.host?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return [r.left - h.left + r.width * (o.ux ?? 0.5), r.top - h.top + r.height * (o.uy ?? 0.5)];
  };
}

/**
 * Where a 3D point is in the frame, seen by a three.js camera (anything with
 * `projectionMatrix.elements` and `matrixWorldInverse.elements`, column-major;
 * call camera.updateMatrixWorld() first). Perspective or orthographic. null
 * behind the lens (for an orthographic camera: nearer than its near plane) or
 * past its far plane. `at: (t) => project(rig.camera, [0.4, 1.2, 0])`
 * @param {{ projectionMatrix: { elements: ArrayLike<number> }, matrixWorldInverse: { elements: ArrayLike<number> } }} camera
 * @param {[number, number, number]} p
 * @param {{ frame?: Frame }} [o]
 * @returns {Pt | null}
 */
export function project(camera, p, o = {}) {
  const fr = frameOf(o.frame);
  const V = camera.matrixWorldInverse.elements;
  const P = camera.projectionMatrix.elements;
  /** a column-major 4×4 matrix times a vector @param {ArrayLike<number>} M @param {[number, number, number, number]} v
   *  @returns {[number, number, number, number]} */
  const m = (M, v) => {
    const e = (/** @type {number} */ i) => M[i] ?? 0;
    const row = (/** @type {number} */ r) => e(r) * v[0] + e(4 + r) * v[1] + e(8 + r) * v[2] + e(12 + r) * v[3];
    return [row(0), row(1), row(2), row(3)];
  };
  // an orthographic projection keeps w at 1: its bottom row is 0 0 0 1
  const ortho = (P[3] ?? 0) === 0 && (P[7] ?? 0) === 0 && (P[11] ?? 0) === 0 && (P[15] ?? 0) === 1;
  const [cx, cy, cz, cw] = m(P, m(V, [p[0], p[1], p[2], 1]));
  if (cw <= 1e-9) return null;
  const z = cz / cw;
  if (z > 1 || (ortho && z < -1)) return null;
  return [((cx / cw + 1) / 2) * fr.width, ((1 - cy / cw) / 2) * fr.height];
}

/**
 * An agent's cursor: an arrow and its name on a saturated block, pinned to a
 * point (Df-JzBcCrDo: 39 of them, 28 names — `foliage_palms`, `wrist_ik.R` —
 * on 3D points, the same size however close the camera; name 0.017–0.018 H on
 * a 0.031 H block). It pops in over 3 frames, its first frame at `t` already
 * on screen, rides its point, and goes in 3 frames when its part is done
 * (f33–36). Many at once read as many hands working, not as words to read.
 * Its block is `colour` — the layer's accent, a dark grey with none (the
 * film gave each agent a colour of its own: give each its `colour`) — and
 * its name black or white, whichever reads on it, unless `ink` says.
 * @param {HTMLElement | null} host
 * @param {{ name: string, t: number, out?: number, at: Where, colour?: string, ink?: string, size?: number,
 *   font?: string, frame?: Frame }} o
 *   at: the arrow's tip — a point, a function of t (pinTo, project), null while off screen
 */
export function agent(host, o) {
  const geo = later(o.frame, (fr) => ({ fr, size: o.size ?? Math.round(0.018 * short(fr)) }));
  const pop = 3 * F;
  /** @param {number} t */
  const at = (t) => {
    const out = o.out ?? Infinity;
    const live = on(t, o.t) && !on(t, out + pop);
    const p = live ? where(o.at, t) : null;
    // frames t, t + F, t + 2F: a third, two thirds (past full size), whole
    const scale = !on(t, out) ? backOut(prog(t, o.t - F, o.t + pop - F)) : 1 - in2(prog(t, out, out + pop));
    return { visible: p != null, x: p?.[0] ?? 0, y: p?.[1] ?? 0, scale };
  };
  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const el = mk("div", "hud-agent", host);
  el.style.visibility = "hidden";
  /** @type {unknown} */
  let builtFor = null;
  /** @param {number} t */
  const draw = (t) => {
    const g = geo();
    if (builtFor !== g) {
      builtFor = g;
      fit(host, g.fr);
      const { size } = g;
      const colour = o.colour ?? accentOf(host) ?? "#3a3c44";
      const arrow = Math.round(size * 1.35);
      el.innerHTML =
        `<svg width="${arrow}" height="${arrow}" viewBox="0 0 20 20" style="position:absolute;left:-2px;top:-2px;overflow:visible">` +
        `<path d="M2 2 L17 9 L10 11 L7 18 Z" fill="${esc(colour)}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      const tag = mk("span", "", el);
      tag.textContent = o.name;
      Object.assign(tag.style, {
        left: `${Math.round(arrow * 0.8)}px`,
        top: `${Math.round(arrow * 0.85)}px`,
        height: `${Math.round(size * 1.72)}px`,
        lineHeight: `${Math.round(size * 1.72)}px`,
        padding: `0 ${Math.round(size * 0.5)}px`,
        fontSize: `${size}px`,
        fontFamily: o.font ?? FONT,
        background: colour,
        color: o.ink ?? inkOn(colour),
      });
    }
    const a = at(t);
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (a.visible) el.style.transform = `translate(${r1(a.x)}px, ${r1(a.y)}px) scale(${a.scale.toFixed(3)})`;
    return a;
  };
  return { el, at, draw };
}

// --- detection box ------------------------------------------------------------

/** the colour a measure is shown in by its value: low red, middling yellow, high green (opus55-monster-truck) @param {number} v */
export const gauge = (v) => (v < 34 ? "#ea1a4c" : v < 75 ? "#f8e53e" : "#7ad13a");

/**
 * A detection box: a label typed a letter a frame above it, a rounded outline
 * drawn round the thing (about 0.25 s, about 6 px of a 1080 frame), a number
 * counting up inside its top-right corner in steps every 2 frames
 * (48 → 60 → 72 → 84 → 96 %: from half the value, `steps` 4), the box filled
 * with a pale tint of its colour when it lands. opus55-monster-truck shots
 * 11–13 ("Condition" at 67 % yellow, 16 % red, 96 % green; the number about
 * the label's size). The label is black on the film's white; here it takes
 * its ink from the scene under it unless `ink` says. The film's number sits
 * in its colour straight on the photograph; here it sits on a small plate of
 * that colour, in black or white, whichever stands further from it (black
 * on the gauge's three: 4.75:1 on its red, more on the others), so it reads
 * over whatever the box frames. `rect` may be a function of t, to ride a camera that moves.
 * @param {HTMLElement | null} host
 * @param {{ t: number, rect: { x: number, y: number, w: number, h: number } | ((t: number) => { x: number, y: number, w: number, h: number }),
 *   label?: string, value: number, unit?: string, steps?: number, colour?: string, fill?: number, out?: number,
 *   size?: number, ink?: string, font?: string, frame?: Frame }} o
 *   fill: when the tint comes in (default none); size: the label's px (default 0.05 of the short
 *   side; the number 0.9×); steps: how many 2-frame steps the count takes (1 at the least)
 */
export function detect(host, o) {
  const geo = later(o.frame, (fr) => ({ fr, size: o.size ?? Math.round(0.05 * short(fr)), stroke: Math.max(2, Math.round(0.0055 * short(fr))) }));
  const label = glyphs(o.label ?? "");
  const steps = Math.max(1, Math.round(o.steps ?? 4));
  const unit = o.unit ?? "%";
  const colour = o.colour ?? gauge(o.value);
  const countAt = o.t + 6 * F;
  /** @param {number} t */
  const at = (t) => {
    const out = o.out ?? Infinity;
    const rect = typeof o.rect === "function" ? o.rect(t) : o.rect;
    const k = !on(t, countAt) ? -1 : Math.min(steps, count(t - countAt, 2 * F));
    const value = k < 0 ? null : Math.round(lerp(o.value / 2, o.value, k / steps));
    return {
      visible: on(t, o.t) && !on(t, out + 4 * F),
      rect,
      label: label.slice(0, !on(t, o.t) ? 0 : count(t - o.t, F) + 1).join(""),
      stroke: out3(prog(t, o.t + 2 * F, o.t + 2 * F + 0.25)),
      value,
      text: value == null ? "" : `${value}${unit}`,
      fill: o.fill == null ? 0 : 0.16 * out3(prog(t, o.fill, o.fill + 0.33)),
      opacity: 1 - prog(t, out, out + 4 * F),
    };
  };
  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const el = mk("div", "hud-detect", host);
  el.style.visibility = "hidden";
  el.style.fontFamily = o.font ?? FONT;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const box = document.createElementNS(NS, "rect");
  box.setAttribute("pathLength", "1");
  box.setAttribute("stroke", colour);
  box.setAttribute("stroke-dasharray", "1 1");
  svg.appendChild(box);
  el.appendChild(svg);
  const lab = mk("b", "", el);
  const num = mk("b", "", el);
  const [cr, cg, cb] = colourOf(colour, "detect colour");
  // the number's ink on its plate: black or white, whichever stands further
  // from the plate's colour
  const L = luminance([cr, cg, cb, 1]);
  const contrast = (/** @type {string} */ ink) => {
    const l = luminance(colourOf(ink, "ink"));
    return (Math.max(l, L) + 0.05) / (Math.min(l, L) + 0.05);
  };
  const numInk = contrast("#000") >= contrast("#fff") ? "#000" : "#fff";
  /** @type {unknown} */
  let builtFor = null;
  /** @param {number} t */
  const draw = (t) => {
    const g = geo();
    const { size } = g;
    if (builtFor !== g) {
      builtFor = g;
      fit(host, g.fr);
      box.setAttribute("stroke-width", String(g.stroke));
      Object.assign(lab.style, { fontSize: `${size}px`, fontWeight: "700" });
      const pad = Math.round(size * 0.12);
      Object.assign(num.style, {
        fontSize: `${Math.round(size * 0.9)}px`,
        fontWeight: "600",
        color: numInk,
        background: colour,
        padding: `${pad}px ${Math.round(pad * 2)}px`,
        borderRadius: `${Math.round(size * 0.2)}px`,
        lineHeight: "1",
      });
    }
    const a = at(t);
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (!a.visible) return a;
    const { x, y, w, h } = a.rect;
    el.style.opacity = String(r1(a.opacity * 100) / 100);
    svg.setAttribute("width", String(Math.ceil(x + w + 20)));
    svg.setAttribute("height", String(Math.ceil(y + h + 20)));
    for (const [k, v] of Object.entries({ x, y, width: w, height: h, rx: Math.round(size * 0.4) })) box.setAttribute(k, String(r1(v)));
    box.setAttribute("stroke-dashoffset", String(1 - a.stroke));
    box.setAttribute("fill", a.fill > 0 ? `rgba(${cr},${cg},${cb},${a.fill.toFixed(3)})` : "none");
    lab.textContent = a.label;
    lab.style.transform = `translate(${r1(x)}px, ${r1(y - size * 1.2)}px)`;
    lab.style.color = o.ink ?? inkFor(sceneBehind([lab])).ink;
    num.textContent = a.text;
    // inside the box's top-right corner
    const inset = Math.round(size * 0.22);
    num.style.transform = `translate(${r1(x + w - inset - num.offsetWidth)}px, ${r1(y + inset)}px)`;
    return a;
  };
  return { el, at, draw };
}

// --- title --------------------------------------------------------------------

/**
 * A title whose letters come out of blur one after another: Df-JzBcCrDo's
 * title, a letter every ~1.5 frames, each sharp in 3–4 frames, the line done
 * in 0.7 s. A launch film's titles appear in 0.1–0.2 s (dots-creative-crew:
 * a 30–36 character line, rising 19–40 px) and hold 0.8–2.5 s: for that,
 * `by: "word"` with a smaller stagger. Out: up and away, accelerating
 * (0.3 s), the letters blurring as they go. It wraps between words inside
 * 0.9 W. White on a dark scene, near black on a light one (read from the
 * scene under it), unless `colour` says.
 * @param {HTMLElement | null} host
 * @param {{ text: string, t: number, out?: number, x?: number, y?: number, align?: "left" | "center" | "right",
 *   by?: "char" | "word", stagger?: number, each?: number, blur?: number, dy?: number, size?: number,
 *   weight?: number, colour?: string, font?: string, frame?: Frame }} o
 *   x, y: its anchor (default the frame's middle; align says which part of it sits on x);
 *   size: default 0.09 of the short side
 */
export function title(host, o) {
  const by = o.by ?? "char";
  const parts = by === "word" ? o.text.split(/(\s+)/).filter(Boolean) : glyphs(o.text);
  const stagger = o.stagger ?? 1.5 * F;
  const each = o.each ?? 3.5 * F;
  const outDur = 0.3;
  const geo = later(o.frame, (fr) => {
    const size = o.size ?? Math.round(0.09 * short(fr));
    return { fr, size, blur: o.blur ?? Math.round(size * 0.22), dy: o.dy ?? Math.round(size * 0.25) };
  });
  /** @param {number} t */
  const at = (t) => {
    const { blur, dy } = geo();
    const out = o.out ?? Infinity;
    const e = in3(prog(t, out, out + outDur));
    let j = 0;
    const letters = parts.map((p) => {
      if (/^\s+$/.test(p)) return { text: p, opacity: 1, blur: 0, y: 0 };
      const s = o.t + j++ * stagger;
      const k = out3(prog(t, s, s + each));
      return { text: p, opacity: k * (1 - e), blur: r1((1 - k) * blur + e * blur * 0.6), y: r1((1 - k) * dy - e * dy * 2) };
    });
    return { visible: on(t, o.t) && !on(t, out + outDur), letters, done: o.t + Math.max(0, j - 1) * stagger + each };
  };
  if (!host || typeof document === "undefined") return { el: null, at, draw: at };
  styles();
  const el = mk("div", "hud-title", host);
  el.style.visibility = "hidden";
  // letters inside words that do not break; the spaces between them do
  /** @type {(HTMLElement | null)[]} */
  const spans = [];
  /** @type {HTMLElement | null} */
  let word = null;
  for (const p of parts) {
    if (/^\s+$/.test(p)) {
      el.appendChild(document.createTextNode(" "));
      word = null;
      spans.push(null);
      continue;
    }
    word ??= mk("span", "hud-word", el);
    const s = mk("span", "", word);
    s.textContent = p;
    spans.push(s);
  }
  const align = o.align ?? "center";
  el.style.textAlign = align;
  /** @type {unknown} */
  let builtFor = null;
  /** @param {number} t */
  const draw = (t) => {
    const g = geo();
    if (builtFor !== g) {
      builtFor = g;
      fit(host, g.fr);
      Object.assign(el.style, {
        fontFamily: o.font ?? FONT,
        fontSize: `${g.size}px`,
        fontWeight: String(o.weight ?? 700),
        letterSpacing: "-0.02em",
        maxWidth: `${Math.round(g.fr.width * 0.9)}px`,
        width: "max-content",
      });
      const x = o.x ?? g.fr.width / 2;
      const y = o.y ?? g.fr.height / 2;
      const shift = align === "left" ? "0%" : align === "center" ? "-50%" : "-100%";
      el.style.transform = `translate(${r1(x)}px, ${r1(y)}px) translate(${shift}, -50%)`;
    }
    const a = at(t);
    el.style.visibility = a.visible ? "inherit" : "hidden";
    if (!a.visible) return a;
    if (o.colour) el.style.color = o.colour;
    else {
      const { ink, shadow } = inkFor(sceneBehind([el]));
      el.style.color = ink;
      el.style.textShadow = shadow === "none" ? "" : shadow;
    }
    a.letters.forEach((l, i) => {
      const s = spans[i];
      if (!s) return;
      s.style.opacity = String(r1(l.opacity * 1000) / 1000);
      s.style.filter = l.blur > 0.05 ? `blur(${l.blur}px)` : "";
      s.style.transform = l.y ? `translateY(${l.y}px)` : "";
    });
    return a;
  };
  return { el, at, draw };
}
