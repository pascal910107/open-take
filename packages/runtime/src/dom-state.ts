// DOM states — the page's UI STRUCTURE, saved at every settled moment of a
// take so a launch film can later re-render the product's real interface as
// live, vector-crisp DOM (lift the clicked button out of the page, split the
// page into its regions, zoom without blur) instead of scaling video pixels.
//
// Opt-in (`CaptureOpts.states`). Three moving parts, all in this module:
//
//   1. DURING the recording (`captureDomState`) — strictly READ-ONLY on the
//      live page: a page-side probe (`DOM_STATE_PROBE_JS`) reads structure,
//      live input values, scroll offsets, canvas/video pixels and the current
//      value of every animated property; a 1× screenshot is the fidelity
//      reference; `Page.captureSnapshot` (MHTML) carries the markup, styles,
//      images and fonts. Raw files land in `states/<id>/`.
//   2. AFTER the screencast (`finalizeDomStates`) — the MHTML becomes a
//      self-contained `state.html` (`convertMhtml`): parts are written once
//      into a shared `states/assets/` (sha1-named), references are rewritten,
//      every script is made inert IN PLACE (element indices survive), and a
//      restore script re-applies what markup cannot carry. Then a FIDELITY
//      check re-opens the state in the same browser and compares it with the
//      reference screenshot; a state that does not match stays on disk with
//      `fidelity.ok: false` so the film falls back to the video.
//   3. `index.json` per state is the contract the film side reads
//      (the compositor's `StateIndex` — exactly these keys).
//
// Element PATHS. Chrome's MHTML serializer (measured on 149) drops `<script>`,
// `<noscript>`, `[hidden]` and `<input type=hidden>` outright, so a path is
// the chain of child indices counted over the siblings that SURVIVE
// serialization — the probe skips the same elements the serializer skips,
// and the restore script resolves the same path in the saved document. The
// serializer also emits shadow roots as legacy `<template shadowmode>`
// (rewritten to `shadowrootmode` so the parser attaches them, which keeps a
// host's light children at their indices) and prepends its own `<meta>` +
// custom-elements shim `<script>` to `<head>` — nothing visible lives in
// `<head>`, so no path points there.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CaptureLog,
  CLIP_CLEAR_CSS,
  type ComponentProbeResult,
  componentProbeExpression,
  type PartsFile,
  pictureClip,
  readStateIndex,
  resolveFfmpeg,
  type StateElement,
  type StateIndex,
} from "@open-take/compositor";
import { type Browser, CDP, isCdpStall } from "./cdp";
import { runBuffer } from "./tool";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the contract ---------------------------------------------------------

type StateFidelity = NonNullable<StateIndex["fidelity"]>;

/** What the page-side probe returns (JSON). Everything the markup cannot
 *  carry: live `.value`s, scroll offsets, canvas/video pixels, the computed
 *  value of every animated property, and the custom-element names to define
 *  so `:defined` styling holds. */
export type DomStateProbe = {
  url: string;
  title: string;
  viewport: { w: number; h: number; dpr: number };
  scroll: { x: number; y: number };
  elements: StateElement[];
  layers: string[];
  scrolled: { path: number[]; top: number; left: number }[];
  /** `selected`: a <select>'s chosen options, by index (one, or several when multiple) */
  inputs: { path: number[]; value?: string; checked?: boolean; selected?: number[] }[];
  /** `box`: where it is on screen (CSS px); `blank`: its copy came out one colour */
  canvases: {
    path: number[];
    dataUrl: string;
    box?: [number, number, number, number];
    blank?: boolean;
  }[];
  videos: {
    path: number[];
    dataUrl: string;
    box?: [number, number, number, number];
    blank?: boolean;
  }[];
  animated: { path: number[]; styles: Record<string, string> }[];
  custom: { name: string; extends?: string }[];
  /** the focused element (a typed-into field keeps its focus ring), if any */
  focus?: number[];
};

/** Hard cap on the element index — a page past it is a data table, not a UI. */
const DOM_STATE_MAX_ELEMENTS = 3000;
/** A state whose re-render reaches this PSNR against the live screenshot is
 *  trusted; below it the film uses the video. */
const DOM_STATE_PSNR_OK = 30;

// --- the page-side probe ----------------------------------------------------

/** Runs in the live page (Runtime.evaluate, returnByValue) and returns the
 *  probe as a JSON string. Reads only: no attribute, style or node is touched
 *  — the app is being filmed and must behave exactly as without states. */
