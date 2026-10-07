// Product audio — the sounds the app itself makes while a take is recorded.
//
// The CDP screencast carries pictures only, so a film that wants the
// product's REAL clicks, chimes and notes had nothing to work with. This
// module records them in-page and hands them to the runtime:
//
//   1. An init script (runs before the page's own scripts, in every document
//      a take visits) wraps AudioNode.prototype.connect/disconnect. Whenever
//      a node is connected to an AudioContext's destination, it is ALSO
//      connected to a private tap in that context; the destination itself is
//      never replaced, so library code that inspects it sees the real node.
//      HTMLMediaElement.play is wrapped the same way: a playing <audio>/<video>
//      is tapped through captureStream(), which does not change its output.
//   2. Each tap is a ScriptProcessor that forwards only NON-SILENT blocks,
//      stamped with the wall-clock time the page produced them (the browser's
//      AudioContext.getOutputTimestamp, less the capturing device's own output
//      latency) and with their frame on the context's own sample clock,
//      through a CDP binding. Buffers it never got (a busy main thread) are
//      reported as a gap, not hidden.
//   3. At the end of the take the runtime mixes every block onto the capture
//      timeline — sample 0 is the take's t0, the same zero every event tMs
//      and the capture video use — and writes product-audio.wav (32-bit float,
//      unclipped) plus product-sound.json describing how it was placed.
//
// Cost on a silent page: one prototype patch and a CDP binding — no node is
// created until the page connects something to its speakers, and silent
// blocks never cross the wire. Every part is guarded: a failure anywhere is a
// warning and no file, never a failed take.
//
// Alongside, the audio files the page FETCHED (audio/* responses, or a URL
// with an audio extension) are listed in product-sound.json, and small ones
// are saved to product-sounds/ so a film can load the product's own sound
// pack directly.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CDP } from "./cdp";

/** the CDP binding the page posts blocks through */
export const PRODUCT_AUDIO_BINDING = "__openTakeProductAudio";

/** Saved fetched sound files: per file and in total. Larger ones are only listed. */
const MAX_SAVED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SAVED_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_LISTED_FILES = 200;

