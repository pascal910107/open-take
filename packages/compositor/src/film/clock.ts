// The film clock: the page-side half of `open-take film render`, installed in
// the film's page before any of its own scripts run.
//
// A film is any web page. It either draws itself for a time (`window.__render(t)`,
// t in seconds, any order — the page is a pure function of time) or it simply
// animates: CSS animations and transitions, the Web Animations API, a
// requestAnimationFrame loop, GSAP, three.js, a <video>. For the second kind this
// clock replaces every time source the page can read — performance.now, Date,
// timers, requestAnimationFrame — with film time, and pauses every running
// animation and video so each frame shows exactly the instant asked for. Such a
// page keeps its own state, so it renders front to back (time only moves
// forward); Math.random is seeded so every render worker draws the same numbers.
//
// The renderer drives the page through `window.__ot`:
//   prepare()        → the page's ready promise, fonts, images; what it declared
//   seek(t)          → the page shows film time t (seconds)
//   motion(t, half)  → how far (px) anything visible moves across [t-half, t+half]
//
// The page may declare itself with `window.__film = { duration, width, height,
// fps, audio, ready, motion }` (every field optional). `__duration` and `__ready`
// are read too.
//
// This function is serialized into the page (Function#toString): it must not
// reference anything outside its own body.

type FilmClockOptions = {
  /** Math.random's seed — the same in every worker */
  seed: number;
  /** what Date says at film time 0 (ms since the epoch) */
  epochMs: number;
};

export type FilmPageInfo = {
  /** "render": the page draws any time on request (window.__render);
   *  "clock": it animates on its own and renders front to back */
  mode: "render" | "clock";
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  audio: string | null;
  /** the page has <audio> elements — they are not recorded */
  audioElements: number;
};

export function filmClockSource(opts: FilmClockOptions): string {
  // a transpiler that keeps function names (tsx/esbuild) calls a module-level
  // `__name` helper inside the body; the page has none, so it gets a no-op
  return `(() => { const __name = (f) => f; (${installFilmClock.toString()})(${JSON.stringify(opts)}); })();`;
}