const DOM_STATE_PROBE_JS = `(() => {
  try {
    const vw = innerWidth, vh = innerHeight, dpr = devicePixelRatio || 1;
    const CAP = ${DOM_STATE_MAX_ELEMENTS};
    // never listed (invisible by nature) — but they DO count as siblings when they survive serialization
    const SKIP = { script: 1, style: 1, link: 1, meta: 1, noscript: 1, head: 1, title: 1, template: 1 };
    // what Chrome's MHTML serializer drops: these never count as siblings (see the module header)
    const survives = (el) => {
      const t = el.localName;
      if (t === "script" || t === "noscript") return false;
      if (el.hasAttribute("hidden")) return false;
      if (t === "input" && (el.getAttribute("type") || "").toLowerCase() === "hidden") return false;
      return true;
    };
    // containers never take their name from content (a page-sized div would name itself after the page)
    const CONTAINER = { div: 1, section: 1, article: 1, main: 1, nav: 1, header: 1, footer: 1, aside: 1, form: 1, ul: 1, ol: 1, table: 1, tbody: 1, thead: 1, tfoot: 1, tr: 1, fieldset: 1, dialog: 1, body: 1, html: 1, figure: 1, details: 1, menu: 1, dl: 1 };
    const HEADING = { h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
    const INTERACTIVE_ROLE = { button: 1, link: 1, tab: 1, menuitem: 1, checkbox: 1, switch: 1, radio: 1, option: 1, combobox: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1, menuitemcheckbox: 1, menuitemradio: 1 };
    const collapse = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    const ownText = (el) => { let s = ""; for (const n of el.childNodes) if (n.nodeType === 3) s += n.data; return collapse(s); };
    const implicitRole = (el) => {
      const t = el.localName;
      switch (t) {
        case "a": case "area": return el.hasAttribute("href") ? "link" : null;
        case "button": case "summary": return "button";
        case "input": {
          const ty = (el.getAttribute("type") || "text").toLowerCase();
          if (ty === "checkbox") return "checkbox";
          if (ty === "radio") return "radio";
          if (ty === "range") return "slider";
          if (ty === "number") return "spinbutton";
          if (ty === "search") return "searchbox";
          if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return "button";
          return "textbox";
        }
        case "select": return el.multiple || el.size > 1 ? "listbox" : "combobox";
        case "textarea": return "textbox";
        case "img": case "svg": return "img";
        case "ul": case "ol": case "menu": return "list";
        case "li": return "listitem";
        case "nav": return "navigation";
        case "main": return "main";
        case "header": return "banner";
        case "footer": return "contentinfo";
        case "aside": return "complementary";
        case "form": return "form";
        case "table": return "table";
        case "tr": return "row";
        case "td": return "cell";
        case "th": return "columnheader";
        case "dialog": return "dialog";
        case "option": return "option";
        case "progress": return "progressbar";
        case "hr": return "separator";
        case "article": return "article";
        case "fieldset": case "details": return "group";
        case "output": return "status";
        case "section": return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
        default: return HEADING[t] ? "heading" : null;
      }
    };
    const isInteractive = (el, role) => {
      const t = el.localName;
      if (t === "a" || t === "button" || t === "input" || t === "select" || t === "textarea" || t === "summary") return true;
      if (role && INTERACTIVE_ROLE[role]) return true;
      const ce = el.getAttribute("contenteditable");
      if (ce != null && ce !== "false") return true;
      const ti = el.getAttribute("tabindex");
      if (ti != null && Number(ti) >= 0) return true;
      return false;
    };
    const nameOf = (el, interactive) => {
      const al = el.getAttribute("aria-label"); if (al && al.trim()) return collapse(al);
      const lb = el.getAttribute("aria-labelledby");
      if (lb) { let s = ""; for (const id of lb.split(/\\s+/)) { const r = document.getElementById(id); if (r) s += " " + r.textContent; } if (s.trim()) return collapse(s); }
      const alt = el.getAttribute("alt"); if (alt && alt.trim()) return collapse(alt);
      const ti = el.getAttribute("title"); if (ti && ti.trim()) return collapse(ti);
      const ph = el.getAttribute("placeholder"); if (ph && ph.trim()) return collapse(ph);
      if (el.labels && el.labels.length) { const s = collapse(el.labels[0].textContent); if (s) return s; }
      if (el.localName === "input") {
        const ty = (el.getAttribute("type") || "").toLowerCase();
        if (ty === "submit" || ty === "button" || ty === "reset") { const v = el.getAttribute("value"); if (v) return collapse(v); }
      }
      if (el.localName === "select") { const o = el.selectedOptions && el.selectedOptions[0]; return o ? collapse(o.textContent) : ""; }
      if (interactive || !CONTAINER[el.localName]) { const s = collapse(el.textContent); if (s) return s; }
      return "";
    };
    const elements = [], scrolled = [], inputs = [], canvases = [], videos = [];
    // a copy that came out empty (a WebGL canvas that does not keep its
    // drawing buffer reads back transparent): one colour over 16×16 samples
    const blankImage = (img) => {
      try {
        const c = document.createElement("canvas"); c.width = 16; c.height = 16;
        const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        for (let i = 4; i < d.length; i += 4)
          if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return false;
        return true;
      } catch (e) { return false; }
    };
    const custom = new Map();
    const idOf = new Map();
    let count = 0;
    const visit = (el, path) => {
      const t = el.localName;
      if (t === "head") return; // nothing visible lives there
      if (t.indexOf("-") > 0 && customElements.get(t)) custom.set(t, "");
      const isAttr = el.getAttribute("is");
      if (isAttr && customElements.get(isAttr)) custom.set(isAttr, t);
      if (!SKIP[t]) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") return; // no boxes below either
        if (parseFloat(cs.opacity) === 0) return; // subtree invisible
        const r = el.getBoundingClientRect();
        // checkVisibility: content skipped by content-visibility (a closed
        // <details>' rows keep boxes but are not drawn) is not on screen
        const drawn = typeof el.checkVisibility !== "function" || el.checkVisibility();
        const onScreen = drawn && cs.visibility === "visible" && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
        if (count < CAP && onScreen) {
          const role = (el.getAttribute("role") || "").trim().split(/\\s+/)[0] || implicitRole(el);
          const interactive = isInteractive(el, role);
          const id = "e" + count++;
          const item = { id, path, tag: t };
          if (role) item.role = role;
          const name = nameOf(el, interactive); if (name) item.name = name;
          const text = ownText(el); if (text) item.text = text;
          item.box = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          if (cs.position === "fixed" || cs.position === "sticky") item.fixed = true;
          if (interactive) item.interactive = true;
          elements.push(item);
          idOf.set(el, id);
        }
        if ((el.scrollTop || el.scrollLeft) && el !== document.scrollingElement && el !== document.body)
          scrolled.push({ path, top: el.scrollTop, left: el.scrollLeft });
        if (t === "input") {
          const ty = (el.getAttribute("type") || "text").toLowerCase();
          if (ty === "checkbox" || ty === "radio") inputs.push({ path, checked: !!el.checked });
          else if (ty !== "file") inputs.push({ path, value: ty === "password" ? "x".repeat(el.value.length) : el.value });
        } else if (t === "textarea") inputs.push({ path, value: el.value });
        else if (t === "select") {
          const selected = [];
          for (let i = 0; i < el.options.length; i++) if (el.options[i].selected) selected.push(i);
          inputs.push({ path, selected });
        }
        // pixels are copied only for what is on screen, at the size it is
        // shown (× the pixel ratio): encoding runs on the app's main thread,
        // and a hidden 4K <video> behind a canvas stage cost a 5.7 s freeze
        else if (t === "canvas") {
          if (onScreen && el.width > 0 && el.height > 0) {
            try {
              const w = Math.min(el.width, Math.ceil(r.width * dpr)), h = Math.min(el.height, Math.ceil(r.height * dpr));
              let src = el;
              if (w < el.width || h < el.height) { src = document.createElement("canvas"); src.width = w; src.height = h; src.getContext("2d").drawImage(el, 0, 0, w, h); }
              canvases.push({ path, dataUrl: src.toDataURL("image/png"), box: [r.left, r.top, r.width, r.height], blank: blankImage(src) });
            } catch (e) {}
          }
        } else if (t === "video") {
          try {
            if (onScreen && el.videoWidth > 0 && el.videoHeight > 0) {
              const c = document.createElement("canvas");
              c.width = Math.min(el.videoWidth, Math.ceil(r.width * dpr)); c.height = Math.min(el.videoHeight, Math.ceil(r.height * dpr));
              c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
              // a frame of video is opaque: JPEG encodes it an order of magnitude faster than PNG
              videos.push({ path, dataUrl: c.toDataURL("image/jpeg", 0.92), box: [r.left, r.top, r.width, r.height], blank: blankImage(c) });
            }
          } catch (e) {}
        }
      }
      if (t === "svg") return; // internals are never targets; keeps icon-heavy pages under the cap
      let i = 0;
      for (const c of el.children) { if (!survives(c)) continue; visit(c, path.concat(i)); i++; }
    };
    visit(document.documentElement, []);

    // layers: from <body> descend through single big-child wrappers; a container
    // covering > 50% of the viewport is split into its big in-view children;
    // fixed/sticky and higher z-index sort on top
    const areaOf = (el) => { const r = el.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
    const big = (el) => !SKIP[el.localName] && survives(el) && areaOf(el) >= 0.03 * vw * vh && getComputedStyle(el).display !== "none";
    const bigKids = (n) => Array.from(n.children).filter(big);
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0; };
    let node = document.body, guard = 0;
    while (node && bigKids(node).length === 1 && guard++ < 8) node = bigKids(node)[0];
    const split = (k, depth) => {
      const cs = getComputedStyle(k);
      if (depth > 4 || cs.position === "fixed" || cs.position === "sticky" || areaOf(k) <= 0.5 * vw * vh) return [k];
      const sub = bigKids(k).filter(inView);
      if (sub.length >= 2) return sub;
      if (sub.length === 1) return split(sub[0], depth + 1);
      return [k];
    };
    const score = (el) => { const cs = getComputedStyle(el); return (cs.position === "fixed" || cs.position === "sticky" ? 1000 : 0) + (Number(cs.zIndex) || 0); };
    const kids = node ? bigKids(node).flatMap((k) => split(k, 0)).filter(inView) : [];
    const layers = [];
    for (const { el } of kids.map((el, i) => ({ el, i, s: score(el) })).sort((a, b) => a.s - b.s || a.i - b.i)) {
      const id = idOf.get(el);
      if (id && layers.length < 8) layers.push(id);
    }

    // animated: the CURRENT computed value of every property an animation or
    // transition drives — the saved page runs no animations (animation: none),
    // so without this a finished "fadeIn forwards" would show its base style
    const pathOf = (el) => {
      const p = [];
      let n = el;
      while (n !== document.documentElement) {
        const par = n.parentElement;
        if (!par || !survives(n)) return null; // detached, hidden, or inside a shadow root
        let i = 0;
        for (const c of par.children) { if (c === n) break; if (survives(c)) i++; }
        p.push(i);
        n = par;
      }
      return p.reverse();
    };
    const animated = [];
    try {
      const byEl = new Map();
      for (const a of document.getAnimations()) {
        const ef = a.effect;
        if (!ef || typeof ef.getKeyframes !== "function") continue;
        const target = ef.target;
        if (!(target instanceof Element) || ef.pseudoElement) continue;
        let styles = byEl.get(target);
        if (!styles) { styles = {}; byEl.set(target, styles); }
        const cs = getComputedStyle(target);
        for (const kf of ef.getKeyframes()) for (const k in kf) {
          if (k === "offset" || k === "easing" || k === "composite" || k === "computedOffset") continue;
          const prop = k === "cssFloat" ? "float" : k === "cssOffset" ? "offset" : k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
          styles[prop] = cs.getPropertyValue(prop);
        }
      }
      for (const [el, styles] of byEl) {
        const path = pathOf(el);
        if (path && Object.keys(styles).length) animated.push({ path, styles });
      }
    } catch (e) {}

    const active = document.activeElement;
    const focus = active && active !== document.body && active !== document.documentElement ? pathOf(active) : null;
    return JSON.stringify({
      url: location.href,
      title: document.title,
      viewport: { w: vw, h: vh, dpr: devicePixelRatio },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      elements, layers, scrolled, inputs, canvases, videos, animated,
      custom: Array.from(custom, ([name, ext]) => (ext ? { name, extends: ext } : { name })),
      ...(focus ? { focus } : {}),
    });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message || e) });
  }
})()`;

// --- MHTML parsing ------------------------------------------------------------

type MhtmlPart = {
  /** media type, lowercased, parameters stripped ("text/html") */
  contentType: string;
  /** Content-Location as written (Chrome writes absolute URLs, or `cid:…`) */
  location?: string;
  /** Content-ID without its angle brackets */
  id?: string;
  /** the decoded bytes */
  body: Buffer;
};

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  // unfold continuation lines (a leading space/tab continues the previous header)
  const lines = text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  for (const line of lines) {
    const c = line.indexOf(":");
    if (c <= 0) continue;
    headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return headers;
}

/** quoted-printable → bytes (soft line breaks removed, `=XX` decoded) */
export function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x3d /* = */) {
      const a = text[i + 1];
      const b = text[i + 2];
      if (a === "\r" && b === "\n") {
        i += 2;
        continue;
      }
      if (a === "\n") {
        i += 1;
        continue;
      }
      if (a != null && b != null && /^[0-9A-Fa-f]{2}$/.test(a + b)) {
        out.push(parseInt(a + b, 16));
        i += 2;
        continue;
      }
    }
    out.push(ch & 0xff);
  }
  return Buffer.from(out);
}