const AUDIO_EXT = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|weba|caf|aif|aiff)(?:$|[?#])/i;

// The in-page half. Plain ES2017, no template literals inside (it is itself
// one). Never throws into the page: every wrapper calls the original FIRST and
// returns its result, and the tap work after it is try/caught.
export const PRODUCT_AUDIO_INIT_JS = `(() => {
  if (window.__openTakeAudioTap || typeof AudioNode === "undefined") return;
  window.__openTakeAudioTap = true;
  var NAME = ${JSON.stringify(PRODUCT_AUDIO_BINDING)};
  var post = function (s) { try { var f = window[NAME]; if (typeof f === "function") f(s); } catch (e) {} };
  var connect = AudioNode.prototype.connect;
  var disconnect = AudioNode.prototype.disconnect;
  var taps = new WeakMap();
  var nextId = 0;
  var DOC = Math.random().toString(36).slice(2, 10);
  var toB64 = function (f32) {
    var u8 = new Uint8Array(f32.buffer), s = "";
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  // Wall-clock ms at which the page's audio graph PRODUCED context time t:
  // the output timestamp pairs a context time with the moment it leaves the
  // speakers, and the output device's own latency (outputLatency) is taken
  // back off — that delay belongs to the capturing browser (its fake output,
  // see launchBrowser, reports ~16 ms), not to the product, and a film's own
  // playback adds its own. Right after a context starts it reports
  // contextTime 0 (not yet paired): then "now" plus the base latency.
  var producedAt = function (ctx, t) {
    var o = null;
    try { o = ctx.getOutputTimestamp(); } catch (e) {}
    if (o && o.contextTime > 0 && o.performanceTime > 0)
      return performance.timeOrigin + o.performanceTime + (t - o.contextTime - (ctx.outputLatency || 0)) * 1000;
    return performance.timeOrigin + performance.now() + (t - ctx.currentTime + (ctx.baseLatency || 0)) * 1000;
  };
  var tapFor = function (ctx, kind) {
    if (taps.has(ctx)) return taps.get(ctx);
    var t = null;
    try {
      if (typeof AudioContext !== "undefined" && ctx instanceof AudioContext) {
        var bus = ctx.createGain();
        var sp = ctx.createScriptProcessor(4096, 2, 2);
        connect.call(bus, sp);
        connect.call(sp, ctx.destination);
        var id = DOC + "." + ++nextId;
        post("S " + id + " " + ctx.sampleRate + " " + kind + " " + (ctx.baseLatency || 0));
        var next = -1;
        sp.onaudioprocess = function (e) {
          try {
            // a buffer the main thread was too busy to take is skipped, and
            // its sound is lost to the tap (the page itself still played it)
            var span = e.inputBuffer.length / ctx.sampleRate;
            if (next >= 0 && e.playbackTime - next > span / 2)
              post("G " + id + " " + producedAt(ctx, next - 2 * span).toFixed(3) + " " + ((e.playbackTime - next) * 1000).toFixed(0));
            next = e.playbackTime + span;
            var ob = e.outputBuffer;
            for (var c = 0; c < ob.numberOfChannels; c++) ob.getChannelData(c).fill(0);
            var ib = e.inputBuffer, n = ib.length;
            var L = ib.getChannelData(0), R = ib.numberOfChannels > 1 ? ib.getChannelData(1) : L;
            var peak = 0;
            for (var i = 0; i < n; i++) { var a = L[i] < 0 ? -L[i] : L[i], b = R[i] < 0 ? -R[i] : R[i]; if (a > peak) peak = a; if (b > peak) peak = b; }
            if (peak < 1e-5) return;
            var f = new Float32Array(n * 2);
            for (var j = 0; j < n; j++) { f[2 * j] = L[j]; f[2 * j + 1] = R[j]; }
            // a ScriptProcessor hands over its input two buffers before the
            // playbackTime it reports (Chrome double-buffers it): the block's
            // audio is the graph's output at playbackTime - 2 * n / rate. The
            // block's frame on the context's own sample clock goes along, so
            // the runtime can lay consecutive blocks sample-exactly end to end
            // (the wall-clock estimate jitters by a few samples per block).
            var at = e.playbackTime - (2 * n) / ctx.sampleRate;
            post("B " + id + " " + producedAt(ctx, at).toFixed(3) + " " + ((ctx.outputLatency || 0) * 1000).toFixed(1) + " " + Math.round(at * ctx.sampleRate) + " " + toB64(f));
          } catch (err) {}
        };
        t = { bus: bus, sp: sp };
      }
    } catch (e) { t = null; }
    taps.set(ctx, t);
    return t;
  };
  AudioNode.prototype.connect = function (dest) {
    var r = connect.apply(this, arguments);
    try {
      if (dest instanceof AudioDestinationNode) {
        var t = tapFor(this.context, "webaudio");
        if (t && t.bus !== this) connect.call(this, t.bus, arguments.length > 1 ? arguments[1] : 0);
      }
    } catch (e) {}
    return r;
  };
  AudioNode.prototype.disconnect = function (dest) {
    var r = disconnect.apply(this, arguments);
    try {
      if (dest instanceof AudioDestinationNode) {
        var t = taps.get(this.context);
        if (t) { try { arguments.length > 1 ? disconnect.call(this, t.bus, arguments[1]) : disconnect.call(this, t.bus); } catch (e) {} }
      }
    } catch (e) {}
    return r;
  };
  // <audio>/<video>: captureStream() leaves the element's own output alone —
  // but it also ignores the element's muted/volume, so each element's tap goes
  // through a gain that follows them (a muted hero video stays unheard). An
  // element the page routes into its own graph (createMediaElementSource) is
  // already heard at that graph's speakers, so its stream tap is silenced.
  var mediaCtx = null;
  var tappedMedia = new WeakSet();
  var routed = new WeakSet();
  var mediaGains = new WeakMap();
  var follow = function (el) {
    var g = mediaGains.get(el);
    if (g) { try { g.gain.value = routed.has(el) || el.muted ? 0 : el.volume; } catch (e) {} }
  };
  if (typeof AudioContext !== "undefined" && AudioContext.prototype.createMediaElementSource) {
    var cmes = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (el) {
      var r = cmes.apply(this, arguments);
      try { routed.add(el); follow(el); } catch (e) {}
      return r;
    };
  }
  var tapMedia = function (el) {
    if (!el || tappedMedia.has(el) || routed.has(el) || typeof el.captureStream !== "function") return;
    tappedMedia.add(el);
    var stream;
    try { stream = el.captureStream(); } catch (e) { return; }
    var attached = false;
    var attach = function () {
      try {
        if (attached || !stream.getAudioTracks().length) return;
        attached = true;
        stream.getVideoTracks().forEach(function (v) { try { v.stop(); } catch (e) {} });
        if (!mediaCtx) mediaCtx = new AudioContext();
        if (mediaCtx.state === "suspended") mediaCtx.resume().catch(function () {});
        var t = tapFor(mediaCtx, "media");
        if (!t) return;
        var g = mediaCtx.createGain();
        mediaGains.set(el, g);
        follow(el);
        el.addEventListener("volumechange", function () { follow(el); });
        connect.call(mediaCtx.createMediaStreamSource(stream), g);
        connect.call(g, t.bus);
      } catch (e) {}
    };
    attach();
    try { stream.addEventListener("addtrack", attach); } catch (e) {}
  };
  var play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    var r = play.apply(this, arguments);
    try { tapMedia(this); } catch (e) {}
    return r;
  };
  // autoplay (and any play the wrapper above did not see) still fires "play"
  try { window.addEventListener("play", function (e) { try { if (e.target instanceof HTMLMediaElement) tapMedia(e.target); } catch (x) {} }, true); } catch (e) {}
})();`;

/** A source = one AudioContext in one document: "<document tag>.<n>", so
 *  contexts of a later page (after a navigation) or of an iframe never share
 *  a key — each has its own sample clock. */
type SourceKey = string | number;

/** One forwarded block: produced at `producedMs` (wall clock), interleaved
 *  stereo; `ctxFrame` = its first frame on its source's own sample clock. */
type Block = { src: SourceKey; producedMs: number; ctxFrame?: number; samples: Float32Array };
type Source = {
  id: SourceKey;
  sampleRate: number;
  kind: "webaudio" | "media";
  baseLatencyMs: number;
  outputLatencyMs: number;
};

export type FetchedSound = {
  url: string;
  mimeType: string;
  status: number;
  /** bytes on the wire, when the response finished loading */
  bytes?: number;
  /** take-relative path of the saved copy (`product-sounds/…`), when saved */
  saved?: string;
};

export type ProductSoundReport = {
  /** the mix of everything the page sent to its speakers, or null when the
   *  page made no sound the tap could hear */
  audio: null | {
    file: string;
    sampleRate: number;
    channels: 2;
    format: "float32";
    /** capture-timeline ms of the WAV's first sample (the take's t0) */
    startMs: number;
    durationMs: number;
    /** capture-timeline ms ranges where the product made sound (blocks of
     *  ~85 ms; adjacent blocks merged) */
    soundAt: Array<[number, number]>;
    peakDbfs: number;
    /** how the sound was put on the capture timeline */
    placement: string;
    sources: Array<Omit<Source, "id">>;
  };
  /** audio files the page fetched */
  files: FetchedSound[];
  /** what could not be done (the take itself is unaffected) */
  notes: string[];
};

export type ProductAudioRecorder = {
  /** stop listening and write what was heard; never throws */
  finish(opts: { t0: number; endMs: number; dir: string }): Promise<ProductSoundReport | null>;
};

/** Start listening on the capture page. Call BEFORE the first navigation so
 *  the init script runs ahead of the page's own scripts. Never throws: a
 *  failure to install returns a recorder that reports why. */
export async function startProductAudio(cdp: CDP): Promise<ProductAudioRecorder> {
  const notes: string[] = [];
  const sources = new Map<SourceKey, Source>();
  const blocks: Block[] = [];
  const lost: Array<{ producedMs: number; ms: number }> = [];
  let listening = true;
  let installed = false;
  try {
    await cdp.send("Runtime.addBinding", { name: PRODUCT_AUDIO_BINDING });
    cdp.on<{ name: string; payload: string }>("Runtime.bindingCalled", (p) => {
      if (!listening || p.name !== PRODUCT_AUDIO_BINDING) return;
      const s = p.payload;
      const parts = s.split(" ", 6);
      if (parts[0] === "S") {
        sources.set(parts[1]!, {
          id: parts[1]!,
          sampleRate: Number(parts[2]),
          kind: parts[3] === "media" ? "media" : "webaudio",
          baseLatencyMs: round1(Number(parts[4]) * 1000),
          outputLatencyMs: 0,
        });
      } else if (parts[0] === "G") {
        // "G <src> <producedMs> <lostMs>": buffers the tap never received
        lost.push({ producedMs: Number(parts[2]), ms: Number(parts[3]) });
      } else if (parts[0] === "B") {
        // "B <src> <producedMs> <outputLatencyMs> <ctxFrame> <base64>"
        const src = parts[1]!;
        const source = sources.get(src);
        if (source)
          source.outputLatencyMs = Math.max(source.outputLatencyMs, round1(Number(parts[3])));
        let at = 0;
        for (let k = 0; k < 5; k++) at = s.indexOf(" ", at) + 1;
        const buf = Buffer.from(s.slice(at), "base64");
        const samples = new Float32Array(Math.floor(buf.length / 8) * 2);
        for (let k = 0; k < samples.length; k++) samples[k] = buf.readFloatLE(k * 4);
        const ctxFrame = Number(parts[4]);
        blocks.push({
          src,
          producedMs: Number(parts[2]),
          ...(Number.isFinite(ctxFrame) ? { ctxFrame } : {}),
          samples,
        });
      }
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PRODUCT_AUDIO_INIT_JS });
    installed = true;
  } catch (e) {
    notes.push(`product audio tap not installed (${(e as Error).message})`);
  }

  // fetched sound files — listed as they arrive; their bodies are read only
  // at the end, so a page that preloads a whole sample library does not put
  // megabytes on the capture's CDP socket while frames are streaming
  const responses = new Map<string, FetchedSound>();
  const finished = new Set<string>();
  try {
    await cdp.send("Network.enable", {});
    cdp.on<{
      requestId: string;
      response: { url: string; mimeType?: string; status: number };
    }>("Network.responseReceived", (p) => {
      if (!listening || responses.size >= MAX_LISTED_FILES) return;
      const { url, mimeType = "", status } = p.response;
      if (!/^https?:|^file:/i.test(url)) return;
      if (!/^audio\//i.test(mimeType) && !AUDIO_EXT.test(url)) return;
      responses.set(p.requestId, { url, mimeType, status });
    });
    cdp.on<{ requestId: string; encodedDataLength?: number }>("Network.loadingFinished", (p) => {
      const r = responses.get(p.requestId);
      if (!r) return;
      if (p.encodedDataLength != null) r.bytes = Math.round(p.encodedDataLength);
      finished.add(p.requestId);
    });
  } catch (e) {
    notes.push(`fetched sound files not listed (${(e as Error).message})`);
  }

  return {
    async finish({ t0, endMs, dir }) {
      listening = false;
      try {
        const files = await saveFetched(cdp, responses, finished, dir, notes);
        let audio: ProductSoundReport["audio"] = null;
        const gaps = lost
          .map((g) => ({ at: Math.round(g.producedMs - t0), ms: g.ms }))
          .filter((g) => Number.isFinite(g.at) && g.at < endMs && g.at + g.ms > 0);
        if (blocks.length && gaps.length)
          notes.push(
            `the tap missed ${Math.round(gaps.reduce((a, g) => a + g.ms, 0))} ms of the page's audio while its main thread was busy (any sound there is missing from product-audio.wav; the page itself played it) — at ${gaps
              .slice(0, 8)
              .map((g) => `${g.at}+${g.ms} ms`)
              .join(", ")}${gaps.length > 8 ? ", …" : ""}`,
          );
        if (installed && blocks.length) {
          try {
            audio = writeMix(blocks, sources, t0, endMs, join(dir, "product-audio.wav"));
          } catch (e) {
            notes.push(`product audio not written (${(e as Error).message})`);
          }
        }
        if (!audio && !files.length && !notes.length) return null;
        const report: ProductSoundReport = { audio, files, notes };
        writeFileSync(join(dir, "product-sound.json"), `${JSON.stringify(report, null, 2)}\n`);
        return report;
      } catch (e) {
        console.error(`product audio: nothing written (${(e as Error).message})`);
        return null;
      }
    },
  };
}

const round1 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);

async function saveFetched(
  cdp: CDP,
  responses: Map<string, FetchedSound>,
  finished: Set<string>,
  dir: string,
  notes: string[],
): Promise<FetchedSound[]> {
  const out: FetchedSound[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  let total = 0;
  let timedOut = false;
  // reading bodies gets a few seconds, never the take's time
  const deadline = Date.now() + 5000;
  for (const [id, r] of responses) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    let body: Buffer | null = null;
    if (finished.has(id) && r.status === 200 && (r.bytes ?? 0) <= MAX_SAVED_FILE_BYTES) {
      if (Date.now() > deadline) timedOut = true;
      else
        body = await Promise.race([
          cdp
            .send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", {
              requestId: id,
            })
            .then((b) => Buffer.from(b.body, b.base64Encoded ? "base64" : "utf8"))
            .catch(() => null),
          // a body that never comes cannot hold the take up past the deadline
          new Promise<null>((r) =>
            setTimeout(() => r(null), Math.max(0, deadline - Date.now())).unref(),
          ),
        ]);
    }
    if (body?.length && total + body.length <= MAX_SAVED_TOTAL_BYTES) {
      const name = uniqueName(r.url, used);
      mkdirSync(join(dir, "product-sounds"), { recursive: true });
      writeFileSync(join(dir, "product-sounds", name), body);
      total += body.length;
      out.push({ ...r, bytes: r.bytes ?? body.length, saved: `product-sounds/${name}` });
    } else out.push(r);
  }
  if (timedOut)
    notes.push("some fetched sound files are listed but not saved (ran out of time reading them)");
  return out;
}

