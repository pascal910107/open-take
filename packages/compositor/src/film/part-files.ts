// The product's parts as files: each part of a saved screen (the same set
// components.json lists) written as a standalone HTML file —
// `parts/<state>-<el>-<kind>.html` — that opens alone, at any size, in the
// product's own styles, with no page CSS.
//
// Two halves:
//
//   - in the page (`PART_DOM_JS`, evaluated by the runtime in the restored
//     state.html right after the component probe, before the pictures — the
//     moment computed styles are live): each part's subtree rebuilt with
//     every computed style that differs from what the browser would give it
//     anyway inlined on its element (all inherited ones on the part itself,
//     so it reads the same wherever it is put), ::before / ::after /
//     ::placeholder as rules, shadow roots flattened, live input values
//     written into the markup, a canvas as its picture, local SVG references
//     (a gradient, a <use>d symbol) carried along. References to the saved
//     screen's files are marked state-relative; nothing on the page is
//     changed but a hidden frame for the browser's defaults, removed after.
//     Written as `states/<id>/parts-dom.json`.
//   - in Node (`writePartFiles`, beside writeComponents): each part's file,
//     with the page's @font-face rules for the families it uses (the saved
//     fonts in states/assets/), every reference made relative to the parts
//     folder, a header saying where it came from and what it holds, and
//     `parts/index.json` listing them. A part the page could not give
//     (a frame from another site, too many elements) is listed as skipped
//     with its reason.
//
// Measurement and copying only: which part a film uses is not said here.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ComponentEntry, ComponentSource, ComponentsFile } from "./components";

// --- in the page ----------------------------------------------------------------

/** One part as the page gave it. */
export type PartDom = {
  el: string;
  /** the part's own element and everything inside it, every style inlined;
   *  references to the saved screen's files are `otrel:<path from states/>` */
  html: string;
  /** rules the markup cannot carry: ::before / ::after / ::placeholder, by
   *  `[data-ot-p="<n>"]` */
  css: string;
  /** a hidden <svg> holding what the part's SVG refers to outside itself
   *  (a gradient, a symbol), or "" */
  defs: string;
  /** its natural size, CSS px (border box, untransformed) */
  w: number;
  h: number;
  /** what it draws to the right and below, its box included, when that is
   *  more than its box (a heading set nowrap past its width) */
  drawn?: [number, number];
  /** font families its text is set in (lower case, unquoted) */
  families: string[];
  /** elements in it */
  nodes: number;
};

/** `states/<id>/parts-dom.json` — version 1. */
export type PartDomFile = {
  version: 1;
  state: string;
  parts: PartDom[];
  skipped: { el: string; why: string }[];
  /** time in the page */
  ms: number;
};

/** What the page script takes. */
export type PartDomInput = {
  /** element ids (data-ot-id), the component probe's parts */
  els: string[];
  /** most elements in one part (default 3000) */
  maxNodes?: number;
  /** most characters of markup per screen, all parts together (default 12 000 000) */
  maxChars?: number;
};

/**
 * A function expression: `(${PART_DOM_JS})(input)` returns a JSON string
 * (Omit<PartDomFile, "version" | "state"> or { error }). Reads the page; the
 * only thing it adds is a hidden about:blank frame (the browser's own
 * defaults per tag), removed before it returns.
 */
