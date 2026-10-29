// @ts-check
// Type and colour at film scale — open-take's film kit. Nothing here picks a
// look: the colours and fonts are the product's (`npx open-take film look`
// reads them into look/look.json) or yours. These are measurements to execute
// with, at the size a film is watched:
//
//   - fitText: the biggest size a text can be set at in a box, and where its
//     lines break — CJK by phrase and never before a closing mark, Latin at
//     spaces, lines balanced so none is left with one word;
//   - contrast: the WCAG contrast ratio of a colour on a ground;
//   - readable: how big a size in the 1920-wide frame shows on a phone, a
//     timeline, a laptop — information, not a rule;
//   - palette: look.json's colours and fonts by role, ready for CSS;
//   - frame: the product's own surface for a picture of it — the corner and
//     shadow its cards have (look.json), a margin of its own ground — for a
//     screenshot shown as an object rather than cut flush; only where called.
//
//   import { fitText, contrast, readable, palette, loadLook, fontsReady } from "./kit/look.js";
//   const look = palette(await loadLook("look/look.json"));
//   await fontsReady(look.font(), "700", "找到你的下一間健身房");
//   const f = fitText({ width: 1400, height: 400 }, "找到你的下一間健身房", { font: look.font(), weight: 700, lines: 2 });
//   title.style.font = f.font;                      // "700 168px ..." — the size it fits at
//   title.innerHTML = f.lines.join("<br>");          // its own line breaks
//   contrast(look.text, look.bg)                    // 13.1
//   readable(f.size).on[0]                          // { screen: "phone, upright…", px: 34.4, mm: 5.7 }
//   Object.assign(shot.style, frame(lookJson).style); // its corner, shadow, margin, ground
//
// fitText measures with the browser's own text engine (a canvas), so the font
// must have loaded before it is asked — `fontsReady` loads it; the film clock
// waits for fonts anyway, but a measurement taken before they are in is taken
// in the fallback font.

/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba  sRGB 0..255, alpha 0..1 */
/** @typedef {{ width: number, height: number }} Size */

// --- colour -----------------------------------------------------------------

/** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined} */
let ctx2d;
const context = () => {
  if (ctx2d !== undefined) return ctx2d;
  try {
    const c =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : typeof document !== "undefined"
          ? document.createElement("canvas")
          : null;
    ctx2d = c ? /** @type {any} */ (c.getContext("2d", { willReadFrequently: true })) : null;
  } catch {
    ctx2d = null;
  }
  return ctx2d;
};

/**
 * A CSS colour as sRGB. Hex, rgb(), hsl() and `transparent` are read here;
 * anything else a browser knows (names, oklch(), color-mix()…) is painted on
 * one canvas pixel and read back. null when it is not a colour.
 * @param {string | Rgba} css
 * @returns {Rgba | null}
 */
export function parseColor(css) {
  if (typeof css === "object" && css) return css;
  const s = String(css).trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1] ?? "";
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    /** @param {number} i */
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (fn) {
    const kind = fn[1] ?? "";
    const parts = (fn[2] ?? "")
      .replace(/\s*\/\s*/, " / ")
      .split(/[\s,]+/)
      .filter((p) => p && p !== "/");
    /** @param {string} p @param {number} scale */
    const num = (p, scale) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
    if (parts.length < 3) return null;
    const [p0 = "", p1 = "", p2 = "", p3] = parts;
    const a = p3 != null ? Math.max(0, Math.min(1, num(p3, 1))) : 1;
    if (kind.startsWith("rgb")) {
      /** @param {string} p */
      const c = (p) => Math.max(0, Math.min(255, Math.round(num(p, 255))));
      const [r, g, b] = [c(p0), c(p1), c(p2)];
      if ([r, g, b, a].every(Number.isFinite)) return { r, g, b, a };
      return null;
    }
    const h = (((parseFloat(p0) % 360) + 360) % 360) / 360;
    const sat = parseFloat(p1) / 100;
    const l = parseFloat(p2) / 100;
    if (![h, sat, l, a].every(Number.isFinite)) return null;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    /** @param {number} t */
    const ch = (t) => {
      const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      const v =
        u < 1 / 6
          ? p + (q - p) * 6 * u
          : u < 1 / 2
            ? q
            : u < 2 / 3
              ? p + (q - p) * (2 / 3 - u) * 6
              : p;
      return Math.round(v * 255);
    };
    return { r: ch(h + 1 / 3), g: ch(h), b: ch(h - 1 / 3), a };
  }
  const c = context();
  if (!c) return null;
  c.clearRect(0, 0, 1, 1);
  c.fillStyle = "rgba(0, 0, 0, 0)";
  c.fillStyle = s;
  if (c.fillStyle === "rgba(0, 0, 0, 0)" && !/^(rgba?|hsla?)\(.*\b0\)$/.test(s)) return null; // not a colour
  c.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = c.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

