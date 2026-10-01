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
  // clock of the page that holds it — times in ms on the top page's clock —
  // from where that page put it
  try {
    const up = w.parent;
    if (up && up !== w && up.__ot) {
      now = up.__ot.bornOf(w.frameElement);
      base = up.__ot.origin();
    }
  } catch {
    /* a cross-origin parent: this frame keeps its own clock */
  }
  // requestAnimationFrame runs on one grid of film time (see advance): the
  // grid's instants, and the next one to run
  const gridTime = (k: number) => base + (k + 0.5) * STEP_MS;
  const gridAfter = (t: number) => Math.floor((t - base) / STEP_MS - 0.5 + 1e-9) + 1;
  let grid = gridAfter(now);
  // whether the page has had its first animation frame (see firstFrame), and
  // when its own timers or animation frames last ran
  let started = false;
  let lastRan = Number.NEGATIVE_INFINITY;

  // when each <iframe> and <video> was put on the page: it loads in real
  // time, after the clock has moved on, and must start where it was inserted.
  // Lazy loading waits for a viewport a film never scrolls into, so what is
  // lazy loads at once. Records are drained synchronously after every
  // callback that could insert.
  const inserted = new WeakMap<Element, number>();
  const noteInserted = (records: MutationRecord[]) => {
    for (const r of records)
      for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof Element)) continue;
        const els = Array.from(n.querySelectorAll("iframe,video,img"));
        if (n.matches("iframe,video,img")) els.push(n);
        for (const el of els) {
          if (!(el instanceof HTMLImageElement) && !inserted.has(el)) inserted.set(el, now);
          const lazy = el as HTMLImageElement | HTMLIFrameElement;
          if (lazy.loading === "lazy") lazy.loading = "eager";
        }
      }
  };
  const watcher = new MutationObserver(noteInserted);
  watcher.observe(document, { childList: true, subtree: true });
  const drain = () => noteInserted(watcher.takeRecords());

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
    if (mode === "clock")
      for (const a of document.getAnimations()) if (!born.has(a)) born.set(a, now);
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

  // --- loading: what the page asked for that is still on its way. Before the
  // film starts the clock moves on only while nothing is (see pump) ----------
  let loading = 0;
  const track = <T>(p: Promise<T>): Promise<T> => {
    loading++;
    const done = () => {
      loading--;
    };
    p.then(done, done);
    return p;
  };
  if (typeof w.fetch === "function") {
    const realFetch = w.fetch.bind(w);
    w.fetch = (...a: unknown[]) => track(realFetch(...a));
  }
  // biome-ignore lint/suspicious/noExplicitAny: the body readers, by name
  const body = Response.prototype as any;
  for (const k of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
    const real = body[k];
    if (typeof real === "function")
      body[k] = function (this: Response, ...a: unknown[]) {
        return track(real.apply(this, a));
      };
  }
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...a: unknown[]) {
    loading++;
    this.addEventListener(
      "loadend",
      () => {
        loading--;
      },
      { once: true },
    );
    try {
      // biome-ignore lint/suspicious/noExplicitAny: send's one optional body
      return realSend.apply(this, a as any);
    } catch (e) {
      loading--;
      throw e;
    }
  };
  // an image made in script (a texture, say) counts while it loads; the
  // document's own images are looked at directly (see busy)
  for (const k of ["src", "srcset"]) {
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, k);
    const set = d?.set;
    if (!set) continue;
    Object.defineProperty(HTMLImageElement.prototype, k, {
      ...d,
      set(this: HTMLImageElement, v: unknown) {
        set.call(this, v);
        if (this.isConnected || this.complete) return;
        loading++;
        let counted = true;
        const done = () => {
          if (counted) loading--;
          counted = false;
        };
        this.addEventListener("load", done, { once: true });
        this.addEventListener("error", done, { once: true });
      },
    });
  }
  const realDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
    return track(realDecode.call(this));
  };
  if (typeof w.createImageBitmap === "function") {
    const realBitmap = w.createImageBitmap.bind(w);
    w.createImageBitmap = (...a: unknown[]) => track(realBitmap(...a));
  }

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
      else {
        now = Math.max(now, pick.due);
        // what the callback reads of an animation is where it is at its time
        if (now !== syncedAt) syncAnimations();
      }
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
  let syncedAt = Number.NaN;
  function syncAnimations(): void {
    syncedAt = now;
    // a page that draws any moment on request jumps around in time: its
    // animations all run from film time 0. In one that animates on its own —
    // and in a frame inside the film, which plays its own life in order — an
    // animation runs from the callback that started it, or from where it was
    // first seen; one that started before the film did starts with it
    for (const a of document.getAnimations()) {
      let b = base;
      if (mode === "clock") {
        if (!born.has(a)) born.set(a, now);
        b = Math.max(base, born.get(a)!);
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
          m.born = mode === "render" ? base : Math.max(base, inserted.get(el) ?? now);
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
    await rewindFrames(now);
    await eachFrame(async (f) => {
      if (await loaded(f)) await clockOf(f)?.follow(now, base);
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

  /** a frame's document is still to come (a frame with a source shows an
   *  empty one until that loads) */
  const awaiting = (f: HTMLIFrameElement, doc: Document) => {
    const src = f.getAttribute("src");
    return (
      doc.readyState !== "complete" ||
      (doc.URL === "about:blank" && (f.hasAttribute("srcdoc") || (!!src && src !== "about:blank")))
    );
  };

  /** wait for a frame's document; false when it is not ours to drive */
  async function loaded(f: HTMLIFrameElement): Promise<boolean> {
    const doc = f.contentDocument; // null when cross-origin
    if (!doc) return false;
    if (awaiting(f, doc))
      await new Promise<void>((ok) => {
        const done = () => ok();
        f.addEventListener("load", done, { once: true });
        realSetTimeout(done, 15_000);
      });
    return !!f.contentDocument;
  }

  /** frames whose own timers or animation frames ran past `at` hold what
   *  happened after it: each is loaded again, with what is inside it, to play
   *  up to `at` from its start */
  function rewindFrames(at: number): Promise<unknown> {
    return eachFrame(async (f) => {
      const ot = clockOf(f);
      if (!ot) return;
      const url = f.contentDocument?.URL;
      // a frame the page wrote itself has nothing to load again
      if (!ot.ahead(at) || !url || url === "about:blank") return ot.rewindFrames(at);
      await new Promise<void>((ok) => {
        f.addEventListener("load", () => ok(), { once: true });
        realSetTimeout(ok, 15_000);
        f.contentWindow?.location.reload();
      });
    });
  }

  /** while a __render waits, the frames inside the page hold its instant too
   *  (see tick) */
  const tickFrames = (jump: boolean) => eachFrame(async (f) => clockOf(f)?.tick(jump));

  /** a frame inside the film: go to the holding page's time (`origin` is
   *  where film time 0 is) */
  async function follow(at: number, origin: number): Promise<void> {
    if (origin !== base) {
      base = origin;
      grid = gridAfter(now);
    }
    if (!started) await firstFrame();
    if (at >= now) await advance(at);
    else {
      // nothing ran past `at`, or the frame cannot be loaded again
      now = at;
      grid = gridAfter(at);
      syncAnimations();
    }
    await settle();
  }

  /** the page's first animation frame, which a browser runs before it first
   *  paints: where the page becomes ready, or where a frame inside it starts */
  async function firstFrame(): Promise<void> {
    started = true;
    await runTimers(now);
    syncAnimations();
    await runFrames();
    syncAnimations();
  }

  /** when the page's clock has something to run next — a timer, or an
   *  animation frame someone asked for — its own or a frame's inside it */
  function nextEvent(): number {
    let t = Number.POSITIVE_INFINITY;
    for (const x of timers.values()) t = Math.min(t, x.due);
    if (frames.size) t = Math.min(t, gridTime(grid));
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      const n = clockOf(f)?.next();
      if (typeof n === "number") t = Math.min(t, n);
    }
    return t;
  }

  /** something the page asked for is still on its way: a fetch, an image, a
   *  font, a video's first frame, a frame's document, or the like in a frame */
  function busy(): boolean {
    if (loading > 0 || document.fonts.status === "loading") return true;
    if (Array.from(document.images).some((i) => !i.complete)) return true;
    for (const v of Array.from(document.querySelectorAll("video")))
      if (v.readyState < 2 && v.networkState === v.NETWORK_LOADING) return true;
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      const doc = f.contentDocument;
      if (doc && (awaiting(f, doc) || clockOf(f)?.busy())) return true;
    }
    return false;
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
   *  Real waiting comes first (a fetch, an image, a font). A promise that waits
   *  on the page's own clock (a timer, an animation frame) would never settle
   *  on a clock that only moves when asked: when real waiting does not settle
   *  it, the clock runs the next thing due — at most MAX_JUMP_MS past where
   *  the wait began.
   *  Before the film starts (`hold` false: the ready wait) the clock moves
   *  with it, but only while nothing the page asked for is still on its way:
   *  however long loading took, the page reaches film time 0 — where it
   *  became ready — in the same state. Inside a __render (`hold` true) the
   *  clock stays at the instant being drawn, as do the frames inside the
   *  page; timers run in due order on their own clock. */
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
    const began = RealDate.now();
    if (hold) {
      holding = true;
      timerNow = now;
    }
    try {
      for (let i = 0, stepped = false; !settled; i++) {
        if (RealDate.now() - began > 45_000)
          throw new Error("film clock: the page's promise did not settle within 45 s");
        if (hold) {
          await runTimers(now, true);
          await runFrames();
          await tickFrames(false);
        } else await advance(now);
        if (settled) break;
        await new Promise((ok) => realSetTimeout(ok, stepped || i < 20 ? 0 : 15));
        stepped = false;
        if (settled || i < 3) continue;
        if (hold) {
          let due = Number.POSITIVE_INFINITY;
          for (const t of timers.values()) due = Math.min(due, t.due);
          if (due - start <= MAX_JUMP_MS) await runTimers(due, true);
          await tickFrames(true);
        } else if (!busy()) {
          const next = nextEvent();
          if (next - start <= MAX_JUMP_MS) {
            await advance(Math.max(now, next));
            await followFrames();
            stepped = true;
          }
        }
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
      now = t;
      // the frames inside the page are at t before it draws — it may read
      // them, or write into them — and one whose own script ran past t has
      // been loaded again
      await followFrames();
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
    if (mode === "clock") await firstFrame();
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
    // --- for the frames inside the film (times in ms on the top page's clock) ---
    follow,
    /** the page holding this frame draws one instant: this frame holds it too
     *  — its timers run in due order on their own clock — and with `jump` its
     *  next timer runs or, with none due, its next animation frame, which the
     *  page may be waiting for */
    tick: async (jump: boolean) => {
      if (!holding) {
        holding = true;
        timerNow = now;
      }
      await runTimers(now, true);
      if (jump) {
        let due = Number.POSITIVE_INFINITY;
        for (const t of timers.values()) due = Math.min(due, t.due);
        if (due - now <= MAX_JUMP_MS) await runTimers(due, true);
        else if (frames.size) await runFrames();
      }
      await tickFrames(jump);
    },
    release: async () => {
      holding = false;
      await eachFrame(async (f) => clockOf(f)?.release());
    },
    rewindFrames,
    ahead: (at: number) => lastRan > at + 1e-6,
    next: nextEvent,
    busy,
    origin: () => base,
    // in a page that draws any moment on request, which moment put a frame on
    // the page first depends on the order they were drawn in: its frames
    // start at film time 0
    bornOf: (el: Element | null) => {
      if (mode === "render") return base;
      drain();
      return (el && inserted.get(el)) ?? now;
    },
  };
}
