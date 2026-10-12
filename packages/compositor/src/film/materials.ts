// The page's material, the whole page: the product's own images (an <img> or
// <picture> with its largest source, an inline SVG drawing, a CSS background
// image, a video, a canvas the page draws) and the copy it writes (headings,
// taglines, short paragraphs) — from the top of the page to its bottom, not
// only the first screen, in page order. The component index (parts.json)
// measures what is on screen at a saved moment; this lists what the page
// holds, so an illustration two screens down or the tagline above the footer
// is named too.
//
// One page script (MATERIALS_PROBE_JS) reads it, read-only, in the live page
// as a shoot keeps its first saved screen of each page (the URLs and the
// srcset candidates are the network's there), or in a restored state.html
// for a screen saved before this existed (its files are the saved ones). The
// Node side here turns what it returns into `states/<id>/materials.json`:
// the largest source of each image, the copy, and the summary lines a shoot
// prints. Nothing is ranked or picked: every list is in page order, and what
// the probe leaves out is counted with its reason in `skipped`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentSource } from "./components";

type Box = [number, number, number, number];

export type MaterialKind = "img" | "svg" | "background" | "video" | "canvas";

/** One image of the page. */
export type MaterialImage = {
  kind: MaterialKind;
  /** PAGE CSS px — x, y from the top-left of the whole page (scroll 0), and
   *  the size it is drawn at */
  box: Box;
  /** an <img>'s alt as written ("" — the page marks it decorative) */
  alt?: string;
  /** its accessible name when there is no alt: aria-label, title, an svg's <title> */
  name?: string;
  /** the largest source the page offers (srcset / <picture> / image-set), a URL */
  src?: string;
  /** that source's width descriptor (srcset `1600w`) */
  srcW?: number;
  /** how many sources the page offers for it */
  sources?: number;
  /** the source the browser drew, when it is not `src` */
  shown?: string;
  /** the drawn source's own pixel size, when it had loaded */
  natural?: [number, number];
  /** a video's poster frame, a URL */
  poster?: string;
  /** the saved copy, relative to the state folder ("../assets/<sha1>.jpg");
   *  a video's is its poster frame */
  file?: string;
  /** the saved copy's pixel size (absent for a format whose header is not read) */
  fileSize?: [number, number];
  bytes?: number;
  /** why no copy was saved */
  notSaved?: string;
  /** it starts within the first screen (scroll 0) */
  firstScreen: boolean;
  /** inside a position: fixed layer (its box is where the page was scrolled to) */
  fixed?: true;
  /** the landmark it sits in: nav, header, footer, aside, dialog */
  in?: string;
  /** why it is not seen as the page stands: "opacity 0" (a reveal not yet
   *  run), "visibility hidden", "outside the page width" (a carousel slide) */
  hidden?: string;
  /** a CSS path that finds it */
  selector: string;
  /** its element id in the saved screen (read from a state.html) */
  el?: string;
};

/** One piece of the page's copy. */
export type MaterialText = {
  /** the element's tag (h1–h6, p, li, blockquote, …; a div or span set larger than the body) */
  tag: string;
  /** a heading's level (h2 → 2, aria-level) */
  level?: number;
  /** the text, collapsed (cut at MATERIAL_TEXT_MAX chars, `chars` the whole length) */
  text: string;
  chars?: number;
  box: Box;
  fontPx: number;
  weight: number;
  firstScreen: boolean;
  fixed?: true;
  in?: string;
  hidden?: string;
  selector: string;
  el?: string;
};

export type MaterialMeta = {
  description?: string;
  /** og:image / twitter:image, a URL — the page's share picture */
  ogImage?: string;
  ogImageFile?: string;
  ogTitle?: string;
  themeColor?: string;
  icon?: string;
};

/** A link the page offers — to its About, docs, examples, repository, store
 *  page: other pages a film can read the product from. */
export type MaterialLink = {
  /** what it says (its text, else its accessible name) */
  text: string;
  href: string;
  /** on the page's own site (its host's last two labels) */
  own: boolean;
  /** the landmark it sits in: nav, header, footer, aside, dialog */
  in?: string;
  firstScreen: boolean;
};

/** The full-page picture: the page from top to bottom, small, cut into
 *  columns side by side (column k shows page y k·columnPx … (k+1)·columnPx). */
export type MaterialSheet = {
  /** relative to the state folder */
  file: string;
  columns: number;
  /** page CSS px per column */
  columnPx: number;
  /** image px per page CSS px */
  scale: number;
  /** page CSS px it shows from the top (the whole page unless it is very tall) */
  coveredPx: number;
  /** read from the saved screen: images the snapshot did not carry are blank */
  from: "saved screen";
};

/** `states/<id>/materials.json` — version 1. */
export type MaterialsFile = {
  version: 1;
  /** the saved screen it was read with */
  state: string;
  /** "live": in the product's page as it was shot; "saved screen": in its state.html */
  read: "live" | "saved screen";
  url: string;
  title: string;
  viewport: { w: number; h: number };
  /** the whole page, CSS px */
  page: { w: number; h: number };
  medianTextPx: number;
  meta: MaterialMeta;
  /** in page order (top to bottom, then left to right) */
  images: MaterialImage[];
  /** in page order */
  copy: MaterialText[];
  /** the other pages it links to, one per address, in page order (absent in
   *  a file written before links were read) */
  links?: MaterialLink[];
  /** counted, not listed — each with its reason in `scope` */
  skipped: MaterialSkipped;
  sheet?: MaterialSheet;
  /** what was read and what was not, in words */
  scope: string;
  ms: { read: number; files?: number; sheet?: number };
};