/** @param {number} v */
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) .. 1 (white) @param {string | Rgba} c */
export function luminance(c) {
  const x = parseColor(c);
  if (!x) return Number.NaN;
  return 0.2126 * lin(x.r) + 0.7152 * lin(x.g) + 0.0722 * lin(x.b);
}

/** @param {Rgba} fg @param {Rgba} bg @returns {Rgba} */
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

/**
 * The WCAG contrast ratio of `fg` on `bg`, 1 (none) to 21 (black on white). A
 * translucent fg is laid over bg first; a translucent bg over white. For
 * reference only: WCAG asks 4.5 for body text and 3 for large text on a page
 * read up close — a film is read for a moment, at whatever size it is shown.
 * @param {string | Rgba} fg
 * @param {string | Rgba} bg
 */
export function contrast(fg, bg) {
  const f = parseColor(fg);
  let b = parseColor(bg);
  if (!f || !b) return Number.NaN;
  if (b.a < 1) b = over(b, { r: 255, g: 255, b: 255, a: 1 });
  const l1 = luminance(over(f, b));
  const l2 = luminance(b);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
}

// --- text at film scale -------------------------------------------------------

/**
 * Where a film is watched: the CSS px width the frame is shown across. The
 * millimetres assume a 6.1-inch phone (393 px across 65 mm upright).
 * @type {{ name: string, widthPx: number, mmPerPx?: number }[]}
 */
export const SCREENS = [
  { name: "phone, upright, film across the screen", widthPx: 393, mmPerPx: 65.1 / 393 },
  { name: "phone, sideways, full screen", widthPx: 852, mmPerPx: 141.2 / 852 },
  { name: "desktop timeline (about 600 px wide)", widthPx: 600 },
  { name: "laptop, full screen", widthPx: 1440 },
];

/**
 * How big text set at `sizePx` in a `filmWidth`-wide film shows on the screens
 * it is watched on — information, not a rule.
 * @param {number} sizePx
 * @param {{ filmWidth?: number, screens?: typeof SCREENS }} [opts]
 */
export function readable(sizePx, { filmWidth = 1920, screens = SCREENS } = {}) {
  return {
    filmPx: sizePx,
    filmWidth,
    on: screens.map((s) => {
      const px = Math.round(((sizePx * s.widthPx) / filmWidth) * 10) / 10;
      return {
        screen: s.name,
        px,
        ...(s.mmPerPx ? { mm: Math.round(px * s.mmPerPx * 10) / 10 } : {}),
      };
    }),
    reference: "iOS default text: body 17 px, footnote 13 px, caption 12 px, the smallest 11 px",
  };
}

