// Saved screens on the film's stage — the product's real interface, as
// `open-take make --states` saves it — as material: frame it like a camera,
// lift a part of it, place it anywhere, act on it (type into a field, press a
// button, switch it to another state). Part of film-kit.js, optional like
// everything in it.
//
//   const home = await openScreen("takes/home.take/states/s2/state.html");
//   const card = await openScreen(src, { show: ["e16"] }); // only that part paints
//
// A part is named by its id in `open-take states <take> --state sN --json`
// ("e16"), by a CSS selector, or as an element of the saved page.
//
// A screen is set from film time like the rest of the page. place() and view()
// take where it is now. The actions (set, type, press) take t: call them on
// every frame, without conditions — each sets what it does at t, the screen
// starts every new t from the page as it was saved, so a frame comes out the
// same in any order. When two actions set the same thing, the later call wins.

import {
  type Box,
  clampView,
  ease,
  frame as frameView,
  graphemes,
  type Typing,
  typing,
  type View,
} from "./kit";

/** a part of a saved page: "e16" (its id in `open-take states --json`), a CSS
 *  selector, or the element itself */
export type Target = string | Element;

export type ScreenOptions = {
  /** where the screen goes on the film's page (default document.body); place()
   *  and window() boxes are in its coordinates */
  parent?: HTMLElement;
  /** only these parts paint — everything else, the page's own background
   *  included, is transparent — so they can be lifted off the page and moved.
   *  What they contain keeps its own visibility. */
  show?: string | string[];
  /** these parts do not paint */
  hide?: string | string[];
  /** more CSS for the saved page */
  css?: string;
  /** the saved page's viewport in CSS px; default as captured (its index.json) */
  width?: number;
  height?: number;
  /** scroll the saved page to this offset instead of where it was captured */
  scrollY?: number;
};

type Placement = { x: number; y: number; s: number; r: number; ax: number; ay: number };

const selector = (t: string) => (/^e\d+$/.test(t) ? `[data-ot-id="${t}"]` : t);
const list = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
const isView = (v: unknown): v is View =>
  typeof v === "object" && v !== null && "cx" in v && "cy" in v && "w" in v;
const isField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  el.localName === "input" || el.localName === "textarea";

/** what the saved page needs to sit on a stage: no scrollbars */
const STAGE_CSS = "html{scrollbar-width:none}::-webkit-scrollbar{display:none}";

/** Open a saved screen on the film's page; resolves once it stands as it was
 *  captured (inputs, scroll, canvases, fonts and images restored). Await it in
 *  `__film.ready`. */
export async function openScreen(src: string, opts: ScreenOptions = {}): Promise<Screen> {
  const url = new URL(src, location.href);
  const index = (await fetch(new URL("index.json", url)).then(
    (r) => (r.ok ? r.json() : null),
    () => null,
  )) as ScreenIndex | null;
  const width = opts.width ?? index?.viewport?.w;
  const height = opts.height ?? index?.viewport?.h;
  if (!width || !height)
    throw new Error(
      `openScreen: no index.json beside ${src} to read its size from — is it a saved screen? (or pass { width, height })`,
    );
  const screen = new Screen(url.href, width, height, opts, index);
  await screen.ready;
  return screen;
}

/** what a saved screen's index.json says the film side needs: the captured
 *  viewport, and where each element was when it was captured */
type ScreenIndex = {
  viewport?: { w?: number; h?: number };
  elements?: { id: string; box: [number, number, number, number] }[];
};