export const PART_DOM_JS = String.raw`function (input) {
  var frame = null;
  try {
    var t0 = performance.now();
    var HTML_NS = "http://www.w3.org/1999/xhtml", SVG_NS = "http://www.w3.org/2000/svg";
    var maxNodes = input.maxNodes || 3000, maxChars = input.maxChars || 12000000;
    var here = location.href.replace(/#.*$/, "");
    var statesBase = new URL("../", location.href).href;
    // a reference into the saved files: marked relative to states/ (the
    // caller makes it relative to wherever the part's file goes)
    var rel = function (u) {
      if (!u) return u;
      if (/^(data|blob|about|javascript|mailto|tel):/i.test(u) || u.charAt(0) === "#") return u;
      var a;
      try { a = new URL(u, location.href).href; } catch (e) { return u; }
      if (a.replace(/#.*$/, "") === here) { var h = a.indexOf("#"); return h >= 0 ? a.slice(h) : u; }
      if (a.indexOf(statesBase) === 0) return "otrel:" + a.slice(statesBase.length);
      return a;
    };
    var fixUrls = function (v) {
      if (v.indexOf("url(") < 0) return v;
      return v.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g, function (m, a, b, c) {
        var u = a != null ? a : b != null ? b : c;
        return 'url("' + rel(u).replace(/"/g, "%22") + '")';
      });
    };

    // --- what the browser would give each element anyway -------------------
    frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:absolute;left:-20000px;top:0;width:1200px;height:900px;border:0;visibility:hidden";
    // after <body>, not in it: nothing of the page's own (a :last-child) changes
    document.documentElement.appendChild(frame);
    var fd = frame.contentDocument, fw = frame.contentWindow;
    fd.open();
    fd.write('<!doctype html><html><head><style>#ot-ps::before,#ot-ps::after{content:""}</style></head><body><div id="ot-ps"></div><input id="ot-ph" placeholder="x"></body></html>');
    fd.close();
    var EXCLUDE = /^(--|transition|animation|will-change|view-transition|inline-size|block-size|min-inline-size|max-inline-size|min-block-size|max-block-size|margin-(block|inline)|padding-(block|inline)|border-(block|inline)|inset-(block|inline)|scroll-(margin|padding)-(block|inline)|overflow-(block|inline)|contain-intrinsic-(block|inline)|border-(start|end)-|offset|app-region|-webkit-app-region)/;
    var probeCs = getComputedStyle(document.documentElement);
    var PROPS = [];
    for (var i = 0; i < probeCs.length; i++) if (!EXCLUDE.test(probeCs[i])) PROPS.push(probeCs[i]);
    var INH = {};
    ("border-collapse border-spacing caption-side caret-color color color-scheme cursor direction empty-cells " +
      "font-family font-feature-settings font-kerning font-optical-sizing font-palette font-size font-size-adjust " +
      "font-stretch font-style font-synthesis-small-caps font-synthesis-style font-synthesis-weight font-variant " +
      "font-variant-alternates font-variant-caps font-variant-east-asian font-variant-emoji font-variant-ligatures " +
      "font-variant-numeric font-variant-position font-variation-settings font-weight hyphens hyphenate-character " +
      "image-rendering letter-spacing line-break line-height list-style-image list-style-position list-style-type " +
      "orphans overflow-wrap paint-order pointer-events quotes ruby-position tab-size text-align text-align-last " +
      "text-anchor text-combine-upright text-decoration-skip-ink text-emphasis-color text-emphasis-position " +
      "text-emphasis-style text-indent text-orientation text-rendering text-shadow text-size-adjust text-transform " +
      "text-underline-offset text-underline-position text-wrap-mode text-wrap-style visibility white-space-collapse " +
      "widows word-break word-spacing writing-mode -webkit-text-fill-color -webkit-text-stroke-color " +
      "-webkit-text-stroke-width -webkit-font-smoothing -webkit-locale -webkit-text-security " +
      "-webkit-border-horizontal-spacing -webkit-border-vertical-spacing fill fill-opacity fill-rule stroke " +
      "stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity " +
      "stroke-width clip-rule color-interpolation color-interpolation-filters color-rendering marker-start " +
      "marker-mid marker-end shape-rendering")
      .split(" ").forEach(function (p) { INH[p] = 1; });
    // always written: a default frame's width can equal the page's by chance
    var ALWAYS = { width: 1, height: 1 };
    // what the part itself always carries of what it inherits, so it reads
    // the same put into any page (the rest only where it is not the default)
    var ROOT = {};
    ("color font-family font-size font-weight font-style font-stretch font-variant-numeric font-feature-settings " +
      "font-variation-settings line-height letter-spacing word-spacing text-align text-transform text-indent " +
      "text-shadow white-space-collapse text-wrap-mode visibility direction writing-mode cursor list-style-type")
      .split(" ").forEach(function (p) { ROOT[p] = 1; });
    // colours that follow the text's own colour unless set (currentColor)
    var CURRENT = {};
    ("border-top-color border-right-color border-bottom-color border-left-color outline-color column-rule-color " +
      "row-rule-color text-decoration-color text-emphasis-color caret-color -webkit-text-fill-color " +
      "-webkit-text-stroke-color").split(" ").forEach(function (p) { CURRENT[p] = 1; });
    var snap = function (cs) { var o = {}; for (var i = 0; i < PROPS.length; i++) o[PROPS[i]] = cs.getPropertyValue(PROPS[i]); return o; };
    var defs = {};
    // the attributes the browser's own sheet styles by (a link's underline,
    // an input's type, an open <details>), copied onto the default element
    var UA_ATTRS = { href: 1, type: 1, open: 1, multiple: 1, size: 1, controls: 1 };
    var defaultsOf = function (el) {
      var ns = el.namespaceURI || HTML_NS, tag = el.localName, key = ns + " " + tag, set = [];
      if (ns === HTML_NS)
        for (var a in UA_ATTRS) if (el.hasAttribute(a)) { var av = a === "href" ? "#" : el.getAttribute(a); set.push([a, av]); key += " " + a + "=" + av; }
      if (defs[key]) return defs[key];
      var holder = null, d;
      if (ns === SVG_NS) {
        holder = fd.createElementNS(SVG_NS, "svg"); fd.body.appendChild(holder);
        d = tag === "svg" ? holder : holder.appendChild(fd.createElementNS(SVG_NS, tag));
      } else if (ns === HTML_NS) {
        d = fd.createElement(tag);
        set.forEach(function (kv) { try { d.setAttribute(kv[0], kv[1]); } catch (e) {} });
        fd.body.appendChild(d); holder = d;
      } else { d = fd.createElementNS(ns, tag); fd.body.appendChild(d); holder = d; }
      var v = snap(fw.getComputedStyle(d)), up = snap(fw.getComputedStyle(d.parentNode)), ua = {};
      // an inherited property the browser's own sheet sets for this tag (an h1's size)
      for (var p in INH) if (v[p] !== up[p]) ua[p] = 1;
      holder.remove();
      return (defs[key] = { v: v, ua: ua });
    };
    var psDefault = snap(fw.getComputedStyle(fd.getElementById("ot-ps"), "::before"));
    var phDefault = snap(fw.getComputedStyle(fd.getElementById("ot-ph"), "::placeholder"));

    var cache = new Map();
    var computed = function (el) {
      var c = cache.get(el);
      if (!c) { c = snap(getComputedStyle(el)); cache.set(el, c); }
      return c;
    };
    var styleOf = function (el, cs, parent, root) {
      var d = defaultsOf(el), out = [];
      for (var i = 0; i < PROPS.length; i++) {
        var p = PROPS[i], v = cs[p];
        if (!v) continue;
        if (CURRENT[p] && v === cs.color && d.v[p] === d.v.color) continue;
        if (INH[p]) {
          if (root ? !ROOT[p] && v === d.v[p] : parent && v === parent[p] && !d.ua[p]) continue;
        } else if (v === d.v[p] && !(ALWAYS[p] && v !== "auto")) continue;
        out.push(p + ":" + fixUrls(v));
      }
      return out;
    };
    var pseudoN = 0;
    var pseudoCss = function (el, cs, out, fams) {
      var rules = "";
      var id = null;
      var tag = function () { if (id == null) { id = String(++pseudoN); out.setAttribute("data-ot-p", id); } return id; };
      ["::before", "::after"].forEach(function (ps) {
        var live = getComputedStyle(el, ps), c = live.getPropertyValue("content");
        if (!c || c === "none" || c === "normal") return;
        var p = snap(live);
        var st = [];
        for (var i = 0; i < PROPS.length; i++) {
          var k = PROPS[i], v = p[k];
          if (!v) continue;
          if (CURRENT[k] && v === p.color && psDefault[k] === psDefault.color) continue;
          if (INH[k] ? v === cs[k] : v === psDefault[k] && k !== "content") continue;
          st.push(k + ":" + fixUrls(v));
        }
        addFamilies(p["font-family"], fams);
        rules += '[data-ot-p="' + tag() + '"]' + ps + "{" + st.join(";") + "}";
      });
      if ((el.localName === "input" || el.localName === "textarea") && el.getAttribute("placeholder")) {
        var ph = snap(getComputedStyle(el, "::placeholder")), st2 = [];
        ["color", "opacity", "font-style", "font-weight", "letter-spacing", "text-transform", "-webkit-text-fill-color"].forEach(function (k) {
          if (ph[k] && ph[k] !== phDefault[k] && ph[k] !== cs[k]) st2.push(k + ":" + ph[k]);
        });
        if (st2.length) rules += '[data-ot-p="' + tag() + '"]::placeholder{' + st2.join(";") + "}";
      }
      return rules;
    };
    var addFamilies = function (ff, fams) {
      (ff || "").split(",").forEach(function (f) {
        f = f.trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (f) fams[f] = 1;
      });
    };
    var URL_ATTR = { src: 1, href: 1, poster: 1, "xlink:href": 1, background: 1 };
    var SKIP = { script: 1, style: 1, link: 1, meta: 1, noscript: 1, template: 1, title: 1, base: 1 };
    var FRAMES = { iframe: 1, frame: 1, object: 1, embed: 1, portal: 1, fencedframe: 1 };
    var kids = function (n) {
      if (n.shadowRoot) return Array.prototype.slice.call(n.shadowRoot.childNodes);
      if (n.localName === "slot" && n.assignedNodes) { var a = n.assignedNodes(); if (a.length) return a; }
      return Array.prototype.slice.call(n.childNodes);
    };

    var build = function (el, parent, root, st) {
      var tag = el.localName, ns = el.namespaceURI || HTML_NS;
      if (SKIP[tag]) return null;
      if (FRAMES[tag]) throw new Error("it holds an <" + tag + ">: what is inside a frame is another page, not carried into a file");
      if (++st.nodes > maxNodes) throw new Error("more than " + maxNodes + " elements in it");
      if (tag === "source" && el.parentElement && el.parentElement.localName === "picture") return null;
      var cs = computed(el), out;
      if (tag === "canvas") {
        out = document.createElement("img");
        try { out.setAttribute("src", el.toDataURL("image/png")); } catch (e) { out.setAttribute("alt", "a canvas that could not be read"); }
      } else out = document.createElementNS(ns, tag);
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i], n = a.name.toLowerCase(), v = a.value;
        if (n === "style" || n.indexOf("on") === 0 || n.indexOf("data-ot-") === 0 || n === "srcset" || n === "sizes" || n === "loading") continue;
        if (tag === "canvas" && n !== "class" && n !== "id") continue;
        if (URL_ATTR[n]) v = rel(v);
        try { if (a.namespaceURI) out.setAttributeNS(a.namespaceURI, a.name, v); else out.setAttribute(a.name, v); } catch (e) { /* a name markup cannot hold */ }
      }
      if (tag === "img" && (el.currentSrc || el.getAttribute("src"))) out.setAttribute("src", rel(el.currentSrc || el.getAttribute("src")));
      if (tag === "video" && el.currentSrc) out.setAttribute("src", rel(el.currentSrc));
      if (tag === "input") {
        var ty = (el.type || "").toLowerCase();
        if (ty === "checkbox" || ty === "radio") { if (el.checked) out.setAttribute("checked", ""); else out.removeAttribute("checked"); }
        else if (ty !== "file" && ty !== "password") out.setAttribute("value", el.value);
      }
      if (tag === "option") { if (el.selected) out.setAttribute("selected", ""); else out.removeAttribute("selected"); }
      var style = styleOf(el, cs, parent, root);
      if (root) {
        // the part itself: where it sat on the page is not its own
        style = style.filter(function (s) { return !/^(margin-|position:|top:|left:|right:|bottom:|transform:|translate:|rotate:|scale:|float:|z-index:)/.test(s); });
        style.push("margin:0", "position:relative", "float:none");
      }
      if (style.length) out.setAttribute("style", style.join(";"));
      addFamilies(cs["font-family"], st.fams);
      var r = pseudoCss(el, cs, out, st.fams);
      if (r) st.css += r;
      if (tag === "textarea") { out.textContent = el.value; return out; }
      if (tag === "canvas") return out;
      var ks = kids(el);
      for (var k = 0; k < ks.length; k++) {
        var c = ks[k];
        if (c.nodeType === 3) out.appendChild(document.createTextNode(c.data));
        else if (c.nodeType === 1) { var b = build(c, cs, false, st); if (b) out.appendChild(b); }
      }
      return out;
    };

    // what the part's SVG names outside itself (url(#g), <use href="#icon">)
    var refsIn = function (node, ids) {
      var all = [node].concat(Array.prototype.slice.call(node.querySelectorAll("*")));
      all.forEach(function (n) {
        var h = n.getAttribute("href") || n.getAttribute("xlink:href");
        if (h && h.charAt(0) === "#") ids[h.slice(1)] = 1;
        var s = (n.getAttribute("style") || "") + " " + (n.getAttribute("fill") || "") + " " + (n.getAttribute("stroke") || "") + " " + (n.getAttribute("clip-path") || "") + " " + (n.getAttribute("mask") || "") + " " + (n.getAttribute("filter") || "");
        s.replace(/url\(\s*["']?#([^"')]+)["']?\s*\)/g, function (m, id) { ids[id] = 1; return m; });
      });
    };
    var carried = function (root, st) {
      var have = {}, out = [];
      Array.prototype.forEach.call(root.querySelectorAll("[id]"), function (n) { have[n.id] = 1; });
      if (root.id) have[root.id] = 1;
      var queue = {};
      refsIn(root, queue);
      for (var round = 0; round < 3; round++) {
        var next = {};
        for (var id in queue) {
          if (have[id]) continue;
          have[id] = 1;
          var src = document.getElementById(id);
          if (!src) continue;
          // a symbol takes its paint from the <use> that shows it: copied as
          // it is; a gradient, a clip, a mask or a filter with its styles
          var copy = src.localName === "symbol" ? src.cloneNode(true) : build(src, null, false, st);
          if (!copy) continue;
          out.push(copy);
          refsIn(copy, next);
        }
        queue = next;
      }
      if (!out.length) return "";
      var svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
      var d = document.createElementNS(SVG_NS, "defs");
      out.forEach(function (n) { d.appendChild(n); });
      svg.appendChild(d);
      return svg.outerHTML;
    };

    var parts = [], skipped = [], chars = 0;
    (input.els || []).forEach(function (id) {
      var el = document.querySelector('[data-ot-id="' + id + '"]');
      if (!el) { skipped.push({ el: id, why: "not found in the restored page" }); return; }
      if (chars > maxChars) { skipped.push({ el: id, why: "this screen's part files already hold " + Math.round(maxChars / 1e6) + " MB of markup" }); return; }
      var st = { nodes: 0, css: "", fams: {} };
      try {
        var r = el.getBoundingClientRect();
        var w = el.offsetWidth != null ? el.offsetWidth : r.width, h = el.offsetHeight != null ? el.offsetHeight : r.height;
        if (!(w > 0 && h > 0)) { w = r.width; h = r.height; }
        if (!(w > 0 && h > 0)) { skipped.push({ el: id, why: "it has no size on the page" }); return; }
        var node = build(el, el.parentElement ? computed(el.parentElement) : null, true, st);
        if (!node) { skipped.push({ el: id, why: "a <" + el.localName + "> is not drawn" }); return; }
        var html = node.outerHTML, defsHtml = carried(node, st);
        chars += html.length + defsHtml.length + st.css.length;
        var dw = Math.max(w, el.scrollWidth || 0), dh = Math.max(h, el.scrollHeight || 0);
        var item = { el: id, html: html, css: st.css, defs: defsHtml, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100, families: Object.keys(st.fams), nodes: st.nodes };
        if (dw > w + 1 || dh > h + 1) item.drawn = [Math.ceil(dw), Math.ceil(dh)];
        parts.push(item);
      } catch (e) {
        skipped.push({ el: id, why: String(e && e.message || e) });
      }
    });
    return JSON.stringify({ parts: parts, skipped: skipped, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.stack || e) });
  } finally {
    if (frame) frame.remove();
  }
}`;