/** a family name as CSS: quoted unless it is already a stack or a generic @param {string} font */
const fontStack = (font) =>
  /[,"']/.test(font) || /^(serif|sans-serif|monospace|system-ui|cursive|fantasy)$/.test(font)
    ? font
    : `${JSON.stringify(font)}, sans-serif`;

/**
 * Load a font (every weight asked, for the characters given) so a measurement
 * of it is a measurement of it. Resolves once it is in, or has failed.
 * @param {string} font a family name or a CSS font-family stack
 * @param {string | number | (string | number)[]} [weights]
 * @param {string} [text]
 */
export async function fontsReady(font, weights = "400", text) {
  if (typeof document === "undefined" || !document.fonts) return;
  const list = Array.isArray(weights) ? weights : [weights];
  await Promise.all(
    list.map((w) => document.fonts.load(`${w} 32px ${fontStack(font)}`, text).catch(() => [])),
  );
}

/**
 * A width function for one font: (text, sizePx) → px, by the browser's canvas.
 * @param {{ font: string, weight?: string | number, style?: string, letterSpacing?: number }} f
 *   letterSpacing in em, like the product's CSS may have it
 * @returns {(text: string, sizePx: number) => number}
 */
export function measurer({ font, weight = 400, style = "normal", letterSpacing = 0 }) {
  const c = context();
  if (!c) throw new Error("look: no canvas to measure text with — pass measure(text, sizePx)");
  const stack = fontStack(font);
  /** @type {Map<string, number>} */
  const cache = new Map();
  return (text, sizePx) => {
    const k = `${sizePx}|${text}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    c.font = `${style} ${weight} ${sizePx}px ${stack}`;
    if ("letterSpacing" in c) c.letterSpacing = `${letterSpacing * sizePx}px`;
    const w = c.measureText(text).width;
    cache.set(k, w);
    return w;
  };
}

// CJK and the marks that must not begin a line (they cling to the unit before)
// or end one (they cling to the unit after) — the line-start/line-end rules
// Chinese and Japanese typesetting follow
const NO_START =
  /^[、。，．,.;；:：!！?？)\]}）］｝」』】〉》〕〗〙〛・…‥ー〜～%％’”»›゛゜ゝゞヽヾぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/u;
const NO_END = /[([{（［｛「『【〈《〔〖〘〚‘“«‹$＄￥£]$/u;
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯\u{20000}-\u{3134f}]/u;

/**
 * The text's units that a line can break between: words with the space after
 * them, CJK phrases (Intl.Segmenter's words when `phrases`, else characters),
 * marks attached by the line-start and line-end rules.
 * @param {string} text
 * @param {boolean} phrases
 * @returns {string[]}
 */
function units(text, phrases) {
  /** @type {string[]} */
  let segs = [];
  const Seg = /** @type {any} */ (Intl).Segmenter;
  if (Seg) {
    const lang = CJK.test(text) ? (/[぀-ヿ]/.test(text) ? "ja" : "zh") : "en";
    const s = new Seg(lang, { granularity: "word" });
    for (const x of s.segment(text)) segs.push(x.segment);
  } else segs = text.split(/(\s+)/).filter(Boolean);
  // CJK runs broken into characters unless kept as phrases; Latin words kept
  if (!phrases) segs = segs.flatMap((s) => (CJK.test(s) ? [...s] : [s]));
  // no break inside Latin, numbers and their marks ("$3,176", "example.com"):
  // only at a space, next to a CJK character, or after a dash
  /** @type {string[]} */
  const glued = [];
  for (const s of segs) {
    const prev = glued[glued.length - 1];
    const last = prev ? ([...prev].pop() ?? "") : "";
    const first = [...s][0] ?? "";
    if (prev && !/\s/.test(last + first) && !CJK.test(last + first) && !/[-‐–—]/.test(last))
      glued[glued.length - 1] = prev + s;
    else glued.push(s);
  }
  /** @type {string[]} */
  const out = [];
  let carry = "";
  for (const s of glued) {
    if (/^\s+$/.test(s)) {
      if (out.length) out[out.length - 1] += s;
      continue;
    }
    if (NO_START.test(s) && out.length && !carry) {
      out[out.length - 1] += s;
      continue;
    }
    const u = carry + s;
    carry = "";
    if (NO_END.test(u)) {
      carry = u;
      continue;
    }
    out.push(u);
  }
  if (carry) out.push(carry);
  return out;
}

/** a unit holding Latin letters or digits, which a character break would cut mid-word @param {string} u */
const wordy = (u) => /[\p{L}\p{N}]/u.test(u.replace(new RegExp(CJK.source, "gu"), ""));

/**
 * breakLines, and whether it had to cut a Latin word or number by character.
 * @param {string} text
 * @param {number} maxWidth
 * @param {(s: string) => number} widthOf
 * @param {{ phrases?: boolean }} [opts]
 * @returns {{ lines: string[], cut: boolean }}
 */
function lineBreaks(text, maxWidth, widthOf, { phrases = true } = {}) {
  /** @type {string[]} */
  const lines = [];
  let cut = false;
  for (const para of String(text).split("\n")) {
    let line = "";
    const push = () => {
      lines.push(line.trimEnd());
      line = "";
    };
    /** too wide alone: by character @param {string} u */
    const byChar = (u) => {
      if (wordy(u)) cut = true;
      for (const ch of u) {
        if (line && widthOf((line + ch).trimEnd()) > maxWidth) push();
        line += ch;
      }
    };
    for (const u of units(para.trim(), phrases)) {
      if (widthOf((line + u).trimEnd()) <= maxWidth || !line) {
        if (!line && widthOf(u.trimEnd()) > maxWidth) byChar(u);
        else line += u;
      } else {
        push();
        if (widthOf(u.trimEnd()) > maxWidth) byChar(u);
        else line = u;
      }
    }
    push();
  }
  return { lines, cut };
}

/**
 * Lines of `text` no wider than `maxWidth` by `widthOf`: greedy, a unit wider
 * than the line broken by character. "\n" always breaks.
 * @param {string} text
 * @param {number} maxWidth
 * @param {(s: string) => number} widthOf
 * @param {{ phrases?: boolean }} [opts]
 * @returns {string[]}
 */
export function breakLines(text, maxWidth, widthOf, opts) {
  return lineBreaks(text, maxWidth, widthOf, opts).lines;
}

/**
 * The same number of lines, as even as they go: the narrowest width that
 * still breaks into as many lines as `maxWidth` does, cutting no word that
 * `maxWidth` leaves whole.
 * @param {string} text
 * @param {number} maxWidth
 * @param {(s: string) => number} widthOf
 * @param {{ phrases?: boolean }} [opts]
 */
function balancedLines(text, maxWidth, widthOf, opts) {
  const first = lineBreaks(text, maxWidth, widthOf, opts);
  if (first.lines.length < 2) return first;
  let lo = maxWidth / first.lines.length;
  let hi = maxWidth;
  let best = first;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const l = lineBreaks(text, mid, widthOf, opts);
    if (l.lines.length <= first.lines.length && (first.cut || !l.cut)) {
      best = l;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

/**
 * @typedef {object} FitOptions
 * @property {string} [font] family name or CSS stack (needed unless `measure` is given)
 * @property {string | number} [weight] default 400
 * @property {string} [style] default "normal"
 * @property {number} [min] smallest size tried, px (default 8)
 * @property {number} [max] biggest size tried, px (default the box height)
 * @property {number} [lines] at most this many lines (default: as many as fit)
 * @property {number} [lineHeight] line box as a multiple of the size (default 1.15)
 * @property {number} [letterSpacing] in em (default 0)
 * @property {boolean} [balance] even out the lines (default true)
 * @property {boolean} [phrases] keep CJK words whole across lines (default true)
 * @property {number} [step] sizes are whole multiples of this (default 0.5 px)
 * @property {(text: string, sizePx: number) => number} [measure] your own width function
 */

/**
 * The biggest size `text` can be set at inside `box` and its lines there.
 * `fits: false` means even `min` does not fit — the result is at `min`,
 * overflowing. Height counts `lineHeight` per line.
 * @param {Size} box
 * @param {string} text
 * @param {FitOptions} [opts]
 */
export function fitText(box, text, opts = {}) {
  const {
    font = "sans-serif",
    weight = 400,
    style = "normal",
    min = 8,
    max = box.height,
    lines: maxLines,
    lineHeight = 1.15,
    letterSpacing = 0,
    balance = true,
    phrases = true,
    step = 0.5,
  } = opts;
  if (!(box.width > 0 && box.height > 0))
    throw new Error("fitText: the box needs a width and a height above 0");
  const measure = opts.measure ?? measurer({ font, weight, style, letterSpacing });
  /** @param {number} size */
  const layout = (size) => {
    /** @param {string} s */
    const w = (s) => measure(s, size);
    const { lines: ls, cut } = balance
      ? balancedLines(text, box.width, w, { phrases })
      : lineBreaks(text, box.width, w, { phrases });
    const widest = Math.max(0, ...ls.map(w));
    return { lines: ls, cut, width: widest, height: ls.length * size * lineHeight };
  };
  // a Latin word or number is cut by character only when no size from `min`
  // up fits it whole
  let whole = true;
  /** @param {ReturnType<typeof layout>} l */
  const ok = (l) =>
    l.width <= box.width + 0.01 &&
    l.height <= box.height + 0.01 &&
    (maxLines == null || l.lines.length <= maxLines) &&
    !(whole && l.cut);
  if (!ok(layout(min))) whole = false;
  let lo = min;
  let hi = Math.max(min, max);
  let found = ok(layout(lo));
  if (found && ok(layout(hi))) lo = hi;
  else if (found)
    while (hi - lo > step / 2) {
      const mid = (lo + hi) / 2;
      if (ok(layout(mid))) lo = mid;
      else hi = mid;
    }
  // the search ends within half a step of the edge: take the biggest whole step that fits
  let size = Math.max(min, Math.floor(lo / step) * step);
  for (let s = Math.floor(hi / step) * step; s > size; s -= step)
    if (ok(layout(s))) {
      size = s;
      break;
    }
  const l = layout(size);
  whole = false;
  found = ok(l);
  const stack = fontStack(font);
  return {
    size,
    lines: l.lines,
    /** px between baselines */
    lineHeight: size * lineHeight,
    width: l.width,
    height: l.height,
    fits: found,
    /** the CSS font shorthand at that size */
    font: `${style} ${weight} ${size}px/${lineHeight} ${stack}`,
    readable: readable(size),
  };
}

// --- the product's look -----------------------------------------------------------

/**
 * look.json, fetched (written by `npx open-take film look`).
 * @param {string} [url]
 */
export async function loadLook(url = "look/look.json") {
  const r = await fetch(url);
  if (!r.ok)
    throw new Error(
      `look: ${url} answered ${r.status} — run npx open-take film look <take|url> --out look`,
    );
  return r.json();
}

/**
 * The product's colours and fonts from a look.json, by role. Every role is the
 * reader's estimate (look.json says why for each); `null` where none was found.
 * @param {any} look
 */
export function palette(look) {
  /** @type {Record<string, string | null>} */
  const roles = {};
  for (const [k, r] of Object.entries(look?.roles ?? {}))
    roles[k] = /** @type {any} */ (r)?.hex ?? null;
  /** @type {string[]} */
  const fonts = (look?.fonts ?? [])
    .filter((/** @type {any} */ f) => f.webfont)
    .map((/** @type {any} */ f) => f.family);
  /** @type {string[]} */
  const colours = (look?.colours ?? []).map((/** @type {any} */ c) => c.hex);
  return {
    ...roles,
    roles,
    colours,
    fonts,
    /** a role's colour, or `fallback` when the reader found none @param {string} role @param {string} [fallback] */
    get: (role, fallback) => roles[role] ?? fallback ?? null,
    /** the i-th font family the product's text is set in (by characters), as a CSS stack @param {number} [i] */
    font: (i = 0) => (fonts[i] ? fontStack(fonts[i]) : "sans-serif"),
    /** the product's colours by contrast on `ground`, most first @param {string} ground */
    byContrast: (ground) =>
      colours
        .map((hex) => ({ hex, contrast: contrast(hex, ground) }))
        .sort((a, b) => b.contrast - a.contrast),
    /** the roles as CSS custom properties: "--look-bg: #fff; …" @param {string} [prefix] */
    css: (prefix = "--look-") =>
      Object.entries(roles)
        .filter(([, v]) => v)
        .map(([k, v]) => `${prefix}${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v};`)
        .join(" "),
  };
}

/** the largest blur in a box-shadow list (px), to rank shadows by @param {string} v */
function shadowBlur(v) {
  let most = 0;
  for (const layer of v.split(/,(?![^(]*\))/)) {
    const px = [...layer.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    if (px.length >= 3) most = Math.max(most, px[2] ?? 0);
  }
  return most;
}

/**
 * The product's own surface, for a picture of it shown as an object: the
 * corner of its roundest card (look.json `radii`, pills and circles aside),
 * its softest shadow (`shadows`, by blur), and a margin of its own ground
 * (`roles.surface`, else `bg`) — so a screenshot reads as the product's
 * card, not a sheet cut flush. Each is null when the product has none; the
 * margin is the corner's size unless `pad` says. Nothing is applied: put
 * `style` on the picture (or its wrapper) where the film wants it.
 * @param {any} look a look.json
 * @param {{ pad?: number }} [o]
 * @returns {{ radius: number | null, shadow: string | null, ground: string | null, pad: number,
 *   style: Record<string, string> }}
 */
export function frame(look, o = {}) {
  const radii = (look?.radii ?? []).filter(
    (/** @type {any} */ r) => Number.isFinite(r?.px) && r.value !== "pill" && r.value !== "circle",
  );
  const radius = radii.length ? Math.max(...radii.map((/** @type {any} */ r) => r.px)) : null;
  const shadows = (look?.shadows ?? []).filter(
    (/** @type {any} */ x) => typeof x?.value === "string",
  );
  const shadow = shadows.length
    ? shadows.reduce((/** @type {any} */ a, /** @type {any} */ b) =>
        shadowBlur(b.value) > shadowBlur(a.value) ? b : a,
      ).value
    : null;
  const ground = look?.roles?.surface?.hex ?? look?.roles?.bg?.hex ?? null;
  const pad = o.pad ?? radius ?? 0;
  /** @type {Record<string, string>} */
  const style = {};
  if (radius != null) style.borderRadius = `${radius}px`;
  if (shadow) style.boxShadow = shadow;
  if (pad) style.padding = `${pad}px`;
  if (ground) style.background = ground;
  if (radius != null || pad) style.overflow = "hidden";
  return { radius, shadow, ground, pad, style };
}