export type MaterialSkipped = {
  /** drawn at no size (display: none, an empty box) */
  hidden: number;
  /** images and backgrounds drawn smaller than MATERIAL_MIN_IMAGE_PX square (icons, pixels) */
  small: number;
  /** inline svgs smaller than MATERIAL_MIN_SVG_AREA px² (icons) */
  icons: number;
  /** copy inside aria-hidden (a marquee's repeat) */
  ariaHidden: number;
  /** iframes (embeds, ads): not read */
  frames: number;
  /** past MATERIAL_MAX_IMAGES / MATERIAL_MAX_COPY entries */
  more: number;
};

export const MATERIAL_TEXT_MAX = 400;
export const MATERIAL_MIN_IMAGE_PX = 24;
export const MATERIAL_MIN_SVG_AREA = 3000;
export const MATERIAL_MAX_IMAGES = 400;
export const MATERIAL_MAX_COPY = 600;
export const MATERIAL_MAX_LINKS = 120;

/** A source the page offers for an image. */
export type MaterialCandidate = {
  url: string;
  /** srcset width descriptor */
  w?: number;
  /** density descriptor (a plain src is 1x) */
  x?: number;
  /** a <source>'s type */
  type?: string;
  media?: string;
};

/** What the page script returns per image, before the Node side picks the
 *  largest source and saves files. */
export type MaterialProbeImage = Omit<
  MaterialImage,
  "src" | "srcW" | "sources" | "shown" | "file" | "fileSize" | "bytes" | "notSaved"
> & {
  candidates: MaterialCandidate[];
  /** the source drawn (currentSrc) */
  current?: string;
  /** an inline svg, standalone (xmlns added, drawn size and colour on a wrapper) */
  markup?: string;
};

export type MaterialsProbeResult =
  | {
      url: string;
      title: string;
      viewport: { w: number; h: number };
      page: { w: number; h: number };
      medianTextPx: number;
      meta: MaterialMeta;
      images: MaterialProbeImage[];
      copy: MaterialText[];
      links?: MaterialLink[];
      skipped: MaterialSkipped;
      ms: number;
    }
  | { error: string };

/**
 * A function expression: `(${MATERIALS_PROBE_JS})()` returns a JSON string
 * (MaterialsProbeResult). Reads the page only — no node, attribute or style
 * is touched and nothing scrolls; the page is being filmed.
 */