/** `https://x/sounds/click/1.wav?v=3` → `sounds-click-1.wav` (deduped). */
export function uniqueName(url: string, used: Set<string>): string {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    path = url;
  }
  const segs = path.split("/").filter(Boolean).slice(-3);
  let name = (segs.join("-") || "sound").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
  if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) name += ".audio";
  let candidate = name;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const dot = name.lastIndexOf(".");
    candidate = `${name.slice(0, dot)}-${i}${name.slice(dot)}`;
  }
  used.add(candidate.toLowerCase());
  return basename(candidate);
}

/** Mix the blocks onto the capture timeline and write a float WAV. Exported
 *  for the unit test; `producedMs` and `t0` share one wall clock (the page's
 *  performance.timeOrigin and the runtime's Date.now are both epoch ms on the
 *  same machine). */
export function mixBlocks(
  blocks: Array<{ src: SourceKey; producedMs: number; ctxFrame?: number; samples: Float32Array }>,
  sources: Map<SourceKey, { sampleRate: number }>,
  t0: number,
  endMs: number,
): {
  sampleRate: number;
  pcm: Float32Array;
  soundAt: Array<[number, number]>;
  peak: number;
} {
  // the rate most of the sound arrived at; anything else is resampled to it
  const weight = new Map<number, number>();
  for (const b of blocks) {
    const sr = sources.get(b.src)?.sampleRate ?? 48000;
    weight.set(sr, (weight.get(sr) ?? 0) + b.samples.length);
  }
  const sampleRate = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 48000;
  const frames = Math.max(1, Math.ceil((Math.max(endMs, 0) / 1000) * sampleRate));
  const pcm = new Float32Array(frames * 2);
  const spans: Array<[number, number]> = [];
  const startOf = placeOnSourceClocks(blocks, sources);
  for (const b of blocks) {
    const sr = sources.get(b.src)?.sampleRate ?? sampleRate;
    const n = b.samples.length / 2;
    const placed = startOf.get(b);
    if (placed === null) continue;
    const startMs = (placed ?? b.producedMs) - t0;
    const durMs = (n / sr) * 1000;
    if (startMs + durMs <= 0 || startMs >= endMs) continue;
    spans.push([startMs, startMs + durMs]);
    const ratio = sr / sampleRate;
    const first = Math.round((startMs / 1000) * sampleRate);
    const count = Math.floor(n / ratio);
    for (let k = 0; k < count; k++) {
      const o = first + k;
      if (o < 0) continue;
      if (o >= frames) break;
      const x = k * ratio;
      const i = Math.floor(x);
      const f = x - i;
      const j = Math.min(i + 1, n - 1);
      pcm[2 * o] = pcm[2 * o]! + b.samples[2 * i]! * (1 - f) + b.samples[2 * j]! * f;
      pcm[2 * o + 1] =
        pcm[2 * o + 1]! + b.samples[2 * i + 1]! * (1 - f) + b.samples[2 * j + 1]! * f;
    }
  }
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  spans.sort((a, b) => a[0] - b[0]);
  const soundAt: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = soundAt[soundAt.length - 1];
    if (last && a <= last[1] + 30) last[1] = Math.max(last[1], b);
    else soundAt.push([a, b]);
  }
  return {
    sampleRate,
    pcm,
    soundAt: soundAt.map(([a, b]) => [Math.max(0, Math.round(a)), Math.min(endMs, Math.round(b))]),
    peak,
  };
}