/** The expression to evaluate in a restored state.html for these parts. */
export function partDomExpression(els: string[], opts: Omit<PartDomInput, "els"> = {}): string {
  return `(${PART_DOM_JS})(${JSON.stringify({ els, ...opts } satisfies PartDomInput)})`;
}

// --- the page's fonts -------------------------------------------------------------

/** a url() in CSS, quoted or not */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g;

/** `css` with every relative url() resolved from `fromDir` and written
 *  relative to `toDir` (posix separators) */
function moveCssUrls(css: string, fromDir: string, toDir: string): string {
  return css.replace(CSS_URL, (m, a?: string, b?: string, c?: string) => {
    const u = (a ?? b ?? c ?? "").trim();
    if (!u || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(u)) return m;
    const [path, rest] = splitRef(u);
    const to = relative(toDir, resolve(fromDir, decodeURIComponentSafe(path)))
      .split(sep)
      .join("/");
    return `url("${encodeURI(to)}${rest}")`;
  });
}

const splitRef = (u: string): [string, string] => {
  const i = u.search(/[?#]/);
  return i < 0 ? [u, ""] : [u.slice(0, i), u.slice(i)];
};
const decodeURIComponentSafe = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** the family an @font-face block declares, unquoted */
function faceFamily(block: string): string | null {
  const m = /font-family\s*:\s*([^;}]+)/i.exec(block);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : null;
}

/**
 * Every @font-face rule a saved screen's state.html carries — in its own
 * <style> elements and in the stylesheets it links (and those they @import)
 * — each with its url()s written relative to `toDir`, and the family it
 * declares (as written, and lower case to match by).
 */
export function stateFontFaces(
  stateDir: string,
  toDir: string,
): { family: string; key: string; css: string }[] {
  const out: { family: string; key: string; css: string }[] = [];
  const seen = new Set<string>();
  const take = (css: string, fromDir: string) => {
    for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
      // a face whose files the snapshot did not carry (cut off: about:blank) draws nothing
      const urls = [...m[0].matchAll(CSS_URL)].map((u) => (u[1] ?? u[2] ?? u[3] ?? "").trim());
      if (urls.length && urls.every((u) => /^about:/i.test(u))) continue;
      const family = faceFamily(m[0]);
      if (family)
        out.push({ family, key: family.toLowerCase(), css: moveCssUrls(m[0], fromDir, toDir) });
    }
  };
  const sheet = (file: string, depth: number) => {
    if (depth > 4 || seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    let css: string;
    try {
      css = readFileSync(file, "utf8");
    } catch {
      return;
    }
    take(css, dirname(file));
    for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
      const ref = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
      sheet(resolve(dirname(file), decodeURIComponentSafe(splitRef(ref)[0])), depth + 1);
    }
  };
  let html: string;
  try {
    html = readFileSync(join(stateDir, "state.html"), "utf8");
  } catch {
    return out;
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    take(m[1]!, stateDir);
    for (const im of m[1]!.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi))
      if (!/^[a-z][a-z0-9+.-]*:/i.test(im[1]!))
        sheet(resolve(stateDir, decodeURIComponentSafe(splitRef(im[1]!)[0])), 1);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const ref = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
    sheet(resolve(stateDir, decodeURIComponentSafe(splitRef(ref.replace(/&amp;/g, "&"))[0])), 0);
  }
  return out;
}