export const MATERIALS_PROBE_JS = String.raw`function () {
  try {
    var t0 = performance.now();
    var vw = innerWidth, vh = innerHeight, sx = scrollX, sy = scrollY;
    var de = document.documentElement, body = document.body || de;
    var pageW = Math.max(de.scrollWidth, body.scrollWidth, vw);
    var pageH = Math.max(de.scrollHeight, body.scrollHeight, vh);
    var R = Math.round;
    var MIN_PX = ${MATERIAL_MIN_IMAGE_PX}, MIN_SVG = ${MATERIAL_MIN_SVG_AREA};
    var MAX_IMAGES = ${MATERIAL_MAX_IMAGES}, MAX_COPY = ${MATERIAL_MAX_COPY}, TEXT_MAX = ${MATERIAL_TEXT_MAX}, MAX_LINKS = ${MATERIAL_MAX_LINKS};
    var collapse = function (s) { return (s || "").replace(/\s+/g, " ").trim(); };
    var absUrl = function (u) {
      if (!u) return null;
      try { var h = new URL(u, document.baseURI).href; return /^(about|javascript):/i.test(h) ? null : h; } catch (e) { return null; }
    };
    var styleCache = new Map();
    var cs = function (el) { var s = styleCache.get(el); if (!s) { s = getComputedStyle(el); styleCache.set(el, s); } return s; };
    var skipped = { hidden: 0, small: 0, icons: 0, ariaHidden: 0, frames: 0, more: 0 };

    // --- where it is -----------------------------------------------------------
    var fixedCache = new Map();
    var fixedOf = function (el) {
      if (!el || el.nodeType !== 1) return false;
      if (fixedCache.has(el)) return fixedCache.get(el);
      var f = cs(el).position === "fixed" || fixedOf(el.parentElement);
      fixedCache.set(el, f);
      return f;
    };
    var pageBox = function (r, fixed) {
      // a fixed layer is where it is on screen, wherever the page is scrolled
      var ox = fixed ? 0 : sx, oy = fixed ? 0 : sy;
      return [R(r.left + ox), R(r.top + oy), R(r.width), R(r.height)];
    };
    var LANDMARK = "nav,header,footer,aside,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog]";
    var ROLE_NAME = { navigation: "nav", banner: "header", contentinfo: "footer", complementary: "aside", dialog: "dialog" };
    var landmarkOf = function (el) {
      var l = el.closest(LANDMARK);
      if (!l) return undefined;
      var role = l.getAttribute("role");
      return (role && ROLE_NAME[role]) || l.localName;
    };
    var opacityCache = new Map();
    var faded = function (el) {
      if (!el || el.nodeType !== 1) return null;
      if (opacityCache.has(el)) return opacityCache.get(el);
      var o = parseFloat(cs(el).opacity);
      var res = o < 0.05 ? "opacity " + R(o * 100) / 100 : faded(el.parentElement);
      opacityCache.set(el, res);
      return res;
    };
    var hiddenWhy = function (el, box) {
      var v = cs(el).visibility;
      if (v === "hidden" || v === "collapse") return "visibility hidden";
      var f = faded(el);
      if (f) return f;
      if (box[0] + box[2] <= 0 || box[0] >= pageW) return "outside the page width";
      return null;
    };
    var cssIdent = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
    var selectorOf = function (el) {
      var steps = [], n = el;
      while (n && n !== de) {
        if (n.id && cssIdent.test(n.id) && document.querySelectorAll("#" + n.id).length === 1) { steps.unshift("#" + n.id); break; }
        var tag = n.localName, par = n.parentElement, step = tag;
        if (par) {
          var same = Array.prototype.filter.call(par.children, function (c) { return c.localName === tag; });
          if (same.length > 1) step += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
        }
        steps.unshift(step);
        if (tag === "body") break;
        n = par;
      }
      return steps.join(" > ");
    };
    var common = function (el, r) {
      var fixed = fixedOf(el), box = pageBox(r, fixed);
      var o = { box: box, firstScreen: !fixed && box[1] < vh || fixed && r.top < vh, selector: selectorOf(el) };
      if (fixed) o.fixed = true;
      var lm = landmarkOf(el); if (lm) o.in = lm;
      var h = hiddenWhy(el, box); if (h) o.hidden = h;
      var id = el.getAttribute("data-ot-id"); if (id) o.el = id;
      return o;
    };
    var nameOf = function (el) {
      var a = el.getAttribute("aria-label");
      if (a && collapse(a)) return collapse(a);
      var by = el.getAttribute("aria-labelledby");
      if (by) {
        var t = by.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? collapse(n.textContent) : ""; }).join(" ").trim();
        if (t) return t;
      }
      var ti = el.getAttribute("title");
      if (ti && collapse(ti)) return collapse(ti);
      return undefined;
    };

    // --- sources ------------------------------------------------------------------
    var parseSrcset = function (value) {
      var out = [], n = value.length, i = 0;
      while (i < n) {
        while (i < n && /[\s,]/.test(value[i])) i++;
        if (i >= n) break;
        var st = i;
        while (i < n && !/\s/.test(value[i])) i++;
        var url = value.slice(st, i), d = "";
        if (/,$/.test(url)) url = url.replace(/,+$/, "");
        else {
          while (i < n && /\s/.test(value[i])) i++;
          var ds = i;
          while (i < n && value[i] !== ",") i++;
          d = value.slice(ds, i).trim();
        }
        if (url) out.push({ url: url, d: d });
      }
      return out;
    };
    var candidate = function (url, d, from) {
      var a = absUrl(url);
      if (!a) return null;
      var c = { url: a }, m;
      if ((m = /^(\d+(?:\.\d+)?)w$/i.exec(d || ""))) c.w = +m[1];
      else if ((m = /^(\d+(?:\.\d+)?)x$/i.exec(d || ""))) c.x = +m[1];
      else c.x = 1;
      if (from && from.getAttribute("type")) c.type = from.getAttribute("type");
      if (from && from.getAttribute("media")) c.media = from.getAttribute("media");
      return c;
    };
    var fromSrcset = function (value, from) {
      return parseSrcset(value || "").map(function (s) { return candidate(s.url, s.d, from); }).filter(Boolean);
    };
    var cssUrls = function (value) {
      var out = [], re = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)\s*(\d+(?:\.\d+)?x)?/g, m;
      while ((m = re.exec(value))) {
        var c = candidate((m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || "").replace(/\\(.)/g, "$1"), m[4] || "");
        if (c) out.push(c);
      }
      return out;
    };

    var images = [];
    var pushImage = function (o) {
      if (images.length >= MAX_IMAGES) { skipped.more++; return; }
      images.push(o);
    };

    // --- <img> (and its <picture>) ---------------------------------------------------
    Array.prototype.forEach.call(document.images, function (img) {
      var r = img.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { skipped.hidden++; return; }
      var nw = img.complete ? img.naturalWidth : 0, nh = img.complete ? img.naturalHeight : 0;
      if ((r.width < MIN_PX || r.height < MIN_PX) && (nw < MIN_PX * 2 || nh < MIN_PX * 2)) { skipped.small++; return; }
      var cands = [];
      var pic = img.parentElement && img.parentElement.localName === "picture" ? img.parentElement : null;
      if (pic) Array.prototype.forEach.call(pic.querySelectorAll(":scope > source"), function (s) {
        cands = cands.concat(fromSrcset(s.getAttribute("srcset"), s));
        var one = s.getAttribute("src") && candidate(s.getAttribute("src"), "", s);
        if (one) cands.push(one);
      });
      cands = cands.concat(fromSrcset(img.getAttribute("srcset"), null));
      var src = img.getAttribute("src") && candidate(img.getAttribute("src"), "", null);
      if (src) cands.push(src);
      var o = common(img, r);
      o.kind = "img";
      var alt = img.getAttribute("alt");
      if (alt != null) o.alt = collapse(alt);
      var nm = nameOf(img); if (nm) o.name = nm;
      o.candidates = cands;
      if (img.currentSrc) o.current = img.currentSrc;
      if (nw && nh) o.natural = [nw, nh];
      pushImage(o);
    });

    // --- inline svg, video, canvas, iframes ------------------------------------------------
    Array.prototype.forEach.call(document.querySelectorAll("svg"), function (svg) {
      if (svg.parentElement && svg.parentElement.closest("svg")) return;
      var r = svg.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { skipped.hidden++; return; }
      if (r.width * r.height < MIN_SVG) { skipped.icons++; return; }
      var o = common(svg, r);
      o.kind = "svg";
      var t = svg.querySelector(":scope > title");
      var nm = nameOf(svg) || (t && collapse(t.textContent)) || undefined;
      if (nm) o.name = nm;
      o.candidates = [];
      var w = R(r.width), h = R(r.height), src = svg.outerHTML;
      if (src.length <= 400000)
        o.markup = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + w + '" height="' + h +
          '" viewBox="0 0 ' + w + " " + h + '" style="color:' + cs(svg).color + '">' +
          src.replace(/^<svg(?![^>]*\sxmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"') + "</svg>";
      pushImage(o);
    });
    Array.prototype.forEach.call(document.querySelectorAll("video"), function (v) {
      var r = v.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { skipped.hidden++; return; }
      var o = common(v, r);
      o.kind = "video";
      var nm = nameOf(v); if (nm) o.name = nm;
      var cands = [];
      var one = v.getAttribute("src") && candidate(v.getAttribute("src"), "", null);
      if (one) cands.push(one);
      Array.prototype.forEach.call(v.querySelectorAll("source"), function (s) {
        var c = s.getAttribute("src") && candidate(s.getAttribute("src"), "", s);
        if (c) cands.push(c);
      });
      o.candidates = cands;
      if (v.currentSrc) o.current = v.currentSrc;
      if (v.videoWidth && v.videoHeight) o.natural = [v.videoWidth, v.videoHeight];
      var p = absUrl(v.getAttribute("poster")); if (p) o.poster = p;
      pushImage(o);
    });
    Array.prototype.forEach.call(document.querySelectorAll("canvas"), function (c) {
      var r = c.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { skipped.hidden++; return; }
      if (r.width < MIN_PX * 2 || r.height < MIN_PX * 2) { skipped.small++; return; }
      var o = common(c, r);
      o.kind = "canvas";
      var nm = nameOf(c); if (nm) o.name = nm;
      o.candidates = [];
      pushImage(o);
    });
    skipped.frames = document.querySelectorAll("iframe, frame").length;

    // --- one pass over the elements: background images and the copy -----------------
    var all = body.querySelectorAll("*");
    var SKIP = { script: 1, style: 1, noscript: 1, template: 1, head: 1, link: 1, meta: 1, title: 1, svg: 1, math: 1, iframe: 1, canvas: 1, video: 1, img: 1, picture: 1, source: 1, select: 1, option: 1, textarea: 1, input: 1 };
    var ownText = function (el) { var s = ""; for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3) s += n.data; } return collapse(s); };
    // the body size: the median font over the page's text, weighted by characters
    var sizes = [];
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (SKIP[e.localName] || e.closest("svg")) continue;
      var t = ownText(e);
      if (!t) continue;
      var rr = e.getBoundingClientRect();
      if (rr.width < 1 || rr.height < 1) continue;
      sizes.push([parseFloat(cs(e).fontSize) || 16, t.length]);
    }
    sizes.sort(function (a, b) { return a[0] - b[0]; });
    var total = sizes.reduce(function (s, x) { return s + x[1]; }, 0), acc = 0, median = 16;
    for (var k = 0; k < sizes.length; k++) { acc += sizes[k][1]; if (acc >= total / 2) { median = sizes[k][0]; break; } }

    var COPY = { p: 1, blockquote: 1, figcaption: 1, li: 1, dt: 1, dd: 1, caption: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
    var INTERACTIVE = "a[href],button,select,textarea,input,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=switch],[role=checkbox]";
    var copy = [], taken = new Set();
    var underTaken = function (el) { for (var n = el.parentElement; n; n = n.parentElement) if (taken.has(n)) return true; return false; };
    var linkText = function (el) {
      var s = "";
      Array.prototype.forEach.call(el.querySelectorAll(INTERACTIVE), function (a) { s += " " + (a.innerText || ""); });
      return collapse(s);
    };
    for (var j = 0; j < all.length; j++) {
      var el = all[j], tag = el.localName;
      if (SKIP[tag] || el.closest("svg")) continue;
      // background images
      var bg = cs(el).backgroundImage;
      if (bg && bg !== "none" && bg.indexOf("url(") >= 0) {
        var cands = cssUrls(bg);
        if (cands.length) {
          var br = el.getBoundingClientRect();
          if (br.width < 1 || br.height < 1) skipped.hidden++;
          else if (br.width < MIN_PX * 2 || br.height < MIN_PX * 2) skipped.small++;
          else {
            var bo = common(el, br);
            bo.kind = "background";
            var bn = nameOf(el); if (bn) bo.name = bn;
            bo.candidates = cands;
            pushImage(bo);
          }
        }
      }
      // copy
      var role = el.getAttribute("role");
      var heading = /^h[1-6]$/.test(tag) || role === "heading";
      var own = ownText(el);
      var fs = parseFloat(cs(el).fontSize) || 16;
      var block = COPY[tag] || heading;
      var large = own.length >= 2 && fs >= 1.25 * median;
      var prose = own.length >= 24 && !el.querySelector("p,div,li,section,article,h1,h2,h3,h4,h5,h6");
      if (!block && !large && !prose) continue;
      if (!heading && el.closest(INTERACTIVE)) continue;
      if (underTaken(el)) continue;
      var tr = el.getBoundingClientRect();
      if (tr.width < 1 || tr.height < 1) { skipped.hidden++; continue; }
      if (el.closest("[aria-hidden=true]")) { skipped.ariaHidden++; continue; }
      var text = collapse(el.innerText || el.textContent);
      if (!text) continue;
      if (!heading) {
        var lt = linkText(el);
        if (lt && lt.length >= text.length * 0.9) continue;
      }
      if (copy.length >= MAX_COPY) { skipped.more++; continue; }
      taken.add(el);
      var co = common(el, tr);
      co.tag = tag;
      if (heading) {
        var lv = /^h([1-6])$/.exec(tag) ? +tag[1] : +(el.getAttribute("aria-level") || 2);
        co.level = lv;
      }
      co.text = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX - 1) + "…" : text;
      if (text.length > TEXT_MAX) co.chars = text.length;
      co.fontPx = R(fs * 10) / 10;
      co.weight = parseInt(cs(el).fontWeight, 10) || 400;
      copy.push(co);
    }

    // --- the other pages it links to ---------------------------------------------------
    var site = function (h) { return h.split(".").slice(-2).join("."); };
    var here = location.href.split("#")[0], ownSite = site(location.hostname);
    var links = [], seenHref = new Set();
    Array.prototype.forEach.call(body.querySelectorAll("a[href]"), function (a) {
      if (links.length >= MAX_LINKS) return;
      var href = absUrl(a.getAttribute("href"));
      if (!href || !/^https?:/i.test(href)) return;
      var bare = href.split("#")[0];
      if (bare === here || seenHref.has(bare)) return;
      var lr = a.getBoundingClientRect();
      if (lr.width < 1 || lr.height < 1) return;
      var text = collapse(a.innerText || "") || nameOf(a) || "";
      if (!text) { var im = a.querySelector("img[alt]"); if (im) text = collapse(im.getAttribute("alt")); }
      if (!text) return;
      seenHref.add(bare);
      var lo = { text: text.length > 80 ? text.slice(0, 79) + "…" : text, href: href, own: site(new URL(href).hostname) === ownSite,
        firstScreen: (fixedOf(a) ? lr.top : lr.top + sy) < vh, box: pageBox(lr, fixedOf(a)) };
      var lm = landmarkOf(a); if (lm) lo.in = lm;
      links.push(lo);
    });
    links.sort(function (a, b) { return a.box[1] - b.box[1] || a.box[0] - b.box[0]; });
    links.forEach(function (l) { delete l.box; });

    // --- the head: what the page says about itself ----------------------------------
    var metaOf = function (sel) { var m = document.querySelector(sel); return m ? collapse(m.getAttribute("content")) : ""; };
    var meta = {};
    var d = metaOf('meta[name="description"]') || metaOf('meta[property="og:description"]'); if (d) meta.description = d;
    var og = absUrl(metaOf('meta[property="og:image"]') || metaOf('meta[name="twitter:image"]')); if (og) meta.ogImage = og;
    var ot = metaOf('meta[property="og:title"]'); if (ot) meta.ogTitle = ot;
    var tc = metaOf('meta[name="theme-color"]'); if (tc) meta.themeColor = tc;
    var ic = document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"]');
    var icu = ic && absUrl(ic.getAttribute("href")); if (icu) meta.icon = icu;

    var order = function (a, b) { return a.box[1] - b.box[1] || a.box[0] - b.box[0]; };
    images.sort(order);
    copy.sort(order);
    return JSON.stringify({
      url: location.href, title: document.title,
      viewport: { w: vw, h: vh }, page: { w: pageW, h: pageH },
      medianTextPx: median, meta: meta, images: images, copy: copy, links: links, skipped: skipped,
      ms: R(performance.now() - t0)
    });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.stack || e) });
  }
}`;