/** Wall-clock start of each block that carries its source-clock frame.
 *  Each block's own wall-clock estimate jitters by a few samples, which laid
 *  end to end leaves 1-2 sample overlaps (spikes) and holes (dropouts) at
 *  every ~85 ms boundary. So per source, blocks whose clock offset (wall ms −
 *  source-clock ms) agrees within OFFSET_JUMP_MS form a run that shares ONE
 *  offset — the run's median — and sit sample-exactly on the source's clock;
 *  a larger jump (a suspend/resume, an output restart) starts a new run.
 *  After a main-thread stall Chrome hands over a few buffers stamped with one
 *  stale playbackTime, overlapping the steady chain that follows; a block that
 *  runs into the next one on its own clock is such a stamp and is dropped
 *  (null) rather than summed into a spike. */
const OFFSET_JUMP_MS = 10;
function placeOnSourceClocks<
  B extends { src: SourceKey; producedMs: number; ctxFrame?: number; samples: Float32Array },
>(blocks: B[], sources: Map<SourceKey, { sampleRate: number }>): Map<B, number | null> {
  const out = new Map<B, number | null>();
  const bySrc = new Map<SourceKey, B[]>();
  for (const b of blocks) {
    if (b.ctxFrame == null || !sources.get(b.src)) continue;
    const list = bySrc.get(b.src) ?? [];
    list.push(b);
    bySrc.set(b.src, list);
  }
  for (const [src, list] of bySrc) {
    const sr = sources.get(src)!.sampleRate;
    list.sort((a, b) => a.ctxFrame! - b.ctxFrame!);
    const offset = (b: B) => b.producedMs - (b.ctxFrame! / sr) * 1000;
    let run: B[] = [];
    const close = () => {
      if (!run.length) return;
      const offs = run.map(offset).sort((a, b) => a - b);
      // whole source samples, so every block of the run rounds the same way
      const mid = Math.round((offs[Math.floor(offs.length / 2)]! * sr) / 1000);
      for (const b of run) out.set(b, ((mid + b.ctxFrame!) / sr) * 1000);
      run = [];
    };
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      const next = list[i + 1];
      if (next && next.ctxFrame! < b.ctxFrame! + b.samples.length / 2) {
        out.set(b, null);
        continue;
      }
      const last = run[run.length - 1];
      if (last && Math.abs(offset(b) - offset(last)) > OFFSET_JUMP_MS) close();
      run.push(b);
    }
    close();
  }
  return out;
}

