// @ts-check
// The real interface in a film — open-take's film kit. The kinds of material:
//
//   screen(iframe)  a saved screen (`make --states`: takes/x.take/states/s3/
//                   state.html; a shoot's still kept with { state: true }:
//                   shots/states/home/state.html — the same files) shown in
//                   an <iframe> the size of its viewport. screen(iframe, url)
//                   points the iframe at it.
//                   box() says where a part of it is — measured on the page as
//                   it is now, so restyling it moves the box too — in the
//                   screen's own CSS px: the coordinates the camera and cursor
//                   take when the screen is their layer.
//   stills(log)     the 2× stills `open-take shoot` writes, with its log
//                   (shots.json): which still shows at t, decoded before the
//                   frame is drawn, a bounded number held at once (a long drag
//                   can be 900 stills), and every box and cursor position the
//                   shoot recorded — in the still's own px — so nothing is
//                   copied by hand. state(i) is the URL of the saved screen
//                   a still kept, for screen(), and so for lift / isolate.
//   readTake(url)   a take `open-take make` recorded (capture.json): its
//                   actions, its recording, its saved states. clip() maps
//                   film time onto the recording (a start and a speed, or
//                   keys that slow down round a click); clipEvents() turns
//                   the actions into film events through it — the input, and
//                   apart from it when its RESULT showed, which can be a
//                   second later; seam() says when and where a saved state
//                   stands in for the video without a jump.
//   lift(screen, part)  one real part of a saved screen as a layer of its
//                   own, starting exactly where it sat — to carry it
//                   anywhere at any size, the page around it kept or
//                   cleared; isolate() fades all but chosen parts instead.
//
// A box is always in one place's own CSS px. Where a screen sits inside a
// bigger layer, box(…, { in: layer }) adds its offset — and refuses when
// something between them is transformed, rather than answer wrong.
//
//   const s = screen(document.querySelector("#app"));
//   window.__film = { duration: 30, ready: s.ready };  // the film waits for it
//   cam.frame(s.box("#search"), { arrive: 3 });
//
//   const st = await stills("shots/shots.json", document.querySelector("#still"));
//   await st.show(st.at(t, { from: 4, start: 12, rate: 30 }));
//
//   const home = screen(document.querySelector("#home"), st.state("home")); // a shoot's still, as live DOM
//   const total = lift(home, "#total", { around: "clear" });                 // that part, sharp at any size
//
//   const c = clip({ at: 7, from: 12.0, to: 15.5 });            // film 7 s shows 12.0 s
//   const card = lift(s, "e126", { around: "clear" });           // the number the app worked out
//   let shown = 0;                                               // when the new number showed
//   const ready = Promise.all([card.ready, readTake("../takes/calc.take/").then((take) => {
//     const ev = clipEvents(take, c, { tl });                    // also declared for the score
//     shown = ev.find((e) => e.kind === "result" && e.action === "a2").t;
//   })]);

/** @typedef {{ x: number, y: number, width: number, height: number }} Box */

/**
 * Where the document inside the frame `el` begins, in `layer`'s CSS px: the
 * offsets up to it, the borders they are taken inside of, less what scrolls in
 * between, plus the frame's own border and padding. Anything transformed on
 * the way (the frame included) would make that wrong, so it is refused.
 * @param {string} what
 * @param {Element} el
 * @param {Element} layer
 */
function offsetWithin(what, el, layer) {
  if (!layer.contains(el))
    throw new Error(`${what}: it is not inside the layer it was measured in`);
  for (let n = /** @type {Element | null} */ (el); n && n !== layer; n = n.parentElement)
    if (getComputedStyle(n).transform !== "none")
      throw new Error(
        `${what}: it, or something between it and the layer, is transformed — the kit cannot measure through that; place it untransformed in the layer (a seam's transform goes on the layer that holds the screen's iframe), or map it yourself`,
      );
  if (!(el instanceof HTMLElement)) throw new Error(`${what}: only HTML elements can be measured`);
  // its document starts inside its border and padding
  const own = getComputedStyle(el);
  let x = el.clientLeft + Number.parseFloat(own.paddingLeft);
  let y = el.clientTop + Number.parseFloat(own.paddingTop);
  // what scrolls in between moves it
  for (let n = el.parentElement; n && n !== layer; n = n.parentElement) {
    x -= n.scrollLeft;
    y -= n.scrollTop;
  }
  /** @type {Element | null} */
  let n = el;
  while (n && n !== layer) {
    if (!(n instanceof HTMLElement)) throw new Error(`${what}: only HTML elements can be measured`);
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent;
    if (n && n !== layer && !layer.contains(n))
      throw new Error(
        `${what}: the layer is not positioned — give it position: relative (or absolute) so what is inside it can be measured in it`,
      );
    // an offset is taken from inside its parent's border
    if (n && n !== layer) {
      x += n.clientLeft;
      y += n.clientTop;
    }
  }
  if (n !== layer)
    throw new Error(
      `${what}: the layer is not positioned — give it position: relative (or absolute) so what is inside it can be measured in it`,
    );
  return { x, y };
}

/**
 * A saved screen shown in an iframe of its viewport's size: one already in
 * the iframe's src, or `src` — a state.html URL (a take's, a shoot's
 * states/<id>/state.html, stills().state(i)).
 * @param {HTMLIFrameElement} frame
 * @param {string | URL} [src]
 */