/** The expression to evaluate (returnByValue): a JSON string. */
export const materialsProbeExpression = (): string => `(${MATERIALS_PROBE_JS})()`;

// --- the Node side ---------------------------------------------------------------

/** Formats a browser draws everywhere, preferred over a newer one of the
 *  same size (a saved .avif is a file fewer tools open) */
const PLAIN_TYPE = /^image\/(jpeg|jpg|png|webp|gif|svg\+xml)$/i;

/**
 * The largest source among what the page offers for one image: the widest
 * `w` descriptor when there is one, else the highest density (a plain src
 * is 1x). A data: URL counts only when nothing else is offered (a blurred
 * placeholder in src, the picture in srcset). Ties go to a plain format,
 * then to the first offered. Null when nothing can be fetched.
 */
export function largestSource(
  cands: readonly MaterialCandidate[],
): { url: string; w?: number } | null {
  const real = cands.filter((c) => !/^(data|blob):/i.test(c.url));
  const pool = real.length ? real : cands.filter((c) => /^data:/i.test(c.url));
  if (!pool.length) return null;
  const widths = pool.filter((c) => c.w != null);
  const by = widths.length ? widths : pool;
  const size = (c: MaterialCandidate) => (widths.length ? c.w! : (c.x ?? 1));
  const plain = (c: MaterialCandidate) => (!c.type || PLAIN_TYPE.test(c.type) ? 1 : 0);
  let best = by[0]!;
  for (const c of by.slice(1))
    if (size(c) > size(best) || (size(c) === size(best) && plain(c) > plain(best))) best = c;
  return { url: best.url, ...(best.w != null ? { w: best.w } : {}) };
}