// --- the files ----------------------------------------------------------------------

/** One part's file in `parts/index.json`. */
export type PartFileEntry = {
  /** the file, relative to index.json */
  file: string;
  ref: string;
  state: string;
  el: string;
  kind: ComponentEntry["kind"];
  label: string;
  /** what it holds, by field, as the page showed it (components.json has
   *  each with where it was read) */
  values: Record<string, string>;
  /** its natural size, CSS px — the file's body is this size */
  w: number;
  h: number;
  /** what it draws to the right and below, when more than w × h (as on the page) */
  drawn?: [number, number];
  /** where it sat on its screen, the screen's CSS px */
  box: [number, number, number, number];
  /** its crisp picture (components.json's), relative to index.json */
  picture?: string;
  /** what was behind it on the page (the file itself is see-through) */
  backdrop: string;
  /** font families set in it that have their font in the file */
  fonts: string[];
};

/** `parts/index.json` — version 1. */
export type PartFilesIndex = {
  version: 1;
  about: string;
  /** components.json, relative to index.json */
  components: string;
  parts: PartFileEntry[];
  skipped: { ref: string; kind: ComponentEntry["kind"]; label: string; why: string }[];
};

const INDEX_ABOUT =
  "Each part of the product's saved screens (the parts components.json lists) as a standalone HTML file: its own elements with every computed style inlined, the page's @font-face rules for the fonts it uses (the saved font files), its images from the saved files — it opens alone, at any size, in the product's own styles. w × h is its natural size; each file's header says where it came from and how to show it. Nothing here says which part a film uses.";