export function screen(frame, src) {
  if (src != null) {
    const url = new URL(String(src), location.href).href;
    if (frame.src !== url) frame.src = url;
  }
  /** @type {{ viewport?: { w: number, h: number }, elements?: { id: string, box: number[] }[] } | null} */
  let index = null;
  // an iframe that has not loaded yet holds a blank page that also reads as
  // complete: wait for the screen itself
  const loaded = () => {
    const doc = frame.contentDocument;
    return !!doc && doc.readyState === "complete" && doc.URL !== "about:blank";
  };
  const ready = (async () => {
    if (!loaded()) await new Promise((ok) => frame.addEventListener("load", ok, { once: true }));
    try {
      const res = await fetch(new URL("index.json", frame.src));
      if (res.ok) index = await res.json();
    } catch {
      /* a screen without its index: boxes by selector still work */
    }
  })();

  /** @param {string | Element} key */
  const measure = (key) => {
    const doc = frame.contentDocument;
    if (typeof key === "string" && /^e\d+$/.test(key)) {
      const e = index?.elements?.find((el) => el.id === key);
      if (!e) throw new Error(`screen: no element ${key} in ${frame.src}'s index.json`);
      const [x = 0, y = 0, width = 0, height = 0] = e.box;
      return { x, y, width, height };
    }
    if (!doc)
      throw new Error(`screen: ${frame.src} is not same-origin — its parts cannot be measured`);
    const el = typeof key === "string" ? doc.querySelector(key) : key;
    if (!el) throw new Error(`screen: nothing matches ${String(key)} in ${frame.src}`);
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  return {
    frame,
    /** resolves once the screen has loaded and its index (if any) is read */
    ready,
    /** the screen's size (its viewport's), CSS px */
    get size() {
      return {
        width: index?.viewport?.w ?? frame.clientWidth,
        height: index?.viewport?.h ?? frame.clientHeight,
      };
    },
    /**
     * Where a part of the screen is: a CSS selector (measured live), an
     * element of it, or an index id ("e12", as captured). In the screen's own
     * px, or in `layer`'s px when given.
     * @param {string | Element} key
     * @param {{ in?: Element }} [o]
     * @returns {Box}
     */
    box(key, o = {}) {
      const b = measure(key);
      if (!o.in) return b;
      const off = offsetWithin("screen", frame, o.in);
      return { x: b.x + off.x, y: b.y + off.y, width: b.width, height: b.height };
    },
  };
}

/**
 * Decoded stills, bounded twice: at most `keep` held, and at most `ahead`
 * fetched ahead while still loading. One pushed out while it loads is
 * cancelled, so a render that seeks about cannot pile up decodes. stills()
 * is what a film uses; this is the part that can be tested without a browser.
 * @template T
 * @param {{ keep: number, ahead: number, count: number, open: (i: number) => { ready: Promise<T>, cancel: () => void } }} o
 */
export function stillCache({ keep, ahead, count, open }) {
  /** @type {Map<number, { ready: Promise<T>, cancel: () => void, done: boolean }>} */
  const held = new Map();
  /** @param {number} i */
  const get = (i) => {
    const had = held.get(i);
    if (had) {
      held.delete(i); // the most recently wanted go last, the oldest first
      held.set(i, had);
      return had.ready;
    }
    const o = open(i);
    /** @type {{ ready: Promise<T>, cancel: () => void, done: boolean }} */
    const entry = { ready: o.ready, cancel: o.cancel, done: false };
    entry.ready = o.ready.then((v) => {
      entry.done = true;
      return v;
    });
    entry.ready.catch(() => {}); // a cancelled fetch ahead is nobody's error
    held.set(i, entry);
    while (held.size > Math.max(1, keep)) {
      const first = held.keys().next().value;
      if (first === undefined) break;
      const old = held.get(first);
      held.delete(first);
      if (old && !old.done) old.cancel();
    }
    return entry.ready;
  };
  const loading = () => {
    let n = 0;
    for (const e of held.values()) if (!e.done) n++;
    return n;
  };
  return {
    /** still i, and a few after it fetched while fewer than `ahead` are
     *  loading — never more than the cache holds besides still i, so what is
     *  fetched ahead cannot push out the still that was asked for */
    /** @param {number} i */
    take(i) {
      const p = get(i);
      for (let k = 1; k <= Math.min(ahead, keep - 1) && i + k < count; k++) {
        if (held.has(i + k)) continue;
        if (loading() > ahead) break; // the one wanted counts as loading too
        get(i + k);
      }
      return p;
    },
    loading,
    get size() {
      return held.size;
    },
  };
}

/**
 * @typedef {object} Still
 * @property {string} file
 * @property {string} [name]
 * @property {number} t
 * @property {{ x: number, y: number }} [cursor]
 * @property {{ x: number, y: number }} [scroll]
 * @property {Record<string, Box>} [boxes]
 * @property {string} [state] its saved screen's id: states/<state>/state.html
 */

/**
 * The stills of a shoot, played into one <img>.
 * @param {string} logUrl the shoot's shots.json
 * @param {HTMLImageElement} img where the current still is shown (size it to the viewport)
 * @param {{ keep?: number, ahead?: number }} [o] how many decoded stills are held, how many are fetched ahead
 */
export async function stills(logUrl, img, { keep = 12, ahead = 3 } = {}) {
  const res = await fetch(logUrl);
  if (!res.ok) throw new Error(`stills: ${logUrl} could not be read (${res.status})`);
  /** @type {{ viewport: { w: number, h: number }, scale?: number, stills: Still[], states?: { dir: string } }} */
  const log = await res.json();
  const base = new URL(logUrl, location.href);
  let shown = -1;

  /** @param {number} i */
  const still = (i) => {
    const s = log.stills[i];
    if (!s) throw new Error(`stills: there is no still ${i} (the shoot has ${log.stills.length})`);
    return s;
  };
  const cache = stillCache({
    keep,
    ahead,
    count: log.stills.length,
    open: (i) => {
      const im = new Image();
      const src = new URL(still(i).file, base).href;
      im.src = src;
      return {
        ready: im.decode().then(
          () => im,
          () => {
            throw new Error(`stills: ${src} could not be decoded`);
          },
        ),
        cancel: () => {
          im.src = ""; // stops the fetch and the decode
        },
      };
    },
  });

  return {
    log,
    count: log.stills.length,
    /**
     * The still to show at t when stills from `from` play at `rate` a second
     * from `start` (s). Whole frames of film time pick whole stills: a tiny
     * float error never repeats one.
     * @param {number} t
     * @param {{ from?: number, start?: number, rate: number, to?: number }} o
     */
    at(t, o) {
      const from = o.from ?? 0;
      const to = o.to ?? log.stills.length - 1;
      const i = from + Math.floor((t - (o.start ?? 0)) * o.rate + 1e-6);
      return Math.max(from, Math.min(to, i));
    },
    /** show still i (decoded first), fetching a few ahead */
    /** @param {number} i */
    async show(i) {
      const im = await cache.take(i);
      if (shown !== i) {
        img.src = im.src;
        await img.decode();
        shown = i;
      }
    },
    /** a box the shoot recorded at still i, by the selector it was tracked
     *  with — in the still's own CSS px (the shoot logs page px; the still
     *  shows the page from its scroll) */
    /** @param {number} i @param {string} selector */
    box(i, selector) {
      const s = still(i);
      const b = s.boxes?.[selector];
      if (!b) throw new Error(`stills: still ${i} recorded no box for ${selector}`);
      return {
        x: b.x - (s.scroll?.x ?? 0),
        y: b.y - (s.scroll?.y ?? 0),
        width: b.width,
        height: b.height,
      };
    },
    /**
     * The saved screen a still kept (shot with { state: true } or --states):
     * its state.html URL, for screen(iframe, url) — and so lift / isolate.
     * By the still's index, its name, or the screen's id.
     * @param {number | string} key
     */
    state(key) {
      const s =
        typeof key === "number"
          ? still(key)
          : (log.stills.find((x) => x.state === key) ?? log.stills.find((x) => x.name === key));
      if (!s) throw new Error(`stills: no still ${JSON.stringify(key)} in ${logUrl}`);
      if (!s.state)
        throw new Error(
          `stills: ${s.file} kept no saved screen — shoot it with s.still(name, { state: true }) (or --states)`,
        );
      const dir = log.states?.dir ?? "states";
      return new URL(`${dir}/${s.state}/state.html`, base).href;
    },
    /** where the shoot's cursor was at still i, in the still's own CSS px */
    /** @param {number} i */
    cursor(i) {
      const s = still(i);
      if (!s.cursor) throw new Error(`stills: still ${i} recorded no cursor`);
      return { x: s.cursor.x - (s.scroll?.x ?? 0), y: s.cursor.y - (s.scroll?.y ?? 0) };
    },
  };
}

// --- a take: its recording, its actions, its saved states ----------------------

/**
 * One action as the capture logged it (capture.json `events`): times in ms on
 * the capture's clock, places in the viewport's CSS px.
 * @typedef {object} TakeAction
 * @property {string} [kind] "click" when absent
 * @property {number} tMs when the input happened
 * @property {number} x
 * @property {number} y
 * @property {{ x: number, y: number, w: number, h: number }} [box]
 * @property {number} [durationMs]
 * @property {string} [text]
 * @property {string} [keys]
 * @property {string} [sel]
 * @property {string} [state]
 * @property {{ atMs: number, doneMs: number, box: { x: number, y: number, w: number, h: number } }} [result]
 * @property {number} [settledMs]
 */
/**
 * @typedef {object} TakeLog
 * @property {{ w: number, h: number }} viewport
 * @property {TakeAction[]} events
 * @property {number} [tEndMs]
 * @property {{ dir: string, items: { id: string, tMs: number, step?: number, moving?: true,
 *   fidelity?: { psnr: number, diffFrac: number, ok: boolean },
 *   seam?: { dx: number, dy: number, meanDiff: number, diffFrac: number } }[] }} [states]
 */
/**
 * @typedef {object} Take
 * @property {TakeLog} log
 * @property {string} video the recording's URL (capture.mp4)
 * @property {(id: string) => string} state a saved state's state.html URL
 */

/**
 * A take made by `open-take make` (`--states` for saved states): its
 * capture.json read, and where its recording and states are.
 * @param {string} url the take's folder (…/x.take/) or its capture.json
 * @returns {Promise<Take>}
 */
export async function readTake(url) {
  const base = new URL(
    /\.json$/.test(url) ? url : `${url.replace(/\/?$/, "/")}capture.json`,
    location.href,
  );
  const res = await fetch(base);
  if (!res.ok) throw new Error(`readTake: ${base.href} could not be read (${res.status})`);
  return fromLog(await res.json(), base.href);
}

/**
 * A take from a capture log already in hand — `base` is where capture.json
 * sits, for the recording's and the states' URLs.
 * @param {TakeLog} log
 * @param {string} base
 * @returns {Take}
 */
export function fromLog(log, base) {
  if (!log || !Array.isArray(log.events) || !log.viewport)
    throw new Error("take: not a capture log (no events or viewport)");
  return {
    log,
    video: new URL("capture.mp4", base).href,
    state: (id) => {
      if (!log.states?.items.some((s) => s.id === id))
        throw new Error(
          `take: no saved state ${id} (record with --states; \`open-take states\` lists them)`,
        );
      return new URL(`${log.states.dir}/${id}/state.html`, base).href;
    },
  };
}

/**
 * How film time maps onto a recording: the part of it a film shows, from
 * where and how fast. Either a start and a speed — the recording's `from`
 * (s) shows at film time `at`, then plays at `speed` (recording seconds a
 * film second; 1 is as it happened) until its `to` — or `keys`, pairs of
 * [film s, recording s] joined by straight lines, for a clip that slows down
 * around a click and hurries through the waiting. `fileStart`: when the
 * video file was cut from the recording, the recording time its first frame
 * shows (so videoTime(t) is a time in that file).
 * @param {{ at?: number, from?: number, to?: number, speed?: number,
 *   keys?: [number, number][], fileStart?: number }} o
 */
export function clip(o) {
  const fileStart = o.fileStart ?? 0;
  /** film times and the recording times they show, joined by straight lines */
  /** @type {number[]} */
  const F = [];
  /** @type {number[]} */
  const C = [];
  // a clip given no end runs on at its speed
  let open = false;
  if (o.keys) {
    if (o.keys.length < 2) throw new Error("clip: keys needs two [film, recording] pairs at least");
    for (const [f, c] of o.keys) {
      const n = F.length;
      if (!Number.isFinite(f) || !Number.isFinite(c))
        throw new Error(`clip: key ${n} is not two times`);
      if (
        n &&
        (!(f > /** @type {number} */ (F[n - 1])) || !(c >= /** @type {number} */ (C[n - 1])))
      )
        throw new Error(
          `clip: keys must move forward — film time rising, recording time not falling (pair ${n})`,
        );
      F.push(f);
      C.push(c);
    }
  } else {
    const at = o.at ?? 0;
    const from = o.from ?? 0;
    const speed = o.speed ?? 1;
    if (!(speed > 0))
      throw new Error(`clip: speed is recording seconds a film second, above 0 (got ${speed})`);
    if (![at, from].every(Number.isFinite)) throw new Error("clip: at and from are times (s)");
    const to = o.to ?? Number.POSITIVE_INFINITY;
    if (!(to > from)) throw new Error(`clip: to (${to}) must come after from (${from})`);
    open = !Number.isFinite(to);
    F.push(at, at + (open ? 1 : (to - from) / speed));
    C.push(from, open ? from + speed : to);
  }
  const n = F.length;
  /** @param {number[]} a @param {number} i */
  const get = (a, i) => /** @type {number} */ (a[i]);
  /** film s → recording s (held at the ends, or run on when open) @param {number} t */
  const toCapture = (t) => {
    if (t <= get(F, 0)) return get(C, 0);
    for (let i = 1; i < n; i++)
      if (t <= get(F, i) || (open && i === n - 1))
        return (
          get(C, i - 1) +
          ((get(C, i) - get(C, i - 1)) * (t - get(F, i - 1))) / (get(F, i) - get(F, i - 1))
        );
    return get(C, n - 1);
  };
  /** recording s → the first film s showing it, or null when the clip never
   *  does @param {number} c */
  const toFilm = (c) => {
    if (c < get(C, 0) - 1e-9) return null;
    for (let i = 1; i < n; i++) {
      const c0 = get(C, i - 1);
      const c1 = get(C, i);
      if (c <= c1 + 1e-9 || (open && i === n - 1))
        return c1 === c0
          ? get(F, i - 1)
          : get(F, i - 1) + ((get(F, i) - get(F, i - 1)) * (c - c0)) / (c1 - c0);
    }
    return null;
  };
  return {
    /** film time the clip starts (s) */
    start: get(F, 0),
    /** film time it ends (s); Infinity when it was given no end */
    end: open ? Number.POSITIVE_INFINITY : get(F, n - 1),
    /** the span of the recording it shows (s) */
    from: get(C, 0),
    to: open ? Number.POSITIVE_INFINITY : get(C, n - 1),
    toCapture,
    toFilm,
    /** where to seek the video element at film time t (s, in the file) @param {number} t */
    videoTime: (t) => toCapture(t) - fileStart,
  };
}

/** @typedef {ReturnType<typeof clip>} Clip */

/**
 * @typedef {object} ClipEvent
 * @property {number} t film time (s)
 * @property {string} kind the action's kind ("click", "type", "press", …), or
 *   "key" (one character of a typed text), "result" (its result showed),
 *   "resultDone" (its result stopped changing), "settled" (the page went quiet)
 * @property {"measured" | "estimated"} basis logged or read off the
 *   recording / spread evenly or guessed from page structure
 * @property {string} action which action, a1… in capture order (`open-take states` names them so)
 * @property {number} capture recording time (s)
 * @property {number} [x] where (CSS px of the viewport, or what `map` gives)
 * @property {number} [y]
 * @property {Box} [box] the control, or for a result the region that changed
 * @property {string} [label]
 * @property {number | "not detected" | "outside the clip"} [resultAt] on an input: film time
 *   its result showed — "outside the clip" when it was measured but the clip ends first
 * @property {number | "not detected" | "outside the clip"} [resultDone]
 * @property {number} [settled]
 */

/**
 * A take's actions as film events, through a clip's time map: each input at
 * the film time the clip shows it, and — apart from it — when its result
 * showed (measured off the recording by `make`; older takes: `open-take
 * states <take> --measure`). Actions outside the clip are left out.
 * `tl`: also declare each one on a timeline (kit/time.js), for the score.
 * `map`: viewport px → stage px, e.g. through the camera. `keys`: a typed
 * text as one "key" event a character, spread evenly over its duration
 * (estimated — the capture logs when typing ran, not each key).
 * @param {Take | TakeLog} take
 * @param {Clip} c
 * @param {{ tl?: { event: (at: number, kind: string, o?: { x?: number, y?: number, label?: string }) => number },
 *   kinds?: string[], keys?: boolean, map?: (x: number, y: number, t: number) => number[] }} [o]
 * @returns {ClipEvent[]}
 */
export function clipEvents(take, c, o = {}) {
  const log = "log" in take ? take.log : take;
  /** @type {ClipEvent[]} */
  const out = [];
  /** @param {{ x: number, y: number, w: number, h: number } | undefined} b */
  const asBox = (b) => (b ? { x: b.x, y: b.y, width: b.w, height: b.h } : undefined);
  /** @param {number} x @param {number} y @param {number} t */
  const at = (x, y, t) => {
    if (!o.map) return { x, y };
    const [mx, my] = o.map(x, y, t);
    return { x: mx, y: my };
  };
  log.events.forEach((e, i) => {
    const action = `a${i + 1}`;
    const kind = e.kind ?? "click";
    const t = c.toFilm(e.tMs / 1000);
    if (t == null || t > c.end) return;
    const film = (/** @type {number} */ ms) => {
      const f = c.toFilm(ms / 1000);
      return f == null || f > c.end ? null : f;
    };
    // measured, but past what the clip shows: said so, not "not detected"
    const shown = (/** @type {number | null} */ f) =>
      f ?? (e.result ? /** @type {const} */ ("outside the clip") : "not detected");
    const resultAt = e.result ? film(e.result.atMs) : null;
    const resultDone = e.result ? film(e.result.doneMs) : null;
    const settled = e.settledMs != null ? film(e.settledMs) : null;
    /** @type {ClipEvent} */
    const input = {
      t,
      kind,
      basis: "measured",
      action,
      capture: e.tMs / 1000,
      ...at(e.x, e.y, t),
      ...(e.box ? { box: asBox(e.box) } : {}),
      ...(e.sel || e.text || e.keys ? { label: e.keys ?? e.text ?? e.sel } : {}),
      resultAt: shown(resultAt),
      resultDone: shown(resultDone),
      ...(settled != null ? { settled } : {}),
    };
    out.push(input);
    const typing = e.durationMs ?? 0;
    if (o.keys && kind === "type" && e.text && typing > 0) {
      const chars = [...e.text];
      chars.forEach((ch, k) => {
        const kt = film(e.tMs + (typing * (k + 0.5)) / chars.length);
        if (kt != null)
          out.push({
            t: kt,
            kind: "key",
            basis: "estimated",
            action,
            capture: c.toCapture(kt),
            ...at(e.x, e.y, kt),
            label: ch,
          });
      });
    }
    if (e.result && resultAt != null) {
      const b = e.result.box;
      out.push({
        t: resultAt,
        kind: "result",
        basis: "measured",
        action,
        capture: e.result.atMs / 1000,
        ...at(b.x + b.w / 2, b.y + b.h / 2, resultAt),
        box: asBox(b),
      });
      if (resultDone != null && resultDone > resultAt)
        out.push({
          t: resultDone,
          kind: "resultDone",
          basis: "measured",
          action,
          capture: e.result.doneMs / 1000,
          ...at(b.x + b.w / 2, b.y + b.h / 2, resultDone),
          box: asBox(b),
        });
    }
    if (settled != null)
      out.push({
        t: settled,
        kind: "settled",
        basis: "estimated",
        action,
        capture: /** @type {number} */ (e.settledMs) / 1000,
      });
  });
  const kept = (o.kinds ? out.filter((e) => o.kinds?.includes(e.kind)) : out).sort(
    (a, b) => a.t - b.t,
  );
  if (o.tl)
    for (const e of kept)
      o.tl.event(e.t, e.kind, {
        ...(e.x != null ? { x: e.x, y: e.y } : {}),
        label: e.label != null ? `${e.action} ${e.label}` : e.action,
      });
  return kept;
}

/**
 * Cutting from the recording to a saved state of the same moment, without a
 * jump. Says when the two show the same thing — the stretch of film time
 * from the state's action being done (its result stopped changing, measured;
 * else the page went quiet, estimated; else the input) to the next input —
 * and where to put the state so it lands on the video: a transform for the
 * state's layer — a positioned box of the viewport's size holding its
 * iframe, at the stage's 0, 0 with transform-origin 0 0 — when the video is
 * shown at `video` (stage px; default the viewport's size at 0, 0). On the
 * layer rather than the iframe itself, lift(), isolate() and box() still
 * measure the screen, in the layer's px, and what they make moves with it —
 * so a lifted part's rect and place() are in the state's px too: a stage box
 * b is ((b.x − offset.x) / scale, (b.y − offset.y) / scale, b.width / scale,
 * b.height / scale) there (full frame is not the stage's size unless the
 * scale is 1).
 * `residual` is what `make` measured between the recording's frame and the
 * state's screenshot: the shift left (CSS px) and the difference at it.
 * @param {Take | TakeLog} take
 * @param {Clip} c
 * @param {string} id the state ("s3")
 * @param {{ video?: { x?: number, y?: number, width: number, height: number } }} [o]
 */
export function seam(take, c, id, o = {}) {
  const log = "log" in take ? take.log : take;
  const item = log.states?.items.find((s) => s.id === id);
  if (!item) throw new Error(`seam: no saved state ${id} in the take`);
  if (item.moving)
    throw new Error(`seam: nothing was saved at ${id} — the page was still moving there`);
  const vw = log.viewport.w;
  const vh = log.viewport.h;
  const v = o.video ?? { x: 0, y: 0, width: vw, height: vh };
  const sx = v.width / vw;
  const sy = v.height / vh;
  if (Math.abs(sx - sy) > 1e-3 * Math.max(sx, sy))
    throw new Error(
      `seam: the video is shown at ${v.width}×${v.height}, not the viewport's ${vw}:${vh} shape — a state cannot be stretched onto it`,
    );
  const s = item.seam;
  const dx = s ? s.dx : 0;
  const dy = s ? s.dy : 0;
  const x = (v.x ?? 0) + dx * sx;
  const y = (v.y ?? 0) + dy * sx;
  // the stretch of the recording the state stands for
  const before = log.events.filter((e) => e.tMs <= item.tMs);
  const last = before[before.length - 1];
  const next = log.events.find((e) => e.tMs > item.tMs);
  /** @type {[number, "measured" | "estimated"]} */
  let from = [0, "measured"];
  if (last)
    from = last.result
      ? [last.result.doneMs, "measured"]
      : last.settledMs != null
        ? [last.settledMs, "estimated"]
        : [last.tMs + (last.durationMs ?? 0), "estimated"];
  const until = next ? next.tMs : (log.tEndMs ?? item.tMs);
  // a clip that starts inside that stretch shows it from its own start
  const lo = Math.min(from[0], item.tMs) / 1000;
  const hi = Math.max(until, item.tMs) / 1000;
  if (lo < c.from && hi >= c.from) from = [c.from * 1000, "measured"];
  const filmLo = hi >= c.from ? c.toFilm(Math.max(lo, c.from)) : null;
  const filmHi = c.toFilm(hi) ?? c.end;
  const filmAt = c.toFilm(item.tMs / 1000);
  return {
    state: id,
    /** film time the clip shows the moment the state was saved, or null */
    at: filmAt != null && filmAt <= c.end ? filmAt : null,
    /** film times the video and the state show the same page — clipped to
     *  the clip; null when the clip does not show that stretch */
    window:
      filmLo != null && filmLo <= c.end
        ? {
            from: filmLo,
            to: Math.min(filmHi, c.end),
            basis: { from: from[1], to: /** @type {const} */ ("measured") },
          }
        : null,
    /** scale of state px to stage px, and where the state's 0, 0 goes on the stage */
    scale: sx,
    offset: { x, y },
    /** for the state's layer, the box holding its iframe (transform-origin
     *  0 0, at the stage's 0, 0) */
    transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${sx.toFixed(6)})`,
    residual: s
      ? {
          dx: s.dx,
          dy: s.dy,
          meanDiff: s.meanDiff,
          diffFrac: s.diffFrac,
          basis: /** @type {const} */ ("measured"),
        }
      : { basis: /** @type {const} */ ("not detected") },
    fidelity: item.fidelity ?? null,
  };
}

// --- one real part of a saved screen, as a layer of its own ----------------------

/** @typedef {{ x: number, y: number, width?: number, height?: number, w?: number, h?: number }} BoxLike */

/** @param {BoxLike} b @returns {Box} */
const boxOf = (b) => ({ x: b.x, y: b.y, width: b.width ?? b.w ?? 0, height: b.height ?? b.h ?? 0 });

/** @param {any} source @returns {{ frame: HTMLIFrameElement, ready: Promise<unknown> }} */
function screenOf(source) {
  if (source instanceof HTMLIFrameElement) return { frame: source, ready: whenLoaded(source) };
  if (source && source.frame instanceof HTMLIFrameElement)
    return { frame: source.frame, ready: Promise.all([source.ready, whenLoaded(source.frame)]) };
  throw new Error("lift: give it a saved screen — screen(iframe) — or its iframe");
}

/** the frame's own document has loaded, and a saved state has finished
 *  putting back what its markup could not carry (its ready flag; a page that
 *  is not a saved state has no restore script, and nothing to wait for)
 * @param {HTMLIFrameElement} frame */
async function whenLoaded(frame) {
  const loaded = () => {
    const doc = frame.contentDocument;
    return !!doc && doc.readyState === "complete" && doc.URL !== "about:blank";
  };
  if (!loaded()) await new Promise((ok) => frame.addEventListener("load", ok, { once: true }));
  const doc = frame.contentDocument;
  if (!doc) throw new Error(`lift: ${frame.src} is not same-origin — its parts cannot be lifted`);
  // a saved state marks itself ready once its restore script is done (it
  // gives up after 6 s); anything else has nothing to wait for
  // (watched, not polled: under the film's clock a timer here is film time)
  if (!doc.querySelector("script[data-ot-restore]")) return;
  const root = doc.documentElement;
  if (root.dataset.otReady === "1") return;
  await new Promise((ok) => {
    const watch = new MutationObserver(() => {
      if (root.dataset.otReady !== "1") return;
      watch.disconnect();
      ok(undefined);
    });
    watch.observe(root, { attributes: true, attributeFilter: ["data-ot-ready"] });
  });
}

/** an element of a saved screen's document: by selector, by its index id
 *  ("e12", as `open-take states` names it), or the element itself
 * @param {Document} doc @param {string | Element} key */
function findIn(doc, key) {
  if (typeof key !== "string") return key;
  const el = /^e\d+$/.test(key)
    ? doc.querySelector(`[data-ot-id="${key}"]`)
    : doc.querySelector(key);
  if (!el) throw new Error(`lift: nothing matches ${key} in ${doc.URL}`);
  return el;
}

/** child indices from <html> down to el @param {Element} el */
function pathOf(el) {
  /** @type {number[]} */
  const path = [];
  for (let n = el; n.parentElement; n = n.parentElement)
    path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
  return path;
}

/** @param {Document} doc @param {number[]} path */
function atPath(doc, path) {
  /** @type {Element | undefined} */
  let n = doc.documentElement;
  for (const i of path) n = n?.children[i];
  return n ?? null;
}

/** put a layer over a screen: fades (isolate) right over it, lifted parts
 *  over the fades — each above the ones of its kind made before it
 * @param {HTMLIFrameElement} frame @param {HTMLElement} el @param {"fade" | "lift"} kind */
function stackOver(frame, el, kind) {
  el.dataset.otOver = kind;
  let at = /** @type {Element} */ (frame);
  for (
    let n = at.nextElementSibling;
    n instanceof HTMLElement && n.dataset.otOver;
    n = n.nextElementSibling
  )
    if (kind === "lift" || n.dataset.otOver === "fade") at = n;
  at.after(el);
}

/** the first corner radius of an element, in px @param {Element} el */
const radiusOf = (el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;

/**
 * A transform that puts a box `from` onto a rect `to` — both in one layer's
 * px, for an element sitting at `from` with transform-origin 0 0 (its own
 * top-left corner): `x`, `y` move that corner, `kx`, `ky` scale about it. `fit`:
 * "contain" (default) scales evenly to fit inside the rect, centred;
 * "cover" scales evenly to fill it; "fill" stretches to it.
 * @param {BoxLike} from
 * @param {BoxLike} to
 * @param {"contain" | "cover" | "fill"} [fit]
 */
export function fitTransform(from, to, fit = "contain") {
  const a = boxOf(from);
  const b = boxOf(to);
  if (!(a.width > 0 && a.height > 0)) throw new Error("fitTransform: the box to move has no size");
  let kx = b.width / a.width;
  let ky = b.height / a.height;
  if (fit !== "fill") kx = ky = fit === "cover" ? Math.max(kx, ky) : Math.min(kx, ky);
  const x = b.x + (b.width - a.width * kx) / 2 - a.x;
  const y = b.y + (b.height - a.height * ky) / 2 - a.y;
  const f = (/** @type {number} */ v) => v.toFixed(3);
  return {
    x,
    y,
    kx,
    ky,
    css: `translate(${f(x)}px, ${f(y)}px) scale(${kx.toFixed(5)}, ${ky.toFixed(5)})`,
  };
}

/**
 * Lift one real part out of a saved screen as a layer of its own — the
 * clicked card, the number the app worked out — so it can be carried from
 * where it sat to anywhere, at any size. It is the same saved page again,
 * shown through a window the part's size: live DOM, so it stays sharp
 * however big it gets (the renderer rasterizes each frame at its final
 * scale; a very slow push on small text can step a pixel — see `film
 * picture` in the guide).
 *
 * The layer starts exactly over the part, inside `into` (default: the
 * screen's own parent, which must be positioned — there it sits above the
 * screen, its isolate() fades and the parts lifted before it), so lifting
 * it changes nothing on screen until it moves. `box` is where the part sits in `into`'s
 * px — what motion.js's handoffs (morphRect, hop…) start from; `place(rect)`
 * moves it there.
 *
 *   const s = screen(document.querySelector("#calc"));
 *   const card = lift(s, "e126", { around: "clear" });    // or a selector, or a box
 *   window.__film = { duration: 12, ready: card.ready };
 *   // in __render(t):
 *   card.place(morphRect(t, 4, 4.6, card.box, { x: 160, y: 140, w: 1600, h: 800 }));
 *
 * `around`: "keep" (default) — what was on screen within its box, page
 * included; "clear" — only the part itself, the rest of the page hidden and
 * see-through (a selector or id, not a bare box). `background`: CSS behind
 * it. `pad`: px of the page kept around its box (a shadow, a focus ring).
 * `radius`: the window's corner radius (default the part's own). `css`:
 * styles added to the lifted copy only — restyle it without touching the
 * screen.
 * @param {any} source a saved screen (screen(iframe)) or its iframe
 * @param {string | Element | BoxLike} key a selector, an index id ("e12"), an element of the screen, or a box in the screen's px
 * @param {{ into?: HTMLElement, around?: "keep" | "clear", background?: string, pad?: number,
 *   radius?: number, css?: string, fit?: "contain" | "cover" | "fill" }} [o]
 */
export function lift(source, key, o = {}) {
  const { frame, ready: sourceReady } = screenOf(source);
  const around = o.around ?? "keep";
  const pad = o.pad ?? 0;
  const isBox = typeof key === "object" && !(key instanceof Element);
  if (isBox && around === "clear")
    throw new Error(
      'lift: around: "clear" needs a part to keep (a selector or an id), not a bare box',
    );
  const into = o.into ?? frame.parentElement;
  if (!(into instanceof HTMLElement))
    throw new Error("lift: the screen has no parent to lift into");
  const el = document.createElement("div");
  el.dataset.otLift = typeof key === "string" ? key : "box";
  Object.assign(el.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    overflow: "hidden",
    transformOrigin: "0 0",
    pointerEvents: "none",
    visibility: "hidden", // until it is in place
    ...(o.background ? { background: o.background } : {}),
  });
  const copy = document.createElement("iframe");
  copy.setAttribute("aria-hidden", "true");
  copy.tabIndex = -1;
  Object.assign(copy.style, { position: "absolute", border: "0", background: "transparent" });
  el.appendChild(copy);
  if (into === frame.parentElement) stackOver(frame, el, "lift");
  else into.appendChild(el);

  /** @type {Box | null} */
  let box = null;
  /** @type {Box | null} */
  let own = null;
  let radius = 0;
  const ready = (async () => {
    await sourceReady;
    const doc = /** @type {Document} */ (frame.contentDocument);
    const target = isBox ? null : findIn(doc, /** @type {string | Element} */ (key));
    const r = target ? target.getBoundingClientRect() : null;
    const b = r
      ? { x: r.left, y: r.top, width: r.width, height: r.height }
      : boxOf(/** @type {BoxLike} */ (key));
    if (!(b.width > 0 && b.height > 0))
      throw new Error(`lift: ${String(el.dataset.otLift)} has no size on the screen`);
    own = { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
    const off = offsetWithin("lift", frame, into);
    box = { x: own.x + off.x, y: own.y + off.y, width: own.width, height: own.height };
    radius = o.radius ?? (target && !pad ? radiusOf(target) : 0);
    Object.assign(copy.style, {
      width: `${frame.clientWidth}px`,
      height: `${frame.clientHeight}px`,
      left: `${-own.x}px`,
      top: `${-own.y}px`,
    });
    copy.src = frame.src;
    await whenLoaded(copy);
    const cdoc = /** @type {Document} */ (copy.contentDocument);
    const win = /** @type {Window} */ (copy.contentWindow);
    // the same scroll as the screen it came from
    win.scrollTo(frame.contentWindow?.scrollX ?? 0, frame.contentWindow?.scrollY ?? 0);
    const mine = target ? atPath(cdoc, pathOf(target)) : null;
    if (target && !mine)
      throw new Error(`lift: ${String(el.dataset.otLift)} is not in the copy of the screen`);
    let css = o.css ?? "";
    if (around === "clear" && mine) {
      mine.setAttribute("data-ot-lifted", "");
      css += `html,body{background:transparent!important}
body *{visibility:hidden!important}
[data-ot-lifted],[data-ot-lifted] *{visibility:visible!important}`;
      // a document of another colour scheme than the page it sits in gets an
      // opaque backdrop: match it so the hidden page is see-through
      copy.style.colorScheme = getComputedStyle(cdoc.documentElement).colorScheme || "normal";
    }
    if (css) {
      const st = cdoc.createElement("style");
      st.textContent = css;
      cdoc.head.appendChild(st);
    }
    // the part may have moved in the copy (fonts, a restyle): measure again
    if (mine) {
      const m = mine.getBoundingClientRect();
      const ddx = m.left - pad - own.x;
      const ddy = m.top - pad - own.y;
      if (Math.abs(ddx) > 0.5 || Math.abs(ddy) > 0.5)
        Object.assign(copy.style, { left: `${-own.x - ddx}px`, top: `${-own.y - ddy}px` });
    }
    Object.assign(el.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      borderRadius: radius ? `${radius}px` : "",
      visibility: "visible",
    });
  })();
  ready.catch(() => {});

  const need = () => {
    if (!box) throw new Error("lift: not ready yet — wait for its .ready (put it in __film.ready)");
    return box;
  };
  return {
    /** the layer: a window onto a copy of the saved screen */
    el,
    /** the copy's iframe inside it */
    frame: copy,
    /** resolves once the copy is loaded and the layer sits over the part */
    ready,
    /** where the part sits, in `into`'s px (the layer's px at rest) */
    get box() {
      return { ...need() };
    },
    /** the same, as a motion.js rect (with the corner radius) */
    get rect() {
      const b = need();
      return { x: b.x, y: b.y, w: b.width, h: b.height, r: radius };
    },
    /** where the part sits in the screen's own px */
    get source() {
      if (!own) need();
      return { .../** @type {Box} */ (own) };
    },
    /** the transform that puts the part onto `rect` (in `into`'s px) @param {BoxLike} rect @param {"contain" | "cover" | "fill"} [fit] */
    at: (rect, fit = o.fit) => fitTransform(need(), rect, fit).css,
    /**
     * Put the part onto `rect` (`into`'s px; a motion.js rect's radius is
     * kept on screen, scaled back so the corners read as given) and,
     * optionally, its opacity.
     * @param {BoxLike & { r?: number }} rect
     * @param {{ opacity?: number, fit?: "contain" | "cover" | "fill" }} [p]
     */
    place(rect, p = {}) {
      const f = fitTransform(need(), rect, p.fit ?? o.fit);
      el.style.transform = f.css;
      if (rect.r != null) el.style.borderRadius = `${rect.r / Math.min(f.kx, f.ky)}px`;
      if (p.opacity != null) el.style.opacity = String(p.opacity);
      return f;
    },
    /** add styles to the lifted copy @param {string} css */
    restyle(css) {
      const cdoc = copy.contentDocument;
      if (!cdoc) throw new Error("lift: not ready yet");
      const st = cdoc.createElement("style");
      st.textContent = css;
      cdoc.head.appendChild(st);
    },
    remove: () => el.remove(),
  };
}

/**
 * Show a saved screen with everything but the chosen parts faded away: an
 * overlay over the screen (in the screen's parent, so a camera on that layer
 * carries it) with holes cut where the parts are. `set(p)` takes it from
 * nothing (0) to all the way (1). By default the rest fades into the page's
 * own background colour; `color` and `opacity` change that (a dim is
 * { color: "#000", opacity: 0.6 }), `blur` softens what is behind (px).
 *
 *   const focus = isolate(s, ["e126", "e133"]);
 *   window.__film = { …, ready: focus.ready };
 *   focus.set(smooth((t - 5) / 0.4));               // in __render(t)
 *
 * @param {any} source a saved screen or its iframe
 * @param {(string | Element | BoxLike)[]} keys selectors, index ids, elements or boxes (screen px)
 * @param {{ color?: string, opacity?: number, blur?: number, pad?: number, radius?: number }} [o]
 */
export function isolate(source, keys, o = {}) {
  const { frame, ready: sourceReady } = screenOf(source);
  const parent = frame.parentElement;
  if (!parent) throw new Error("isolate: the screen has no parent to draw in");
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    pointerEvents: "none",
    opacity: "0",
  });
  stackOver(frame, el, "fade");
  const pad = o.pad ?? 0;
  /** @type {Box[]} */
  let holes = [];
  const opacity = o.opacity ?? 1;
  const ready = (async () => {
    await sourceReady;
    const doc = /** @type {Document} */ (frame.contentDocument);
    const f = (/** @type {number} */ v) => v.toFixed(2);
    let path = "";
    holes = keys.map((k) => {
      const target = typeof k === "object" && !(k instanceof Element) ? null : findIn(doc, k);
      const r = target ? target.getBoundingClientRect() : null;
      const b = r
        ? { x: r.left, y: r.top, width: r.width, height: r.height }
        : boxOf(/** @type {BoxLike} */ (k));
      const x = b.x - pad;
      const y = b.y - pad;
      const w = b.width + 2 * pad;
      const h = b.height + 2 * pad;
      const rad = Math.min(o.radius ?? (target ? radiusOf(target) : 0), w / 2, h / 2);
      path += rad
        ? `M${f(x + rad)} ${f(y)}H${f(x + w - rad)}A${f(rad)} ${f(rad)} 0 0 1 ${f(x + w)} ${f(y + rad)}V${f(y + h - rad)}A${f(rad)} ${f(rad)} 0 0 1 ${f(x + w - rad)} ${f(y + h)}H${f(x + rad)}A${f(rad)} ${f(rad)} 0 0 1 ${f(x)} ${f(y + h - rad)}V${f(y + rad)}A${f(rad)} ${f(rad)} 0 0 1 ${f(x + rad)} ${f(y)}Z`
        : `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
      return { x, y, width: w, height: h };
    });
    const off = offsetWithin("isolate", frame, parent);
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    // the page's own background: the body's, else the root's, else white
    const bg = (/** @type {Element} */ n) => {
      const c = getComputedStyle(n).backgroundColor;
      return c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c) ? c : null;
    };
    Object.assign(el.style, {
      left: `${off.x}px`,
      top: `${off.y}px`,
      width: `${w}px`,
      height: `${h}px`,
      background: o.color ?? bg(doc.body) ?? bg(doc.documentElement) ?? "#fff",
      clipPath: `path(evenodd, "M0 0H${w}V${h}H0Z${path}")`,
    });
  })();
  ready.catch(() => {});
  return {
    el,
    ready,
    /** the parts left showing, in the screen's px */
    get holes() {
      return holes.map((b) => ({ ...b }));
    },
    /** how far the rest has faded, 0..1 @param {number} p */
    set(p) {
      const k = Math.max(0, Math.min(1, p));
      el.style.opacity = String(k * opacity);
      const blur = o.blur ? `blur(${(k * o.blur).toFixed(2)}px)` : "";
      el.style.backdropFilter = blur;
    },
  };
}

/**
 * A box of a layer under a camera, as it shows in the picture at t: its four
 * corners through cam.toView, bounded. For carrying a part from where the
 * camera shows it into a layer the camera does not move.
 * @param {BoxLike} b
 * @param {{ toView: (x: number, y: number, t: number) => number[] }} cam
 * @param {number} t
 * @returns {Box}
 */
export function throughCamera(b, cam, t) {
  const a = boxOf(b);
  const pts = [
    cam.toView(a.x, a.y, t),
    cam.toView(a.x + a.width, a.y, t),
    cam.toView(a.x, a.y + a.height, t),
    cam.toView(a.x + a.width, a.y + a.height, t),
  ];
  const xs = pts.map((p) => /** @type {number} */ (p[0]));
  const ys = pts.map((p) => /** @type {number} */ (p[1]));
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