/** Hosts that serve ads and tracking, not a product's own pictures: listed,
 *  never saved. */
const AD_HOST =
  /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|google-analytics\.com|googletagmanager\.com|facebook\.net|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|amazon-adsystem\.com|scorecardresearch\.com|quantserve\.com|bat\.bing\.com|ads\.linkedin\.com|ads-twitter\.com|analytics\.twitter\.com|adsrvr\.org|rubiconproject\.com|pubmatic\.com|moatads\.com|hotjar\.com)$/i;

/** An ad or tracking host (the image is listed, never saved). */
export function adHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      AD_HOST.test(u.hostname) ||
      (/(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname.startsWith("/tr"))
    );
  } catch {
    return false;
  }
}

/** The pixel size an image file states in its header (PNG, GIF, JPEG, WebP,
 *  SVG's width/height or viewBox); null for a format it does not read. */
export function imageFileSize(buf: Buffer): [number, number] | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47)
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF")
    return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const m = buf[i + 1]!;
      // SOFn (not DHT c4, JPG c8, DAC cc) carries the frame size
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (
    buf.length >= 30 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
    if (chunk === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)];
    }
    return null;
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 4096));
  const svg = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (svg) {
    const num = (name: string) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(svg);
      return m ? Number(m[1]) : null;
    };
    const w = num("width");
    const h = num("height");
    if (w && h) return [Math.round(w), Math.round(h)];
    const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
    if (vb) return [Math.round(Number(vb[1])), Math.round(Number(vb[2]))];
  }
  return null;
}

