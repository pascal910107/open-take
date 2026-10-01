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
// at least 0.6 (a cross-fade's two scenes are not a collision). Nothing here
// judges taste; contrast, crowding and legibility are not checked.
//
// The probe is serialized into the page (Function#toString): it must not
// reference anything outside its own body.

export type LayoutFinding = {
  kind: "text-over-text" | "text-over-badge" | "text-off-frame";
  /** the two parties, described (the second is absent for text-off-frame) */
  a: string;
  b?: string;
  /** where, in frame CSS px: x, y, w, h */
  box: [number, number, number, number];
};

export function layoutProbeSource(): string {
  return `(() => { const __name = (f) => f; return (${probeLayout.toString()})(); })()`;
}

function probeLayout(): unknown {
  const vw = innerWidth;
  const vh = innerHeight;
  type Box = { x: number; y: number; w: number; h: number };
  type Text = { el: Element; boxes: Box[]; label: string; root: Document };
  type Badge = { el: Element; box: Box; label: string };
  const MIN_OPACITY = 0.6;

  // effective opacity: the element's own times every ancestor's (memoized per probe)
  const opacities = new Map<Element, number>();
  const opacityOf = (el: Element | null, view: Window): number => {
    if (!el) return 1;
    const hit = opacities.get(el);
    if (hit !== undefined) return hit;
    const cs = view.getComputedStyle(el);
    const own = cs.visibility === "hidden" || cs.display === "none" ? 0 : Number(cs.opacity) || 0;
    const o = own === 0 ? 0 : own * opacityOf(el.parentElement, view);
    opacities.set(el, o);
    return o;
  };
  /** the alpha of a computed colour: rgba(…, a) or 1 */
  const alpha = (c: string): number => {
    const m = /rgba?\(([^)]*)\)/.exec(c);
    if (!m) return c === "transparent" ? 0 : 1;
    const parts = m[1]!.split(/[,/\s]+/).filter(Boolean);
    return parts.length >= 4 ? Number.parseFloat(parts[3]!) : 1;
  };
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
  /** what of `base` the element's ancestors leave visible: every ancestor whose
   *  overflow clips (a film's "window" around a scaled iframe, a masked line) */
  const clips = new Map<Element, Box | null>();
  const clipOf = (el: Element, view: Window, map: (b: DOMRect) => Box, base: Box): Box | null => {
    const parent = el.parentElement;
    if (!parent) return base;
    if (clips.has(parent)) return clips.get(parent)!;
    let clip = clipOf(parent, view, map, base);
    const cs = view.getComputedStyle(parent);
    if (clip && (cs.overflowX !== "visible" || cs.overflowY !== "visible"))
      clip = intersect(clip, map(parent.getBoundingClientRect()));
    clips.set(parent, clip);
    return clip;
  };

  const collect = (
    doc: Document,
    view: Window,
    map: (b: DOMRect) => Box,
    clip: Box,
    baseOpacity: number,
    prefix: string,
  ) => {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    const seen = new Map<Element, Text>();
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
      // what the frame, the iframe's box and any clipping ancestor cut off is not drawn
      const visible = clipOf(n.parentElement!, view, map, clip);
      if (!visible) continue;
      const boxes: Box[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 2 || r.height < 2) continue;
        const v = intersect(map(r), visible);
        if (v && v.w >= 2 && v.h >= 2) boxes.push(v);
      }
      if (!boxes.length) continue;
      const t = seen.get(owner);
      if (t) t.boxes.push(...boxes);
      else {
        const entry = { el: owner, boxes, label: describe(owner, prefix), root: doc };
        seen.set(owner, entry);
        texts.push(entry);
      }
    }
    // small painted elements: badges, chips, discs, buttons
    for (const el of Array.from(doc.body.querySelectorAll("*"))) {
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
    const fb = f.getBoundingClientRect();
    const sx = fb.width / (f.clientWidth || fb.width);
    const sy = fb.height / (f.clientHeight || fb.height);
    const map = (r: DOMRect) => ({
      x: fb.left + r.left * sx,
      y: fb.top + r.top * sy,
      w: r.width * sx,
      h: r.height * sy,
    });
    const own = intersect({ x: fb.left, y: fb.top, w: fb.width, h: fb.height }, frame);
    const clip =
      own && clipOf(f, window, (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }), own);
    if (clip) collect(doc, view, map, clip, o, `iframe › `);
  }

  const overlap = (a: Box, b: Box) => {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  const related = (a: Element, b: Element) => a === b || a.contains(b) || b.contains(a);
  const findings: { kind: string; a: string; b?: string; box: [number, number, number, number] }[] =
    [];
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
  // the film's own text cut by the frame's edge
  for (const T of texts) {
    if (T.root !== document) continue;
    const r = T.el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(T.el);
    const full = range.getBoundingClientRect();
    const box = full.width > 0 ? full : r;
    if (box.left < -1 || box.top < -1 || box.right > vw + 1 || box.bottom > vh + 1) {
      const vis = overlap({ x: box.left, y: box.top, w: box.width, h: box.height }, frame);
      if (vis) findings.push({ kind: "text-off-frame", a: T.label, box: round(vis) });
    }
  }
  return findings;
}