/** `<state>-<el>-<kind>.html`, safe as a file name */
export function partFileName(e: Pick<ComponentEntry, "state" | "el" | "kind">): string {
  return `${e.state}-${e.el}-${e.kind}.html`.replace(/[^\w.-]+/g, "_");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** text safe inside an HTML comment (nothing in it ends the comment) */
const inComment = (s: string): string => s.replace(/--(?=!?>)/g, "-\\u002d");

/** One part's file. */
export function partFileHtml(o: {
  entry: ComponentEntry;
  dom: PartDom;
  /** where the part's file goes, to mark-relative references from */
  statesPrefix: string;
  /** @font-face rules, their url()s relative to the file */
  fonts: string[];
  /** the families they declare */
  families: string[];
  file: string;
  values: Record<string, string>;
  /** the saved screen, relative to the file */
  stateHtml: string;
}): string {
  const { entry: e, dom } = o;
  const w = Math.ceil(dom.w);
  const h = Math.ceil(dom.h);
  // the iframe shows all it draws (a heading set past its width included)
  const [fw, fh] = dom.drawn ?? [w, h];
  const local = (s: string) => s.replace(/otrel:/g, o.statesPrefix);
  const header = [
    `${e.label || e.kind} — a ${e.kind} of ${e.provenance.url ?? "the product's page"}, as it stood on the saved screen "${e.state}"`,
    "",
    `source:   ${e.provenance.url ?? "(not recorded)"}`,
    `state:    ${e.state} (${o.stateHtml})`,
    `ref:      ${e.ref}`,
    `selector: ${e.selector}`,
    `kind:     ${e.kind}${e.sub ? ` (${e.sub})` : ""}`,
    `label:    ${JSON.stringify(e.label)}`,
    `values:   ${JSON.stringify(o.values)}`,
    `captured: ${e.provenance.capturedAt ?? "(not recorded)"}`,
    `size:     ${w} × ${h} CSS px (natural; data-w / data-h on <body>, --part-w / --part-h)`,
    ...(dom.drawn
      ? [`drawn:    ${fw} × ${fh} CSS px (it draws past its box, as on the page)`]
      : []),
    `backdrop: ${e.look.backdrop} (what was behind it on the page; this file is see-through)`,
    `fonts:    ${o.families.length ? `${o.families.join(", ")} (the saved font files, declared below)` : "none of its own (system fonts)"}`,
    "",
    "Its elements carry every computed style inline and its fonts are declared below, so it",
    "renders as the page did with no page CSS. At any size, from a page beside parts/:",
    `  <iframe src="parts/${o.file}" width="${fw}" height="${fh}" scrolling="no" style="border:0;transform:scale(2);transform-origin:0 0"></iframe>`,
    `or put into the page itself: (await partFiles("parts/")).node("${e.ref}") — kit/media.js`,
  ]
    .map((l) => (l ? `  ${inComment(l)}` : ""))
    .join("\n");
  return `<!doctype html>
<!--
${header}
-->
<html>
<head>
<meta charset="utf-8">
<title>${esc(e.label || e.ref)}</title>
<style>
:root{--part-w:${w}px;--part-h:${h}px;--part-backdrop:${e.look.backdrop}}
html,body{margin:0;padding:0;background:transparent}
body{width:var(--part-w);height:var(--part-h)}
</style>
${o.fonts.length ? `<style data-part-fonts>\n${local(o.fonts.join("\n"))}\n</style>\n` : ""}${dom.css ? `<style data-part-pseudo>\n${local(dom.css)}\n</style>\n` : ""}</head>
<body data-w="${w}" data-h="${h}" data-ref="${esc(e.ref)}" data-kind="${e.kind}">
${local(dom.html)}${dom.defs ? `\n${local(dom.defs)}` : ""}
</body>
</html>
`;
}

export type PartFilesResult = {
  /** the parts folder (absolute) */
  dir: string;
  /** parts/index.json (absolute) */
  index: string;
  written: number;
  skipped: PartFilesIndex["skipped"];
};

/** a part's values as text, by field */
const valuesText = (e: ComponentEntry): Record<string, string> =>
  Object.fromEntries(Object.entries(e.values).map(([k, v]) => [k, v.text]));

/**
 * Write each part of `file` (gathered from `source`) as
 * `<dir>/<state>-<el>-<kind>.html`, from what its screen's page gave
 * (states/<id>/parts-dom.json), and `<dir>/index.json`. A part whose screen
 * has no parts-dom.json, or that the page could not give, is skipped with
 * its reason. A folder of part files written before is replaced; one that
 * is something else is refused.
 */
export function writePartFiles(
  file: ComponentsFile,
  source: Pick<ComponentSource, "root" | "states">,
  dir: string,
): PartFilesResult {
  const out = resolve(dir);
  const indexPath = join(out, "index.json");
  if (existsSync(out)) {
    let ours = false;
    try {
      ours =
        (JSON.parse(readFileSync(indexPath, "utf8")) as { about?: string }).about === INDEX_ABOUT;
    } catch {
      ours = readdirSync(out).length === 0;
    }
    if (!ours)
      throw new Error(`${out} is there and holds something else than part files — not replaced`);
    rmSync(out, { recursive: true, force: true });
  }
  const parts: PartFileEntry[] = [];
  const skipped: PartFilesIndex["skipped"] = [];
  const doms = new Map<string, Map<string, PartDom> | string>();
  const skips = new Map<string, Map<string, string>>();
  const faces = new Map<string, ReturnType<typeof stateFontFaces>>();
  const dirOf = new Map(source.states.map((s) => [s.id, s.dir]));
  const toPosix = (p: string) => p.split(sep).join("/");
  for (const e of file.components) {
    const skip = (why: string) => skipped.push({ ref: e.ref, kind: e.kind, label: e.label, why });
    const stateDir = dirOf.get(e.state);
    if (!stateDir) {
      skip("its saved screen is not in this inventory's source");
      continue;
    }
    if (!doms.has(e.state)) {
      try {
        const f = JSON.parse(readFileSync(join(stateDir, "parts-dom.json"), "utf8")) as PartDomFile;
        doms.set(e.state, new Map(f.parts.map((p) => [p.el, p])));
        skips.set(e.state, new Map(f.skipped.map((s) => [s.el, s.why])));
      } catch {
        doms.set(
          e.state,
          existsSync(join(stateDir, "parts-dom.json"))
            ? "its screen's parts-dom.json could not be read"
            : "its screen was saved before parts were kept as files (no parts-dom.json) — save it again",
        );
      }
    }
    const byEl = doms.get(e.state)!;
    if (typeof byEl === "string") {
      skip(byEl);
      continue;
    }
    const dom = byEl.get(e.el);
    if (!dom) {
      skip(skips.get(e.state)?.get(e.el) ?? "the page gave nothing for it");
      continue;
    }
    if (!faces.has(e.state)) faces.set(e.state, stateFontFaces(stateDir, out));
    const fams = new Set(dom.families);
    const used = faces.get(e.state)!.filter((f) => fams.has(f.key));
    const name = partFileName(e);
    const values = valuesText(e);
    const statesPrefix = `${toPosix(relative(out, dirname(stateDir))) || "."}/`;
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, name),
      partFileHtml({
        entry: e,
        dom,
        statesPrefix,
        // the fonts are already relative to the parts folder
        fonts: used.map((f) => f.css),
        families: [...new Set(used.map((f) => f.family))],
        file: name,
        values,
        stateHtml: toPosix(relative(out, join(stateDir, "state.html"))),
      }),
    );
    parts.push({
      file: name,
      ref: e.ref,
      state: e.state,
      el: e.el,
      kind: e.kind,
      label: e.label,
      values,
      w: Math.ceil(dom.w),
      h: Math.ceil(dom.h),
      ...(dom.drawn ? { drawn: dom.drawn } : {}),
      box: e.box,
      ...(e.picture ? { picture: toPosix(relative(out, resolve(source.root, e.picture))) } : {}),
      backdrop: e.look.backdrop,
      fonts: [...new Set(used.map((f) => f.family))],
    });
  }
  const index: PartFilesIndex = {
    version: 1,
    about: INDEX_ABOUT,
    components: toPosix(relative(out, join(source.root, "components.json"))),
    parts,
    skipped,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return { dir: out, index: indexPath, written: parts.length, skipped };
}

/** The one line a summary prints about the part files. */
export function partFilesLine(r: PartFilesResult, shownDir: string): string {
  const sk = r.skipped.length;
  if (!r.written)
    return `parts: no part files in ${shownDir}/ — ${r.skipped[0]?.why ?? "no parts measured"} (index.json)`;
  return (
    `parts: ${r.written} part${r.written === 1 ? "" : "s"} as files in ${shownDir}/ (index.json) — each opens alone at any size, in the product's styles` +
    (sk ? `; ${sk} skipped, each with its reason in index.json` : "")
  );
}