/** What the probe found, as the file lists it: each image's largest source
 *  chosen, the source list dropped (its count kept); what is to be saved is
 *  returned beside it, by index. */
export function materialsFromProbe(
  res: Exclude<MaterialsProbeResult, { error: string }>,
  o: { state: string; read: MaterialsFile["read"] },
): {
  file: MaterialsFile;
  /** per image (same index): a URL to fetch, an svg's markup, or a data: URL to decode */
  save: ({ url: string } | { markup: string } | { data: string } | null)[];
} {
  const save: ({ url: string } | { markup: string } | { data: string } | null)[] = [];
  const images: MaterialImage[] = res.images.map((im) => {
    const { candidates, current, markup, ...rest } = im;
    const best = largestSource(candidates);
    const out: MaterialImage = { ...rest };
    if (best) {
      if (/^data:/i.test(best.url)) {
        // the file holds it; the list names only its type
        out.src = /^data:[^;,]*/i.exec(best.url)![0];
        save.push({ data: best.url });
      } else {
        out.src = best.url;
        // a video is not fetched: its poster frame is
        save.push(
          im.kind === "video" ? (out.poster ? { url: out.poster } : null) : { url: best.url },
        );
      }
      if (best.w != null) out.srcW = best.w;
      if (candidates.length > 1) out.sources = candidates.length;
      if (current && current !== best.url && !/^data:/i.test(current)) out.shown = current;
    } else save.push(markup ? { markup } : out.poster ? { url: out.poster } : null);
    // a blob: or the like that names nothing to fetch
    if (!best && current && !/^(data|blob):/i.test(current)) out.shown = current;
    return out;
  });
  const file: MaterialsFile = {
    version: 1,
    state: o.state,
    read: o.read,
    url: res.url,
    title: res.title,
    viewport: res.viewport,
    page: res.page,
    medianTextPx: res.medianTextPx,
    meta: res.meta,
    images,
    copy: res.copy,
    ...(res.links ? { links: res.links } : {}),
    skipped: res.skipped,
    scope: materialsScope(o.read),
    ms: { read: res.ms },
  };
  return { file, save };
}

export function materialsScope(read: MaterialsFile["read"]): string {
  return (
    `the whole page, top to bottom, ${read === "live" ? "read in the product's page as it was shot" : "read in its saved screen (state.html: sources are the saved files)"}: ` +
    `<img>/<picture> (largest source), inline <svg> of ${MATERIAL_MIN_SVG_AREA} px² or more, CSS background images, <video>, <canvas>; ` +
    `headings, paragraphs, list items, quotes, captions, and text set ≥ 1.25× the body size; ` +
    `the other pages it links to (one per address, its own site or not); ` +
    `not read: iframes, shadow roots, ::before/::after, text inside links and buttons (headings aside), aria-hidden copies. ` +
    `Nothing is ranked: every list is in page order`
  );
}

