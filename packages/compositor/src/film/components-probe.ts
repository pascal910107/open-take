// The component probe: which pieces of a saved screen stand on their own — a
// number the product worked out, a stat, a heading, a button, a field, a
// card, a row of like items — measured in the restored page itself
// (state.html, after `data-ot-ready`, so `data-ot-id` is on every indexed
// element and computed styles are live). The runtime evaluates it in the
// fidelity page right after the fidelity screenshot (dom-state.ts
// `finalizeDomStates`) and writes the result as `states/<id>/parts.json`;
// `open-take components` runs the same string for states saved before it
// existed. One copy, shared by both.
//
// What it writes is measurement: kinds by stated tests, styles, the text's
// ink box, the backdrop, whether something covers it, and what each part
// holds in full — its text, an input's value apart from its placeholder, its
// accessible name, the state a tab or a toggle shows. Nothing here grades a
// part; `skipped` keeps every candidate that was left out with its reason.

import type { StateIndex } from "../state-index";
import { cardsOf } from "../state-index";

type Box = [number, number, number, number];

export type PartKind =
  | "number"
  | "stat"
  | "heading"
  | "button"
  | "input"
  | "control"
  | "field"
  | "badge"
  | "media"
  | "logo"
  | "card"
  | "group"
  | "text";

/** One part of a saved screen, as measured in the restored page. */
export type PartCandidate = {
  /** the element id in this state's index.json ("e170"; the ref is `<state>:e170`) */
  el: string;
  kind: PartKind;
  /** cards: "result" (holds a number) | "form" (holds inputs) | "media" (holds media) */
  sub?: "result" | "form" | "media";
  /** the button with the strongest fill contrast in this state */
  primary?: true;
  /** what it reads, for a glance (visible text, collapsed, ≤ 80 chars; an
   *  input's value or placeholder; an icon-only control's name) */
  label: string;
  /** its visible text in full, collapsed — never cut (absent in parts.json
   *  measured before the probe kept it) */
  text?: string;
  /** what the element itself holds, apart from its visible text: its
   *  accessible name when that is not its text (aria-label, aria-labelledby,
   *  title, an svg's <title>, an image's alt), an input's value and
   *  placeholder kept apart, a range's bounds, a checkbox's state, a
   *  select's options — each as the page had it */
  fields?: PartFields;
  /** the ARIA / form state it shows (aria-selected, aria-pressed,
   *  aria-checked, aria-expanded, aria-current, disabled, open) — what a tab
   *  or a toggle changes besides its text */
  state?: Record<string, string>;
  /** element ids its aria-controls names (a tab → its panel) */
  controls?: string[];
  /** element ids its aria-labelledby names (the heading that names a card) */
  labelledBy?: string[];
  /** a CSS path that finds it in state.html */
  selector: string;
  /** layout box, viewport CSS px */
  box: Box;
  /** the text's own extent (union of its text's line boxes) — text kinds
   *  (number, stat, heading, text, button, badge) */
  ink?: Box;
  /** the nearest part around it */
  inside?: string;
  /** its content children in order — what an assemble / stagger would act on */
  parts?: string[];
  /** a group's members (also on a part of another kind that passes the group test) */
  members?: string[];
  axis?: "row" | "column" | "grid";
  /** input → its field (input + label); field → its input */
  field?: string;
  input?: string;
  look: {
    fontPx: number;
    weight: number;
    family: string;
    fg: string;
    /** its own fill (#rrggbb[aa]); "image" for a gradient / background image */
    fill: string | null;
    /** what is behind it: the nearest ancestor fill, else the root's, else white */
    backdrop: string;
    /** an ancestor between it and that fill paints an image / gradient */
    backdropImage?: true;
    radius: number;
    shadow: boolean;
    border: boolean;
  };
  facts: {
    /** box area / viewport area */
    areaShare: number;
    /** its font size / the page's median text size */
    fontRatio: number;
    /** WCAG contrast of its text against its fill or backdrop */
    contrast: number;
    /** WCAG contrast of its own fill against the backdrop (1 when it has none) */
    fillContrast: number;
    numeric: boolean;
    /** within the first screen of the page (scroll 0) */
    inFirstScreen: boolean;
  };
  /** the crisp picture (states/assets/<sha1>.png, relative to the state folder), if taken */
  picture?: string;
  /** why no picture was taken */
  noPicture?: string;
  /** the window the picture shows, viewport CSS px, and its pixel scale */
  clip?: Box;
  clipScale?: number;
  /** the lift() options that reproduce the picture */
  lift: { around: "clear"; box: "ink" | "box"; pad: number };
};

export type PartFields = {
  name?: string;
  value?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
  checked?: boolean;
  options?: string[];
};

/** A candidate left out, and why (nothing is dropped silently). */
export type PartSkipped = {
  el: string;
  kind: PartKind;
  why: string;
  label?: string;
  box?: Box;
};

/** `states/<id>/parts.json` — version 1. */
export type PartsFile = {
  version: 1;
  state: string;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number };
  /** median font size over the page's visible text, weighted by characters */
  medianTextPx: number;
  parts: PartCandidate[];
  skipped: PartSkipped[];
  /** measured: time in the page, and taking the pictures */
  ms: { measure: number; pictures?: number };
};