/** Parse a multipart/related MHTML file (what `Page.captureSnapshot` returns). */
export function parseMhtml(raw: Buffer | string): MhtmlPart[] {
  // MHTML is 7-bit: a latin1 view keeps byte offsets and byte values intact
  const text = typeof raw === "string" ? raw : raw.toString("latin1");
  const headEnd = text.search(/\r?\n\r?\n/);
  if (headEnd < 0) throw new Error("mhtml: no header block");
  const headers = parseHeaders(text.slice(0, headEnd));
  const ct = headers["content-type"] ?? "";
  const bm = /boundary="([^"]+)"|boundary=([^;\s]+)/i.exec(ct);
  const boundary = bm?.[1] ?? bm?.[2];
  if (!boundary) throw new Error("mhtml: no multipart boundary");
  const parts: MhtmlPart[] = [];
  const delimiter = `--${boundary}`;
  // every part starts at a delimiter on its own line
  const chunks = text.split(
    new RegExp(`(?:^|\\r?\\n)${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith("--")) break; // the closing delimiter
    const body0 = chunk.search(/\r?\n\r?\n/);
    if (body0 < 0) continue;
    const h = parseHeaders(chunk.slice(0, body0));
    const bodyText = chunk.slice(body0).replace(/^\r?\n\r?\n/, "");
    const encoding = (h["content-transfer-encoding"] ?? "binary").toLowerCase();
    let body: Buffer;
    if (encoding === "quoted-printable") body = decodeQuotedPrintable(bodyText);
    else if (encoding === "base64") body = Buffer.from(bodyText.replace(/\s+/g, ""), "base64");
    else body = Buffer.from(bodyText, "latin1");
    const idRaw = h["content-id"];
    parts.push({
      contentType: (h["content-type"] ?? "application/octet-stream")
        .split(";")[0]!
        .trim()
        .toLowerCase(),
      ...(h["content-location"] ? { location: h["content-location"] } : {}),
      ...(idRaw ? { id: idRaw.replace(/^<|>$/g, "") } : {}),
      body,
    });
  }
  return parts;
}

// --- MHTML → state.html -----------------------------------------------------

const EXT_BY_TYPE: Record<string, string> = {
  "text/html": "html",
  "text/css": "css",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/bmp": "bmp",
  "font/woff2": "woff2",
  "application/font-woff2": "woff2",
  "font/woff": "woff",
  "application/font-woff": "woff",
  "font/ttf": "ttf",
  "application/x-font-ttf": "ttf",
  "font/otf": "otf",
  "application/x-font-opentype": "otf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
  "text/javascript": "js",
  "application/javascript": "js",
  "application/json": "json",
};

function extFor(part: MhtmlPart): string {
  const byType = EXT_BY_TYPE[part.contentType];
  if (byType) return byType;
  if (part.location && !part.location.startsWith("cid:")) {
    try {
      const e = extname(new URL(part.location).pathname).slice(1).toLowerCase();
      if (/^[a-z0-9]{1,5}$/.test(e)) return e;
    } catch {
      /* not a URL */
    }
  }
  return "bin";
}

const stripFragment = (u: string): string => u.replace(/#.*$/, "");

/** The freeze rule: the saved page runs no animation or transition (each
 *  animated property's live value is re-applied by the restore script) and
 *  shows no caret. Appended at the END of <head>. */
const DOM_STATE_FREEZE_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
const FREEZE_STYLE = `<style data-ot-freeze>${DOM_STATE_FREEZE_CSS}</style>`;
/** What every `<script>` becomes: same element, same index, no behaviour. */
export const INERT_SCRIPT = '<script type="application/x-open-take-inert"></script>';

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
const encodeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

type Attr = { name: string; lower: string; value: string | null; raw: string };

/** Parse the attributes of one start tag from `pos` (just after the tag
 *  name) to its `>`. Chrome's serializer emits well-formed, double-quoted
 *  markup; unquoted and single-quoted values are handled for safety. */
function parseTag(html: string, pos: number): { attrs: Attr[]; end: number; selfClosing: boolean } {
  const attrs: Attr[] = [];
  let i = pos;
  const n = html.length;
  let selfClosing = false;
  while (i < n) {
    while (i < n && /\s/.test(html[i]!)) i++;
    if (i >= n) break;
    const c = html[i]!;
    if (c === ">") return { attrs, end: i + 1, selfClosing };
    if (c === "/") {
      if (html[i + 1] === ">") {
        selfClosing = true;
        return { attrs, end: i + 2, selfClosing };
      }
      i++;
      continue;
    }
    const start = i;
    while (i < n && !/[\s=>/]/.test(html[i]!)) i++;
    if (i === start) {
      i++;
      continue;
    }
    const name = html.slice(start, i);
    let j = i;
    while (j < n && /\s/.test(html[j]!)) j++;
    let value: string | null = null;
    if (html[j] === "=") {
      j++;
      while (j < n && /\s/.test(html[j]!)) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        const stop = close < 0 ? n : close;
        value = html.slice(j + 1, stop);
        j = stop + 1;
      } else {
        const vs = j;
        while (j < n && !/[\s>]/.test(html[j]!)) j++;
        value = html.slice(vs, j);
      }
      i = j;
    }
    attrs.push({ name, lower: name.toLowerCase(), value, raw: html.slice(start, i) });
  }
  return { attrs, end: n, selfClosing };
}

/** Rewrite `url(…)` and `@import "…"` references in CSS text. `resolve`
 *  returns the local reference, or null to leave the original as is. */
function rewriteCss(css: string, resolve: (ref: string) => string | null): string {
  const url = (ref: string, quote: string): string | null => {
    const r = resolve(ref);
    return r == null ? null : `url(${quote}${r}${quote})`;
  };
  return css
    .replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/g,
      (m, d?: string, s?: string, b?: string) => {
        const ref = d ?? s ?? b ?? "";
        if (!ref) return m;
        return url(ref, d != null ? '"' : s != null ? "'" : "") ?? m;
      },
    )
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/g, (m, d?: string, s?: string) => {
      const ref = d ?? s ?? "";
      const r = ref ? resolve(ref) : null;
      return r == null ? m : `@import ${d != null ? '"' : "'"}${r}${d != null ? '"' : "'"}`;
    });
}

/** Parse a `srcset` value into candidates (url + descriptor), the way the
 *  HTML spec does: a URL runs to the next whitespace (so a data URL keeps
 *  its commas), trailing commas end the candidate, otherwise the descriptor
 *  runs to the next comma. */
export function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && /[\s,]/.test(value[i]!)) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !/\s/.test(value[i]!)) i++;
    let url = value.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      while (i < n && /\s/.test(value[i]!)) i++;
      const ds = i;
      while (i < n && value[i] !== ",") i++;
      descriptor = value.slice(ds, i).trim();
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

/** `rel` tokens whose href names a resource the state may hold */
const RESOURCE_RELS = new Set([
  "stylesheet",
  "icon",
  "preload",
  "modulepreload",
  "prefetch",
  "apple-touch-icon",
  "mask-icon",
  "manifest",
  "shortcut",
]);
/** What a reference the snapshot did not carry becomes: it loads nothing. */
const OFFLINE_REF = "about:blank";
const URL_ATTRS: Record<string, Set<string>> = {
  img: new Set(["src"]),
  source: new Set(["src"]),
  video: new Set(["src", "poster"]),
  audio: new Set(["src"]),
  track: new Set(["src"]),
  embed: new Set(["src"]),
  iframe: new Set(["src"]),
  frame: new Set(["src"]),
  input: new Set(["src"]),
  object: new Set(["data"]),
  image: new Set(["href", "xlink:href"]),
  use: new Set(["href", "xlink:href"]),
  feimage: new Set(["href", "xlink:href"]),
  body: new Set(["background"]),
  table: new Set(["background"]),
  td: new Set(["background"]),
};

type RewriteCtx = {
  /** resolve one reference against `base`; null ⇒ leave it */
  resolve: (ref: string, base: string) => string | null;
  /** the document's URL (the part's Content-Location) */
  docUrl: string;
};

/** Rewrite one HTML document: scripts inert in place, `on*` gone, refresh /
 *  CSP metas neutralised, `<base href>` dropped, legacy shadow templates made
 *  declarative, every resource reference resolved to the local asset. Only
 *  attributes change — no element is added or removed before an existing
 *  one, so child indices survive. */
function rewriteHtml(html: string, ctx: RewriteCtx): string {
  // a <base href> governs relative references (Chrome absolutises most, not
  // inline-style url() or <source srcset>); it is dropped from the output so
  // ../assets/ resolves beside the state
  let base = ctx.docUrl;
  const bm = /<base\s[^>]*?href\s*=\s*"([^"]*)"/i.exec(html);
  if (bm?.[1]) {
    try {
      base = new URL(decodeEntities(bm[1]), ctx.docUrl).href;
    } catch {
      /* keep the document URL */
    }
  }
  const resolve = (ref: string): string | null => ctx.resolve(ref, base);
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const next = html[lt + 1];
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const e = end < 0 ? n : end + 3;
      out.push(html.slice(lt, e));
      i = e;
      continue;
    }
    if (next === "!" || next === "?" || next === "/") {
      const end = html.indexOf(">", lt);
      const e = end < 0 ? n : end + 1;
      out.push(html.slice(lt, e));
      i = e;
      continue;
    }
    if (next == null || !/[a-zA-Z]/.test(next)) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(html[j]!)) j++;
    const tagName = html.slice(lt + 1, j);
    const tag = tagName.toLowerCase();
    const { attrs, end, selfClosing } = parseTag(html, j);

    if (tag === "script") {
      // the whole element, content included, becomes the inert twin
      const close = /<\/script\s*>/gi;
      close.lastIndex = end;
      const m = close.exec(html);
      out.push(INERT_SCRIPT);
      i = m ? m.index + m[0].length : n;
      continue;
    }

    let changed = false;
    const kept: Attr[] = [];
    const relTokens =
      tag === "link"
        ? new Set(
            (attrs.find((a) => a.lower === "rel")?.value ?? "")
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean),
          )
        : null;
    const wantsRel = relTokens ? [...relTokens].some((r) => RESOURCE_RELS.has(r)) : false;
    for (const a of attrs) {
      if (a.lower.startsWith("on")) {
        changed = true;
        continue;
      }
      if (tag === "base" && a.lower === "href") {
        changed = true;
        continue;
      }
      if (a.lower === "crossorigin" || a.lower === "integrity") {
        // every resource is a local file now: a CORS-mode request for a
        // file:// asset is refused outright (Vite marks its stylesheet
        // `crossorigin`, so the page would lose all its CSS), and a
        // rewritten stylesheet no longer matches its SRI hash
        changed = true;
        continue;
      }
      if (tag === "meta" && a.lower === "http-equiv" && a.value != null) {
        const v = a.value.trim().toLowerCase();
        if (v === "refresh" || v === "content-security-policy") {
          const name = "data-ot-stripped-http-equiv";
          kept.push({ ...a, name, lower: name, raw: `${name}="${a.value}"` });
          changed = true;
          continue;
        }
      }
      if (tag === "template" && a.lower === "shadowmode") {
        // Chrome's serializer writes the pre-standard attribute; the parser
        // only attaches a declarative shadow root for `shadowrootmode`
        const name = "shadowrootmode";
        kept.push({
          ...a,
          name,
          lower: name,
          raw: a.value == null ? name : `${name}="${a.value}"`,
        });
        changed = true;
        continue;
      }
      if (a.value == null) {
        kept.push(a);
        continue;
      }
      const value = decodeEntities(a.value);
      let rewritten: string | null = null;
      if (a.lower === "style") {
        const css = rewriteCss(value, resolve);
        if (css !== value) rewritten = css;
      } else if (a.lower === "srcset" && (tag === "img" || tag === "source")) {
        const local = parseSrcset(value)
          .map((c) => ({ ...c, url: resolve(c.url) }))
          .filter((c) => c.url != null && c.url !== OFFLINE_REF);
        if (local.length === 0) {
          // no candidate travelled with the page — let `src` stand
          changed = true;
          continue;
        }
        rewritten = local
          .map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url!))
          .join(", ");
      } else if (
        /^cid:/i.test(value) ||
        URL_ATTRS[tag]?.has(a.lower) ||
        (tag === "link" && a.lower === "href" && wantsRel)
      ) {
        rewritten = resolve(value);
      }
      if (rewritten != null && rewritten !== value) {
        kept.push({ ...a, value: rewritten, raw: `${a.name}="${encodeAttr(rewritten)}"` });
        changed = true;
      } else kept.push(a);
    }
    if (changed) {
      out.push(`<${tagName}${kept.map((a) => ` ${a.raw}`).join("")}${selfClosing ? " /" : ""}>`);
    } else out.push(html.slice(lt, end));
    i = end;

    if (tag === "style") {
      const close = /<\/style\s*>/gi;
      close.lastIndex = end;
      const m = close.exec(html);
      const stop = m ? m.index : n;
      out.push(rewriteCss(html.slice(end, stop), resolve));
      i = stop;
    }
  }
  return out.join("");
}

/** The restore script: what markup cannot carry, re-applied when the saved
 *  page loads. Plain JS, the only script that runs; the probe data rides
 *  inline as JSON. Sets `document.documentElement.dataset.otReady = "1"`
 *  once fonts and images are in (bounded — a hung image never blocks it). */
function buildRestoreScript(probe: DomStateProbe): string {
  const data = {
    scroll: probe.scroll,
    scrolled: probe.scrolled,
    inputs: probe.inputs,
    canvases: probe.canvases,
    videos: probe.videos,
    animated: probe.animated,
    custom: probe.custom,
    focus: probe.focus ?? null,
    elements: probe.elements.map((e) => ({ id: e.id, path: e.path, tag: e.tag })),
  };
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script data-ot-restore>(function(){
var P=${json};
var doc=document;
function resolve(path){var n=doc.documentElement;for(var i=0;i<path.length;i++){n=n.children[path[i]];if(!n)return null;}return n;}
function paint(el,url){return new Promise(function(res){try{var ctx=el.getContext("2d");if(!ctx)return res();var im=new Image();im.onload=function(){try{ctx.clearRect(0,0,el.width,el.height);ctx.drawImage(im,0,0,el.width,el.height);}catch(e){}res();};im.onerror=function(){res();};im.src=url;}catch(e){res();}});}
function run(){
  var misses=0,i,j,el,waits=[];
  for(i=0;i<P.custom.length;i++){var c=P.custom[i];try{if(!customElements.get(c.name)){if(c.extends){var Base=doc.createElement(c.extends).constructor;customElements.define(c.name,class extends Base{},{extends:c.extends});}else customElements.define(c.name,class extends HTMLElement{});}}catch(e){}}
  for(i=0;i<P.elements.length;i++){var e=P.elements[i];el=resolve(e.path);if(el&&el.localName===e.tag)el.setAttribute("data-ot-id",e.id);else misses++;}
  for(i=0;i<P.inputs.length;i++){var x=P.inputs[i];el=resolve(x.path);if(!el)continue;try{if("checked" in x)el.checked=x.checked;if(x.selected)for(var o=0;o<el.options.length;o++)el.options[o].selected=x.selected.indexOf(o)>=0;if("value" in x)el.value=x.value;}catch(e){}}
  for(i=0;i<P.canvases.length;i++){var cv=P.canvases[i];el=resolve(cv.path);if(!el||el.localName!=="canvas")continue;waits.push(paint(el,cv.dataUrl));}
  for(i=0;i<P.videos.length;i++){var vd=P.videos[i];el=resolve(vd.path);if(!el||el.localName!=="video")continue;try{el.removeAttribute("autoplay");el.removeAttribute("src");var ss=el.querySelectorAll("source");for(j=0;j<ss.length;j++)ss[j].remove();el.setAttribute("preload","none");el.setAttribute("poster",vd.dataUrl);el.load();}catch(e){}}
  for(i=0;i<P.animated.length;i++){var an=P.animated[i];el=resolve(an.path);if(!el)continue;for(var k in an.styles){try{el.style.setProperty(k,an.styles[k],"important");}catch(e){}}}
  var lazy=doc.querySelectorAll("img[loading=lazy]");for(i=0;i<lazy.length;i++)lazy[i].loading="eager";
  try{var sheet=new CSSStyleSheet();sheet.replaceSync(${JSON.stringify(DOM_STATE_FREEZE_CSS)});var all=doc.querySelectorAll("*");for(i=0;i<all.length;i++){var sr=all[i].shadowRoot;if(sr)sr.adoptedStyleSheets=sr.adoptedStyleSheets.concat([sheet]);}}catch(e){}
  function applyScroll(){try{window.scrollTo({left:P.scroll.x,top:P.scroll.y,behavior:"instant"});}catch(e){window.scrollTo(P.scroll.x,P.scroll.y);}for(var s=0;s<P.scrolled.length;s++){var sc=P.scrolled[s];var se=resolve(sc.path);if(!se)continue;try{se.scrollTo({left:sc.left,top:sc.top,behavior:"instant"});}catch(e){se.scrollTop=sc.top;se.scrollLeft=sc.left;}}}
  void doc.body.getBoundingClientRect();
  if(P.focus){el=resolve(P.focus);if(el){try{el.focus({preventScroll:true});}catch(e){}}}
  applyScroll();
  try{waits.push(doc.fonts.ready);}catch(e){}
  var imgs=doc.images;for(i=0;i<imgs.length;i++){try{if(typeof imgs[i].decode==="function")waits.push(imgs[i].decode().catch(function(){}));}catch(e){}}
  var done=false;
  function finish(){if(done)return;done=true;applyScroll();doc.documentElement.setAttribute("data-ot-misses",String(misses));doc.documentElement.setAttribute("data-ot-ready","1");}
  Promise.all(waits).then(finish,finish);
  setTimeout(finish,6000);
}
if(doc.readyState==="loading")doc.addEventListener("DOMContentLoaded",run);else run();
})();</script>`;
}

type ConvertResult = {
  /** the self-contained document (write it as `state.html`) */
  html: string;
  /** asset files this state references, relative to the assets dir */
  assets: string[];
  /** references that resolved to no part and were left pointing at the network */
  unresolved: number;
};

/**
 * MHTML → state.html. Every part but the document goes to `assetsDir` as
 * `<sha1>.<ext>` (deduped across states); references are rewritten to
 * `../assets/<file>`. Sub-frame documents become `.html` assets, converted
 * the same way (best effort — no restore script for them).
 */
export function convertMhtml(
  raw: Buffer | string,
  probe: DomStateProbe,
  opts: { assetsDir: string },
): ConvertResult {
  const parts = parseMhtml(raw);
  const doc = parts.find((p) => p.contentType === "text/html");
  if (!doc) throw new Error("mhtml: no text/html part");
  mkdirSync(opts.assetsDir, { recursive: true });

  const byLocation = new Map<string, MhtmlPart>();
  const byCid = new Map<string, MhtmlPart>();
  for (const p of parts) {
    if (p === doc) continue;
    if (p.id) byCid.set(p.id, p);
    if (p.location) {
      if (/^cid:/i.test(p.location)) byCid.set(p.location.slice(4), p);
      else byLocation.set(stripFragment(p.location), p);
    }
  }
  const assets = new Set<string>();
  const emitted = new Map<MhtmlPart, string | null>();
  const inProgress = new Set<MhtmlPart>();
  let unresolved = 0;

  const write = (bytes: Buffer, ext: string): string => {
    const name = `${createHash("sha1").update(bytes).digest("hex")}.${ext}`;
    const file = join(opts.assetsDir, name);
    if (!existsSync(file)) writeFileSync(file, bytes);
    assets.add(name);
    return `../assets/${name}`;
  };

  const lookup = (ref: string, base: string): MhtmlPart | null => {
    if (/^cid:/i.test(ref)) return byCid.get(ref.slice(4)) ?? null;
    if (/^(data|blob|about|javascript|mailto|tel):/i.test(ref) || ref.startsWith("#")) return null;
    try {
      const abs = stripFragment(new URL(ref, base).href);
      return byLocation.get(abs) ?? null;
    } catch {
      return null;
    }
  };

  /** the local reference for a part, converting it on first use */
  const emit = (part: MhtmlPart): string | null => {
    if (emitted.has(part)) return emitted.get(part) ?? null;
    if (inProgress.has(part)) return null; // a cycle (a.css → b.css → a.css)
    inProgress.add(part);
    let ref: string | null;
    try {
      const partBase =
        part.location && !/^cid:/i.test(part.location)
          ? part.location
          : (doc.location ?? "about:blank");
      if (part.contentType === "text/css") {
        const css = rewriteCss(part.body.toString("utf8"), (r) => resolveRef(r, partBase));
        ref = write(Buffer.from(css, "utf8"), "css");
      } else if (part.contentType === "text/html") {
        const html = rewriteHtml(part.body.toString("utf8"), {
          resolve: resolveRef,
          docUrl: partBase,
        });
        ref = write(Buffer.from(withFreeze(html), "utf8"), "html");
      } else ref = write(part.body, extFor(part));
    } finally {
      inProgress.delete(part);
    }
    emitted.set(part, ref);
    return ref;
  };

  const resolveRef = (ref: string, base: string): string | null => {
    // a place in the document itself (url(#clip), <use href="#icon">) stays
    if (ref.startsWith("#")) return null;
    const part = lookup(ref, base);
    if (part) {
      // and a place in another file (icons.svg#check) stays on its copy
      const local = emit(part);
      const place = /#.*$/.exec(ref)?.[0];
      return local && place ? local + place : local;
    }
    // a network reference the snapshot did not carry is cut off: a saved
    // state never reaches the network — the app's server is gone by the time
    // a film renders, and one that happens to be up must not change it. The
    // fidelity check (network blocked too) shows whether it mattered.
    if (/^cid:/i.test(ref)) {
      unresolved++;
      return OFFLINE_REF;
    }
    try {
      const u = new URL(ref, base);
      if (u.protocol === "http:" || u.protocol === "https:") {
        unresolved++;
        return OFFLINE_REF;
      }
    } catch {
      /* not a URL at all */
    }
    return null;
  };

  const docUrl = doc.location && !/^cid:/i.test(doc.location) ? doc.location : probe.url;
  let html = rewriteHtml(doc.body.toString("utf8"), { resolve: resolveRef, docUrl });
  html = withFreeze(html);
  // the restore script goes AFTER everything the page had (the parser folds a
  // script after </body> into the body as its last child)
  const htmlClose = html.search(/<\/html\s*>\s*$/i);
  const restore = buildRestoreScript(probe);
  html =
    htmlClose >= 0
      ? `${html.slice(0, htmlClose)}${restore}\n${html.slice(htmlClose)}`
      : `${html}${restore}\n`;
  return { html, assets: [...assets], unresolved };
}

/** the freeze style at the END of <head> (or before <body>, or first) */
function withFreeze(html: string): string {
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose)
    return `${html.slice(0, headClose.index)}${FREEZE_STYLE}${html.slice(headClose.index)}`;
  const body = /<body[\s>]/i.exec(html);
  if (body) return `${html.slice(0, body.index)}${FREEZE_STYLE}${html.slice(body.index)}`;
  return `${FREEZE_STYLE}${html}`;
}

