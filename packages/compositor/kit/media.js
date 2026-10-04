// @ts-check
// The real interface in a film — open-take's film kit. Two kinds of material:
//
//   screen(iframe)  a saved screen (`make --states`: takes/x.take/states/s3/
//                   state.html) shown in an <iframe> the size of its viewport.
//                   box() says where a part of it is — measured on the page as
//                   it is now, so restyling it moves the box too — in the
//                   screen's own CSS px: the coordinates the camera and cursor
//                   take when the screen is their layer.
//   stills(log)     the 2× stills `open-take shoot` writes, with its log
//                   (shots.json): which still shows at t, decoded before the
//                   frame is drawn, a bounded number held at once (a long drag
//                   can be 900 stills), and every box and cursor position the
//                   shoot recorded — in the still's own px — so nothing is
//                   copied by hand.
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
        `${what}: it, or something between it and the layer, is transformed — the kit cannot measure through that; place it untransformed in the layer, or map it yourself`,
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
 * A saved screen shown in an iframe of its viewport's size.
 * @param {HTMLIFrameElement} frame
 */
export function screen(frame) {
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
  /** @type {{ viewport: { w: number, h: number }, scale?: number, stills: Still[] }} */
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
    /** where the shoot's cursor was at still i, in the still's own CSS px */
    /** @param {number} i */
    cursor(i) {
      const s = still(i);
      if (!s.cursor) throw new Error(`stills: still ${i} recorded no cursor`);
      return { x: s.cursor.x - (s.scroll?.x ?? 0), y: s.cursor.y - (s.scroll?.y ?? 0) };
    },
  };
}
