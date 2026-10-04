// What a film page's layout gets wrong at a given moment, read from the page
// itself — the defects an author who cannot watch the film misses:
//
//   text-over-text   two pieces of text drawn on top of each other (a caption
//                    over the real interface's own text, inside an <iframe> too)
//   text-over-badge  text running into a small painted element that is not
//                    its own box (a number growing into a "vs" disc)
//   text-off-frame   text cut by the edge of the frame
//
// Only what is clearly visible counts: both pieces at an effective opacity of
// at least 0.6 (a cross-fade's two scenes are not a collision), where their
// glyphs reach (not their fonts' full line boxes), as far as the boxes that
// hold them let them show. The size each piece of text is drawn at is read
// too — its font size times how much it is scaled on screen — as
// information: what is too small to read is not decided here. Nothing here
// judges taste; contrast and crowding are not checked, and text drawn into a
// canvas or a video is pixels, not text.
//
// `readPageLayout` plays the film's page on its clock and samples it over the
// film's time; a finding counts once it holds for two samples in a row (an
// entrance sliding past an edge for a moment does not).
//
// The probe is serialized into the page (Function#toString): it must not
// reference anything outside its own body.

import { type HtmlBrowser, launchHtmlBrowser } from "../html/cdp";
import { serveDirectory } from "../html/server";
import { type FilmPageInfo, filmClockSource } from "./clock";
import { resolveFilmPage } from "./render";

export type LayoutFinding = {
  kind: "text-over-text" | "text-over-badge" | "text-off-frame";
  /** the two parties, described (the second is absent for text-off-frame) */
  a: string;
  b?: string;
  /** where, in frame CSS px: x, y, w, h */
  box: [number, number, number, number];
};

/** a finding that held, and from when to when (seconds, the film's own time) */
export type LayoutSpan = LayoutFinding & { from: number; to: number };

/** a piece of text as drawn: its description and its size in frame px */
type DrawnText = { text: string; px: number };

export function layoutProbeSource(): string {
  return `(() => { const __name = (f) => f; return (${probeLayout.toString()})(); })()`;
}