/** One page's materials.json, where a source's saved screens hold one. */
export type MaterialsPage = { id: string; dir: string; file: MaterialsFile; path: string };

/** The materials.json files of a source's saved screens (one per page the
 *  shoot visited — the first screen kept on each), in shooting order, and
 *  the screens of pages none of them covers (to read from their state.html). */
export function readMaterials(source: ComponentSource): {
  pages: MaterialsPage[];
  /** one screen per page URL that has no materials.json */
  missing: { id: string; dir: string; url: string }[];
} {
  const pages: MaterialsPage[] = [];
  const missing: { id: string; dir: string; url: string }[] = [];
  const covered = new Set<string>();
  const urlOf = (dir: string): string => {
    try {
      const ix = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { url?: string };
      return pageKey(ix.url ?? "");
    } catch {
      return "";
    }
  };
  for (const s of source.states) {
    const path = join(s.dir, "materials.json");
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as MaterialsFile;
      if (file.version !== 1 || !Array.isArray(file.images) || !Array.isArray(file.copy)) continue;
      pages.push({ id: s.id, dir: s.dir, file, path });
      covered.add(pageKey(file.url));
    } catch {
      /* unreadable: read again below */
    }
  }
  for (const s of source.states) {
    const url = urlOf(s.dir);
    if (covered.has(url)) continue;
    covered.add(url);
    missing.push({ id: s.id, dir: s.dir, url });
  }
  return { pages, missing };
}

/** A page's identity: its URL without the fragment. */
export const pageKey = (url: string): string => url.replace(/#.*$/, "");

// --- printing ----------------------------------------------------------------------

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s: string) => JSON.stringify(s);
const screens = (f: MaterialsFile) => Math.round((f.page.h / Math.max(1, f.viewport.h)) * 10) / 10;

const sizeText = (im: MaterialImage): string => {
  const px = im.fileSize ?? im.natural;
  const drawn = `${im.box[2]}×${im.box[3]}`;
  if (px)
    return `${px[0]}×${px[1]}${px[0] !== im.box[2] || px[1] !== im.box[3] ? ` (drawn ${drawn})` : ""}`;
  if (im.srcW) return `${im.srcW}w (drawn ${drawn})`;
  return `drawn ${drawn}`;
};

const wordOf = (im: MaterialImage): string =>
  im.alt
    ? q(cut(im.alt, 60))
    : im.alt === ""
      ? "(alt empty)"
      : im.name
        ? q(cut(im.name, 60))
        : "(no alt)";

/** where it is: its saved copy, else its URL */
const whereOf = (im: MaterialImage, dir: string, show: (abs: string) => string): string =>
  im.file
    ? show(join(dir, im.file))
    : im.src && !/^data:/.test(im.src)
      ? cut(im.src, 90)
      : (im.notSaved ?? "");

/** a copy line's note on how it stands on the page */
const standing = (x: { fixed?: true; in?: string; hidden?: string }): string =>
  [x.in ? `in ${x.in}` : "", x.fixed ? "fixed" : "", x.hidden ?? ""].filter(Boolean).join(", ");

export function imageLine(im: MaterialImage, dir: string, show: (abs: string) => string): string {
  const s = standing(im);
  return `y ${String(im.box[1]).padStart(5)}  ${im.kind.padEnd(10)} ${sizeText(im)}  ${wordOf(im)}  ${whereOf(im, dir, show)}${s ? `  (${s})` : ""}`;
}

export function copyLine(t: MaterialText, max = 120): string {
  const s = standing(t);
  return `y ${String(t.box[1]).padStart(5)}  ${t.tag.padEnd(10)} ${t.fontPx}px ${q(cut(t.text, max))}${t.chars ? ` (${t.chars} chars)` : ""}${s ? `  (${s})` : ""}`;
}

/** headings and type set larger than the body: what the summary shows of the copy */
const display = (t: MaterialText, f: MaterialsFile) =>
  t.level != null || t.fontPx >= 1.25 * f.medianTextPx;

/**
 * The few lines a shoot and `film init --url` print: per page its size and
 * counts, then — for the first page — its first images in the first screen
 * and below it, and its first headings / large type below the first screen,
 * each in page order, and where the whole list and the sheet are. Counts
 * and positions only; nothing is ranked or recommended.
 */