/** What the page script takes. */
export type ComponentProbeInput = {
  /** element ids that pass `cardsOf` (states-list's card test, from index.json) */
  cards: string[];
  /** the size floor, a fraction of the viewport (default 0.0005) */
  minArea?: number;
};

/** What the page script returns (JSON string): PartsFile without the
 *  fields only the caller knows. */
export type ComponentProbeResult =
  | (Omit<PartsFile, "version" | "state" | "ms"> & { ms: number })
  | { error: string };

/**
 * A function expression: `(${COMPONENT_PROBE_JS})(input)` returns a JSON
 * string (ComponentProbeResult). Reads the page only, except that it may
 * set nothing at all — the pictures are taken separately.
 */
export const COMPONENT_PROBE_JS = String.raw`function (input) {
  try {
    var t0 = performance.now();
    var vw = innerWidth, vh = innerHeight, VA = vw * vh;
    var minArea = input.minArea != null ? input.minArea : 0.0005;
    var cardSet = {};
    (input.cards || []).forEach(function (id) { cardSet[id] = 1; });
    var nodes = Array.prototype.slice.call(document.querySelectorAll("[data-ot-id]"));
    var byId = {};
    nodes.forEach(function (el) { byId[el.getAttribute("data-ot-id")] = el; });
    var idOf = function (el) { return el.getAttribute("data-ot-id"); };
    var collapse = function (s) { return (s || "").replace(/\s+/g, " ").trim(); };
    var cut = function (s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; };
    var R = function (v) { return Math.round(v); };
    var rectBox = function (r) { return [R(r.left), R(r.top), R(r.width), R(r.height)]; };
    var area = function (b) { return Math.max(0, b[2]) * Math.max(0, b[3]); };
    var near = function (a, b, t) { return Math.abs(a - b) <= t; };
    var sameBox = function (a, b) { return a.every(function (v, i) { return near(v, b[i], 2); }); };
    var indexedUp = function (n) {
      while (n && !(n.nodeType === 1 && n.hasAttribute && n.hasAttribute("data-ot-id"))) n = n.parentNode || n.host;
      return n || null;
    };
    var indexedParent = function (el) { return el.parentElement ? indexedUp(el.parentElement) : null; };

    // --- colours (any CSS colour → sRGB through a 1×1 canvas) ---------------
    var cv = document.createElement("canvas"); cv.width = 1; cv.height = 1;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    var colourCache = {};
    var rgba = function (s) {
      if (!s || s === "transparent" || s === "rgba(0, 0, 0, 0)") return [0, 0, 0, 0];
      if (colourCache[s]) return colourCache[s];
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
      var d = cx.getImageData(0, 0, 1, 1).data;
      var c = [d[0], d[1], d[2], d[3] / 255];
      colourCache[s] = c; return c;
    };
    var over = function (top, under) {
      var a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    var hex2 = function (v) { var h = R(v).toString(16); return h.length < 2 ? "0" + h : h; };
    var hex = function (c) { return "#" + hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + (c[3] < 0.995 ? hex2(c[3] * 255) : ""); };
    var lum = function (c) {
      var f = function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    var contrast = function (a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

    var styleCache = new Map();
    var cs = function (el) { var s = styleCache.get(el); if (!s) { s = getComputedStyle(el); styleCache.set(el, s); } return s; };
    var hasImage = function (s) { return s.backgroundImage && s.backgroundImage !== "none"; };
    var ownFill = function (el) {
      var s = cs(el), c = rgba(s.backgroundColor);
      if (c[3] >= 0.1) return c;
      return null;
    };
    var white = [255, 255, 255, 1];
    var rootFill = function () {
      var h = rgba(cs(document.documentElement).backgroundColor);
      if (h[3] >= 0.5) return over(h, white);
      var b = document.body ? rgba(cs(document.body).backgroundColor) : [0, 0, 0, 0];
      if (b[3] >= 0.5) return over(b, white);
      return white;
    };
    var ROOT = rootFill();
    var backdropCache = new Map();
    // what is behind el: the nearest ancestor with an opaque-enough fill
    var backdropOf = function (el) {
      if (backdropCache.has(el)) return backdropCache.get(el);
      var image = false, n = el.parentElement, res = null;
      while (n && n !== document.documentElement) {
        var s = cs(n), c = rgba(s.backgroundColor);
        if (c[3] >= 0.5) { res = { c: over(c, n.parentElement ? backdropOf(n).c : ROOT), image: image }; break; }
        if (hasImage(s)) image = true;
        n = n.parentElement;
      }
      if (!res) res = { c: ROOT, image: image };
      backdropCache.set(el, res);
      return res;
    };

    // --- text --------------------------------------------------------------
    var ownText = function (el) { var s = ""; for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3) s += n.data; } return collapse(s); };
    var textCache = new Map();
    var textOf = function (el) {
      if (textCache.has(el)) return textCache.get(el);
      var t = el.localName === "input" || el.localName === "textarea" ? collapse(el.value || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "")
        : el.localName === "select" ? collapse(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : "")
        : collapse(el.innerText != null ? el.innerText : el.textContent);
      textCache.set(el, t); return t;
    };
    // its accessible name, as far as the page states one: aria-label, the
    // text aria-labelledby points at, title, an svg's own <title>, an
    // image's alt — what an icon-only button is called
    var nameOf = function (el) {
      var n = el.getAttribute("aria-label");
      if (!n) {
        var lb = el.getAttribute("aria-labelledby");
        if (lb) n = lb.split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? x.textContent : ""; }).join(" ");
      }
      if (!collapse(n)) n = el.getAttribute("title");
      if (!collapse(n)) {
        var tt = el.localName === "svg" ? el.querySelector(":scope > title") : el.querySelector("svg > title");
        n = tt ? tt.textContent : "";
      }
      if (!collapse(n)) {
        var im = el.localName === "img" ? el : el.querySelector("img[alt]");
        n = im ? im.getAttribute("alt") : "";
      }
      return collapse(n || "");
    };
    var visibleText = function (n) {
      var p = n.parentElement;
      return !!p && cs(p).visibility === "visible" && (typeof p.checkVisibility !== "function" || p.checkVisibility());
    };
    // the union of the line boxes of el's text — the text's real extent
    var inkOf = function (el) {
      var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      var range = document.createRange();
      while ((n = w.nextNode())) {
        if (!n.data.trim() || !visibleText(n)) continue;
        range.selectNodeContents(n);
        var rs = range.getClientRects();
        for (var i = 0; i < rs.length; i++) {
          var r = rs[i]; if (r.width < 0.5 || r.height < 0.5) continue;
          x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
        }
      }
      if (x0 === Infinity) return null;
      var a = Math.floor(x0), b = Math.floor(y0);
      return [a, b, Math.ceil(x1) - a, Math.ceil(y1) - b];
    };

    // --- the page's statistics -----------------------------------------------
    var info = new Map();
    var sizes = [];
    nodes.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var s = cs(el);
      var own = ownText(el);
      var it = { el: el, id: idOf(el), box: rectBox(r), own: own, font: parseFloat(s.fontSize) || 0, weight: parseInt(s.fontWeight, 10) || 400 };
      info.set(el, it);
      if (own && s.visibility === "visible" && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) sizes.push([it.font, own.length]);
    });
    sizes.sort(function (a, b) { return a[0] - b[0]; });
    var total = sizes.reduce(function (s, x) { return s + x[1]; }, 0), acc = 0, median = 16;
    for (var i = 0; i < sizes.length; i++) { acc += sizes[i][1]; if (acc >= total / 2) { median = sizes[i][0]; break; } }
    median = median || 16;

    // --- tests ----------------------------------------------------------------
    var CURRENCY = /(NT\$|US\$|HK\$|[$€£¥₩])/;
    var numericText = function (t) {
      if (!t || t.length > 24 || !/\d/.test(t)) return false;
      var ns = t.replace(/\s+/g, "");
      var digits = (ns.match(/\d/g) || []).length;
      return digits / ns.length >= 0.3 || CURRENCY.test(t);
    };
    var isBlock = function (s) { return /^(block|flex|grid|list-item|table|flow-root)$/.test(s.display); };
    var interactiveTag = function (el) { var t = el.localName; return t === "button" || t === "a" || t === "input" || t === "select" || t === "textarea" || t === "summary"; };
    var roleOf = function (el) { return (el.getAttribute("role") || "").trim().split(/\s+/)[0]; };
    var isButtonEl = function (el) {
      var t = el.localName, role = roleOf(el);
      if (t === "button" || role === "button") return true;
      if (t === "input") { var ty = (el.getAttribute("type") || "").toLowerCase(); return ty === "button" || ty === "submit" || ty === "reset"; }
      return false;
    };
    var CONTROL_TYPES = { checkbox: 1, radio: 1 };
    var INPUT_ROLES = { textbox: 1, searchbox: 1, combobox: 1, slider: 1, spinbutton: 1 };
    var CONTROL_ROLES = { checkbox: 1, radio: 1, "switch": 1 };
    var inputKind = function (el) {
      var t = el.localName, role = roleOf(el);
      if (t === "input") {
        var ty = (el.getAttribute("type") || "text").toLowerCase();
        if (ty === "hidden" || ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return null;
        return CONTROL_TYPES[ty] ? "control" : "input";
      }
      if (t === "textarea" || t === "select") return "input";
      if (CONTROL_ROLES[role]) return "control";
      if (INPUT_ROLES[role]) return "input";
      var ce = el.getAttribute("contenteditable");
      if (ce != null && ce !== "false" && !(el.parentElement && el.parentElement.closest("[contenteditable]:not([contenteditable=false])"))) return "input";
      return null;
    };
    var MEDIA = { img: 1, svg: 1, picture: 1, canvas: 1, video: 1 };
    var looks = function (el) {
      var s = cs(el), fill = ownFill(el), image = hasImage(s), bd = backdropOf(el);
      var fillC = fill ? contrast(over(fill, bd.c), bd.c) : 1;
      var bw = ["Top", "Right", "Bottom", "Left"].some(function (k) {
        return parseFloat(s["border" + k + "Width"]) >= 1 && s["border" + k + "Style"] !== "none" && rgba(s["border" + k + "Color"])[3] >= 0.1;
      });
      return { s: s, fill: fill, image: image, bd: bd, fillC: fillC, border: bw, shadow: !!s.boxShadow && s.boxShadow !== "none", radius: parseFloat(s.borderTopLeftRadius) || 0 };
    };
    var separate = function (L) { return L.fillC >= 1.05 || L.image || L.border || L.shadow; };
    var labelledOrMedia = function (el) { return !!textOf(el) || !!el.querySelector("img,svg,picture,canvas,video") || !!MEDIA[el.localName]; };
    var indexedChildren = function (el) {
      var out = [];
      var walk = function (n) {
        for (var i = 0; i < n.children.length; i++) {
          var c = n.children[i];
          if (c.hasAttribute("data-ot-id")) out.push(c); else walk(c);
        }
      };
      walk(el);
      return out;
    };
    // the content children an assemble acts on: through same-box wrappers
    var contentChildren = function (el) {
      var n = el, guard = 0, kids = indexedChildren(n);
      while (kids.length === 1 && guard++ < 6 && sameBox(info.get(kids[0]).box, info.get(n).box)) { n = kids[0]; kids = indexedChildren(n); }
      return kids.filter(labelledOrMedia);
    };
    var groupTest = function (el) {
      var kids = indexedChildren(el);
      var byTag = {};
      kids.forEach(function (k) { (byTag[k.localName] = byTag[k.localName] || []).push(k); });
      var best = null;
      Object.keys(byTag).forEach(function (tag) {
        var list = byTag[tag];
        if (list.length < 3) return;
        var sig = list.map(function (k) { return indexedChildren(k).length; });
        var common = sig.slice().sort(function (a, b) { return a - b; })[Math.floor(sig.length / 2)];
        var same = list.filter(function (k, i) { return sig[i] === common; });
        if (same.length < 3) return;
        var ws = same.map(function (k) { return info.get(k).box[2]; }).sort(function (a, b) { return a - b; });
        var hs = same.map(function (k) { return info.get(k).box[3]; }).sort(function (a, b) { return a - b; });
        var mw = ws[Math.floor(ws.length / 2)], mh = hs[Math.floor(hs.length / 2)];
        if (!(mw > 0 && mh > 0)) return;
        var m = same.filter(function (k) { var b = info.get(k).box; return Math.abs(b[2] - mw) <= 0.15 * mw && Math.abs(b[3] - mh) <= 0.15 * mh && labelledOrMedia(k); });
        if (m.length < 3) return;
        var tops = {}, lefts = {}, tol = function (v, unit) { return Math.round(v / Math.max(4, unit * 0.1)); };
        m.forEach(function (k) { var b = info.get(k).box; tops[tol(b[1], mh)] = 1; lefts[tol(b[0], mw)] = 1; });
        var nt = Object.keys(tops).length, nl = Object.keys(lefts).length;
        var axis = nt === 1 ? "row" : nl === 1 ? "column" : nt * nl >= m.length && nt < m.length && nl < m.length ? "grid" : null;
        if (!axis) return;
        if (!best || m.length > best.members.length) best = { members: m, axis: axis };
      });
      return best;
    };

    var textLeaves = function (el) {
      var out = [];
      if (ownText(el)) out.push(el);
      el.querySelectorAll("[data-ot-id]").forEach(function (d) { if (ownText(d) && cs(d).visibility === "visible") out.push(d); });
      return out;
    };
    var verdicts = new Map(); // el → { kind, ... }
    var skipped = [];
    // a value cell: inside a table cell, a <dd>, an <output> / <data>, or the
    // value of a label/value pair — its parent holds 1–3 other short text
    // leaves (≤ 16 characters), each set smaller than it
    var inValueCell = function (el) { return !!el.closest("dd,td,output,data,[role=cell],[role=gridcell],[role=definition]"); };
    var pairValue = function (el) {
      var p = indexedParent(el);
      if (!p) return false;
      var f = info.get(el).font;
      var others = textLeaves(p).filter(function (l) { return l !== el && !el.contains(l); });
      return others.length >= 1 && others.length <= 3 && others.every(function (l) {
        return (l === p ? ownText(l) : textOf(l)).length <= 16 && info.get(l).font < f;
      });
    };
    var valueCell = function (el) { return inValueCell(el) || pairValue(el); };
    // a value with a digit too long for numericText's 24 characters
    // ("US$16 起 / 月（含稅）") — a number when it sits in a value cell
    var valueText = function (t) { return !!t && t.length <= 40 && /\d/.test(t); };
    // 1. numbers — text from one leaf (its own, or one element inside it);
    //    innermost wins; a control whose label is a number is a control
    var numCand = [];
    nodes.forEach(function (el) {
      if (interactiveTag(el) || isButtonEl(el) || inputKind(el)) return;
      if (el.querySelector("input,select,textarea,button") || (el.localName === "label" && el.control)) return;
      // a number on a button or a chip-label is that control's text
      var host = el.parentElement && el.parentElement.closest("button,[role=button],label");
      if (host && (host.localName !== "label" || host.control)) return;
      var leaves = textLeaves(el);
      // its own digits plus a unit in a child of its own ("18.5<small>個月</small>")
      var unit = leaves.length === 2 && leaves[0] === el && /\d/.test(ownText(el)) &&
        indexedChildren(leaves[1]).length === 0 && !/\d/.test(textOf(leaves[1])) && textOf(leaves[1]).length <= 4;
      if (leaves.length !== 1 && !unit) return;
      var t = textOf(el), it = info.get(el);
      if (!numericText(t) && !(valueText(t) && valueCell(el))) return;
      if (it.font >= 1.25 * median || it.weight >= 600) numCand.push(el);
      else skipped.push({ el: it.id, kind: "number", why: "a number at body size and weight (" + R(it.font) + " px, " + it.weight + ")", label: cut(t, 80), box: it.box });
    });
    var numbers = numCand.filter(function (el) { return !numCand.some(function (o) { return o !== el && el.contains(o); }); });
    numbers.forEach(function (el) { verdicts.set(el, { kind: "number" }); });
    var isNumber = function (el) { var v = verdicts.get(el); return v && v.kind === "number"; };
    // a value cell without a digit ("不收", "Unlimited"), set large or bold,
    // one leaf, ≤ 24 characters: the value of the stat around it — not a
    // part of its own, and never a heading
    var cellValues = nodes.filter(function (el) {
      if (verdicts.has(el) || interactiveTag(el) || isButtonEl(el) || inputKind(el)) return false;
      if (/^h[1-6]$/.test(el.localName) || roleOf(el) === "heading") return false;
      var it = info.get(el), t = textOf(el);
      if (!t || t.length > 24 || textLeaves(el).length !== 1 || !inValueCell(el)) return false;
      return (it.font >= 1.25 * median || it.weight >= 600) && pairValue(el);
    });
    var cellSet = new Set(cellValues);
    // 2. stats: one number (the largest, when there are several) and 1–3
    //    short labels; the innermost such holder
    var statCand = [];
    nodes.forEach(function (el) {
      if (verdicts.has(el) || interactiveTag(el) || isButtonEl(el)) return;
      var it = info.get(el);
      if (area(it.box) > 0.03 * VA) return;
      var nums = numbers.concat(cellValues).filter(function (n) { return n !== el && el.contains(n); });
      if (!nums.length) return;
      nums.sort(function (a, b) { return info.get(b).font - info.get(a).font; });
      if (nums.length > 1 && info.get(nums[1]).font >= info.get(nums[0]).font) return;
      var num = nums[0];
      var leaves = textLeaves(el);
      if (leaves.length > 4) return;
      var labels = leaves.filter(function (l) { return l !== num && !num.contains(l); });
      if (labels.length < 1 || labels.length > 3) return;
      var ok = labels.every(function (l) { return (l === el ? ownText(l) : textOf(l)).length <= 16; });
      if (ok) statCand.push(el);
    });
    statCand.filter(function (el) { return !statCand.some(function (o) { return o !== el && el.contains(o); }); })
      .forEach(function (el) { verdicts.set(el, { kind: "stat" }); });
    // 3–9. one kind per element, in order
    var logoSeen = new Set();
    var title = collapse(document.title).toLowerCase();
    nodes.forEach(function (el) {
      if (verdicts.has(el)) return;
      var it = info.get(el), t = el.localName, s = cs(el), role = roleOf(el), text = textOf(el);
      var share = area(it.box) / VA;
      var lvl = parseInt(el.getAttribute("aria-level") || "2", 10);
      if (text && (t === "h1" || t === "h2" || t === "h3" || (role === "heading" && lvl <= 3) ||
          (it.font >= 1.6 * median && text.length <= 90 && isBlock(s) && !cellSet.has(el) &&
           !inValueCell(el) && !(valueText(text) && pairValue(el))))) { verdicts.set(el, { kind: "heading" }); return; }
      if (isButtonEl(el) && it.box[3] >= 20 && it.box[3] <= 140) { verdicts.set(el, { kind: "button" }); return; }
      if (t === "a" && text && it.box[3] >= 20 && it.box[3] <= 140) {
        var L = looks(el);
        var pad = Math.min(parseFloat(s.paddingLeft) || 0, parseFloat(s.paddingRight) || 0);
        if ((L.fillC >= 1.3 || L.border || L.image) && pad >= 4) { verdicts.set(el, { kind: "button" }); return; }
      }
      var ik = inputKind(el);
      if (ik) { verdicts.set(el, { kind: ik }); return; }
      if (MEDIA[t]) {
        var bar = el.closest("header, nav, [role=banner], [role=navigation]");
        var nm = collapse(el.getAttribute("alt") || el.getAttribute("aria-label") || "").toLowerCase();
        var named = nm.length >= 2 && title.indexOf(nm) >= 0;
        if ((bar && !logoSeen.has(bar) || named) && share < 0.03 && it.box[3] >= 16) {
          if (bar) logoSeen.add(bar);
          verdicts.set(el, { kind: "logo" }); return;
        }
        if (share >= 0.015) { verdicts.set(el, { kind: "media" }); return; }
        return;
      }
      if (cardSet[it.id] && share <= 0.4 && separate(looks(el))) {
        if (it.box[2] < 0.9 * vw) { verdicts.set(el, { kind: "card" }); return; }
        skipped.push({ el: it.id, kind: "card", why: "spans the screen's width (a bar)", label: cut(text, 80), box: it.box });
        return;
      }
      // a short label on its own fill or border (a "VS" disc, a status pill)
      if (text && text.length <= 16 && !interactiveTag(el) && share <= 0.01 && indexedChildren(el).length === 0) {
        var Lb = looks(el);
        if (Lb.fillC >= 1.3 || Lb.border || Lb.image) { verdicts.set(el, { kind: "badge" }); return; }
      }
      var g = groupTest(el);
      if (g) { verdicts.set(el, { kind: "group", members: g.members, axis: g.axis }); return; }
      if (text.length >= 40 && text.length <= 600 && it.font >= 1.2 * median && isBlock(s) &&
          !Array.prototype.some.call(el.querySelectorAll("[data-ot-id]"), function (d) { return isBlock(cs(d)) && ownText(d); })) {
        verdicts.set(el, { kind: "text" });
      }
    });
    // a visually hidden checkbox / radio (a 1×1 input behind a styled
    // label): its label is what is on screen — the label stands for it
    verdicts.forEach(function (v, el) {
      if (v.kind !== "input" && v.kind !== "control") return;
      if (area(info.get(el).box) >= 16) return;
      var lab = el.labels && el.labels[0] || el.closest("label");
      var stand = lab && indexedUp(lab);
      if (!stand || stand === el || verdicts.has(stand) || area(info.get(stand).box) < 16) return;
      verdicts.delete(el);
      verdicts.set(stand, { kind: v.kind, input: el });
      skipped.push({ el: idOf(el), kind: v.kind, why: "visually hidden; its label " + idOf(stand) + " stands for it", box: info.get(el).box });
    });
    // fields: the input with its label, at most 4× the input's area
    verdicts.forEach(function (v, el) {
      if (v.kind !== "input" && v.kind !== "control") return;
      if (v.input) return;
      var a = area(info.get(el).box) || 1, n = indexedParent(el);
      while (n && area(info.get(n).box) <= 4 * a) {
        var labelled = textLeaves(n).some(function (l) { return l !== el && !el.contains(l); });
        if (labelled) { if (!verdicts.has(n)) verdicts.set(n, { kind: "field", input: el }); v.field = n; break; }
        n = indexedParent(n);
      }
    });

    // --- exclusions ---------------------------------------------------------
    var COOKIE = /cookie|consent|gdpr|privacy (settings|preferences)|we use cookies/i;
    var fixedRoot = function (el) {
      var n = el, found = null;
      while (n && n !== document.body && n !== document.documentElement) { var p = cs(n).position; if (p === "fixed" || p === "sticky") found = n; n = n.parentElement; }
      return found;
    };
    var hitId = function (x, y, el) {
      var h = document.elementFromPoint(x, y);
      if (!h) return { ok: false, by: null };
      if (h === el || el.contains(h)) return { ok: true };
      // a part inside a shadow host reports the host
      var up = indexedUp(h);
      return { ok: false, by: up ? idOf(up) : h.localName, fixed: !!(up && fixedRoot(up)) };
    };
    var why = function (el, v) {
      var it = info.get(el), b = it.box, share = area(b) / VA;
      if (share < minArea) return "smaller than " + (minArea * 100).toFixed(2) + "% of the screen";
      var vx = Math.max(0, Math.min(b[0] + b[2], vw) - Math.max(b[0], 0)), vy = Math.max(0, Math.min(b[1] + b[3], vh) - Math.max(b[1], 0));
      if (vx * vy < 0.5 * area(b)) return "less than half of it on screen";
      if (el.closest("[aria-hidden=true]") && (v.kind === "media" || v.kind === "logo" || !textOf(el))) return "aria-hidden (decoration)";
      var fr = fixedRoot(el);
      if (fr && COOKIE.test(textOf(fr).slice(0, 400))) return "inside a cookie / consent banner";
      if (v.kind !== "button" && v.kind !== "logo" && el.closest("nav, footer, [role=navigation], [role=contentinfo]")) return "inside nav / footer";
      var cy = b[1] + b[3] / 2, pts = [[b[0] + b[2] / 2, cy], [b[0] + b[2] * 0.25, cy], [b[0] + b[2] * 0.75, cy]];
      var tried = 0, hits = 0, by = null;
      pts.forEach(function (p) {
        if (p[0] < 0 || p[1] < 0 || p[0] >= vw || p[1] >= vh) return;
        tried++;
        var r = hitId(p[0], p[1], el);
        if (r.ok) hits++; else if (!by) by = r;
      });
      if (tried && hits < Math.min(2, tried)) return "covered (" + (by && by.fixed ? "fixed element" : "element") + " at its centre: " + (by && by.by || "?") + ")";
      return null;
    };
    var kept = [];
    verdicts.forEach(function (v, el) {
      var w = why(el, v);
      var it = info.get(el);
      if (w) skipped.push({ el: it.id, kind: v.kind, why: w, label: cut(textOf(el), 80), box: it.box });
      else kept.push(el);
    });
    // a candidate with the box of a kept one of the same kind inside it:
    // outermost kept for blocks, innermost for the rest
    var OUTER = { card: 1, group: 1, stat: 1, field: 1, media: 1 };
    var keptSet = new Set(kept);
    kept.slice().forEach(function (el) {
      if (!keptSet.has(el)) return;
      var v = verdicts.get(el), b = info.get(el).box;
      kept.forEach(function (o) {
        if (o === el || !keptSet.has(o) || !keptSet.has(el)) return;
        var vo = verdicts.get(o);
        if (vo.kind !== v.kind || !el.contains(o) || !sameBox(b, info.get(o).box)) return;
        var drop = OUTER[v.kind] ? o : el, keep = drop === o ? el : o;
        keptSet.delete(drop);
        skipped.push({ el: idOf(drop), kind: v.kind, why: "same box as " + idOf(keep) + " (kept: the " + (OUTER[v.kind] ? "outermost" : "innermost") + ")", label: cut(textOf(drop), 80), box: info.get(drop).box });
      });
    });
    kept = kept.filter(function (el) { return keptSet.has(el); });
    kept.sort(function (a, b) { var p = a.compareDocumentPosition(b); return p & 4 ? -1 : p & 2 ? 1 : 0; });

    // --- the entries ----------------------------------------------------------
    var cssIdent = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
    var selectorOf = function (el) {
      var steps = [], n = el;
      while (n && n !== document.documentElement) {
        if (n.id && cssIdent.test(n.id) && document.querySelectorAll("#" + n.id).length === 1) { steps.unshift("#" + n.id); break; }
        var tag = n.localName, par = n.parentElement;
        var step = tag;
        var cls = Array.prototype.find.call(n.classList || [], function (c) { return cssIdent.test(c) && c.length <= 24 && !/\d{3,}|^(css|sc|jsx|svelte)-/.test(c); });
        if (cls) step += "." + cls;
        if (par) {
          var same = Array.prototype.filter.call(par.children, function (c) { return c.localName === tag; });
          if (same.length > 1) step += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
        }
        steps.unshift(step);
        if (tag === "body") break;
        n = par;
      }
      var sel = steps.join(" > ");
      try { if (document.querySelector(sel) === el) return sel; } catch (e) {}
      return "[data-ot-id=" + idOf(el) + "]";
    };
    var TEXTY = { number: 1, heading: 1, text: 1, button: 1, badge: 1, stat: 1 };
    // what an input holds, apart from what it shows: the value and the
    // placeholder kept apart, a range's bounds, a checkbox's state
    var inputFields = function (el, f) {
      var t = el.localName;
      if (t === "input" || t === "textarea") {
        var ty = (el.getAttribute("type") || "text").toLowerCase();
        if (ty === "checkbox" || ty === "radio") f.checked = !!el.checked;
        else {
          f.value = el.value;
          var ph = el.getAttribute("placeholder");
          if (ph) f.placeholder = collapse(ph);
          ["min", "max", "step"].forEach(function (k) { var a = el.getAttribute(k); if (a != null && a !== "") f[k] = a; });
        }
      } else if (t === "select") {
        var o = el.selectedOptions && el.selectedOptions[0];
        f.value = o ? collapse(o.textContent) : "";
        f.options = Array.prototype.map.call(el.options, function (x) { return collapse(x.textContent); });
      } else {
        var now = el.getAttribute("aria-valuenow");
        if (now != null) {
          f.value = el.getAttribute("aria-valuetext") || now;
          var mn = el.getAttribute("aria-valuemin"), mx = el.getAttribute("aria-valuemax");
          if (mn != null) f.min = mn;
          if (mx != null) f.max = mx;
        } else if (el.isContentEditable) f.value = collapse(el.innerText);
        var ac = el.getAttribute("aria-checked");
        if (ac != null) f.checked = ac === "true";
      }
    };
    var STATE_ATTRS = ["aria-selected", "aria-pressed", "aria-checked", "aria-expanded", "aria-current"];
    var stateOf = function (el) {
      var st = {}, any = false;
      STATE_ATTRS.forEach(function (a) { var x = el.getAttribute(a); if (x != null && x !== "false") { st[a.slice(5)] = x; any = true; } });
      if (el.disabled || el.getAttribute("aria-disabled") === "true") { st.disabled = "true"; any = true; }
      if (el.localName === "details" || el.localName === "dialog") { st.open = el.open ? "true" : "false"; any = true; }
      return any ? st : null;
    };
    var sy = scrollY;
    var parts = kept.map(function (el) {
      var v = verdicts.get(el), it = info.get(el), L = looks(el), s = L.s;
      var text = textOf(el);
      var shown = el.localName === "input" || el.localName === "textarea" || el.localName === "select" ? text : collapse(el.innerText != null ? el.innerText : el.textContent);
      var name = nameOf(el);
      var ink = text && TEXTY[v.kind] ? inkOf(el) : null;
      var fg = rgba(s.color), under = L.fill ? over(L.fill, L.bd.c) : L.bd.c;
      var e = {
        el: it.id, kind: v.kind, label: cut(text || name, 80), text: shown, selector: selectorOf(el), box: it.box,
        look: {
          fontPx: Math.round(it.font * 10) / 10, weight: it.weight,
          family: (s.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
          fg: hex(fg), fill: L.fill ? hex(L.fill) : L.image ? "image" : null, backdrop: hex(L.bd.c),
          radius: Math.round(L.radius), shadow: L.shadow, border: L.border
        },
        facts: {
          areaShare: Math.round(area(it.box) / VA * 1e5) / 1e5,
          fontRatio: Math.round(it.font / median * 100) / 100,
          contrast: Math.round(contrast(over(fg, under), under) * 10) / 10,
          fillContrast: Math.round(L.fillC * 100) / 100,
          numeric: numericText(text),
          inFirstScreen: it.box[1] + sy < vh
        },
        // a fill, border, shadow or image is part of how it looks: the
        // picture keeps it (box); bare text is cut to its ink
        lift: { around: "clear", box: ink && !separate(L) ? "ink" : "box", pad: 8 }
      };
      if (L.bd.image) e.look.backdropImage = true;
      var fields = {};
      if (name && name !== shown) fields.name = name;
      if (v.kind === "input" || v.kind === "control") inputFields(v.input || el, fields);
      if (Object.keys(fields).length) e.fields = fields;
      var st = stateOf(v.input && v.kind !== "field" ? v.input : el);
      if (st) e.state = st;
      var ctl = (el.getAttribute("aria-controls") || "").split(/\s+/).map(function (id) {
        var x = id && document.getElementById(id); var up = x ? indexedUp(x) : null; return up ? idOf(up) : null;
      }).filter(Boolean);
      if (ctl.length) e.controls = ctl;
      var lby = (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(function (id) {
        var x = id && document.getElementById(id); var up = x ? indexedUp(x) : null; return up && up !== el ? idOf(up) : null;
      }).filter(Boolean);
      if (lby.length) e.labelledBy = lby;
      if (ink) e.ink = ink;
      if (v.members) { e.members = v.members.map(idOf); e.axis = v.axis; }
      if (v.field) e.field = idOf(v.field);
      if (v.input) e.input = idOf(v.input);
      if (v.kind === "card" || v.kind === "stat" || v.kind === "group" || v.kind === "field") {
        var cc = v.members || contentChildren(el);
        if (cc.length) e.parts = cc.map(idOf);
      }
      return e;
    });
    var keptById = {};
    parts.forEach(function (p, i) { keptById[p.el] = { p: p, el: kept[i] }; });
    parts.forEach(function (p, i) {
      var n = indexedParent(kept[i]);
      while (n) { var k = keptById[idOf(n)]; if (k) { p.inside = k.p.el; break; } n = indexedParent(n); }
    });
    // card subtypes, from what is inside
    parts.forEach(function (p, i) {
      if (p.kind !== "card") return;
      var el = kept[i];
      var holds = function (kinds) { return parts.some(function (q, j) { return j !== i && kinds[q.kind] && el.contains(kept[j]); }); };
      if (holds({ number: 1, stat: 1 })) p.sub = "result";
      else if (holds({ input: 1, control: 1, field: 1 }) || el.querySelector("input:not([type=hidden]),textarea,select")) p.sub = "form";
      else if (holds({ media: 1 })) p.sub = "media";
    });
    var best = null;
    parts.forEach(function (p) { if (p.kind === "button" && (!best || p.facts.fillContrast > best.facts.fillContrast)) best = p; });
    if (best && best.facts.fillContrast > 1) best.primary = true;
    return JSON.stringify({
      viewport: { w: vw, h: vh }, scroll: { x: R(scrollX), y: R(scrollY) }, medianTextPx: median,
      parts: parts, skipped: skipped, ms: Math.round(performance.now() - t0)
    });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.stack || e) });
  }
}`;