function installFilmClock(opts: FilmClockOptions): void {
  // biome-ignore lint/suspicious/noExplicitAny: the page's globals are untyped
  const w = window as any;
  if (w.__ot) return;
  const realSetTimeout = w.setTimeout.bind(w) as typeof setTimeout;
  const RealDate = w.Date as DateConstructor;
  const realPause = HTMLMediaElement.prototype.pause;
  // motion (px) credited to a canvas whose pixels changed or a playing video —
  // their content moves in ways no element box shows
  const OPAQUE_PX = 12;
  const STEP_MS = 1000 / 60;
  const MAX_JUMP_MS = 10_000;

  let now = 0; // the page's clock, ms
  // the timers' own clock: equal to `now`, except while a __render holds its
  // instant — then timers still run in due order and schedule from their own
  // due time (a timer set inside a timer lands after the earlier ones)
  let holding = false;
  let timerNow = 0;
  const schedNow = () => (holding ? timerNow : now);
  // film time 0 is where the page became ready: a ready promise that waits on
  // a timer advances the page's clock before the film starts
  let base = 0;
  let mode: "render" | "clock" = "clock";
  // a frame inside the film (an <iframe> of a saved screen, say) runs on the
  // clock of the page that holds it, from where that page put it
  // biome-ignore lint/suspicious/noExplicitAny: the holding page's film clock
  let holder: any = null;
  try {
    const up = w.parent;
    if (up && up !== w && up.__ot) {
      holder = up.__ot;
      now = holder.bornOf(w.frameElement);
      base = holder.origin();
    }
  } catch {
    /* a cross-origin parent: this frame keeps its own clock */
  }
  /** this page, or the page that holds it, draws any moment on request: what
   *  runs in it runs from film time 0, whichever moment was drawn first */
  const drawn = (): boolean => mode === "render" || !!holder?.drawn();
  // requestAnimationFrame runs on one grid of film time (see advance): the
  // grid's instants, and the next one to run
  const gridTime = (k: number) => base + (k + 0.5) * STEP_MS;
  const gridAfter = (t: number) => Math.floor((t - base) / STEP_MS - 0.5 + 1e-9) + 1;
  let grid = gridAfter(now);
  // when the page's own timers or animation frames last ran
  let lastRan = Number.NEGATIVE_INFINITY;

  // the film time each <iframe> was put on the page: a frame loads in real
  // time, after the clock has moved on, and must start where it was inserted.
  // Records are drained synchronously after every callback that could insert.
  const inserted = new WeakMap<Element, number>();
  const noteFrames = (records: MutationRecord[]) => {
    for (const r of records)
      for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof Element)) continue;
        const frames =
          n instanceof HTMLIFrameElement ? [n] : Array.from(n.querySelectorAll("iframe"));
        for (const f of frames) if (!inserted.has(f)) inserted.set(f, now);
      }
  };
  const watcher = new MutationObserver(noteFrames);
  watcher.observe(document, { childList: true, subtree: true });
  const drain = () => noteFrames(watcher.takeRecords());

  // an error in the page's own callback fails the render, named, instead of
  // leaving a frame half drawn: rethrown on a clean stack the renderer watches
  const report = (e: unknown) => {
    realSetTimeout(() => {
      throw e;
    }, 0);
  };

  // In a browser every timer and animation-frame callback is a task of its
  // own: the promises it settles run before anything else does, so an `await`
  // resumes at the time its timer was due. A message on the clock's own
  // channel is such a task boundary.
  const channel = new MessageChannel();
  const flushed: (() => void)[] = [];
  channel.port1.onmessage = () => flushed.shift()?.();
  const flush = () =>
    new Promise<void>((ok) => {
      flushed.push(ok);
      channel.port2.postMessage(null);
    });
  /** after each of the page's callbacks: what it settled runs on, at its
   *  time, and an animation it started runs from then */
  async function after(): Promise<void> {
    lastRan = Math.max(lastRan, now);
    await flush();
    drain();
    if (!drawn()) for (const a of document.getAnimations()) if (!born.has(a)) born.set(a, now);
  }

  // --- random: seeded (mulberry32) -----------------------------------------
  let seed = opts.seed >>> 0;
  /** a page that draws any moment on request draws each moment with the same
   *  numbers, whichever worker draws it and in whatever order */
  const reseed = (tSec: number) => {
    let h = (opts.seed ^ Math.round(tSec * 1e6)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    seed = (h ^ (h >>> 16)) >>> 0;
  };
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // --- time sources ---------------------------------------------------------
  performance.now = () => now;
  class FilmDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(opts.epochMs + now);
      // biome-ignore lint/suspicious/noExplicitAny: Date's overloads
      else super(...(args as [any]));
    }
    static override now() {
      return opts.epochMs + now;
    }
  }
  w.Date = FilmDate;

  type Timer = { due: number; fn: unknown; args: unknown[]; every: number };
  const timers = new Map<number, Timer>();
  let nextTimer = 1;
  w.setTimeout = (fn: unknown, delay?: number, ...args: unknown[]) => {
    const id = nextTimer++;
    timers.set(id, { due: schedNow() + Math.max(0, Number(delay) || 0), fn, args, every: 0 });
    return id;
  };
  w.setInterval = (fn: unknown, delay?: number, ...args: unknown[]) => {
    const id = nextTimer++;
    const every = Math.max(1, Number(delay) || 0);
    timers.set(id, { due: schedNow() + every, fn, args, every });
    return id;
  };
  w.clearTimeout = w.clearInterval = (id: number) => {
    timers.delete(id);
  };
  w.requestIdleCallback = (fn: (d: unknown) => void) =>
    w.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0);
  w.cancelIdleCallback = (id: number) => timers.delete(id);

  let frames = new Map<number, (t: number) => void>();
  let nextFrame = 1;
  w.requestAnimationFrame = (fn: (t: number) => void) => {
    const id = nextFrame++;
    frames.set(id, fn);
    return id;
  };
  w.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };

  /** run every timer due by `until`, in due order. The clock moves to each
   *  timer's time — unless `hold`: a __render draws one instant, so the timers
   *  it waits on run at that instant (a page reading the clock reads t). */
  async function runTimers(until: number, hold = false): Promise<void> {
    for (let guard = 0; guard < 100_000; guard++) {
      let pickId = 0;
      let pick: Timer | undefined;
      for (const [id, t] of timers)
        if (t.due <= until && (!pick || t.due < pick.due)) {
          pick = t;
          pickId = id;
        }
      if (!pick) return;
      if (hold) timerNow = Math.max(timerNow, pick.due);
      else now = Math.max(now, pick.due);
      if (pick.every) pick.due += pick.every;
      else timers.delete(pickId);
      try {
        if (typeof pick.fn === "function") pick.fn(...pick.args);
        // setTimeout("code") is part of the timer API this clock stands in for
        // biome-ignore lint/complexity/noCommaOperator: an indirect (global) eval, as the browser's own
        // biome-ignore lint/security/noGlobalEval: the page's own string handler, run as the browser would
        else (0, eval)(String(pick.fn));
      } catch (e) {
        report(e);
      }
      await after();
    }
  }

  async function runFrames(): Promise<void> {
    const batch = frames;
    frames = new Map();
    for (const fn of batch.values()) {
      try {
        fn(now);
      } catch (e) {
        report(e);
      }
      await after();
    }
  }

  // --- animations: every one paused and set from film time -------------------
  const born = new WeakMap<Animation, number>();
  function syncAnimations(): void {
    // a page that draws any moment on request jumps around in time: its
    // animations all run from film time 0. In one that animates on its own an
    // animation runs from the callback that started it (or from where it was
    // first seen)
    const fromZero = drawn();
    for (const a of document.getAnimations()) {
      let b = base;
      if (!fromZero) {
        b = born.get(a) ?? now;
        born.set(a, b);
      }
      if (a.playState !== "paused") a.pause();
      a.currentTime = Math.max(0, (now - b) * (a.playbackRate || 1));
    }
    for (const svg of Array.from(document.querySelectorAll("svg"))) {
      if (svg.ownerSVGElement) continue;
      if (!svg.querySelector("animate,animateTransform,animateMotion,set")) continue;
      svg.pauseAnimations();
      svg.setCurrentTime((now - base) / 1000);
    }
  }

  // --- media: a video plays on film time, seeked frame by frame ---------------
  type Media = { seen: boolean; playing: boolean; born: number };
  const media = new WeakMap<HTMLMediaElement, Media>();
  const mediaOf = (el: HTMLMediaElement): Media => {
    let m = media.get(el);
    if (!m) {
      m = { seen: false, playing: false, born: now };
      media.set(el, m);
    }
    return m;
  };
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    const m = mediaOf(this);
    if (!m.playing) {
      m.playing = true;
      m.born = now - this.currentTime * 1000;
    }
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    mediaOf(this).playing = false;
    return realPause.call(this);
  };
  function seekVideo(el: HTMLVideoElement, at: number): Promise<void> {
    return new Promise((ok) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        el.removeEventListener("seeked", done);
        ok();
      };
      const go = () => {
        el.addEventListener("seeked", done);
        el.currentTime = at;
      };
      if (el.readyState >= 1) go();
      else el.addEventListener("loadedmetadata", go, { once: true });
      realSetTimeout(done, 10_000);
    });
  }
  async function syncMedia(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const el of Array.from(document.querySelectorAll("video"))) {
      const m = mediaOf(el);
      if (!m.seen) {
        m.seen = true;
        el.muted = true;
        if (el.autoplay && !m.playing) {
          m.playing = true;
          m.born = drawn() ? base : now;
        }
        el.autoplay = false;
        realPause.call(el);
      }
      if (!m.playing) continue;
      let at = (now - m.born) / 1000;
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) at = el.loop ? at % d : Math.min(at, d - 0.001);
      if (Math.abs(el.currentTime - at) > 0.0005 || el.readyState < 2)
        waits.push(seekVideo(el, Math.max(0, at)));
    }
    await Promise.all(waits);
  }

  async function settle(): Promise<void> {
    await syncMedia();
    const pending = Array.from(document.images).filter((i) => !i.complete);
    if (pending.length)
      await Promise.race([
        Promise.all(pending.map((i) => i.decode().catch(() => {}))),
        new Promise((ok) => realSetTimeout(ok, 15_000)),
      ]);
    if (document.fonts.status !== "loaded") await document.fonts.ready;
    await followFrames();
  }

  // same-origin frames on the page: loaded before the frame is taken, and on
  // the film's time (their own animations, timers and videos)
  async function followFrames(): Promise<void> {
    await eachFrame(async (f) => {
      if (!(await loaded(f))) return;
      await rewind(f, now);
      await clockOf(f)?.follow(now, base);
    });
  }

  function eachFrame(fn: (f: HTMLIFrameElement) => Promise<unknown>): Promise<unknown> {
    return Promise.all(Array.from(document.querySelectorAll("iframe")).map(fn));
  }

  /** a frame's own film clock; null when it is cross-origin or has none */
  // biome-ignore lint/suspicious/noExplicitAny: the frame's own film clock
  function clockOf(f: HTMLIFrameElement): any {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the frame's own film clock
      return (f.contentWindow as any)?.__ot ?? null;
    } catch {
      return null; // cross-origin: not ours to drive
    }
  }

  /** wait for a frame's document; false when it is not ours to drive */
  async function loaded(f: HTMLIFrameElement): Promise<boolean> {
    const doc = f.contentDocument; // null when cross-origin
    if (!doc) return false;
    // a frame with a source shows an empty document until that loads
    const src = f.getAttribute("src");
    const loading =
      doc.URL === "about:blank" && (f.hasAttribute("srcdoc") || (!!src && src !== "about:blank"));
    if (doc.readyState !== "complete" || loading)
      await new Promise<void>((ok) => {
        const done = () => ok();
        f.addEventListener("load", done, { once: true });
        realSetTimeout(done, 15_000);
      });
    return !!f.contentDocument;
  }

  /** a frame whose own timers or animation frames ran past `at` holds what
   *  happened after it: it is loaded again, to play up to `at` from its start */
  async function rewind(f: HTMLIFrameElement, at: number): Promise<void> {
    if (!clockOf(f)?.ahead(at)) return;
    const url = f.contentDocument?.URL;
    if (!url || url === "about:blank") return; // written by the page: nothing to load again
    await new Promise<void>((ok) => {
      f.addEventListener("load", () => ok(), { once: true });
      realSetTimeout(ok, 15_000);
      f.contentWindow?.location.reload();
    });
  }

  /** while the page waits (its ready promise, an async __render), the frames
   *  inside it run their due timers and animation frames too — a ready promise
   *  may wait on a frame's requestAnimationFrame. With `jump` a frame also runs
   *  its next timer, as the page does; with `hold` (a __render drawing one
   *  instant) its clock stays at that instant meanwhile, as the page's does. */
  function tickFrames(jump: boolean, hold: boolean): Promise<unknown> {
    return eachFrame(async (f) => clockOf(f)?.tick(jump, hold));
  }

  /** a frame inside the film: go to the holding page's time (ms on its clock;
   *  `origin` is where film time 0 is) */
  async function follow(at: number, origin: number): Promise<void> {
    if (origin !== base) {
      base = origin;
      grid = gridAfter(now);
    }
    if (at >= now) await advance(at);
    else {
      // nothing ran past `at`, or the frame cannot be loaded again
      now = at;
      grid = gridAfter(at);
      syncAnimations();
    }
    await settle();
  }

  // --- moving time -----------------------------------------------------------
  /** requestAnimationFrame runs 60 times a second of film time, on one grid
   *  from film time 0 — as on a 60 Hz screen — however the film is sought: in
   *  order, between a shutter's samples, or straight from a fresh page, a page
   *  that moves a step a frame is where a browser would have it. The grid
   *  lies halfway between 60 fps frames, so no frame's shutter spans two of
   *  its instants: what a page draws itself in requestAnimationFrame is sharp;
   *  what CSS, the Web Animations API or __render move is blurred. */
  async function advance(to: number): Promise<void> {
    if (to < now - 1e-6)
      throw new Error(
        `film clock: cannot go back from ${((now - base) / 1000).toFixed(3)}s to ${((to - base) / 1000).toFixed(3)}s — ` +
          "this film has no window.__render(t), so it keeps its own state and renders front to back",
      );
    syncAnimations(); // what is on the page now starts now
    for (let g = gridTime(grid); g <= to + 1e-6; g = gridTime(++grid)) {
      await runTimers(g);
      now = g;
      if (frames.size) {
        syncAnimations();
        await runFrames();
      }
    }
    await runTimers(to);
    now = to;
    syncAnimations();
  }

  /** await a promise the page returned while its timers and frames still run.
   *  A promise that waits on a timer (a __render that waits a few ms, a ready
   *  promise behind a setTimeout) would never settle on a clock that only moves
   *  when asked: when real waiting does not settle it, the next timer due runs
   *  — at most MAX_JUMP_MS past where the wait began. Before the film starts
   *  (`hold` false: the ready wait) the clock moves with it, and film time 0
   *  is where the page became ready; inside a __render (`hold` true) the clock
   *  stays at the instant being drawn. */
  async function pump<T>(p: PromiseLike<T>, hold = false): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    let failed = false;
    Promise.resolve(p).then(
      (v) => {
        settled = true;
        value = v;
      },
      (e) => {
        settled = true;
        failed = true;
        error = e;
      },
    );
    const start = now;
    if (hold) {
      holding = true;
      timerNow = now;
    }
    try {
      for (let i = 0; !settled; i++) {
        if (i > 3000) throw new Error("film clock: the page's promise did not settle within ~45 s");
        await runTimers(now, hold);
        await runFrames();
        await tickFrames(false, hold);
        await new Promise((ok) => realSetTimeout(ok, i < 20 ? 0 : 15));
        if (settled || i < 3) continue;
        let due = Number.POSITIVE_INFINITY;
        for (const t of timers.values()) due = Math.min(due, t.due);
        if (due !== Number.POSITIVE_INFINITY && due - start <= MAX_JUMP_MS)
          await runTimers(due, hold);
        await tickFrames(true, hold);
      }
    } finally {
      if (hold) {
        holding = false;
        await eachFrame(async (f) => clockOf(f)?.release());
      }
    }
    if (failed) throw error;
    return value as T;
  }

  async function seek(tSec: number): Promise<void> {
    const t = base + tSec * 1000;
    if (mode === "render") {
      // a frame that ran on past t is loaded again before the page draws into it
      await eachFrame((f) => rewind(f, t));
      now = t;
      reseed(tSec);
      const r = w.__render(tSec);
      if (r && typeof r.then === "function") await pump(r, true);
      drain();
      syncAnimations();
    } else await advance(t);
    await settle();
  }

  // --- motion: how far anything visible moves over the shutter ---------------
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = 48;
  thumbCanvas.height = 27;
  let thumbCtx: CanvasRenderingContext2D | null = null;
  function thumb(c: HTMLCanvasElement): Uint8ClampedArray | null {
    try {
      thumbCtx ??= thumbCanvas.getContext("2d", { willReadFrequently: true });
      if (!thumbCtx) return null;
      thumbCtx.clearRect(0, 0, 48, 27);
      thumbCtx.drawImage(c, 0, 0, 48, 27);
      return thumbCtx.getImageData(0, 0, 48, 27).data.slice();
    } catch {
      return null; // a tainted or lost canvas: counted as moving
    }
  }
  type Snapshot = {
    rects: Map<Element, DOMRect>;
    thumbs: Map<HTMLCanvasElement, Uint8ClampedArray | null>;
    video: boolean;
  };
  function snapshot(): Snapshot {
    const vw = innerWidth;
    const vh = innerHeight;
    const rects = new Map<Element, DOMRect>();
    const thumbs = new Map<HTMLCanvasElement, Uint8ClampedArray | null>();
    let video = false;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (
        r.width < 1 ||
        r.height < 1 ||
        r.right <= 0 ||
        r.bottom <= 0 ||
        r.left >= vw ||
        r.top >= vh
      )
        continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      rects.set(el, r);
      if (el instanceof HTMLCanvasElement) thumbs.set(el, thumb(el));
      else if (el instanceof HTMLVideoElement && media.get(el)?.playing) video = true;
      else if (el instanceof HTMLIFrameElement) framed(el, r, rects, vw, vh);
    }
    return { rects, thumbs, video };
  }

  /** the elements inside a same-origin frame (a saved screen lifted into the
   *  film), in the film's coordinates — what moves inside it moves on screen */
  function framed(
    f: HTMLIFrameElement,
    box: DOMRect,
    rects: Map<Element, DOMRect>,
    vw: number,
    vh: number,
  ): void {
    let doc: Document | null = null;
    try {
      doc = f.contentDocument;
    } catch {
      return; // cross-origin
    }
    if (!doc?.body) return;
    // the frame's own viewport, scaled by whatever transform the film put on it
    const sx = box.width / (f.clientWidth || box.width);
    const sy = box.height / (f.clientHeight || box.height);
    for (const el of Array.from(doc.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const m = new DOMRect(
        box.left + r.left * sx,
        box.top + r.top * sy,
        r.width * sx,
        r.height * sy,
      );
      if (m.right <= Math.max(0, box.left) || m.bottom <= Math.max(0, box.top)) continue;
      if (m.left >= Math.min(vw, box.right) || m.top >= Math.min(vh, box.bottom)) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      rects.set(el, m);
    }
  }
  type Change = {
    /** the farthest any element that is in both snapshots travelled */
    px: number;
    /** visible area (px²) of elements that are in only one of them */
    churn: number;
  };
  function moved(a: Snapshot, b: Snapshot): Change {
    let px = 0;
    let churn = 0;
    const vw = innerWidth;
    const vh = innerHeight;
    const area = (r: DOMRect) =>
      Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left)) *
      Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    for (const [el, ra] of a.rects) {
      const rb = b.rects.get(el);
      if (!rb) {
        churn += area(ra); // vanished: a cut or a fade, not motion
        continue;
      }
      const d = Math.max(
        Math.abs(ra.left - rb.left),
        Math.abs(ra.top - rb.top),
        Math.abs(ra.right - rb.right),
        Math.abs(ra.bottom - rb.bottom),
      );
      if (d > px) px = d;
    }
    for (const [el, rb] of b.rects) if (!a.rects.has(el)) churn += area(rb);
    for (const [el, ta] of a.thumbs) {
      if (!b.thumbs.has(el)) continue;
      const tb = b.thumbs.get(el);
      let changed = !ta || !tb;
      if (ta && tb) {
        let diff = 0;
        for (let i = 0; i < ta.length; i++) diff += Math.abs(ta[i]! - tb[i]!);
        changed = diff / ta.length > 0.5;
      }
      if (changed) px = Math.max(px, OPAQUE_PX);
    }
    if (a.video || b.video) px = Math.max(px, OPAQUE_PX);
    return { px, churn };
  }
  async function motion(tSec: number, halfSec: number): Promise<number> {
    const hook = w.__film?.motion;
    if (typeof hook === "function") {
      const px = Number(await hook(tSec, halfSec));
      return Number.isFinite(px) && px > 0 ? px : 0;
    }
    await seek(Math.max(0, tSec - halfSec));
    const a = snapshot();
    await seek(tSec);
    const mid = snapshot();
    await seek(tSec + halfSec);
    const b = snapshot();
    // A shutter never straddles a cut: when the change happens in one half of
    // the shutter only — something jumps, or a large part of the picture
    // appears or vanishes at once — the frame gets one sharp sample instead of
    // a double exposure. Motion spreads over both halves.
    const first = moved(a, mid);
    const second = moved(mid, b);
    const screen = innerWidth * innerHeight;
    const onlyIn = (x: Change, y: Change) =>
      (x.px > 1 && y.px < 0.1 * x.px) || (x.churn > 0.25 * screen && y.churn < 0.05 * screen);
    if (onlyIn(first, second) || onlyIn(second, first)) return 0;
    return moved(a, b).px;
  }

  // --- ready -----------------------------------------------------------------
  async function prepare(): Promise<unknown> {
    const film = w.__film ?? {};
    const ready = film.ready ?? w.__ready;
    if (ready) await pump(typeof ready === "function" ? ready() : ready);
    base = now;
    grid = 0;
    mode = typeof w.__render === "function" ? "render" : "clock";
    if (mode === "clock") {
      // the page's first frame, which a browser runs before its first paint
      await runTimers(base);
      syncAnimations();
      await runFrames();
      syncAnimations();
    }
    await settle();
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    return {
      mode,
      duration: num(film.duration ?? w.__duration),
      width: num(film.width),
      height: num(film.height),
      fps: num(film.fps),
      audio: typeof film.audio === "string" ? film.audio : null,
      audioElements: document.querySelectorAll("audio").length,
    };
  }

  w.__ot = {
    prepare,
    seek,
    motion,
    // --- for the frames inside the film (times in ms on this page's clock) ---
    follow,
    tick: async (jump: boolean, hold: boolean) => {
      if (hold && !holding) {
        holding = true;
        timerNow = now;
      }
      await runTimers(now, holding);
      await runFrames();
      if (jump) {
        let due = Number.POSITIVE_INFINITY;
        for (const t of timers.values()) due = Math.min(due, t.due);
        if (due - now <= MAX_JUMP_MS) await runTimers(due, holding);
      }
      await tickFrames(jump, holding);
    },
    release: async () => {
      holding = false;
      await eachFrame(async (f) => clockOf(f)?.release());
    },
    ahead: (at: number) => lastRan > at + 1e-6,
    drawn,
    origin: () => base,
    // in a film that draws itself, which moment put a frame on the page first
    // depends on the order they were drawn in: its frames start at film time 0
    bornOf: (el: Element | null) => {
      if (drawn()) return base;
      drain();
      return (el && inserted.get(el)) ?? now;
    },
  };
}