function writeMix(
  blocks: Block[],
  sources: Map<SourceKey, Source>,
  t0: number,
  endMs: number,
  path: string,
): NonNullable<ProductSoundReport["audio"]> {
  const mix = mixBlocks(blocks, sources, t0, endMs);
  writeFileSync(path, floatWav(mix.pcm, mix.sampleRate, 2));
  return {
    file: "product-audio.wav",
    sampleRate: mix.sampleRate,
    channels: 2,
    format: "float32",
    startMs: 0,
    durationMs: Math.round(endMs),
    soundAt: mix.soundAt,
    peakDbfs: mix.peak > 0 ? Math.round(20 * Math.log10(mix.peak) * 10) / 10 : -Infinity,
    placement:
      "estimated: each ~85 ms block is placed where the browser's audio clock says the page " +
      "produced it (AudioContext.getOutputTimestamp, less the output latency the capturing " +
      "browser reports for its own device — see sources[].outputLatencyMs); sample 0 = capture " +
      "t0, the zero of every event tMs and of capture.mp4. Blocks of one AudioContext sit " +
      "sample-exactly end to end on that context's own clock (one clock offset per run, the " +
      "median of its blocks). The product's own delay between an " +
      "input and its sound is kept. A context's first sound can come late while the browser " +
      "starts its audio output.",
    sources: [...sources.values()].map(({ id: _id, ...s }) => s),
  };
}

/** IEEE-float WAV (format 3), interleaved. */
export function floatWav(pcm: Float32Array, sampleRate: number, channels: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 4, 28);
  h.writeUInt16LE(channels * 4, 32);
  h.writeUInt16LE(32, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