export class Screen {
  /** the screen on the film's page: at its parent's 0,0 until window() puts it in a box */
  readonly el: HTMLDivElement;
  /** the saved page, at its own viewport size */
  readonly frame: HTMLIFrameElement;
  /** the saved page's viewport, CSS px */
  readonly width: number;
  readonly height: number;
  readonly src: string;
  /** resolves once the saved page stands as captured */
  readonly ready: Promise<void>;
  #parent: HTMLElement;
  #doc: Document | null = null;
  #show: string[];
  #win: Box | null = null;
  #at: Placement = { x: 0, y: 0, s: 1, r: 0, ax: 0, ay: 0 };
  /** how each thing an action touched looked on the saved page, as a function that puts it back */
  #saved = new Map<object, Map<string, () => void>>();
  #instant: number | undefined;
  #caret: HTMLElement | null = null;
  #ruler: CanvasRenderingContext2D | null = null;

  #index: ScreenIndex | null;

  constructor(
    src: string,
    width: number,
    height: number,
    opts: ScreenOptions = {},
    index: ScreenIndex | null = null,
  ) {
    this.src = src;
    this.#index = index;
    this.width = width;
    this.height = height;
    this.#show = list(opts.show).map(selector);
    this.#parent = opts.parent ?? document.body;
    this.el = document.createElement("div");
    this.el.setAttribute("data-ot-screen", "");
    Object.assign(this.el.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
      overflow: "visible",
      pointerEvents: "none",
    });
    this.frame = document.createElement("iframe");
    this.frame.tabIndex = -1;
    Object.assign(this.frame.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${width}px`,
      height: `${height}px`,
      border: "0",
      transformOrigin: "0 0",
      pointerEvents: "none",
      background: "transparent",
    });
    this.frame.src = src;
    this.el.append(this.frame);
    this.#parent.append(this.el);
    this.ready = this.#load(opts);
  }

  async #load(opts: ScreenOptions): Promise<void> {
    const frame = this.frame;
    const doc = await new Promise<Document>((ok, fail) => {
      const loaded = () => {
        let d: Document | null = null;
        try {
          d = frame.contentDocument;
        } catch {
          /* cross-origin */
        }
        if (!d)
          return fail(
            new Error(`openScreen: cannot reach ${this.src} — serve it from the film's own folder`),
          );
        if (d.URL !== "about:blank") ok(d);
      };
      frame.addEventListener("load", loaded);
    });
    if (!doc.querySelector("script[data-ot-restore]"))
      throw new Error(
        `openScreen: ${this.src} is not a saved screen (open-take make --states saves them)`,
      );
    const root = doc.documentElement;
    await new Promise<void>((ok) => {
      if (root.getAttribute("data-ot-ready") === "1") return ok();
      const watch = new MutationObserver(() => {
        if (root.getAttribute("data-ot-ready") !== "1") return;
        watch.disconnect();
        ok();
      });
      watch.observe(root, { attributes: true, attributeFilter: ["data-ot-ready"] });
    });
    try {
      await doc.fonts.ready;
    } catch {
      /* no font set */
    }
    const rules = [STAGE_CSS];
    if (this.#show.length) {
      const keep = this.#show;
      // everything else stops painting, the page's background included; what
      // the kept parts contain keeps its own visibility (the caret is ours)
      rules.push(
        "html,body{background:transparent!important}",
        `:not(${[...keep, ...keep.map((k) => `${k} *`), "[data-ot-caret]"].join(",")}){visibility:hidden!important}`,
        `${[...keep, "[data-ot-caret]"].join(",")}{visibility:visible!important}`,
      );
    }
    const hide = list(opts.hide).map(selector);
    if (hide.length) rules.push(`${hide.join(",")}{visibility:hidden!important}`);
    if (opts.css) rules.push(opts.css);
    const style = doc.createElement("style");
    style.setAttribute("data-ot-screen", "");
    style.textContent = rules.join("\n");
    (doc.head ?? root).append(style);
    // a page in another colour scheme than the film's gets an opaque backdrop;
    // matching it keeps a transparent page transparent
    frame.style.colorScheme = doc.defaultView?.getComputedStyle(root).colorScheme || "normal";
    if (opts.scrollY !== undefined)
      doc.defaultView?.scrollTo({ left: 0, top: opts.scrollY, behavior: "instant" });
    this.#doc = doc;
    for (const s of this.#show)
      if (!doc.querySelector(s)) throw new Error(`openScreen: nothing in ${this.src} matches ${s}`);
    this.#checkShown();
  }

  /** A part to lift that the saved page does not show as it was captured —
   *  moved, resized, or not painting at all — would lift as nothing or as the
   *  wrong thing; say so on the console (film render/still print it). */
  #checkShown(): void {
    const captured = new Map((this.#index?.elements ?? []).map((e) => [e.id, e.box]));
    for (const s of this.#show)
      for (const el of this.$$(s)) {
        const r = el.getBoundingClientRect();
        const id = el.getAttribute("data-ot-id");
        const name = id ?? s;
        if (r.width < 1 || r.height < 1) {
          console.warn(`openScreen: ${name} has no size in ${this.src} — it lifts as nothing`);
          continue;
        }
        const was = id ? captured.get(id) : undefined;
        if (!was) continue;
        const now = [r.left, r.top, r.width, r.height];
        if (now.some((v, i) => Math.abs(v - was[i]!) > 6))
          console.warn(
            `openScreen: ${name} is not where it was captured in ${this.src} — ` +
              `[${was.map(Math.round).join(", ")}] then, [${now.map(Math.round).join(", ")}] in the saved page. ` +
              "This saved screen does not reproduce it (its fidelity: `open-take states`); use the recording for it, or another part.",
          );
      }
  }

  /** the saved page's document — reach in to restyle or animate anything yourself */
  get doc(): Document {
    if (!this.#doc) throw new Error(`screen ${this.src} is not ready yet — await openScreen(…)`);
    return this.#doc;
  }

  /** the element a target names (throws when nothing matches) */
  $(target: Target): HTMLElement {
    if (typeof target !== "string") return target as HTMLElement;
    const el = this.doc.querySelector(selector(target));
    if (!el) throw new Error(`screen ${this.src}: nothing matches ${target}`);
    return el as HTMLElement;
  }

  /** every element a selector (or id) names */
  $$(target: string): HTMLElement[] {
    return Array.from(this.doc.querySelectorAll(selector(target))) as HTMLElement[];
  }

  /** Where a part is on the saved page (its CSS px): `target`, else the parts
   *  shown (together), else the whole page. Measure it while it stands still. */
  box(target?: Target): Box {
    const els = target !== undefined ? [this.$(target)] : this.#show.flatMap((s) => this.$$(s));
    if (!els.length) return { x: 0, y: 0, width: this.width, height: this.height };
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      x0 = Math.min(x0, r.left);
      y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right);
      y1 = Math.max(y1, r.bottom);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** Put a part on the stage: fit it into `box` (whole, or covering it with
   *  `fit: "cover"`), or put its `anchor` point (0…1 each way, default its
   *  centre) at (x, y) at `scale`. `rotate` in degrees; `opacity` when given.
   *  The part is `of`, else the parts shown, else the page. Boxes and points
   *  are in the parent's px (the window's, once window() is set). */
  place(o: {
    box?: Box;
    fit?: "contain" | "cover";
    x?: number;
    y?: number;
    scale?: number;
    anchor?: [number, number];
    rotate?: number;
    opacity?: number;
    of?: Target;
  }): this {
    const part = this.box(o.of);
    const [ax, ay] = o.anchor ?? [0.5, 0.5];
    let s = o.scale ?? 1;
    let x = o.x ?? 0;
    let y = o.y ?? 0;
    if (o.box) {
      const fx = o.box.width / part.width;
      const fy = o.box.height / part.height;
      s = o.fit === "cover" ? Math.max(fx, fy) : Math.min(fx, fy);
      x = o.box.x + o.box.width * ax;
      y = o.box.y + o.box.height * ay;
    }
    this.#apply({
      x,
      y,
      s,
      r: o.rotate ?? 0,
      ax: part.x + part.width * ax,
      ay: part.y + part.height * ay,
    });
    if (o.opacity !== undefined)
      this.el.style.opacity = String(Math.round(o.opacity * 1000) / 1000);
    return this;
  }

  /** Look at the page through a window: `box` on the stage (the parent's px),
   *  clipped, with rounded corners if `radius`. view() then says what of the
   *  page it shows. null: no window, the screen is free on the stage. */
  window(
    box: Box | null,
    { radius = 0, clip = true }: { radius?: number; clip?: boolean } = {},
  ): this {
    this.#win = box;
    Object.assign(
      this.el.style,
      box
        ? {
            left: px(box.x),
            top: px(box.y),
            width: px(box.width),
            height: px(box.height),
            overflow: clip ? "hidden" : "visible",
            borderRadius: px(radius),
          }
        : {
            left: "0px",
            top: "0px",
            width: "0px",
            height: "0px",
            overflow: "visible",
            borderRadius: "",
          },
    );
    return this;
  }

  /** The View that frames a part (`pad` around it, a fraction of its size)
   *  through this screen's window — for travel() between two framings. With
   *  no part and nothing lifted: the whole page, filling the window. */
  frameOf(target?: Target, { pad }: { pad?: number } = {}): View {
    const win = this.#window();
    const whole = target === undefined && !this.#show.length;
    return frameView(this.box(target), win.width / win.height, { pad: pad ?? (whole ? 0 : 0.08) });
  }

  /** What the window shows: a View ({ cx, cy, w } in page px — frameOf(),
   *  frame() and travel() make them) or a part to frame. Kept inside the page
   *  (no blank past its edges) unless `clamp` is false. */
  view(
    v: View | Target,
    { pad = 0.08, clamp = true }: { pad?: number; clamp?: boolean } = {},
  ): this {
    const win = this.#window();
    const aspect = win.width / win.height;
    let view = isView(v) ? v : frameView(this.box(v), aspect, { pad });
    if (clamp) view = clampView(view, { width: this.width, height: this.height }, aspect);
    this.#apply({
      x: win.width / 2,
      y: win.height / 2,
      s: win.width / view.w,
      r: 0,
      ax: view.cx,
      ay: view.cy,
    });
    return this;
  }

  /** Where a part is on the stage now (the parent's px): its box on the page
   *  carried through the last place() or view() — the upright bounds, if
   *  rotated. For flying it somewhere else. */
  stageBox(target?: Target): Box {
    const b = this.box(target);
    const { x, y, s, r, ax, ay } = this.#at;
    const c = Math.cos((r * Math.PI) / 180);
    const n = Math.sin((r * Math.PI) / 180);
    const ox = this.#win?.x ?? 0;
    const oy = this.#win?.y ?? 0;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [px0, py0] of [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height],
    ] as const) {
      const dx = (px0 - ax) * s;
      const dy = (py0 - ay) * s;
      xs.push(ox + x + dx * c - dy * n);
      ys.push(oy + y + dx * n + dy * c);
    }
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
  }

  // --- acting on the interface, from film time ------------------------------------

  /** Switch a part to another state from `at` until `until` (seconds): the
   *  product's own CSS draws it — a class, an attribute (aria-expanded,
   *  data-state) — or set a field's value, a checkbox, a text (a number
   *  counting up: `text: count(t, …)`), an inline style. It is a change to the
   *  saved page, not the product running: whatever the product would do on
   *  its own, set it too. */
  set(
    t: number,
    target: Target,
    o: {
      at?: number;
      until?: number;
      addClass?: string | string[];
      removeClass?: string | string[];
      attr?: Record<string, string | null>;
      value?: string;
      checked?: boolean;
      text?: string | number;
      style?: Record<string, string>;
    },
  ): this {
    this.#begin(t);
    if (t < (o.at ?? Number.NEGATIVE_INFINITY) || t >= (o.until ?? Number.POSITIVE_INFINITY))
      return this;
    const el = this.$(target);
    for (const c of list(o.addClass)) {
      const had = el.classList.contains(c);
      this.#keep(el, `class:${c}`, () => el.classList.toggle(c, had));
      el.classList.add(c);
    }
    for (const c of list(o.removeClass)) {
      const had = el.classList.contains(c);
      this.#keep(el, `class:${c}`, () => el.classList.toggle(c, had));
      el.classList.remove(c);
    }
    for (const [k, v] of Object.entries(o.attr ?? {})) {
      const was = el.getAttribute(k);
      this.#keep(el, `attr:${k}`, () =>
        was === null ? el.removeAttribute(k) : el.setAttribute(k, was),
      );
      if (v === null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
    if (o.value !== undefined) this.#value(el, o.value);
    if (o.checked !== undefined) {
      const box = el as HTMLInputElement;
      const was = box.checked;
      this.#keep(el, "checked", () => {
        box.checked = was;
      });
      box.checked = o.checked;
    }
    if (o.text !== undefined) this.#text(el, String(o.text));
    for (const [k, v] of Object.entries(o.style ?? {})) {
      const was = el.style.getPropertyValue(k);
      const priority = el.style.getPropertyPriority(k);
      this.#keep(el, `style:${k}`, () => el.style.setProperty(k, was, priority));
      el.style.setProperty(k, v, "important");
    }
    return this;
  }

  /** Type into a field (or any element) from `at`, at a person's pace: it
   *  fills character by character, and a caret drawn on film time stays
   *  solid while typing, then blinks — until `caret` seconds (default 1.2 s
   *  after the last key; false: none). Pass a typing() instead of text to
   *  share its keystroke times with the score. */
  type(
    t: number,
    target: Target,
    text: string | Typing,
    o: { at?: number; cps?: number; caret?: number | false } = {},
  ): this {
    this.#begin(t);
    const keys = typeof text === "string" ? typing(text, { at: o.at ?? 0, cps: o.cps }) : text;
    const from = keys.times[0] ?? o.at ?? 0;
    if (t < from) return this;
    const el = this.$(target);
    const shown = keys.text(t);
    if (isField(el)) this.#value(el, shown);
    else this.#text(el, shown);
    const until = o.caret === false ? Number.NEGATIVE_INFINITY : (o.caret ?? keys.end + 1.2);
    if (t <= until) this.#drawCaret(el, t, keys.end);
    return this;
  }

  /** Press a part at `at`: it gives a little (`depth`) and comes back over
   *  `dur` seconds — its own CSS scale, so the product's transform stays. */
  press(
    t: number,
    target: Target,
    { at, dur = 0.24, depth = 0.05 }: { at: number; dur?: number; depth?: number },
  ): this {
    this.#begin(t);
    if (t < at || t > at + dur) return this;
    const el = this.$(target);
    const was = el.style.scale;
    this.#keep(el, "scale", () => {
      el.style.scale = was;
    });
    // the scale it has on its own (the page as saved: #begin put it back)
    const own = (this.doc.defaultView?.getComputedStyle(el).scale ?? "none")
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const sx = own[0] ?? 1;
    const sy = own[1] ?? sx;
    const p = (t - at) / dur;
    const down = p < 0.3 ? ease.out(p / 0.3) : 1 - ease.inOut((p - 0.3) / 0.7);
    const f = 1 - depth * down;
    el.style.scale = `${(sx * f).toFixed(4)} ${(sy * f).toFixed(4)}`;
    return this;
  }

  /** Take the screen off the page (and its document with it). */
  close(): void {
    this.el.remove();
    this.#doc = null;
  }

  // --- internals ------------------------------------------------------------------

  #window(): Box {
    return (
      this.#win ?? {
        x: 0,
        y: 0,
        width: this.#parent.clientWidth || innerWidth,
        height: this.#parent.clientHeight || innerHeight,
      }
    );
  }

  #apply(p: Placement): void {
    this.#at = p;
    const tr = `translate(${px(p.x)}, ${px(p.y)}) rotate(${Math.round(p.r * 1000) / 1000}deg) scale(${Math.round(p.s * 1e5) / 1e5}) translate(${px(-p.ax)}, ${px(-p.ay)})`;
    if (this.frame.style.transform !== tr) this.frame.style.transform = tr;
  }

  /** a new instant: everything the actions changed goes back to the saved page */
  #begin(t: number): void {
    if (t === this.#instant) return;
    this.#instant = t;
    for (const keys of this.#saved.values()) for (const back of keys.values()) back();
    if (this.#caret) this.#caret.style.display = "none";
  }

  /** remember, once, how `key` of `thing` looked on the saved page */
  #keep(thing: object, key: string, back: () => void): void {
    let keys = this.#saved.get(thing);
    if (!keys) {
      keys = new Map();
      this.#saved.set(thing, keys);
    }
    if (!keys.has(key)) keys.set(key, back);
  }

  #value(el: HTMLElement, value: string): void {
    const field = el as HTMLInputElement;
    const was = field.value;
    this.#keep(el, "value", () => {
      field.value = was;
    });
    field.value = value;
  }

  /** an element's text, its child elements (an icon) kept: the first piece of
   *  text takes the new text, the other pieces empty */
  #text(el: HTMLElement, text: string): void {
    const walk = this.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const pieces: Text[] = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode())
      if ((n as Text).data.trim()) pieces.push(n as Text);
    if (!pieces.length) {
      const piece = this.doc.createTextNode("");
      el.append(piece);
      this.#keep(piece, "node", () => piece.remove());
      pieces.push(piece);
    }
    pieces.forEach((piece, i) => {
      const was = piece.data;
      this.#keep(piece, "data", () => {
        piece.data = was;
      });
      piece.data = i === 0 ? text : "";
    });
  }

  /** a caret after the text, on film time: solid while typing, then blinking */
  #drawCaret(el: HTMLElement, t: number, end: number): void {
    if (t > end + 0.1 && (t - end - 0.1) % 1.06 >= 0.53) return;
    const doc = this.doc;
    const view = doc.defaultView;
    if (!view) return;
    const cs = view.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const size = Number.parseFloat(cs.fontSize) || 16;
    const h = size * 1.15;
    let x: number;
    let y: number;
    if (isField(el)) {
      this.#ruler ??= doc.createElement("canvas").getContext("2d");
      const ruler = this.#ruler;
      let w = 0;
      if (ruler) {
        ruler.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        w =
          ruler.measureText(el.value).width +
          (Number.parseFloat(cs.letterSpacing) || 0) * graphemes(el.value).length;
      }
      const left =
        r.left + Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft);
      const right =
        r.right - Number.parseFloat(cs.borderRightWidth) - Number.parseFloat(cs.paddingRight);
      x = Math.min(left + w - el.scrollLeft, right);
      y = r.top + (r.height - h) / 2;
    } else {
      const range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const at = range.getBoundingClientRect();
      const placed = at.height > 0 || at.left > 0;
      x = placed ? at.left : r.right;
      y = placed ? at.top + (at.height - h) / 2 : r.top + (r.height - h) / 2;
    }
    if (!this.#caret) {
      this.#caret = doc.createElement("div");
      this.#caret.setAttribute("data-ot-caret", "");
      doc.body.append(this.#caret);
    }
    this.#caret.style.cssText = `display:block;position:absolute;left:${px(x + view.scrollX)};top:${px(y + view.scrollY)};width:${px(Math.max(1.5, size / 14))};height:${px(h)};background:${cs.color};z-index:2147483647;pointer-events:none;visibility:visible`;
  }
}