function probeLayout(): { findings: LayoutFinding[]; texts: DrawnText[]; unread: string[] } {
  const vw = innerWidth;
  const vh = innerHeight;
  type Box = { x: number; y: number; w: number; h: number };
  type Text = { el: Element; boxes: Box[]; label: string; root: Document; px: number };
  type Badge = { el: Element; box: Box; label: string };
  const MIN_OPACITY = 0.6;

  /** how much an element is scaled on screen — by its ancestors' transforms,
   *  a camera's zoom: the box it is drawn in over the box it is laid out in */
  const scaleOf = (el: Element): number => {
    const drawn = el.getBoundingClientRect().height;
    const laid = (el as HTMLElement).offsetHeight;
    if (typeof laid === "number") return laid > 0 ? drawn / laid : 1;
    try {
      // SVG text: its box in its own units
      const own = (el as SVGGraphicsElement).getBBox?.().height;
      return own && own > 0 ? drawn / own : 1;
    } catch {
      return 1;
    }
  };

  // effective opacity: none when the element itself is not visible — its own
  // computed visibility, which a descendant can set back to visible under a
  // hidden ancestor (a part a lifted screen shows), or a display:none
  // ancestor — else its opacity times every ancestor's (memoized per probe)
  const alphas = new Map<Element, number>();
  const alphaOf = (el: Element | null, view: Window): number => {
    if (!el) return 1;
    const hit = alphas.get(el);
    if (hit !== undefined) return hit;
    const cs = view.getComputedStyle(el);
    const own = cs.display === "none" ? 0 : Number(cs.opacity) || 0;
    const o = own === 0 ? 0 : own * alphaOf(el.parentElement, view);
    alphas.set(el, o);
    return o;
  };
  const opacityOf = (el: Element | null, view: Window): number => {
    if (!el) return 1;
    const v = view.getComputedStyle(el).visibility;
    return v === "hidden" || v === "collapse" ? 0 : alphaOf(el, view);
  };
  /** the alpha of a computed colour: rgba(…, a) or 1 */
  const alpha = (c: string): number => {
    const m = /rgba?\(([^)]*)\)/.exec(c);
    if (!m) return c === "transparent" ? 0 : 1;
    const parts = m[1]!.split(/[,/\s]+/).filter(Boolean);
    return parts.length >= 4 ? Number.parseFloat(parts[3]!) : 1;
  };
  /** what an element's own and its ancestors' transforms (an iframe's
   *  included) do to it on screen, without what moves it: a, b, c, d of a 2D
   *  matrix. Within a 3D context (`transform-style: preserve-3d`) the whole
   *  matrices multiply before the plane is taken; perspective is left out.
   *  Memoized per probe. */
  type Lin = [number, number, number, number];
  const UPRIGHT: Lin = [1, 0, 0, 1];
  const SVG_NS = "http://www.w3.org/2000/svg";
  /** what transforms apply to when `display` is inline: replaced elements */
  const REPLACED = new Set([
    "img",
    "video",
    "canvas",
    "iframe",
    "embed",
    "object",
    "input",
    "select",
    "textarea",
    "svg",
  ]);
  /** an element's own transform — `rotate` and `scale` first, then
   *  `transform`, which does not show them; an SVG's stretched viewBox too —
   *  or null where there is none, or none applies (a box-less or plain
   *  inline element) */
  const ownOf = (el: Element, cs: CSSStyleDeclaration): DOMMatrix | null => {
    if (cs.display === "contents" || cs.display === "none") return null;
    if (cs.display === "inline" && el.namespaceURI !== SVG_NS && !REPLACED.has(el.localName))
      return null;
    let m = new DOMMatrix();
    if (cs.rotate && cs.rotate !== "none") {
      const v = cs.rotate.trim().split(/\s+/); // "30deg", "x 30deg", "1 1 0 30deg"
      const deg = Number.parseFloat(v[v.length - 1] ?? "0");
      const axis =
        v.length === 4
          ? v.slice(0, 3).map(Number)
          : v[0] === "x"
            ? [1, 0, 0]
            : v[0] === "y"
              ? [0, 1, 0]
              : [0, 0, 1];
      m = m.rotateAxisAngle(axis[0], axis[1], axis[2], deg);
    }
    if (cs.scale && cs.scale !== "none") {
      const v = cs.scale.trim().split(/\s+/).map(Number.parseFloat);
      m = m.scale(v[0], v[1] ?? v[0], v[2] ?? 1);
    }
    if (cs.transform && cs.transform !== "none") m = m.multiply(new DOMMatrix(cs.transform));
    if (el.namespaceURI === SVG_NS && el.localName === "svg") {
      const svg = el as SVGSVGElement;
      const vb = svg.viewBox?.baseVal;
      // SVG_PRESERVEASPECTRATIO_NONE: the viewBox stretched to the box
      if (vb && vb.width > 0 && vb.height > 0 && svg.preserveAspectRatio?.baseVal.align === 1) {
        const w = svg.clientWidth || svg.width.baseVal.value;
        const h = svg.clientHeight || svg.height.baseVal.value;
        if (w > 0 && h > 0) m = m.scale(w / vb.width, h / vb.height);
      }
    }
    return m.isIdentity ? null : m;
  };
  const times = (u: Lin, m: DOMMatrix): Lin => [
    u[0] * m.a + u[2] * m.b,
    u[1] * m.a + u[3] * m.b,
    u[0] * m.c + u[2] * m.d,
    u[1] * m.c + u[3] * m.d,
  ];
  /** whether what an element holds stays in its 3D space: `preserve-3d`,
   *  unless a grouping property flattens it all the same (a clip, a fade, a
   *  filter, a blend, a mask, isolation, paint containment) */
  const keeps3D = (cs: CSSStyleDeclaration): boolean =>
    cs.transformStyle === "preserve-3d" &&
    /^(visible|clip)$/.test(cs.overflowX) &&
    /^(visible|clip)$/.test(cs.overflowY) &&
    !(Number(cs.opacity) < 1) &&
    cs.filter === "none" &&
    (!cs.backdropFilter || cs.backdropFilter === "none") &&
    cs.clipPath === "none" &&
    (!cs.clip || cs.clip === "auto") &&
    cs.isolation !== "isolate" &&
    (!cs.maskImage || cs.maskImage === "none") &&
    cs.mixBlendMode === "normal" &&
    !/paint|strict|content/.test(cs.contain);
  /** what a parent's `perspective` does to what it holds (about its origin:
   *  which plane is tilted, not where, is what matters here) */
  const perspectiveOf = (cs: CSSStyleDeclaration): DOMMatrix | null => {
    const d = Number.parseFloat(cs.perspective);
    return cs.perspective !== "none" && d > 0
      ? new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / d, 0, 0, 0, 1])
      : null;
  };
  /** a plane tilted under perspective: no single 2D matrix maps it */
  const projective = (m: DOMMatrix) => Math.abs(m.m14) + Math.abs(m.m24) > 1e-9;
  /** per element: its 2D part on screen; the 3D context it belongs to (the
   *  whole matrix from that context's root down) and the 2D part above it;
   *  whether it, or what holds it, is tilted under perspective */
  type Turn = { lin: Lin; ctx: DOMMatrix; above: Lin; projected: boolean };
  const turns = new Map<Element, Turn>();
  const turnOf = (el: Element, view: Window, base: Lin): Turn => {
    const hit = turns.get(el);
    if (hit) return hit;
    const p = el.parentElement;
    const pcs = p ? view.getComputedStyle(p) : null;
    const own = ownOf(el, view.getComputedStyle(el));
    // a parent's perspective reaches whatever it holds in its 3D space, an
    // untransformed wrapper included
    const persp = pcs ? perspectiveOf(pcs) : null;
    const local = persp ? (own ? persp.multiply(own) : persp) : own;
    let t: Turn;
    if (p && pcs && keeps3D(pcs)) {
      const pt = turnOf(p, view, base);
      const ctx = local ? pt.ctx.multiply(local) : pt.ctx;
      t = {
        lin: times(pt.above, ctx),
        ctx,
        above: pt.above,
        projected: pt.projected || projective(ctx),
      };
    } else {
      const pt = p ? turnOf(p, view, base) : null;
      const above = pt ? pt.lin : base;
      const ctx = local ?? new DOMMatrix();
      t = {
        lin: local ? times(above, local) : above,
        ctx,
        above,
        projected: !!pt?.projected || projective(ctx),
      };
    }
    turns.set(el, t);
    return t;
  };
  const linOf = (el: Element, view: Window, base: Lin): Lin => turnOf(el, view, base).lin;
  /** turned, skewed or mirrored on screen: its boxes would be the upright
   *  boxes around it, and its size a guess — such text is named, not read */
  const askew = (l: Lin) =>
    l[0] < 0 ||
    l[3] < 0 ||
    Math.abs(l[1]) + Math.abs(l[2]) > 0.01 * (Math.abs(l[0]) + Math.abs(l[3]));
  const unread = new Set<string>();
  const describe = (el: Element, prefix: string): string => {
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28);
    return `${prefix}${el.localName}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  const texts: Text[] = [];
  const badges: Badge[] = [];
  const intersect = (a: Box, b: Box): Box | null => {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  /** whether an element is where positioned descendants are placed from: a
   *  positioned one (for `absolute`), or one with a transform, a filter or
   *  containment (for `fixed` too) */
  const holds = (cs: CSSStyleDeclaration, fixed: boolean): boolean =>
    (!fixed && cs.position !== "static") ||
    cs.transform !== "none" ||
    cs.perspective !== "none" ||
    cs.filter !== "none" ||
    (!!cs.backdropFilter && cs.backdropFilter !== "none") ||
    /paint|layout|strict|content/.test(cs.contain) ||
    /transform|perspective|filter/.test(cs.willChange);
  /** the element whose overflow can clip `el`: its parent, or for an
   *  absolutely or fixed positioned one the ancestor it is placed from — those
   *  in between do not clip it; null when that is the frame itself */
  const containerOf = (el: Element, view: Window): Element | null => {
    const pos = view.getComputedStyle(el).position;
    if (pos !== "absolute" && pos !== "fixed") return el.parentElement;
    for (let a = el.parentElement; a; a = a.parentElement)
      if (holds(view.getComputedStyle(a), pos === "fixed")) return a;
    return null;
  };
  /** an element's overflow clips what it holds — except the root's, and the
   *  body's while the root's is visible: those belong to the frame */
  const clipping = (el: Element, view: Window): boolean => {
    const doc = el.ownerDocument;
    if (el === doc.documentElement) return false;
    const visible = (cs: CSSStyleDeclaration) =>
      cs.overflowX === "visible" && cs.overflowY === "visible";
    if (el === doc.body && visible(view.getComputedStyle(doc.documentElement))) return false;
    const cs = view.getComputedStyle(el);
    return cs.display !== "contents" && !visible(cs);
  };
  /** what of `base` shows of what `holder` holds: its own box when its
   *  overflow clips, within what its own holder lets show (a film's "window"
   *  around a scaled iframe, a masked line) — memoized per holder */
  const clips = new Map<Element, Box | null>();
  const shownIn = (
    holder: Element | null,
    view: Window,
    map: (b: DOMRect) => Box,
    base: Box,
  ): Box | null => {
    if (!holder) return base;
    if (clips.has(holder)) return clips.get(holder)!;
    let clip = shownIn(containerOf(holder, view), view, map, base);
    if (clip && clipping(holder, view)) clip = intersect(clip, map(holder.getBoundingClientRect()));
    clips.set(holder, clip);
    return clip;
  };
  /** what of `base` shows of an element: what its holder lets show */
  const clipOf = (el: Element, view: Window, map: (b: DOMRect) => Box, base: Box) =>
    shownIn(containerOf(el, view), view, map, base);

  const collect = (
    doc: Document,
    view: Window,
    map: (b: DOMRect) => Box,
    clip: Box,
    baseOpacity: number,
    prefix: string,
    /** how much the document itself is scaled on screen (an iframe's) */
    scale: number,
    /** what the frame holding the document turns or skews (an iframe's) */
    base: Lin,
    /** whether the frame's box maps what it holds: not when the frame is
     *  turned, mirrored or tilted under perspective — then all its text is
     *  named */
    mapped: boolean,
  ) => {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    const seen = new Map<Element, Text>();
    // the document's own fonts, to measure its text's glyphs with
    const pen = doc.createElement("canvas").getContext("2d");
    /** how much of a line of text's box, top and bottom, its glyphs leave
     *  empty: the box is the font's full height, the ink only what these
     *  characters reach — a label tucked under a big number shares its line
     *  box, not its glyphs */
    const inkOf = (cs: CSSStyleDeclaration, text: string) => {
      const whole = { top: 0, bottom: 0 };
      if (!pen) return whole;
      pen.font = "10px serif";
      pen.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      if (pen.font === "10px serif") return whole; // a font canvas cannot read
      const m = pen.measureText(text);
      const box = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
      if (!(box > 0)) return whole;
      const top = Math.max(0, (m.fontBoundingBoxAscent - m.actualBoundingBoxAscent) / box);
      const bottom = Math.max(0, (m.fontBoundingBoxDescent - m.actualBoundingBoxDescent) / box);
      return top + bottom < 0.95 ? { top, bottom } : whole;
    };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue?.trim()) continue;
      const el = n.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      if (baseOpacity * opacityOf(el, view) < MIN_OPACITY) continue;
      // the block the text belongs to: a caption split into per-character
      // spans for its entrance is one piece of text, not one per character
      let owner: Element = el;
      while (
        owner.parentElement &&
        owner.parentElement !== doc.body &&
        /^(inline|inline-block|inline-flex|contents)$/.test(view.getComputedStyle(owner).display)
      )
        owner = owner.parentElement;
      range.selectNodeContents(n);
      if (!mapped) {
        // the frame's box cannot place it: named when drawn in the frame's
        // own view at all
        const inView = Array.from(range.getClientRects()).some(
          (r) =>
            r.width >= 2 &&
            r.height >= 2 &&
            r.right > 0 &&
            r.bottom > 0 &&
            r.left < view.innerWidth &&
            r.top < view.innerHeight,
        );
        if (inView) unread.add(describe(owner, prefix));
        continue;
      }
      // what the frame, the iframe's box and any clipping box that holds the
      // text — its own element first — cut off is not drawn
      const visible = shownIn(el, view, map, clip);
      if (!visible) continue;
      const ink = inkOf(view.getComputedStyle(el), n.nodeValue);
      const boxes: Box[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 2 || r.height < 2) continue;
        const glyphs = new DOMRect(
          r.left,
          r.top + ink.top * r.height,
          r.width,
          r.height * (1 - ink.top - ink.bottom),
        );
        const v = intersect(map(glyphs), visible);
        if (v && v.w >= 2 && v.h >= 2) boxes.push(v);
      }
      if (!boxes.length) continue;
      // drawn at all, but turned: named, not read
      if (askew(linOf(el, view, base))) {
        unread.add(describe(owner, prefix));
        continue;
      }
      // the size it is drawn at: its own font size, as scaled on screen
      const px = (Number.parseFloat(view.getComputedStyle(el).fontSize) || 0) * scaleOf(el) * scale;
      const t = seen.get(owner);
      if (t) {
        t.boxes.push(...boxes);
        t.px = Math.min(t.px, px);
      } else {
        const entry = { el: owner, boxes, label: describe(owner, prefix), root: doc, px };
        seen.set(owner, entry);
        texts.push(entry);
      }
    }
    // small painted elements: badges, chips, discs, buttons
    for (const el of Array.from(doc.body.querySelectorAll("*"))) {
      if (!mapped || askew(linOf(el, view, base))) continue; // its box would be the one around it
      const cs = view.getComputedStyle(el);
      const painted =
        alpha(cs.backgroundColor) >= 0.5 ||
        (Number.parseFloat(cs.borderTopWidth) > 0 &&
          cs.borderTopStyle !== "none" &&
          alpha(cs.borderTopColor) >= 0.5);
      if (!painted) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const full = map(r);
      if (full.w * full.h > 0.04 * vw * vh) continue; // a panel or a page, not a badge
      if (baseOpacity * opacityOf(el, view) < MIN_OPACITY) continue;
      const visible = clipOf(el, view, map, clip);
      const m = visible && intersect(full, visible);
      if (!m) continue;
      badges.push({ el, box: m, label: describe(el, prefix) });
    }
  };

  const frame: Box = { x: 0, y: 0, w: vw, h: vh };
  collect(
    document,
    window,
    (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }),
    frame,
    1,
    "",
    1,
    UPRIGHT,
    true,
  );
  // same-origin iframes, mapped into the frame through their own box and scale
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    let doc: Document | null = null;
    try {
      doc = f.contentDocument;
    } catch {
      continue;
    }
    const view = f.contentWindow;
    if (!doc?.body || !view) continue;
    const o = opacityOf(f, window);
    if (o < MIN_OPACITY) continue;
    // its page shows in its content box (inside its border and padding), as
    // scaled as the frame's own box is on screen
    const fb = f.getBoundingClientRect();
    const sx = f.offsetWidth ? fb.width / f.offsetWidth : 1;
    const sy = f.offsetHeight ? fb.height / f.offsetHeight : 1;
    const fcs = getComputedStyle(f);
    const pad = (side: "Left" | "Right" | "Top" | "Bottom") =>
      Number.parseFloat(fcs[`padding${side}`]) || 0;
    const left = fb.left + (f.clientLeft + pad("Left")) * sx;
    const top = fb.top + (f.clientTop + pad("Top")) * sy;
    const map = (r: DOMRect) => ({
      x: left + r.left * sx,
      y: top + r.top * sy,
      w: r.width * sx,
      h: r.height * sy,
    });
    // that box, within what the boxes holding it let show (measured from
    // the frame, as everything on this page is: the clips are shared)
    const own = {
      x: left,
      y: top,
      w: Math.max(0, f.clientWidth - pad("Left") - pad("Right")) * sx,
      h: Math.max(0, f.clientHeight - pad("Top") - pad("Bottom")) * sy,
    };
    const shown = clipOf(
      f,
      window,
      (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }),
      frame,
    );
    // a frame turned, mirrored or tilted in perspective: its box cannot map
    // what it holds, and whether it shows at all is read from the box around it
    const turn = turnOf(f, window, UPRIGHT);
    const mapped = !askew(turn.lin) && !turn.projected;
    const clip =
      shown &&
      intersect(mapped ? own : { x: fb.left, y: fb.top, w: fb.width, h: fb.height }, shown);
    if (clip) collect(doc, view, map, clip, o, `iframe › `, sy, turn.lin, mapped);
  }

  const overlap = (a: Box, b: Box) => {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  const related = (a: Element, b: Element) => a === b || a.contains(b) || b.contains(a);
  const findings: LayoutFinding[] = [];
  const round = (b: Box): [number, number, number, number] => [
    Math.round(b.x),
    Math.round(b.y),
    Math.round(b.w),
    Math.round(b.h),
  ];

  // text over text: a real overlap of glyph boxes, not a touch
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const A = texts[i]!;
      const B = texts[j]!;
      if (A.root === B.root && related(A.el, B.el)) continue;
      // inside one embedded page the overlap is the product's own design
      if (A.root === B.root && A.root !== document) continue;
      let hit: Box | null = null;
      for (const a of A.boxes)
        for (const b of B.boxes) {
          const o = overlap(a, b);
          if (o && o.w * o.h >= Math.max(40, 0.2 * Math.min(a.w * a.h, b.w * b.h))) hit = o;
        }
      if (hit) findings.push({ kind: "text-over-text", a: A.label, b: B.label, box: round(hit) });
    }
  // text into a badge that is not its own box
  for (const T of texts)
    for (const G of badges) {
      if (T.root === G.el.ownerDocument && related(T.el, G.el)) continue;
      if (T.root === G.el.ownerDocument && T.root !== document) continue;
      for (const a of T.boxes) {
        const o = overlap(a, G.box);
        if (o && o.w * o.h >= Math.max(40, 0.15 * Math.min(a.w * a.h, G.box.w * G.box.h))) {
          findings.push({ kind: "text-over-badge", a: T.label, b: G.label, box: round(o) });
          break;
        }
      }
    }
  // the film's own text cut by the frame's edge — where what shows of it
  // reaches that edge: a box inside the frame that clips it first is design
  for (const T of texts) {
    if (T.root !== document) continue;
    const r = T.el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(T.el);
    const full = range.getBoundingClientRect();
    const box = full.width > 0 ? full : r;
    const reaches = (edge: (b: Box) => boolean) => T.boxes.some(edge);
    if (
      (box.left < -1 && reaches((b) => b.x <= 1)) ||
      (box.top < -1 && reaches((b) => b.y <= 1)) ||
      (box.right > vw + 1 && reaches((b) => b.x + b.w >= vw - 1)) ||
      (box.bottom > vh + 1 && reaches((b) => b.y + b.h >= vh - 1))
    ) {
      const vis = overlap({ x: box.left, y: box.top, w: box.width, h: box.height }, frame);
      if (vis) findings.push({ kind: "text-off-frame", a: T.label, box: round(vis) });
    }
  }
  return {
    findings,
    texts: texts.map((t) => ({ text: t.label, px: Math.round(t.px * 10) / 10 })),
    unread: [...unread],
  };
}

export type PageReading = {
  /** what held for two samples in a row */
  spans: LayoutSpan[];
  /** the smallest text drawn — at about the same size for two samples in a
   *  row, so text growing in from nothing does not count — and when */
  smallest: { px: number; at: number; text: string } | null;
  /** text drawn turned, skewed or mirrored, which is named rather than read */
  unread: string[];
  /** the page's own window.__film.marks, as prepare() returned them */
  marks: unknown;
  /** the size the page was laid out at (CSS px: the master's frame) */
  width: number;
  height: number;
};

/** Play the film's page on the film clock and read its layout every `every`
 *  seconds of [from, from + duration) — the stretch of the page the film
 *  shows. Times come back in the film's own time (its first frame is 0). */
export async function readPageLayout(opts: {
  page: string;
  root?: string;
  chromePath: string;
  from: number;
  duration: number;
  every: number;
  /** the size the film was rendered at; default the page's own, else `fallback` */
  width?: number;
  height?: number;
  fallback: { width: number; height: number };
  onConsole?: (level: string, text: string) => void;
}): Promise<PageReading> {
  const { root, urlPath } = resolveFilmPage(opts.page, opts.root);
  const server = await serveDirectory(root);
  // as `film render` opens it: the same clock, animations still until it sets them
  const open = (width: number, height: number) =>
    launchHtmlBrowser({
      chromePath: opts.chromePath,
      url: `${server.url}${urlPath}`,
      width,
      height,
      initScript: filmClockSource({ seed: 0x5eed, epochMs: Date.now() }),
      stillAnimations: true,
      onConsole: opts.onConsole,
      timeoutMs: 120_000,
      profilePrefix: "open-take-check-",
    });
  const prepare = async (b: HtmlBrowser) => {
    if (!(await b.evaluate<boolean>(`typeof window.__ot === "object"`)))
      throw new Error("film check: the film clock did not install in the page");
    return b.evaluate<FilmPageInfo>("window.__ot.prepare()", { timeoutMs: 120_000 });
  };
  try {
    let width = opts.width ?? opts.fallback.width;
    let height = opts.height ?? opts.fallback.height;
    let browser = await open(width, height);
    try {
      let info = await prepare(browser);
      // a page that declares its size, when the film does not say, is laid
      // out again at it — as `film render` does
      if (
        opts.width === undefined &&
        info.width &&
        info.height &&
        (info.width !== width || info.height !== height)
      ) {
        await browser.close();
        width = info.width;
        height = info.height;
        browser = await open(width, height);
        info = await prepare(browser);
      }
      // findings seen at the last sample, and since when
      const running = new Map<string, LayoutSpan & { count: number }>();
      const spans: LayoutSpan[] = [];
      const end = (key: string) => {
        const s = running.get(key)!;
        running.delete(key);
        if (s.count >= 2)
          spans.push({ kind: s.kind, a: s.a, b: s.b, box: s.box, from: s.from, to: s.to });
      };
      let smallest: PageReading["smallest"] = null;
      const unread = new Set<string>();
      // each piece of text's size at the sample before, and when that was
      let before = new Map<string, number>();
      let beforeAt = 0;
      for (let k = 0; ; k++) {
        const at = Math.round(k * opts.every * 1000) / 1000;
        if (at >= opts.duration - 1e-9) break;
        await browser.evaluate(`window.__ot.seek(${opts.from + at})`);
        const read = await browser.evaluate<ReturnType<typeof probeLayout>>(layoutProbeSource());
        const { findings, texts } = read;
        for (const u of read.unread) unread.add(u);
        const now = new Set<string>();
        for (const f of findings) {
          const key = `${f.kind}|${f.a}|${f.b ?? ""}`;
          now.add(key);
          const s = running.get(key);
          if (s) {
            s.to = at;
            s.count++;
          } else running.set(key, { ...f, from: at, to: at, count: 1 });
        }
        for (const key of [...running.keys()]) if (!now.has(key)) end(key);
        // a size counts once a piece of text keeps it, within a tenth, from
        // one sample to the next
        const sizes = new Map<string, number>();
        for (const t of texts) sizes.set(t.text, Math.min(t.px, sizes.get(t.text) ?? t.px));
        for (const [text, px] of sizes) {
          const was = before.get(text);
          if (was === undefined || Math.abs(px - was) > 0.1 * Math.max(px, was)) continue;
          if (!smallest || was < smallest.px) smallest = { px: was, at: beforeAt, text };
        }
        before = sizes;
        beforeAt = at;
      }
      for (const key of [...running.keys()]) end(key);
      return {
        spans: spans.sort((a, b) => a.from - b.from),
        smallest,
        unread: [...unread],
        marks: info.marks,
        width,
        height,
      };
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}