// --- fidelity -------------------------------------------------------------------

/** Boxes (x, y, w, h — image px) left out of a comparison. */
type PixelMask = { width: number; boxes: [number, number, number, number][] };

/** PSNR (dB, capped at 99 for identical images) and the fraction of pixels
 *  differing by more than 8 on any channel, over two rgb24 buffers — pixels
 *  inside `mask` boxes (what moves on its own: canvases, videos) left out. */
export function comparePixels(
  a: Uint8Array,
  b: Uint8Array,
  mask?: PixelMask,
): { psnr: number; diffFrac: number } {
  const n = Math.min(a.length, b.length) - (Math.min(a.length, b.length) % 3);
  if (n === 0) return { psnr: 0, diffFrac: 1 };
  const masked = mask?.boxes.length ? maskBits(mask, n / 3) : null;
  let se = 0;
  let diff = 0;
  let counted = 0;
  for (let i = 0; i < n; i += 3) {
    if (masked?.[i / 3]) continue;
    counted++;
    const d0 = a[i]! - b[i]!;
    const d1 = a[i + 1]! - b[i + 1]!;
    const d2 = a[i + 2]! - b[i + 2]!;
    se += d0 * d0 + d1 * d1 + d2 * d2;
    if (Math.abs(d0) > 8 || Math.abs(d1) > 8 || Math.abs(d2) > 8) diff++;
  }
  if (counted === 0) return { psnr: 99, diffFrac: 0 };
  const mse = se / (counted * 3);
  const psnr = mse === 0 ? 99 : Math.min(99, 10 * Math.log10((255 * 255) / mse));
  return {
    psnr: Math.round(psnr * 100) / 100,
    diffFrac: Math.round((diff / counted) * 10000) / 10000,
  };
}