export function materialsSummary(
  pages: readonly MaterialsPage[],
  o: { show: (abs: string) => string; cmd: string },
): string[] {
  if (!pages.length) return [];
  const lines: string[] = [];
  const [first, ...rest] = pages;
  const head = (p: MaterialsPage) => {
    const f = p.file;
    const below = f.images.filter((i) => !i.firstScreen).length;
    const belowT = f.copy.filter((t) => !t.firstScreen).length;
    const saved = f.images.filter((i) => i.file).length;
    return (
      `${p.id} (${cut(f.url, 60)}) — ${f.page.h} px tall, ${screens(f)} screens: ` +
      `${f.images.length} image${f.images.length === 1 ? "" : "s"} (${below} below the first screen, ${saved} saved), ` +
      `${f.copy.length} text${f.copy.length === 1 ? "" : "s"} (${belowT} below)`
    );
  };
  lines.push(`material, whole page: ${head(first!)}`);
  const f = first!.file;
  const top = f.images.filter((i) => i.firstScreen).slice(0, 2);
  const low = f.images.filter((i) => !i.firstScreen).slice(0, 5 - top.length);
  for (const im of [...top, ...low]) lines.push(`  ${imageLine(im, first!.dir, o.show)}`);
  const texts = f.copy.filter((t) => !t.firstScreen && display(t, f)).slice(0, 3);
  for (const t of texts) lines.push(`  ${copyLine(t, 70)}`);
  const links = linksLine(f);
  if (links) lines.push(`  ${links}`);
  for (const p of rest.slice(0, 2)) lines.push(`  + ${head(p)}`);
  if (rest.length > 2)
    lines.push(`  + ${rest.length - 2} more page${rest.length - 2 === 1 ? "" : "s"}`);
  const sheet = f.sheet
    ? `; the page as one picture: ${o.show(join(first!.dir, f.sheet.file))}`
    : "";
  lines.push(
    `  all of it in page order: ${o.cmd} (${o.show(first!.path)}${pages.length > 1 ? ", one per page" : ""})${sheet}`,
  );
  return lines;
}

/** The pages a film can read the product from, as the page's links name
 *  them: its navigation, header and footer first, its own site before
 *  others, a few words each. Null when it links nowhere. */
export function linksLine(f: MaterialsFile, max = 10): string | null {
  const all = f.links ?? [];
  if (!all.length) return null;
  const rank = (l: MaterialLink) =>
    (l.in === "nav" || l.in === "header" ? 0 : l.in === "footer" ? 1 : 2) + (l.own ? 0 : 0.5);
  const seen = new Set<string>();
  const distinct = [...all]
    .sort((a, b) => rank(a) - rank(b))
    .filter((l) => {
      const k = l.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const shown = distinct.slice(0, max).map((l) => `${cut(l.text, 28)}${l.own ? "" : " ↗"}`);
  return `links (${all.length}, pages a film can read the product from): ${shown.join(" · ")}${distinct.length > shown.length ? " · …" : ""} — each with its address in materials.json (links[])`;
}

/** The whole list, as `open-take materials` prints it: per page, images
 *  and copy interleaved in page order. */
export function formatMaterials(
  pages: readonly MaterialsPage[],
  o: { show: (abs: string) => string },
): string {
  const out: string[] = [];
  for (const p of pages) {
    const f = p.file;
    out.push(
      `${p.id}: ${f.url} — ${f.title ? `${q(f.title)}, ` : ""}page ${f.page.w}×${f.page.h} (${screens(f)} screens of ${f.viewport.w}×${f.viewport.h}); read ${f.read === "live" ? "live" : "from the saved screen"}`,
    );
    out.push(`  list: ${o.show(p.path)}`);
    if (f.sheet)
      out.push(
        `  sheet: ${o.show(join(p.dir, f.sheet.file))} — ${f.sheet.columns} column${f.sheet.columns === 1 ? "" : "s"} of ${f.sheet.columnPx} page px, ${f.sheet.coveredPx < f.page.h ? `the first ${f.sheet.coveredPx} px` : "the whole page"}`,
      );
    const m = f.meta;
    if (m.description) out.push(`  description: ${q(m.description)}`);
    if (m.ogTitle) out.push(`  og:title: ${q(m.ogTitle)}`);
    if (m.ogImage)
      out.push(`  og:image: ${m.ogImageFile ? o.show(join(p.dir, m.ogImageFile)) : m.ogImage}`);
    const items: { y: number; x: number; line: string }[] = [
      ...f.images.map((im) => ({ y: im.box[1], x: im.box[0], line: imageLine(im, p.dir, o.show) })),
      ...f.copy.map((t) => ({ y: t.box[1], x: t.box[0], line: copyLine(t) })),
    ].sort((a, b) => a.y - b.y || a.x - b.x);
    let fold = false;
    for (const it of items) {
      if (!fold && it.y >= f.viewport.h) {
        out.push(`  ── the first screen ends (y ${f.viewport.h}) ──`);
        fold = true;
      }
      out.push(`  ${it.line}`);
    }
    if (f.links?.length) {
      out.push(`  links, in page order (${f.links.length}):`);
      for (const l of f.links)
        out.push(
          `    ${q(cut(l.text, 60))} → ${l.href}${l.own ? "" : " (another site)"}${l.in ? ` [${l.in}]` : ""}`,
        );
    }
    const sk = f.skipped;
    const counted = (
      [
        [sk.hidden, "drawn at no size"],
        [sk.small, `smaller than ${MATERIAL_MIN_IMAGE_PX} px`],
        [sk.icons, "svg icons"],
        [sk.ariaHidden, "aria-hidden copies"],
        [sk.frames, "iframes (not read)"],
        [sk.more, "past the list's length"],
      ] as const
    )
      .filter(([n]) => n > 0)
      .map(([n, w]) => `${n} ${w}`);
    if (counted.length) out.push(`  not listed: ${counted.join(", ")}`);
    out.push(`  read: ${f.scope}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}