/** The largest card the probe considers, a fraction of the screen (the page
 *  script also requires a fill, border or shadow; `open-take states` keeps
 *  cardsOf's 20 %). */
const CARD_MAX_SHARE = 0.4;

/** The expression to evaluate in a restored state.html: runs the probe on
 *  this state's index (its card test runs here, in Node, on index.json). */
export function componentProbeExpression(
  index: StateIndex,
  opts: { minArea?: number } = {},
): string {
  const input: ComponentProbeInput = {
    cards: [...cardsOf(index, undefined, { maxFrac: CARD_MAX_SHARE })],
    ...(opts.minArea != null ? { minArea: opts.minArea } : {}),
  };
  return `(${COMPONENT_PROBE_JS})(${JSON.stringify(input)})`;
}

/** The CSS that leaves only `[data-ot-clip]` drawn, on a see-through page —
 *  what lift(…, { around: "clear" }) shows (kit/media.js). */
export const CLIP_CLEAR_CSS =
  "html,body{background:transparent!important}" +
  "body *{visibility:hidden!important}" +
  "[data-ot-clip],[data-ot-clip] *{visibility:visible!important}";

/** The window a part's picture shows: its ink (text kinds) or box, ± pad,
 *  inside the viewport; and the pixel scale (3×, less if that would pass
 *  `maxSide` px). Null when nothing of it is on screen. */
export function pictureClip(
  part: Pick<PartCandidate, "box" | "ink" | "lift">,
  viewport: { w: number; h: number },
  opts: { scale?: number; maxSide?: number } = {},
): { clip: Box; scale: number } | null {
  const b = part.lift.box === "ink" && part.ink ? part.ink : part.box;
  const pad = part.lift.pad;
  const x0 = Math.max(0, Math.floor(b[0] - pad));
  const y0 = Math.max(0, Math.floor(b[1] - pad));
  const x1 = Math.min(viewport.w, Math.ceil(b[0] + b[2] + pad));
  const y1 = Math.min(viewport.h, Math.ceil(b[1] + b[3] + pad));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const want = opts.scale ?? 3;
  const side = Math.max(x1 - x0, y1 - y0);
  const scale = Math.max(1, Math.min(want, (opts.maxSide ?? 4096) / side));
  return { clip: [x0, y0, x1 - x0, y1 - y0], scale: Math.round(scale * 100) / 100 };
}