function maskBits(mask: PixelMask, pixels: number): Uint8Array {
  const bits = new Uint8Array(pixels);
  const w = mask.width;
  const h = Math.floor(pixels / w);
  for (const [bx, by, bw, bh] of mask.boxes) {
    const x0 = Math.max(0, Math.floor(bx));
    const y0 = Math.max(0, Math.floor(by));
    const x1 = Math.min(w, Math.ceil(bx + bw));
    const y1 = Math.min(h, Math.ceil(by + bh));
    for (let y = y0; y < y1; y++) bits.fill(1, y * w + x0, Math.max(y * w + x0, y * w + x1));
  }
  return bits;
}

/** width/height from a PNG's IHDR */
function pngSize(png: Buffer): { w: number; h: number } {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) throw new Error("not a PNG");
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** Decode an image file to raw rgb24 at `w`×`h` through ffmpeg. */
function decodeRgb(
  ffmpeg: string,
  file: string,
  w: number,
  h: number,
  flags: "neighbor" | "area" = "neighbor",
): Promise<Uint8Array> {
  return runBuffer(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `scale=${w}:${h}:flags=${flags}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]).then((buf) => {
    if (buf.length !== w * h * 3)
      throw new Error(`ffmpeg decoded ${file} to ${buf.length} bytes, not ${w}×${h} rgb`);
    return new Uint8Array(buf);
  });
}

/** `box` (CSS px) of a PNG as a PNG data URL, clamped to the image. */
async function cropPng(
  ffmpeg: string,
  png: string,
  box: [number, number, number, number],
): Promise<string> {
  const { w, h } = pngSize(await readFile(png));
  const x = Math.max(0, Math.floor(box[0]));
  const y = Math.max(0, Math.floor(box[1]));
  const cw = Math.min(w - x, Math.ceil(box[0] + box[2]) - x);
  const ch = Math.min(h - y, Math.ceil(box[1] + box[3]) - y);
  if (cw < 1 || ch < 1) throw new Error("the box is off the image");
  const out = await runBuffer(ffmpeg, [
    "-v",
    "error",
    "-i",
    png,
    "-vf",
    `crop=${cw}:${ch}:${x}:${y}`,
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-",
  ]);
  return `data:image/png;base64,${out.toString("base64")}`;
}

/** Compare a state's re-render against the live reference, both PNG files. */
async function measureFidelity(
  ffmpeg: string,
  livePng: string,
  statePng: string,
  /** CSS-px boxes to leave out: canvases and videos whose moving content the
   *  still froze a moment apart from the reference screenshot */
  moving: [number, number, number, number][] = [],
): Promise<StateFidelity> {
  const { w, h } = pngSize(await readFile(livePng));
  const [a, b] = await Promise.all([
    decodeRgb(ffmpeg, livePng, w, h),
    decodeRgb(ffmpeg, statePng, w, h),
  ]);
  const { psnr, diffFrac } = comparePixels(a, b, { width: w, boxes: moving });
  return { psnr, diffFrac, ok: psnr >= DOM_STATE_PSNR_OK };
}

// --- event ↔ element matching ------------------------------------------------------

/** The element whose box best matches `box` (IoU ≥ 0.5), or undefined. */
export function matchTarget(
  box: { x: number; y: number; w: number; h: number },
  elements: StateElement[],
): string | undefined {
  let best: string | undefined;
  let bestIou = 0.5;
  const area = Math.max(0, box.w) * Math.max(0, box.h);
  for (const e of elements) {
    const [x, y, w, h] = e.box;
    const ix = Math.max(0, Math.min(box.x + box.w, x + w) - Math.max(box.x, x));
    const iy = Math.max(0, Math.min(box.y + box.h, y + h) - Math.max(box.y, y));
    const inter = ix * iy;
    if (inter <= 0) continue;
    const iou = inter / (area + w * h - inter);
    if (iou > bestIou) {
      bestIou = iou;
      best = e.id;
    }
  }
  return best;
}

// --- during the take -------------------------------------------------------------------

export type DomStateRaw = {
  id: string;
  tMs: number;
  step?: number;
  /** `states/<id>/` */
  dir: string;
  probe: DomStateProbe;
  /** what reading it cost the take */
  ms: number;
};

/** Visible canvases and videos (CSS px): content that moves on its own — a
 *  spinning WebGL globe, a looping clip — which a still can only freeze. And
 *  the focused text field, whose caret blinks on its own (every half second:
 *  two shots 150 ms apart straddled a blink about one time in three). */
const LIVING_JS = `(() => {
  const out = [];
  const f = document.activeElement;
  if (f && (f.isContentEditable || /^(input|textarea|select)$/i.test(f.tagName))) {
    const r = f.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push([r.left, r.top, r.width, r.height]);
  }
  for (const el of document.querySelectorAll("canvas,video")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    out.push([r.left, r.top, r.width, r.height]);
  }
  return out;
})()`;

/** Is the page visually still? Two screenshots 150 ms apart. They are taken at
 *  the page's own scale: a scaled capture re-rasters the page and is not
 *  repeatable (a still page gave two different 1/8-scale images in 12 shots;
 *  native-scale shots were identical), so identical bytes mean nothing moved.
 *  When they differ and the page has content that moves on its own — visible
 *  canvases and videos, the focused field's caret — both are decoded small
 *  and compared outside those boxes. The settle probe hears a page WORKING —
 *  timers, requests, mutations — which a loaded machine stretches past its
 *  budget even when nothing on screen moves; only moving pixels make a moment
 *  unfit for a still. */
export async function visuallyStill(cdp: CDP, vw: number, vh: number): Promise<boolean> {
  const living = await cdp
    .send<{ result?: { value?: [number, number, number, number][] } }>("Runtime.evaluate", {
      expression: LIVING_JS,
      returnByValue: true,
    })
    .then((r) => r.result?.value ?? [])
    .catch(() => [] as [number, number, number, number][]);
  const shot = async () =>
    Buffer.from(
      (
        await cdp.send<{ data: string }>("Page.captureScreenshot", {
          format: "jpeg",
          quality: 80,
          optimizeForSpeed: true,
        })
      ).data,
      "base64",
    );
  const a = await shot();
  await sleep(150);
  const b = await shot();
  if (a.equals(b)) return true;
  if (!living.length) return false;
  const w = Math.max(1, Math.round(vw / 4));
  const h = Math.max(1, Math.round(vh / 4));
  const [sa, sb] = await decodeSmall(await resolveFfmpeg(), [a, b], w, h);
  // JPEG blocks at a box's edge carry some of what moves inside it: 2 px of margin
  return stillOutside(sa!, sb!, living, vw, 2);
}

/** JPEG screenshots → w×h rgb24 (area-averaged), one ffmpeg run each. */
async function decodeSmall(
  ffmpeg: string,
  jpegs: Buffer[],
  w: number,
  h: number,
): Promise<DecodedImage[]> {
  const dir = await mkdtemp(join(tmpdir(), "open-take-still-"));
  try {
    const files = await Promise.all(
      jpegs.map(async (j, i) => {
        const f = join(dir, `${i}.jpg`);
        await writeFile(f, j);
        return f;
      }),
    );
    const frames = await Promise.all(files.map((f) => decodeRgb(ffmpeg, f, w, h, "area")));
    return frames.map((data) => ({ w, h, ch: 3, data }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Pixels of the small image that may change without the page moving, and by
 *  how much a channel must change to count. */
const STILL_TOLERANCE = { pixels: 2, level: 12 };

/** Two decoded screenshots of a `vw`-wide viewport show the same page outside
 *  the CSS-px `boxes` (grown by a screenshot pixel for antialiased edges). */
export function stillOutside(
  a: DecodedImage,
  b: DecodedImage,
  boxes: [number, number, number, number][],
  vw: number,
  /** image px of margin around each box (antialiased edges, JPEG blocks) */
  margin: number,
): boolean {
  if (a.w !== b.w || a.h !== b.h || a.ch !== b.ch) return false;
  const k = a.w / vw; // image px per CSS px
  const masked = maskBits(
    {
      width: a.w,
      boxes: boxes.map(([x, y, w, h]) => [
        x * k - margin,
        y * k - margin,
        w * k + 2 * margin,
        h * k + 2 * margin,
      ]),
    },
    a.w * a.h,
  );
  let moved = 0;
  for (let i = 0; i < a.w * a.h; i++) {
    if (masked[i]) continue;
    for (let c = 0; c < a.ch; c++)
      if (Math.abs(a.data[i * a.ch + c]! - b.data[i * a.ch + c]!) > STILL_TOLERANCE.level) {
        if (++moved > STILL_TOLERANCE.pixels) return false;
        break;
      }
  }
  return true;
}

/** A decoded image: `ch` bytes per pixel, row by row. */
type DecodedImage = { w: number; h: number; ch: number; data: Uint8Array };

/** One settled moment: probe, reference screenshot, MHTML — raw files into
 *  `<statesDir>/<id>/` (`probe.json`, `live.png`, `page.mhtml`). Read-only on
 *  the page. Throws on a CDP failure; the caller decides whether a missing
 *  state matters (it never fails a take). */
export async function captureDomState(
  cdp: CDP,
  args: {
    statesDir: string;
    id: string;
    tMs: number;
    step?: number;
    vw: number;
    vh: number;
    dpr: number;
  },
): Promise<DomStateRaw> {
  const t0 = Date.now();
  const dir = join(args.statesDir, args.id);
  mkdirSync(dir, { recursive: true });
  // A screenshot's clip is in DOCUMENT px: on a scrolled page, (0, 0) is the
  // top of the document, not of what is on screen — the reference must start
  // where the page is scrolled to (measured: a page scrolled by 643 px gave a
  // reference of the document's top, blank above the sticky header).
  const at = await cdp
    .send<{ cssVisualViewport?: { pageX?: number; pageY?: number } }>("Page.getLayoutMetrics")
    .then((m) => ({ x: m.cssVisualViewport?.pageX ?? 0, y: m.cssVisualViewport?.pageY ?? 0 }))
    .catch(() => ({ x: 0, y: 0 }));
  // The probe and the reference screenshot go out together: the probe holds
  // the main thread for a few ms and the screenshot's frame commits right
  // after it, so a running animation is read at (nearly) the phase the
  // reference shows. The screenshot is at 1× CSS size — the clip is CSS px
  // and the output is clip × dsf × scale, so 1/dsf undoes a Retina capture.
  const [r, shot] = await Promise.all([
    cdp
      .send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: DOM_STATE_PROBE_JS,
        returnByValue: true,
      })
      .then((x) => ({ value: x.result?.value })),
    cdp
      .send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: at.x,
          y: at.y,
          width: args.vw,
          height: args.vh,
          scale: 1 / Math.max(1, args.dpr),
        },
      })
      .then((s) => ({ data: s.data })),
  ]);
  const v = r.value;
  if (typeof v !== "string") throw new Error("dom-state probe returned nothing");
  const probe = JSON.parse(v) as DomStateProbe & { error?: string };
  if (probe.error) throw new Error(`dom-state probe failed in page: ${probe.error}`);
  const snap = await cdp.send<{ data: string }>("Page.captureSnapshot", { format: "mhtml" });
  writeFileSync(join(dir, "live.png"), Buffer.from(shot.data, "base64"));
  writeFileSync(join(dir, "page.mhtml"), snap.data, "utf8");
  writeFileSync(join(dir, "probe.json"), v, "utf8");
  return {
    id: args.id,
    tMs: args.tMs,
    ...(args.step != null ? { step: args.step } : {}),
    dir,
    probe,
    ms: Date.now() - t0,
  };
}

// --- after the screencast ----------------------------------------------------------------

export type DomStateItem = NonNullable<CaptureLog["states"]>["items"][number];

/** `states/<id>/index.json` from a raw capture (fidelity filled in later) */
function buildIndex(raw: DomStateRaw): StateIndex {
  return {
    version: 1,
    id: raw.id,
    url: raw.probe.url,
    title: raw.probe.title,
    tMs: raw.tMs,
    ...(raw.step != null ? { step: raw.step } : {}),
    viewport: raw.probe.viewport,
    scroll: raw.probe.scroll,
    elements: raw.probe.elements,
    layers: raw.probe.layers,
  };
}

/**
 * Convert every raw state to `state.html` + `index.json`, drop the raw
 * MHTML/probe, then re-open each state in a second page of the SAME browser
 * (viewport-sized, deviceScaleFactor 1) and score it against `live.png`.
 * Returns the items for the capture log. A state that fails conversion or
 * the check stays on disk with `fidelity.ok: false`; nothing here throws
 * past a single state.
 */
export async function finalizeDomStates(args: {
  browser: Browser;
  statesDir: string;
  states: DomStateRaw[];
  vw: number;
  vh: number;
  /** measure each state's parts in the same page (parts.json + crisp
   *  pictures in states/assets/) — default true; false skips it */
  parts?: boolean;
  /** run on each state's restored page once it is checked and measured
   *  (the shoot's full-page sheet); what it throws is a line, not a failure */
  afterRender?: (cdp: CDP, raw: DomStateRaw) => Promise<void>;
}): Promise<DomStateItem[]> {
  const warn = (l: string) => console.error(l);
  const assetsDir = join(args.statesDir, "assets");
  const items: DomStateItem[] = [];
  const converted: { raw: DomStateRaw; index: StateIndex }[] = [];
  let ffmpeg: string | undefined;
  try {
    ffmpeg = await resolveFfmpeg();
  } catch (e) {
    warn(`dom-state: no ffmpeg for the fidelity check (${(e as Error).message})`);
  }
  for (const raw of args.states) {
    const index = buildIndex(raw);
    // A canvas that copied out empty (WebGL that clears its buffer) would be a
    // hole in the state: its pixels as shown are in the reference screenshot,
    // taken at the same moment — crop them from there.
    if (ffmpeg)
      for (const cv of raw.probe.canvases) {
        if (!cv.blank || !cv.box) continue;
        try {
          cv.dataUrl = await cropPng(ffmpeg, join(raw.dir, "live.png"), cv.box);
          cv.blank = false;
          warn(
            `dom-state ${raw.id}: a canvas read back empty — filled from the screenshot taken with it`,
          );
        } catch (e) {
          warn(
            `dom-state ${raw.id}: an empty canvas could not be filled (${(e as Error).message})`,
          );
        }
      }
    try {
      const mhtml = await readFile(join(raw.dir, "page.mhtml"), "latin1");
      const { html, unresolved } = convertMhtml(mhtml, raw.probe, { assetsDir });
      await writeFile(join(raw.dir, "state.html"), html, "utf8");
      if (unresolved)
        warn(
          `dom-state ${raw.id}: ${unresolved} reference(s) not in the snapshot cut off (the page never loaded them, or loaded them after the snapshot)`,
        );
      converted.push({ raw, index });
    } catch (e) {
      warn(
        `dom-state ${raw.id}: conversion failed (${(e as Error).message}) — the film will use the video here`,
      );
      index.fidelity = { psnr: 0, diffFrac: 1, ok: false };
    }
    await writeFile(join(raw.dir, "index.json"), JSON.stringify(index, null, 2));
    await rm(join(raw.dir, "page.mhtml"), { force: true });
    await rm(join(raw.dir, "probe.json"), { force: true });
  }
  if (converted.length) {
    // (cast, not annotated: openPage/dropPage assign it, and TS would
    // otherwise narrow it to null for the loop below)
    let page = null as { cdp: CDP; targetId: string } | null;
    // A state whose page stops answering (a request timed out, the renderer
    // crashed) leaves that page unusable: it is closed and the next state gets
    // a fresh one. A page that cannot be opened at all — or two states in a
    // row whose pages stall (Chrome itself, not one page, is stuck: each more
    // would wait out its own budgets) — ends the checks; the remaining states
    // keep `ok: false` and the take goes on.
    let noPage = false;
    let stallsInARow = 0;
    const openPage = async () => {
      if (page || noPage || !ffmpeg) return;
      try {
        page = await openFidelityPage(args.browser, args.vw, args.vh);
      } catch (e) {
        noPage = true;
        warn(`dom-state: could not open a page for the fidelity check (${(e as Error).message})`);
      }
    };
    const dropPage = async (id: string, e: unknown) => {
      if (!page || !isCdpStall(e)) return;
      warn(`dom-state ${id}: the check's page stopped answering — the next state gets a new one`);
      await closeFidelityPage(args.browser, page);
      page = null;
      if (++stallsInARow >= 2) {
        noPage = true;
        warn(
          "dom-state: two checks in a row stopped answering — the remaining states are not checked",
        );
      }
    };
    for (const { raw, index } of converted) {
      const stallsBefore = stallsInARow;
      let fidelity: StateFidelity = { psnr: 0, diffFrac: 1, ok: false };
      await openPage();
      if (page && ffmpeg) {
        const statePng = join(raw.dir, "render.png");
        try {
          const shot = await renderState(page.cdp, join(raw.dir, "state.html"), args.vw, args.vh);
          await writeFile(statePng, shot.png);
          // the restored page is open and laid out: measure its parts here,
          // after the fidelity screenshot so nothing it does reaches that
          if (args.parts !== false)
            await measureParts(page.cdp, { dir: raw.dir, index, assetsDir }).catch(async (e) => {
              warn(`dom-state ${raw.id}: parts not measured (${(e as Error).message})`);
              await dropPage(raw.id, e);
            });
          // what moves on its own was frozen a moment apart from the
          // reference; the rest of the page decides whether the state is true
          const moving = [...raw.probe.canvases, ...raw.probe.videos]
            .filter((m) => m.box && !m.blank)
            .map((m) => m.box!);
          fidelity = await measureFidelity(ffmpeg, join(raw.dir, "live.png"), statePng, moving);
          if (args.afterRender)
            await args.afterRender(page.cdp, raw).catch(async (e) => {
              warn(`dom-state ${raw.id}: ${(e as Error).message}`);
              await dropPage(raw.id, e);
            });
          if (shot.misses)
            warn(
              `dom-state ${raw.id}: ${shot.misses} element path(s) did not resolve in state.html`,
            );
        } catch (e) {
          warn(`dom-state ${raw.id}: fidelity check failed (${(e as Error).message})`);
          await dropPage(raw.id, e);
        } finally {
          await rm(statePng, { force: true });
        }
      }
      if (page && stallsInARow === stallsBefore) stallsInARow = 0;
      index.fidelity = fidelity;
      await writeFile(join(raw.dir, "index.json"), JSON.stringify(index, null, 2));
    }
    if (page) await closeFidelityPage(args.browser, page);
  }
  for (const raw of args.states) {
    const index = converted.find((c) => c.raw === raw)?.index;
    items.push({
      id: raw.id,
      tMs: raw.tMs,
      ...(raw.step != null ? { step: raw.step } : {}),
      ...(index?.fidelity
        ? { fidelity: index.fidelity }
        : { fidelity: { psnr: 0, diffFrac: 1, ok: false } }),
    });
  }
  return items;
}

