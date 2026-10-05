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
//   motion(t, half)  → how far (px) anything visible moves across [t-half, t+half],
//                      and which side of that shutter to expose (one that cuts is left out)
//
// The page may declare itself with `window.__film = { duration, width, height,
// fps, audio, ready, motion, marks }` (every field optional). `__duration` and
// `__ready` are read too. `marks` — [{ at, until?, what? }] — are the moments
// the author means to look the way they do (a white flash on the beat): `film
// check` lists what it finds there as marked, not as a defect.
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
  /** window.__film.marks as the page has them (see filmMarks) */
  marks: unknown;
};

/** A moment the author means to look the way it does, in seconds of film
 *  time: `film check` lists what it finds there as marked, not as a defect. */
export type FilmMark = { at: number; until: number; what: string | null };

/** window.__film.marks, checked: a list of { at, until?, what? } in seconds;
 *  a mark without `until` is the moment `at`. */
export function filmMarks(raw: unknown): FilmMark[] {
  if (raw == null) return [];
  const usage = "[{ at: <seconds>, until?: <seconds>, what?: <text> }]";
  if (!Array.isArray(raw)) throw new Error(`film: window.__film.marks is a list — ${usage}`);
  return raw.map((m, i) => {
    const { at, until, what } = (m ?? {}) as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0)
      throw new Error(
        `film: window.__film.marks[${i}].at is the mark's time in seconds — ${usage}`,
      );
    if (until != null && (typeof until !== "number" || !Number.isFinite(until) || until < at))
      throw new Error(
        `film: window.__film.marks[${i}].until is a time in seconds from at (${at}) on — ${usage}`,
      );
    return {
      at,
      until: (until as number | null | undefined) ?? at,
      what: what == null ? null : String(what),
    };
  });
}

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
  // how long the ready wait holds the clock for loading that does not end
  const LOADING_PATIENCE_MS = 10_000;
  // how many times one instant is drawn while new frames keep showing up in it
  const MAX_DRAWS = 32;
  const warn = console.warn.bind(console);

  let now = 0; // the page's clock, ms
  // the timers' own clock: equal to the page's, except while a __render holds
  // its instant — then timers still run in due order and schedule from their
  // own due time (a timer set inside a timer lands after the earlier ones)
  let holding = false;
  let timerNow = 0;
  const schedNow = () => (holding ? timerNow : clock());
  // film time 0 is where the page became ready: a ready promise that waits on
  // a timer advances the page's clock before the film starts
  let base = 0;
  let mode: "render" | "clock" = "clock";
  // A frame inside the film (an <iframe> of a saved screen, say) shows its
  // page as it loaded, on the film's clock. Its timers and animation frames
  // run where the page put it — its first frame, as a browser runs before
  // painting — and not again: what a frame's own script would do later
  // depends on how the film is sought, and what moves inside a frame, the
  // page moves (it is same-origin). Its CSS animations and videos play on
  // film time. While it loads it reads the time it was put on the page;
  // once it shows, the time of the page that holds it (ms on the top page's
  // clock).
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
  // whether the page has had its first animation frame (see firstFrame)
  let started = false;
  /** the time this page reads, and plays its animations and videos at */
  const clock = (): number => (holder && started ? holder.clock() : now);
  /** this page, or the page that holds it, draws any moment on request */
  const drawn = (): boolean => mode === "render" || !!holder?.drawn();
  // requestAnimationFrame runs on one grid of film time (see advance): the
  // grid's instants, and the next one to run
  const gridTime = (k: number) => base + (k + 0.5) * STEP_MS;
  const gridAfter = (t: number) => Math.floor((t - base) / STEP_MS - 0.5 + 1e-9) + 1;
  let grid = gridAfter(now);

  // when each <iframe> and <video> was put on the page: it loads in real
  // time, after the clock has moved on, and must start where it was inserted.
  // Lazy loading waits for a viewport a film never scrolls into, so what is
  // lazy loads at once. Records are drained synchronously after every
  // callback that could insert.
  const inserted = new WeakMap<Element, number>();
  // frames put on the page that have not shown yet (see after), and how many
  // have
  const unshown = new Set<HTMLIFrameElement>();
  let shown = 0;
  const noteInserted = (records: MutationRecord[]) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof Element)) continue;
        const els = Array.from(n.querySelectorAll("iframe,video,img"));
        if (n.matches("iframe,video,img")) els.push(n);
        for (const el of els) {
          if (!(el instanceof HTMLImageElement) && !inserted.has(el)) inserted.set(el, clock());
          if (el instanceof HTMLIFrameElement) unshown.add(el);
          const lazy = el as HTMLImageElement | HTMLIFrameElement;
          if (lazy.loading === "lazy") lazy.loading = "eager";
        }
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
   *  time; an animation it started, here or in a frame, runs from then; and a
   *  frame it put on the page loads and shows before the clock moves on */
  async function after(): Promise<void> {
    await flush();
    stamp();
    await showFrames();
  }
  /** animations not seen before start now */
  function stamp(): void {
    drain();
    if (!drawn()) for (const a of document.getAnimations()) if (!born.has(a)) born.set(a, clock());
    for (const f of Array.from(document.querySelectorAll("iframe"))) clockOf(f)?.stamp();
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
  performance.now = () => clock();
  class FilmDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(opts.epochMs + clock());
      // biome-ignore lint/suspicious/noExplicitAny: Date's overloads
      else super(...(args as [any]));
    }
    static override now() {
      return opts.epochMs + clock();
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
    let counted = true;
    const done = () => {
      if (counted) loading--;
      counted = false;
    };
    // added first: a synchronous request ends inside send
    this.addEventListener("loadend", done, { once: true });
    try {
      // biome-ignore lint/suspicious/noExplicitAny: send's one optional body
      return realSend.apply(this, a as any);
    } catch (e) {
      this.removeEventListener("loadend", done);
      done();
      throw e;
    }
  };
  // a body read as a stream counts while each read waits
  // biome-ignore lint/suspicious/noExplicitAny: the stream readers, by name
  const streams: any[] = [
    w.ReadableStreamDefaultReader?.prototype,
    w.ReadableStreamBYOBReader?.prototype,
  ];
  for (const proto of streams) {
    const real = proto?.read;
    if (typeof real === "function")
      proto.read = function (this: unknown, ...a: unknown[]) {
        return track(real.apply(this, a));
      };
  }
  const stream = ReadableStream.prototype;
  const realPipe = stream.pipeTo;
  stream.pipeTo = function (this: ReadableStream, ...a: Parameters<typeof realPipe>) {
    return track(realPipe.apply(this, a));
  };
  for (const k of ["values", Symbol.asyncIterator]) {
    // biome-ignore lint/suspicious/noExplicitAny: the stream's iterator, by name
    const proto = stream as any;
    const real = proto[k];
    if (typeof real !== "function") continue;
    proto[k] = function (this: ReadableStream, ...a: unknown[]) {
      const it = real.apply(this, a);
      const next = it.next.bind(it);
      it.next = () => track(next());
      return it;
    };
  }
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
        if (clock() !== syncedAt) syncAnimations();
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

  /** the page's animation frame: its callbacks, then the ones it asked the
   *  frames inside it for (see asked) */
  async function runFrames(only?: (fn: unknown) => boolean, at = clock()): Promise<void> {
    let batch = frames;
    if (only) {
      batch = new Map([...frames].filter(([, fn]) => only(fn)));
      for (const id of batch.keys()) frames.delete(id);
    } else frames = new Map();
    for (const fn of batch.values()) {
      try {
        fn(at);
      } catch (e) {
        report(e);
      }
      await after();
    }
    await eachFrame(async (f) => clockOf(f)?.runAsked(at));
    // what those put on this page shows before the clock moves on, too
    await showFrames();
  }
  // A frame runs its own animation frames only where it was put on the page,
  // but a page may ask one for its next animation frame — to wait until it
  // has drawn, say. Such a callback belongs to the page (it comes from the
  // page's own script, not the frame's) and runs on the page's animation
  // frames, at the page's time.
  const asked = (fn: unknown) => !(fn instanceof w.Function);
  const askedHere = (): boolean =>
    [...frames.values()].some(asked) ||
    Array.from(document.querySelectorAll("iframe")).some((f) => clockOf(f)?.asked());
  /** an animation frame is waited for: the page's own, or one it asked a frame for */
  const framesDue = () => frames.size > 0 || askedHere();

  // --- animations: every one paused and set from film time -------------------
  const born = new WeakMap<Animation, number>();
  let syncedAt = Number.NaN;
  function syncAnimations(): void {
    const t = clock();
    syncedAt = t;
    // a page that draws any moment on request jumps around in time: its
    // animations (and its frames') all run from film time 0. In one that
    // animates on its own an animation runs from the callback that started
    // it, or from where it was first seen; one that started before the film
    // did starts with it
    const fromZero = drawn();
    for (const a of document.getAnimations()) {
      let b = base;
      if (!fromZero) {
        if (!born.has(a)) born.set(a, t);
        b = Math.max(base, born.get(a)!);
      }
      if (a.playState !== "paused") a.pause();
      a.currentTime = Math.max(0, (t - b) * (a.playbackRate || 1));
    }
    for (const svg of Array.from(document.querySelectorAll("svg"))) {
      if (svg.ownerSVGElement) continue;
      if (!svg.querySelector("animate,animateTransform,animateMotion,set")) continue;
      svg.pauseAnimations();
      svg.setCurrentTime((t - base) / 1000);
    }
    // a page that reads a frame's animation reads it at its time too
    for (const f of Array.from(document.querySelectorAll("iframe"))) clockOf(f)?.sync();
  }

  // --- media: a video plays on film time, seeked frame by frame ---------------
  // A video the page plays — or that plays by itself (autoplay), from where it
  // was put on the page — plays on film time: where it is follows from when
  // it started. One the page pauses stays where it was; one the page sets to
  // a time goes there. That place is what the page reads of the video, at
  // once; the element is sought there before a frame is taken (see syncMedia).
  type Media = {
    /** taken over: muted, its own playback stopped (see syncMedia) */
    seen: boolean;
    /** the page has played, paused or set it */
    touched: boolean;
    playing: boolean;
    /** playing: the time it was at 0 */
    born: number;
    /** paused: where it stays */
    at: number;
  };
  const media = new WeakMap<HTMLMediaElement, Media>();
  const mediaOf = (el: HTMLMediaElement): Media => {
    let m = media.get(el);
    if (!m) {
      m = { seen: false, touched: false, playing: false, born: 0, at: Number.NaN };
      media.set(el, m);
    }
    return m;
  };
  // what plays by itself: its autoplay is switched off when it is taken over
  const autoplay = new WeakSet<HTMLMediaElement>();
  /** a video that will play by itself, untouched by the page */
  const autoplays = (el: HTMLMediaElement, m: Media) =>
    !m.seen && !m.touched && (el.autoplay || autoplay.has(el));
  /** how many times a video was loaded: what was asked of it before it was
   *  loaded again (a seek, a frame to show) is not done to what it loads */
  const loads = new WeakMap<HTMLMediaElement, number>();
  /** a video loaded again (load(), a new source) starts over where it is
   *  loaded: at 0, playing by itself from there if it does. One that had
   *  nothing to play keeps playing if the page had played it, as the element
   *  does; one that had something stops. The frame it showed goes with what
   *  it had: it shows what it loads */
  function startOver(el: HTMLMediaElement, hadNothing: boolean): void {
    const playing = hadNothing && !!media.get(el)?.playing;
    media.delete(el);
    loads.set(el, (loads.get(el) ?? 0) + 1);
    seeks.delete(el);
    unframe(el);
    inserted.set(el, clock());
    // from where it got it — in a film that draws itself, from film time 0,
    // as what plays by itself does there
    if (playing)
      Object.assign(mediaOf(el), { touched: true, playing: true, born: drawn() ? base : clock() });
  }
  const realLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function (this: HTMLMediaElement) {
    startOver(this, this.networkState === HTMLMediaElement.NETWORK_EMPTY);
    return realLoad.call(this);
  };
  // a new source loads it again too — at once, so what the page sets on the
  // video right after applies to the new one; one the element refuses
  // changes nothing (the element's own checks come first)
  const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    ...source,
    set(this: HTMLMediaElement, v: string) {
      const hadNothing = this.networkState === HTMLMediaElement.NETWORK_EMPTY;
      source.set!.call(this, v);
      startOver(this, hadNothing);
    },
  });
  const realSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    const n = `${name}`; // as the element converts it: once, and an error as its own
    const isSource = this instanceof HTMLMediaElement && n.toLowerCase() === "src";
    const hadNothing =
      isSource && (this as HTMLMediaElement).networkState === HTMLMediaElement.NETWORK_EMPTY;
    realSetAttribute.call(this, n, value);
    if (isSource) startOver(this as HTMLMediaElement, hadNothing);
  };
  const realRemoveAttribute = Element.prototype.removeAttribute;
  Element.prototype.removeAttribute = function (this: Element, name: string) {
    const n = `${name}`;
    const isSource =
      this instanceof HTMLMediaElement && n.toLowerCase() === "src" && this.hasAttribute("src");
    const hadNothing =
      isSource && (this as HTMLMediaElement).networkState === HTMLMediaElement.NETWORK_EMPTY;
    realRemoveAttribute.call(this, n);
    if (isSource) startOver(this as HTMLMediaElement, hadNothing);
  };
  /** when a video that plays by itself started: where it was put on the page */
  const autoBorn = (el: HTMLMediaElement) =>
    drawn() ? base : Math.max(base, inserted.get(el) ?? clock());
  /** where a video is on film time; null for one the page has left to itself */
  function position(el: HTMLMediaElement): number | null {
    const m = mediaOf(el);
    const d = el.duration;
    const known = Number.isFinite(d) && d > 0;
    if (!m.playing && !autoplays(el, m)) {
      if (!m.touched || !Number.isFinite(m.at)) return null;
      return Math.max(0, known ? Math.min(m.at, d) : m.at);
    }
    let at = (clock() - (m.playing ? m.born : autoBorn(el))) / 1000;
    if (known) at = el.loop ? at % d : Math.min(at, d - 0.001);
    return Math.max(0, at);
  }
  // a video sought to its frame (below) reads as seeking until that frame is
  // there, as one sought itself does until it has decoded it: how many such
  // seeks each video has under way
  const seeks = new WeakMap<HTMLMediaElement, number>();
  const realSeeking = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "seeking")!;
  Object.defineProperty(HTMLMediaElement.prototype, "seeking", {
    ...realSeeking,
    get(this: HTMLMediaElement) {
      return seeks.has(this) || realSeeking.get!.call(this);
    },
  });
  const seekTo = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    ...seekTo,
    get(this: HTMLMediaElement) {
      return position(this) ?? seekTo.get!.call(this);
    },
    set(this: HTMLMediaElement, v: number) {
      // a video shown as its frames is not sought: its frame at the new time
      // is shown, and the page told, as a real seek would (see showFrame)
      const virtual =
        this instanceof HTMLVideoElement &&
        asFrame.has(this) &&
        !readers.has(this) &&
        Number.isFinite(Number(v));
      // the element's own checks first: a time it refuses changes nothing
      if (!virtual) seekTo.set!.call(this, v);
      let n = Number(v);
      if (!Number.isFinite(n)) return;
      // as the element does: a time before 0 is 0, one past its end its end
      n = Math.max(0, n);
      if (Number.isFinite(this.duration) && this.duration > 0) n = Math.min(n, this.duration);
      const m = mediaOf(this);
      // a playing video (or one about to play by itself) plays on from there
      if (m.playing || autoplays(this, m)) {
        m.born = clock() - n * 1000;
        m.playing = true;
      } else m.at = n;
      m.touched = true;
      if (virtual) {
        // as a real seek does: seeking at once, then seeked once the frame is
        // there — the events in a later task, so a listener added right after
        // the set still hears them. One loaded again in the meantime is not
        // sought: loading ends a seek
        const el = this as HTMLVideoElement;
        const load = loads.get(el);
        seeks.set(el, (seeks.get(el) ?? 0) + 1);
        realSetTimeout(() => {
          if (loads.get(el) !== load) return;
          el.dispatchEvent(new Event("seeking"));
          void showFrame(el, position(el) ?? n).then((shown) => {
            if (loads.get(el) !== load) return;
            const left = (seeks.get(el) ?? 1) - 1;
            if (left > 0) seeks.set(el, left);
            else seeks.delete(el);
            // read in the meantime: a real seek, which tells the page itself
            if (!shown) return void seekTo.set!.call(el, n);
            el.dispatchEvent(new Event("timeupdate"));
            el.dispatchEvent(new Event("seeked"));
          });
        }, 0);
      }
    },
  });
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    const m = mediaOf(this);
    if (!m.playing) {
      m.born = clock() - (position(this) ?? seekTo.get!.call(this)) * 1000;
      m.playing = true;
    }
    m.touched = true;
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    const m = mediaOf(this);
    const at = position(this);
    if (at !== null) m.at = at;
    m.playing = false;
    m.touched = true;
    return realPause.call(this);
  };
  // --- a video shown as its frames --------------------------------------------
  // A film-timed <video> is shown as its decoded frame at the film's time —
  // the frame's image as the element's CSS `content`, so the page's own size,
  // fit, corners and transforms all hold — and is not sought: a video element
  // composited under a slow push shimmers, and seeking it for every frame and
  // every motion probe is most of a recorded film's render. The frames come
  // from the renderer (the __otFrames binding, answered by framesReady); a
  // canvas, WebGL or a VideoFrame the page makes of the video gets the frame
  // too. With no renderer to ask (a layout reading), for a source it does not
  // decode (or not in time), or for a video the page reads frame by frame
  // itself (a frame callback, a stream), the element is sought as before.
  type Frames = { base: string; times: number[]; ext: string; bright?: boolean } | null;
  const framesFor = new Map<string, Promise<Frames>>();
  const framesWaiting = new Map<string, (f: Frames) => void>();
  const readers = new WeakSet<HTMLMediaElement>();
  const asFrame = new WeakMap<HTMLMediaElement, string>();
  /** What a video shown as its frames shows: the frame's image, when that
   *  frame starts, and whether the image is brighter than the video decodes
   *  (frames.ts). Kept on the element under a key every page and frame
   *  shares, so the page around a frame reads the frame's videos too. */
  type Shown = { im: HTMLImageElement; at: number; bright: boolean; plain?: HTMLCanvasElement };
  const SHOWN = Symbol.for("open-take frame shown");
  const shownOf = (x: unknown): Shown | null =>
    x !== null && typeof x === "object"
      ? ((x as Record<symbol, Shown | undefined>)[SHOWN] ?? null)
      : null;
  /** show the video itself again */
  function unframe(v: HTMLMediaElement): void {
    if (asFrame.has(v)) {
      v.style.removeProperty("content");
      asFrame.delete(v);
    }
    delete (v as unknown as Record<symbol, unknown>)[SHOWN];
  }
  /** the page reads this video's pixels: it is sought from now on */
  const reads = (v: unknown) => {
    if (!(v instanceof HTMLMediaElement) || readers.has(v)) return;
    readers.add(v);
    unframe(v);
  };
  // Chrome on macOS shows video through Apple's gamma, but hands a canvas
  // the pixels as they decode: a frame written as shown (frames.ts) goes to
  // a canvas with that undone
  let undo: Uint8Array | null = null;
  function pixelsOf(f: Shown): HTMLImageElement | HTMLCanvasElement {
    if (!f.bright || !f.im.naturalWidth) return f.im;
    if (f.plain) return f.plain;
    if (!undo) {
      undo = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        const c = v / 255;
        const light = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        undo[v] = Math.round(255 * light ** (1 / 1.961));
      }
    }
    const c = document.createElement("canvas");
    c.width = f.im.naturalWidth;
    c.height = f.im.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(f.im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      p[i] = undo[p[i]!]!;
      p[i + 1] = undo[p[i + 1]!]!;
      p[i + 2] = undo[p[i + 2]!]!;
    }
    g.putImageData(d, 0, 0);
    f.plain = c;
    return c;
  }
  // where the page reads a video's pixels: a video shown as its frames — here
  // or in a frame inside the page — is handed over as its frame (the same
  // pixels, the same size); one not shown so yet is read as it is, sought as
  // before
  const passFrames = (owner: Record<string, unknown> | undefined, name: string) => {
    const real = owner?.[name];
    if (!owner || typeof real !== "function") return;
    owner[name] = function (this: unknown, ...a: unknown[]) {
      for (let i = 0; i < a.length; i++) {
        const f = shownOf(a[i]);
        if (f) a[i] = pixelsOf(f);
      }
      return (real as (...a: unknown[]) => unknown).apply(this, a);
    };
  };
  // what needs the element's own decoding: a frame callback, a stream
  const needsDecoding = (owner: Record<string, unknown> | undefined, name: string) => {
    const real = owner?.[name];
    if (!owner || typeof real !== "function") return;
    owner[name] = function (this: unknown, ...a: unknown[]) {
      reads(this);
      return (real as (...a: unknown[]) => unknown).apply(this, a);
    };
  };
  for (const ctx of [w.CanvasRenderingContext2D, w.OffscreenCanvasRenderingContext2D])
    passFrames(ctx?.prototype, "drawImage");
  for (const gl of [w.WebGLRenderingContext, w.WebGL2RenderingContext])
    for (const f of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D"])
      passFrames(gl?.prototype, f);
  passFrames(w, "createImageBitmap");
  needsDecoding(w.HTMLVideoElement?.prototype, "requestVideoFrameCallback");
  needsDecoding(w.HTMLMediaElement?.prototype, "captureStream");
  // a VideoFrame of a video shown as its frames holds the frame it shows, at
  // that frame's time unless the page gives one
  if (typeof w.VideoFrame === "function")
    w.VideoFrame = new Proxy(w.VideoFrame, {
      construct(target, args, nt) {
        const f = shownOf(args[0]);
        if (f) {
          const init = (args[1] ?? {}) as { timestamp?: number };
          args = [pixelsOf(f), { ...init, timestamp: init.timestamp ?? Math.round(f.at * 1e6) }];
        }
        return Reflect.construct(target, args, nt);
      },
    });
  // A call from the renderer gives up at 120 s, and a page waits for frames
  // inside one: in all, one call waits for frames at most FRAMES_WAIT_MS (a
  // frame inside the page counts with the page), and a video whose frames
  // have not come by then is sought, that once. One whose answer never comes
  // is sought from then on.
  const FRAMES_WAIT_MS = 75_000;
  let framesUntil = 0;
  /** the real time by which the frames of this call must be there */
  const framesBy = (): number =>
    holder?.framesBy?.() ?? (framesUntil || RealDate.now() + FRAMES_WAIT_MS);
  /** the renderer's answers that have come */
  const answered = new Map<string, Frames>();
  /** the frames of the video at `src`, asked of the renderer once */
  const framesOf = (src: string): Promise<Frames> => {
    let p = framesFor.get(src);
    if (!p) {
      p = new Promise<Frames>((ok) => {
        framesWaiting.set(src, ok);
        realSetTimeout(() => framesReady(src, null), FRAMES_WAIT_MS);
      });
      void p.then((f) => answered.set(src, f));
      framesFor.set(src, p);
      try {
        w.__otFrames(JSON.stringify({ src }));
      } catch {
        framesReady(src, null);
      }
    }
    return p;
  };
  /** the frames of the video at `src`; null when they do not come in time */
  const framesNow = (src: string): Frames | Promise<Frames> =>
    answered.has(src)
      ? (answered.get(src) ?? null)
      : Promise.race([
          framesOf(src),
          new Promise<Frames>((ok) => realSetTimeout(() => ok(null), framesBy() - RealDate.now())),
        ]);
  /** the renderer's answer, passed on to the frames inside the film */
  function framesReady(src: string, f: Frames): void {
    const ok = framesWaiting.get(src);
    framesWaiting.delete(src);
    ok?.(f);
    for (const el of Array.from(document.querySelectorAll("iframe"))) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: another document's globals
        (el.contentWindow as any)?.__ot?.framesReady?.(src, f);
      } catch {
        // another origin: it has no frames of ours to wait for
      }
    }
  }
  /** the frame showing at `t` seconds: the last that starts by then — give
   *  or take the film's own rounding, and no more: a 29.97 fps video's second
   *  frame starts 33 µs after a 30 fps film's */
  const frameAt = (times: number[], t: number): number => {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid]! <= t + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // decoded frames, a few held: the ones shown and the next ones fetched ahead
  const decoded = new Map<string, Promise<HTMLImageElement>>();
  const decodeFrame = (url: string): Promise<HTMLImageElement> => {
    let p = decoded.get(url);
    if (p) decoded.delete(url);
    else {
      const im = new Image();
      im.src = url;
      p = im.decode().then(
        () => im,
        () => im,
      );
    }
    decoded.set(url, p);
    while (decoded.size > 8) decoded.delete(decoded.keys().next().value!);
    return p;
  };
  const frameUrl = (f: NonNullable<Frames>, i: number) =>
    `${f.base}${String(i).padStart(6, "0")}.${f.ext}`;
  /** show the video at `at` seconds as its frame; false when it cannot be,
   *  or when it is read or loaded again while its frame comes */
  async function showFrame(el: HTMLVideoElement, at: number): Promise<boolean> {
    if (typeof w.__otFrames !== "function" || readers.has(el)) return false;
    const src = el.currentSrc || el.src;
    if (!src?.startsWith(`${location.origin}/`)) return false;
    const load = loads.get(el);
    const gone = () => readers.has(el) || loads.get(el) !== load;
    const f = await framesNow(src);
    if (!f?.times.length || gone()) return false;
    const i = frameAt(f.times, at);
    const url = frameUrl(f, i);
    const im = await decodeFrame(url);
    for (let k = 1; k <= 2 && i + k < f.times.length; k++) void decodeFrame(frameUrl(f, i + k));
    if (gone()) return false;
    if (asFrame.get(el) !== url) {
      el.style.setProperty("content", `url("${url}")`, "important");
      asFrame.set(el, url);
    }
    if (shownOf(el)?.im !== im) {
      const shown: Shown = { im, at: f.times[i]!, bright: !!f.bright };
      Object.defineProperty(el, SHOWN, { value: shown, configurable: true, writable: true });
    }
    return true;
  }
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
        seekTo.set!.call(el, at);
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
        if (autoplays(el, m)) {
          m.born = autoBorn(el);
          m.playing = true;
          autoplay.add(el);
        }
        m.seen = true;
        el.muted = true;
        el.autoplay = false;
        realPause.call(el);
      }
      const at = position(el);
      if (at === null) continue;
      const load = loads.get(el);
      waits.push(
        showFrame(el, at).then((shown) => {
          // loaded again meanwhile: `at` was where the old one was
          if (shown || loads.get(el) !== load) return;
          unframe(el);
          if (Math.abs(seekTo.get!.call(el) - at) > 0.0005 || el.readyState < 2)
            return seekVideo(el, at);
        }),
      );
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
    if (document.fonts.status !== "loaded")
      await Promise.race([document.fonts.ready, new Promise((ok) => realSetTimeout(ok, 15_000))]);
    await followFrames();
  }

  // same-origin frames on the page: loaded before the frame is taken, and
  // their animations and videos at the film's time
  async function followFrames(): Promise<void> {
    unshown.clear();
    await eachFrame(async (f) => {
      if (await loaded(f)) await clockOf(f)?.follow(base);
    });
  }

  /** frames the page put on it since the last look load and show — their
   *  first frame — before its clock moves on: however the film is sought, a
   *  frame starts at the same moment of the film */
  async function showFrames(): Promise<void> {
    drain(); // what was put here since this page last looked
    while (unshown.size) {
      const fresh = [...unshown];
      unshown.clear();
      await Promise.all(
        fresh.map(async (f) => {
          if (!f.isConnected || !(await loaded(f))) return;
          await clockOf(f)?.follow(base);
          shown++;
        }),
      );
    }
    // one the page put into a frame of its own shows too
    await eachFrame(async (f) => clockOf(f)?.showFrames());
  }
  /** how many frames have shown, here and inside the frames */
  const shownHere = (): number =>
    Array.from(document.querySelectorAll("iframe")).reduce(
      (n, f) => n + (clockOf(f)?.shown() ?? 0),
      shown,
    );

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

  /** a frame inside the film, as the page that holds it moves (`origin` is
   *  where film time 0 is): its first frame where it was put on the page,
   *  then its animations and videos at the film's time */
  async function follow(origin: number): Promise<void> {
    base = origin;
    if (!started) await firstFrame();
    syncAnimations();
    await settle();
  }

  /** the page's first animation frame, which a browser runs before it first
   *  paints: where the page becomes ready, or where a frame inside it starts */
  async function firstFrame(): Promise<void> {
    await runTimers(now);
    syncAnimations();
    await runFrames();
    syncAnimations();
    started = true;
  }

  /** when the page's clock has something to run next: a timer, or an
   *  animation frame someone asked for */
  function nextEvent(): number {
    let t = Number.POSITIVE_INFINITY;
    for (const x of timers.values()) t = Math.min(t, x.due);
    if (framesDue()) t = Math.min(t, gridTime(grid));
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
      if (framesDue()) {
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
   *  clock stays at the instant being drawn; timers run in due order on their
   *  own clock. */
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
    let impatient = false;
    if (hold) {
      holding = true;
      timerNow = now;
    }
    try {
      for (let i = 0, stepped = false; !settled; i++) {
        if (RealDate.now() - began > 45_000)
          throw new Error(
            "film clock: the page's promise did not settle within 45 s" +
              (document.querySelector("iframe")
                ? " (a frame inside the film runs its own timers and animation frames only where it was put on the page)"
                : ""),
          );
        if (hold) {
          await runTimers(now, true);
          await runFrames();
        } else await advance(now);
        if (settled) break;
        await new Promise((ok) => realSetTimeout(ok, stepped || i < 20 ? 0 : 15));
        stepped = false;
        if (settled || i < 3) continue;
        if (hold) {
          let due = Number.POSITIVE_INFINITY;
          for (const t of timers.values()) due = Math.min(due, t.due);
          if (due - start <= MAX_JUMP_MS) await runTimers(due, true);
        } else {
          const stillLoading = busy();
          if (stillLoading && RealDate.now() - began < LOADING_PATIENCE_MS) continue;
          const next = nextEvent();
          if (next - start <= MAX_JUMP_MS) {
            if (stillLoading && !impatient)
              warn(
                `film clock: the page was still loading after ${LOADING_PATIENCE_MS / 1000} s while it waited on its own clock; its clock went on, so renders of it may start differently`,
              );
            impatient ||= stillLoading;
            await advance(Math.max(now, next));
            await followFrames();
            stepped = true;
          }
        }
      }
    } finally {
      holding = false;
    }
    if (failed) throw error;
    return value as T;
  }

  async function seek(tSec: number): Promise<void> {
    const t = base + tSec * 1000;
    if (mode === "render") {
      now = t;
      // the frames the page draws into have shown before it does (their first
      // frame would otherwise come after what it writes), and are at t — the
      // videos in them too, for a page that draws one; a frame it puts on the
      // page while drawing loads, and the instant is drawn again — into that
      // one too — until no new one shows up
      await showFrames();
      await followFrames();
      syncAnimations();
      for (let pass = 0; ; pass++) {
        if (pass === MAX_DRAWS)
          throw new Error(
            `film clock: drawing ${tSec}s put a new frame on the page ${MAX_DRAWS} times over — draw the same frames for the same t`,
          );
        const before = shownHere();
        reseed(tSec);
        const r = w.__render(tSec);
        if (r && typeof r.then === "function") await pump(r, true);
        drain();
        await showFrames();
        if (shownHere() === before) break;
        syncAnimations();
      }
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
    /** what a still element shows — an image's source, a leaf's text: when it
     *  changes, the picture cut there, however small the element */
    shows: Map<Element, string>;
    thumbs: Map<HTMLCanvasElement, Uint8ClampedArray | null>;
    video: boolean;
  };
  function showing(el: Element): string | null {
    // by tag, not instanceof: a saved screen's elements belong to its frame's realm
    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      return img.currentSrc || img.src;
    }
    return el.childElementCount === 0 ? (el.textContent ?? "") : null;
  }
  function snapshot(): Snapshot {
    const vw = innerWidth;
    const vh = innerHeight;
    const rects = new Map<Element, DOMRect>();
    const shows = new Map<Element, string>();
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
      const s = showing(el);
      if (s !== null) shows.set(el, s);
      if (el instanceof HTMLCanvasElement) thumbs.set(el, thumb(el));
      else if (el instanceof HTMLVideoElement && media.get(el)?.playing) video = true;
      else if (el instanceof HTMLIFrameElement) framed(el, r, rects, shows, vw, vh);
    }
    return { rects, shows, thumbs, video };
  }

  /** the elements inside a same-origin frame (a saved screen lifted into the
   *  film), in the film's coordinates — what moves inside it moves on screen */
  function framed(
    f: HTMLIFrameElement,
    box: DOMRect,
    rects: Map<Element, DOMRect>,
    shows: Map<Element, string>,
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
      const s = showing(el);
      if (s !== null) shows.set(el, s);
    }
  }
  type Change = {
    /** the farthest any element that is in both snapshots travelled */
    px: number;
    /** visible area (px²) of elements that are in only one of them */
    churn: number;
    /** elements inside the picture that appeared, vanished or changed what
     *  they show: cuts, however small (one sliding in from an edge is motion) */
    cuts: number;
  };
  function moved(a: Snapshot, b: Snapshot): Change {
    let px = 0;
    let churn = 0;
    let cuts = 0;
    const vw = innerWidth;
    const vh = innerHeight;
    const area = (r: DOMRect) =>
      Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left)) *
      Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    const inside = (r: DOMRect) => r.left > 0 && r.top > 0 && r.right < vw && r.bottom < vh;
    for (const [el, ra] of a.rects) {
      const rb = b.rects.get(el);
      if (!rb) {
        churn += area(ra); // vanished: a cut or a fade, not motion
        if (inside(ra)) cuts++;
        continue;
      }
      if (a.shows.get(el) !== b.shows.get(el)) cuts++;
      const d = Math.max(
        Math.abs(ra.left - rb.left),
        Math.abs(ra.top - rb.top),
        Math.abs(ra.right - rb.right),
        Math.abs(ra.bottom - rb.bottom),
      );
      if (d > px) px = d;
    }
    for (const [el, rb] of b.rects)
      if (!a.rects.has(el)) {
        churn += area(rb);
        if (inside(rb)) cuts++;
      }
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
    return { px, churn, cuts };
  }
  /** how far anything moves while the shutter is open, and which part of the
   *  shutter to expose: side 0 all of it, -1 its first half, 1 its second */
  async function motion(tSec: number, halfSec: number): Promise<{ px: number; side: number }> {
    const hook = w.__film?.motion;
    if (typeof hook === "function") {
      const px = Number(await hook(tSec, halfSec));
      return { px: Number.isFinite(px) && px > 0 ? px : 0, side: 0 };
    }
    await seek(Math.max(0, tSec - halfSec));
    const a = snapshot();
    await seek(tSec);
    const mid = snapshot();
    await seek(tSec + halfSec);
    const b = snapshot();
    // A shutter never straddles a cut: when something changes in one half of
    // the shutter only — it jumps, a large part of the picture appears or
    // vanishes at once, or anything inside the picture appears, vanishes or
    // shows something else — the frame is exposed over the other half alone:
    // no double exposure, and what moves through that half keeps its blur.
    // Motion spreads over both halves.
    const first = moved(a, mid);
    const second = moved(mid, b);
    const screen = innerWidth * innerHeight;
    const onlyIn = (x: Change, y: Change) =>
      (x.px > 1 && y.px < 0.1 * x.px) ||
      (x.churn > 0.25 * screen && y.churn < 0.05 * screen) ||
      (x.cuts > 0 && y.cuts === 0);
    if (onlyIn(first, second)) return { px: second.px, side: 1 };
    if (onlyIn(second, first)) return { px: first.px, side: -1 };
    return { px: moved(a, b).px, side: 0 };
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
      // plain values only, to cross into the renderer; checked there (filmMarks)
      marks: Array.isArray(film.marks)
        ? // biome-ignore lint/suspicious/noExplicitAny: the page's own marks, untyped
          film.marks.map((m: any) => ({ at: m?.at, until: m?.until, what: m?.what }))
        : film.marks == null
          ? null
          : String(film.marks),
    };
  }

  /** a call from the renderer: the frames it waits for count from now */
  const called =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      framesUntil = RealDate.now() + FRAMES_WAIT_MS;
      return fn(...a);
    };
  w.__ot = {
    prepare: called(prepare),
    seek: called(seek),
    motion: called(motion),
    framesReady,
    // --- for the frames inside the film (times in ms on the top page's clock) ---
    framesBy,
    follow,
    stamp,
    showFrames,
    shown: shownHere,
    sync: syncAnimations,
    busy,
    asked: askedHere,
    runAsked: (at: number) => runFrames(asked, at),
    drawn,
    clock,
    origin: () => base,
    // in a page that draws any moment on request, which moment put a frame on
    // the page first depends on the order they were drawn in: its frames
    // start at film time 0
    bornOf: (el: Element | null) => {
      if (drawn()) return base;
      drain();
      return (el && inserted.get(el)) ?? clock();
    },
  };
}