/** close a page openFidelityPage opened (never throws, never waits long:
 *  its target may be the one that stopped answering) */
export async function closeFidelityPage(
  browser: Browser,
  page: { cdp: CDP; targetId: string },
): Promise<void> {
  page.cdp.close();
  await browser.cdp
    .send("Target.closeTarget", { targetId: page.targetId }, { timeoutMs: 5000 })
    .catch(() => {});
}

/** a second page target in the same Chrome, emulated at vw×vh @1× */
export async function openFidelityPage(
  browser: Browser,
  vw: number,
  vh: number,
): Promise<{ cdp: CDP; targetId: string }> {
  const { targetId } = await browser.cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  let cdp: CDP | undefined;
  try {
    cdp = await CDP.connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`);
    await setUpFidelityPage(cdp, vw, vh);
  } catch (e) {
    // a page that could not be set up is not left open behind the error
    cdp?.close();
    await browser.cdp.send("Target.closeTarget", { targetId }, { timeoutMs: 5000 }).catch(() => {});
    throw e;
  }
  return { cdp, targetId };
}

async function setUpFidelityPage(cdp: CDP, vw: number, vh: number): Promise<void> {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: vw,
    height: vh,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The check must see what a film render sees later, when the app's server
  // is long gone: only the saved files load. A reference left pointing at the
  // app would otherwise load from it now and pass a state that breaks then.
  await cdp.send("Network.enable");
  await cdp.send("Network.setBlockedURLs", {
    urls: ["http://*", "https://*", "ws://*", "wss://*"],
  });
}

/** Open a state.html (file://), wait for the restore script's ready flag, screenshot at 1×. */
export async function renderState(
  cdp: CDP,
  stateHtml: string,
  vw: number,
  vh: number,
): Promise<{ png: Buffer; misses: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loaded = new Promise<void>((res) => {
    cdp.on("Page.loadEventFired", () => res());
    timer = setTimeout(res, 15000);
  });
  try {
    await cdp.send("Page.navigate", { url: pathToFileURL(stateHtml).href });
    await loaded;
  } finally {
    // a pending 15 s timer would hold the process open after the last state
    // (also when the navigation itself failed or timed out)
    clearTimeout(timer);
  }
  const deadline = Date.now() + 10000;
  let misses = 0;
  for (;;) {
    const r = await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
      expression:
        'document.documentElement.dataset.otReady === "1" ? (document.documentElement.dataset.otMisses || "0") : ""',
      returnByValue: true,
    });
    const v = r.result?.value;
    if (v) {
      misses = Number(v) || 0;
      break;
    }
    if (Date.now() > deadline) throw new Error("state.html never reported ready");
    await sleep(50);
  }
  await sleep(60); // two frames for the paint after the last restore step
  // the clip is in document px: start where the restored state is scrolled to
  const at = await cdp
    .send<{ cssVisualViewport?: { pageX?: number; pageY?: number } }>("Page.getLayoutMetrics")
    .then((m) => ({ x: m.cssVisualViewport?.pageX ?? 0, y: m.cssVisualViewport?.pageY ?? 0 }))
    .catch(() => ({ x: 0, y: 0 }));
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    clip: { x: at.x, y: at.y, width: vw, height: vh, scale: 1 },
  });
  return { png: Buffer.from(shot.data, "base64"), misses };
}

// --- parts: the component probe, in the restored page --------------------------

/** Most pictures taken per state (each is one clipped screenshot, ~40–80 ms). */
const PARTS_MAX_PICTURES = 60;

/**
 * Measure the parts of the saved state open in `cdp` (state.html, ready —
 * renderState has run) with the compositor's component probe, take a crisp
 * picture of each kept part (its ink or box ± pad, 3×, the rest of the page
 * hidden and see-through — what lift(…, { around: "clear" }) shows), and
 * write `<dir>/parts.json`. Pictures are content-named files in `assetsDir`
 * (shared with the state's other files), referenced relative to `dir`. The
 * page's look is put back afterwards (the background override persists
 * across navigations in this target).
 */
export async function measureParts(
  cdp: CDP,
  opts: {
    dir: string;
    index: StateIndex;
    assetsDir: string;
    pictures?: boolean;
    minArea?: number;
  },
): Promise<PartsFile> {
  const r = await cdp.send<{ result?: { value?: string }; exceptionDetails?: { text?: string } }>(
    "Runtime.evaluate",
    {
      expression: componentProbeExpression(
        opts.index,
        opts.minArea != null ? { minArea: opts.minArea } : {},
      ),
      returnByValue: true,
    },
  );
  const raw = r.result?.value;
  if (typeof raw !== "string")
    throw new Error(`the component probe returned nothing (${r.exceptionDetails?.text ?? "?"})`);
  const res = JSON.parse(raw) as ComponentProbeResult;
  if ("error" in res) throw new Error(`the component probe failed: ${res.error}`);
  const file: PartsFile = {
    version: 1,
    state: opts.index.id,
    viewport: res.viewport,
    scroll: res.scroll,
    medianTextPx: res.medianTextPx,
    parts: res.parts,
    skipped: res.skipped,
    ms: { measure: res.ms },
  };
  if (opts.pictures !== false && file.parts.length) {
    const t0 = Date.now();
    mkdirSync(opts.assetsDir, { recursive: true });
    const evaluate = (expression: string) =>
      cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    // a page that stops answering ends the pictures (each would wait out its
    // own timeout) and skips the clean-up: the caller drops that page
    let stalled = false;
    try {
      await evaluate(
        `(() => { const st = document.createElement("style"); st.setAttribute("data-ot-clip-css", ""); st.textContent = ${JSON.stringify(CLIP_CLEAR_CSS)}; document.head.appendChild(st); })()`,
      );
      const at = await cdp
        .send<{ cssVisualViewport?: { pageX?: number; pageY?: number } }>("Page.getLayoutMetrics")
        .then((m) => ({ x: m.cssVisualViewport?.pageX ?? 0, y: m.cssVisualViewport?.pageY ?? 0 }))
        .catch(() => ({ x: 0, y: 0 }));
      let taken = 0;
      for (const part of file.parts) {
        const win = pictureClip(part, file.viewport);
        if (!win) {
          part.noPicture = "nothing of it inside the screen";
          continue;
        }
        if (taken >= PARTS_MAX_PICTURES) {
          part.noPicture = `not taken: ${PARTS_MAX_PICTURES} pictures already taken in this state`;
          continue;
        }
        const sel = JSON.stringify(`[data-ot-id="${part.el}"]`);
        await evaluate(`document.querySelector(${sel})?.setAttribute("data-ot-clip", "")`);
        try {
          const [x, y, w, h] = win.clip;
          const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            clip: { x: x + at.x, y: y + at.y, width: w, height: h, scale: win.scale },
          });
          const png = Buffer.from(shot.data, "base64");
          const name = `${createHash("sha1").update(png).digest("hex")}.png`;
          const path = join(opts.assetsDir, name);
          if (!existsSync(path)) writeFileSync(path, png);
          part.picture = relative(opts.dir, path).split(sep).join("/");
          part.clip = win.clip;
          part.clipScale = win.scale;
          taken++;
        } catch (e) {
          if (isCdpStall(e)) {
            stalled = true;
            throw e;
          }
          part.noPicture = `the screenshot failed (${(e as Error).message})`;
        } finally {
          if (!stalled)
            await evaluate(`document.querySelector(${sel})?.removeAttribute("data-ot-clip")`);
        }
      }
    } catch (e) {
      if (isCdpStall(e)) stalled = true;
      throw e;
    } finally {
      if (!stalled) {
        await evaluate('document.querySelector("style[data-ot-clip-css]")?.remove()').catch(
          () => {},
        );
        await cdp.send("Emulation.setDefaultBackgroundColorOverride", {}).catch(() => {});
      }
    }
    file.ms.pictures = Date.now() - t0;
  }
  await writeFile(join(opts.dir, "parts.json"), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

/**
 * Measure the parts of saved states that already exist (each a folder with
 * state.html + index.json) — for states saved before parts.json, which
 * `open-take components` meets. One page in `browser`, emulated at each
 * state's own viewport @1×, network blocked, as the fidelity check opens
 * them. A state that cannot be measured is a line in `failed`.
 */
export async function measureStateDirs(args: {
  browser: Browser;
  dirs: string[];
  pictures?: boolean;
  minArea?: number;
}): Promise<{
  measured: { dir: string; parts: PartsFile }[];
  failed: { dir: string; why: string }[];
}> {
  const measured: { dir: string; parts: PartsFile }[] = [];
  const failed: { dir: string; why: string }[] = [];
  let page: { cdp: CDP; targetId: string } | null = null;
  try {
    for (const dir of args.dirs) {
      const index = readStateIndex(dir);
      if (typeof index === "string") {
        failed.push({ dir, why: index });
        continue;
      }
      const { w, h } = index.viewport;
      try {
        if (!page) page = await openFidelityPage(args.browser, w, h);
        else
          await page.cdp.send("Emulation.setDeviceMetricsOverride", {
            width: w,
            height: h,
            deviceScaleFactor: 1,
            mobile: false,
          });
        await renderState(page.cdp, join(dir, "state.html"), w, h);
        const parts = await measureParts(page.cdp, {
          dir,
          index,
          assetsDir: join(dir, "..", "assets"),
          ...(args.pictures != null ? { pictures: args.pictures } : {}),
          ...(args.minArea != null ? { minArea: args.minArea } : {}),
        });
        measured.push({ dir, parts });
      } catch (e) {
        failed.push({ dir, why: (e as Error).message });
        // a page that stopped answering is replaced for the next state
        if (page && isCdpStall(e)) {
          await closeFidelityPage(args.browser, page);
          page = null;
        }
      }
    }
  } finally {
    if (page) await closeFidelityPage(args.browser, page);
  }
  return { measured, failed };
}

/** One stderr line: what the states cost the take and how they scored. */
export function summarizeDomStates(states: DomStateRaw[], items: DomStateItem[]): string {
  const moving = items.filter((i) => i.moving).map((i) => i.id);
  if (!states.length)
    return moving.length
      ? `captureTakeCDP: DOM states — none saved: the page was still moving at ${moving.join(", ")} (use the recording)`
      : "captureTakeCDP: DOM states — none captured";
  const total = states.reduce((s, r) => s + r.ms, 0);
  const each = states.map((r) => `${r.id} ${r.ms}ms`).join(", ");
  const scored = items.filter((i) => i.fidelity);
  const ok = scored.filter((i) => i.fidelity!.ok).length;
  const worst = scored.reduce<DomStateItem | null>(
    (w, i) => (!w || i.fidelity!.psnr < w.fidelity!.psnr ? i : w),
    null,
  );
  return (
    `captureTakeCDP: DOM states — ${states.length} captured, +${(total / 1000).toFixed(1)}s on the take (${each}); ` +
    (moving.length
      ? `${moving.join(", ")} not saved — the page was still moving there (use the recording); `
      : "") +
    `fidelity ${ok}/${scored.length} ok` +
    (worst
      ? ` (lowest ${worst.id}: psnr ${worst.fidelity!.psnr.toFixed(1)}, ${(worst.fidelity!.diffFrac * 100).toFixed(1)}% px differ)`
      : "")
  );
}
