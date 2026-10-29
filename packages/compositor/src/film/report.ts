// What `open-take film render` prints when it finishes: a few things measured
// on the film it just made, read with `film probe`'s own machinery, on the
// path every film already takes. A session that ran the probe changed its
// film on what the probe said; one that did not, never saw it.
//
// It reads, in a few seconds beside a render of minutes:
//   - the picture, as the probe's small grey copy: the one-frame jumps the
//     page did not declare as cuts, and for each how far its content moved
//     (a card that jumps, a saved screen swapped under the camera, a line
//     that re-centres as it is typed) or that it changed in place;
//   - the page, played on the film clock as the probe plays it: where the
//     product's own words (its saved screens) are most of the text on screen
//     and how big they are on a phone; the pictures on screen that their
//     shoot took while the product's screen was still changing; live text
//     that moves under a pixel a frame, which Chrome draws on whole pixels;
//     pictures (<img>, <video>) drawn bigger than their own pixels;
//   - the parts the film named through product() (kit/media.js), read again
//     at the times it used them: in the frame or past an edge, on the screen
//     shown then or not, what the page draws over them, how many frame px
//     each px of the still or recording that shows them takes.
// Text inside pictures (screenshots, recordings) needs the frames read by a
// text recognizer, which takes longer: the full probe does that.
//
// Facts only, each line saying what it covered: no grade, no target.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveFfmpeg, runTool } from "../ffmpeg";
import { decodeMono } from "./beats";
import { type BoundaryCarry, boundaryCarries, CARRY_FILL, carryChange } from "./carry";
import { type SoundChange, soundChanges } from "./changes";
import {
  halfSeconds,
  momentaryLoudness,
  type PictureAgainstSound,
  parseFilmEvents,
  pictureAgainstSound,
  pictureEnergyOf,
} from "./listen";
import { type MovingMaterial, readMovingMaterial } from "./moving";
import {
  decodeGrey,
  findCuts,
  findSmallSwaps,
  frameEnergy,
  frameTime,
  jumpMove,
  PHONE_SMALL_PX,
  PROBE_W,
  productTextSpans,
  textTimeline,
} from "./probe";
import {
  type Box,
  type FrameText,
  type OcrLine,
  ocrHelper,
  type PageTextSample,
  PHONE_W,
  readPageText,
  runOcr,
} from "./probe-text";
import {
  eventsPathFor,
  FINE_SUPERSAMPLE,
  type FilmEvents,
  probeFilm,
  type TurnBack,
} from "./render";
import { type Tuning, tuning } from "./tuning";

export type ReportJump = {
  t: number;
  kind: "cut" | "swap";
  /** share of the frame that changed */
  changed: number;
  /** how far the content that changed moved, px of the page's frame; null:
   *  changed where it stood */
  px: number | null;
  dx: number;
  dy: number;
};

export type ReportSlowText = {
  from: number;
  to: number;
  /** the moving text's median speed, px of the page's frame per film frame
   *  (the median of the samples' medians), and the fastest piece's */
  speed: number;
  fastest: number;
};

export type FilmReport = {
  film: string;
  duration: number;
  fps: number;
  /** where the film starts on the page's timeline (a render of part of it);
   *  every time here is on the film's own clock, from 0 */
  from: number;
  /** seconds between the page's samples */
  every: number;
  /** the size the page was laid out at: every px here is one of these */
  layout: { width: number; height: number };
  /** how the slow text below is counted: device px per page px and frames
   *  a second — this render's, or for a draft a master's (full size, the
   *  page's rate, no --supersample) */
  density: number;
  slowFps: number;
  /** the stretches the render drew finer because text moved slowly there
   *  (film clock), and how finely */
  fine: { from: number; to: number }[];
  fineSupersample: number;
  draft: boolean;
  /** the product's words on screen: its saved screens' (measured on the
   *  page) and those in its pictures (read from their files, estimated) */
  productText: {
    how: "measured" | "not measured";
    note?: string;
    /** pictures on screen read for text: one file per folder and size (a
     *  sequence of stills shares its layout); `skipped` folders past the
     *  first PICTURE_GROUPS; how: "not read" with no text recognizer here */
    pictures: { how: "read" | "not read" | "none on screen"; files: number; skipped: number };
    spans: { from: number; to: number; share: number; phone: number | null; at: number | null }[];
  };
  /** one-frame jumps of the picture the page did not declare as cuts */
  jumps: {
    how: "measured";
    /** whether the page declares any cut at all (kind "cut" events) */
    declared: number;
    list: ReportJump[];
  };
  moving: MovingMaterial;
  slowText: { how: "measured" | "not measured"; note?: string; spans: ReportSlowText[] };
  /** moves of the picture where what it ends up framing does not head
   *  straight for its place (the render's probe, in the events file) */
  turns: { how: "measured" | "not measured"; list: TurnBack[] };
  /** <img>, <video> and <canvas> drawn bigger than their own pixels, and
   *  layers under a perspective drawn bigger than Chrome draws them
   *  (`why` "tilt"), at the page samples: `ratio` the most frame px per px
   *  of the picture */
  pastPixels: {
    how: "measured" | "not measured";
    note?: string;
    list: {
      src?: string;
      label: string;
      from: number;
      to: number;
      ratio: number;
      why?: "tilt";
    }[];
  };
  /** the parts the film named through product() (window.__otParts), each
   *  use read at its times; `named` 0: none was (a drag no part of
   *  components.json was pressed for is a use of no part) */
  parts: {
    how: "measured" | "not measured";
    note?: string;
    named: number;
    uses: ReportPartUse[];
  };
  /** each boundary of the beat sheet (a segment's end inside the film) and
   *  what crossed it: the thing its segment named to `carry`, followed by the
   *  render (src/film/carry.ts), or what the segment says instead; `strip`
   *  a picture beside the film, one row per boundary: 0.3 s before, the
   *  boundary, 0.3 s after */
  seams: {
    how: "measured" | "not measured";
    note?: string;
    list: BoundaryCarry[];
    strip: string | null;
  };
  /** where the picture and the sound run opposite, half a second at a time
   *  (`film listen`'s own reading, from the events file's picture.energy) */
  against: {
    how: "measured" | "not measured";
    note?: string;
    list: PictureAgainstSound["opposite"];
  };
  /** the sound on its own: where several things in it change at once (the
   *  sharpest first), and how in tune it is, by register — `film listen`'s readings */
  sound?:
    | { how: "estimated"; changes: SoundChange[] | null; tuning: Tuning }
    | { how: "not measured"; note: string };
  /** wall time of the report, ms */
  ms: number;
};

/** one use of a part (a camera move, a click, a drag, a mark) and where the
 *  part was at its times (its start, and its end when it has one) */
export type ReportPartUse = {
  name: string;
  /** its element on the screen it was read on at the use, `<state>:<eN>` */
  ref: string;
  use: string;
  t: number;
  end?: number;
  label?: string;
  seen: ReportPartSeen[];
  /** why a time was not read (the page threw there) */
  note?: string;
};

export type ReportPartSeen = {
  t: number;
  /** the screen it was read on; `shown` false: not the one shown then (the
   *  nearest screen it is on was read), `on` every screen it is on */
  state: string;
  shown: boolean;
  /** the screen shown then, when the kit says */
  showing?: string;
  on: string[];
  /** where it is in the picture, px of the frame */
  picture: Box;
  /** its share inside the frame, and the edge it is most past when not all */
  inFrame: number;
  edge?: "left" | "right" | "top" | "bottom";
  /** what the page draws over it, by share of it; null: not read */
  covered: { what: string; share: number }[] | null;
  /** what shows it, and frame px per px of the still or recording */
  drawn: "screen" | "still" | "recording";
  sourcePx?: number;
};

export type FilmReportOptions = {
  /** the film just rendered */
  film: string;
  /** its page (an .html file or its folder) and the folder it was served from */
  page: string;
  root?: string;
  chromePath: string;
  /** default: the film's events file beside it */
  events?: string;
  /** the render's --supersample and --draft: how finely it drew text */
  supersample?: number;
  draft?: boolean;
  /** what the render drew finer (FilmRenderResult.fine, on the page's
   *  timeline) and how finely */
  fine?: { from: number; to: number }[];
  fineSupersample?: number;
  /** seconds between page samples (default 0.5) */
  every?: number;
  onConsole?: (level: string, text: string) => void;
};

// --- live text moving under a pixel a frame ------------------------------------------------

type DriftPick = { node: Text; frame: HTMLIFrameElement | null };

// serialized into the page, like the one below: nothing outside its own
// body. Where each node kept by driftPick draws its first line now (page
// px), or null when it is gone or off the frame.
function driftMeasure(): ([number, number] | null)[] {
  const vw = innerWidth;
  const vh = innerHeight;
  const picks = (window as unknown as { __otDrift?: DriftPick[] }).__otDrift ?? [];
  return picks.map(({ node, frame }) => {
    if (!node.isConnected) return null;
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const r = Array.from(range.getClientRects()).find((x) => x.width >= 1 && x.height >= 1);
    if (!r) return null;
    let x = r.left;
    let y = r.top;
    if (frame) {
      const fb = frame.getBoundingClientRect();
      const sx = frame.offsetWidth ? fb.width / frame.offsetWidth : 1;
      const sy = frame.offsetHeight ? fb.height / frame.offsetHeight : 1;
      x = fb.left + (frame.clientLeft + r.left) * sx;
      y = fb.top + (frame.clientTop + r.top) * sy;
    }
    if (x < 0 || y < 0 || x > vw || y > vh) return null;
    return [x, y];
  });
}

// Where the nodes kept at the sample before are now (`was`); then the
// visible text nodes now (the page and its same-origin frames), up to `max`
// spread over them, kept on window for the next sample, and where they are
// (`now`).
function driftPick(max: number, measure: () => ([number, number] | null)[]) {
  const was = measure();
  const all: DriftPick[] = [];
  const visit = (doc: Document, frame: HTMLIFrameElement | null) => {
    if (!doc.body) return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.nodeValue ?? "").trim()) continue;
      const el = n.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      all.push({ node: n as Text, frame });
    }
  };
  visit(document, null);
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    try {
      if (f.contentDocument && f.checkVisibility({ opacityProperty: true }))
        visit(f.contentDocument, f);
    } catch {}
  }
  const step = Math.max(1, all.length / max);
  const picks: DriftPick[] = [];
  for (let k = 0; k < all.length && picks.length < max; k += step) picks.push(all[Math.floor(k)]!);
  (window as unknown as { __otDrift: DriftPick[] }).__otDrift = picks;
  return { was, now: measure() };
}

const DRIFT_MAX = 32;
/** asked of the page at each sample, on the same seek as its text */
export const DRIFT_JS = `(() => { const __name = (f) => f; return (${driftPick.toString()})(${DRIFT_MAX}, ${driftMeasure.toString()}); })()`;

type Place = [number, number] | null;

/** text that moves slower than one device pixel a frame, for a second or
 *  more. Each step holds the places of the same nodes at its two ends
 *  (page px), its speed what they moved over the frames between, so a
 *  steady move reads exactly and an uneven one as its average. A node
 *  moving at all (≥ 0.02 px a frame) counts; a step is slow when the median
 *  of those, in device px (× `density`), is under one. Steps that follow
 *  each other run into one span. */
export function slowTextSpans(
  steps: readonly { from: number; to: number; at: readonly Place[]; next: readonly Place[] }[],
  density: number,
  fps: number,
): ReportSlowText[] {
  const spans: { from: number; to: number; speeds: number[]; fastest: number }[] = [];
  for (const s of steps) {
    const frames = (s.to - s.from) * fps;
    if (!(frames > 0)) continue;
    const v: number[] = [];
    s.at.forEach((a, i) => {
      const b = s.next[i];
      if (!a || !b) return;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) / frames;
      if (d >= 0.02) v.push(d);
    });
    if (!v.length) continue;
    const m = median(v);
    if (m * density >= 1) continue;
    const open = spans.at(-1);
    if (open && s.from <= open.to + 1e-6) {
      open.to = s.to;
      open.speeds.push(m);
      open.fastest = Math.max(open.fastest, ...v);
    } else spans.push({ from: s.from, to: s.to, speeds: [m], fastest: Math.max(...v) });
  }
  // a second or more: the end of an eased move passes under a pixel a frame too
  return spans
    .filter((s) => s.to - s.from >= 1 - 1e-6 && s.speeds.length >= 2)
    .map((s) => ({
      from: round3(s.from),
      to: round3(s.to),
      speed: round2(median(s.speeds)),
      fastest: round2(s.fastest),
    }));
}

// --- the parts the film named --------------------------------------------------------------

type PartUseRead = { use: string; t: number; end?: number; label?: string; ref?: string };
/** `key` the registry's own (kit/media.js), the same in every playing of
 *  the page; `reads` false: a drag no part of components.json was pressed
 *  for — nothing to read where it is */
type PartListed = { key: string; name: string; ref: string; reads: boolean; uses: PartUseRead[] };

// serialized into the page, like the two below. Every part product() made
// (kit/media.js, window.__otParts) and what the film did with it, as plain
// values.
function partsList(): PartListed[] {
  type Reg = { key?: unknown; name?: unknown; ref?: unknown; uses?: unknown; at?: unknown };
  const reg = (window as unknown as { __otParts?: Reg[] }).__otParts ?? [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return reg.map((p, i) => ({
    key: typeof p?.key === "string" && p.key ? p.key : `#${i}`,
    name: String(p?.name ?? ""),
    ref: typeof p?.ref === "string" ? p.ref : "",
    reads: typeof p?.at === "function",
    uses: (Array.isArray(p?.uses) ? (p.uses as Record<string, unknown>[]) : []).flatMap((u) => {
      const t = num(u?.t);
      if (t === undefined) return [];
      const end = num(u.end);
      return [
        {
          use: String(u.use ?? ""),
          t,
          ...(end !== undefined ? { end } : {}),
          ...(typeof u.label === "string" ? { label: u.label } : {}),
          ...(typeof u.ref === "string" ? { ref: u.ref } : {}),
        },
      ];
    }),
  }));
}

/** where each part with a use at the page's time `at` shows now, as the
 *  part says (at(t), coveredBy(t)) */
function partsAt(at: number): PartRead[] {
  type Seen = {
    state?: string;
    shown?: boolean;
    showing?: string;
    picture?: { x: number; y: number; width: number; height: number };
    drawn?: string;
    sourcePx?: number;
  };
  type Reg = {
    key?: unknown;
    uses?: { t?: number; end?: number }[];
    at?: (t: number) => Seen;
    coveredBy?: (t: number) => { what: string; share: number }[];
    in?: (state: string) => string | null;
    states?: { state: string }[];
  };
  const reg = (window as unknown as { __otParts?: Reg[] }).__otParts ?? [];
  const near = (v: unknown) => typeof v === "number" && Math.abs(v - at) < 1e-3;
  return reg.flatMap((p, i): PartRead[] => {
    if (typeof p?.at !== "function") return [];
    const key = typeof p.key === "string" && p.key ? p.key : `#${i}`;
    if (!(p.uses ?? []).some((u) => near(u?.t) || near(u?.end))) return [];
    try {
      const a = p.at(at);
      let covered: { what: string; share: number }[] | null = null;
      try {
        covered = typeof p.coveredBy === "function" ? p.coveredBy(at) : null;
      } catch {}
      const b = a.picture ?? { x: 0, y: 0, width: 0, height: 0 };
      return [
        {
          key,
          state: String(a.state ?? ""),
          ref: (a.state && p.in?.(a.state)) || "",
          shown: a.shown !== false,
          ...(typeof a.showing === "string" ? { showing: a.showing } : {}),
          on: (p.states ?? []).map((s) => s.state),
          picture: [b.x, b.y, b.width, b.height] as Box,
          drawn: String(a.drawn ?? "screen"),
          ...(typeof a.sourcePx === "number" ? { sourcePx: a.sourcePx } : {}),
          covered,
        },
      ];
    } catch (e) {
      return [{ key, error: String((e as Error)?.message ?? e).split("\n")[0] }];
    }
  });
}

/** asked of the page at each sample: the drift reading, and the parts named */
const PAGE_JS = `(() => { const __name = (f) => f; return { ...${DRIFT_JS}, parts: (${partsList.toString()})() }; })()`;
/** asked of the page at a part's use time (the page's clock) */
const partsAtJs = (at: number) =>
  `(() => { const __name = (f) => f; return (${partsAt.toString()})(${at}); })()`;

type PartRead = {
  key: string;
  error?: string;
  state?: string;
  ref?: string;
  shown?: boolean;
  showing?: string;
  on?: string[];
  picture?: Box;
  drawn?: string;
  sourcePx?: number;
  covered?: { what: string; share: number }[] | null;
};

/** the share of a box inside the frame, and the edge it is most past */
export function inFrameOf(
  b: Box,
  frame: { width: number; height: number },
): { inFrame: number; edge?: ReportPartSeen["edge"] } {
  const [x, y, w, h] = b;
  if (!(w > 0 && h > 0)) return { inFrame: 0 };
  const iw = Math.max(0, Math.min(x + w, frame.width) - Math.max(x, 0));
  const ih = Math.max(0, Math.min(y + h, frame.height) - Math.max(y, 0));
  const inFrame = round3((iw * ih) / (w * h));
  if (inFrame >= 0.999) return { inFrame: 1 };
  const past: [NonNullable<ReportPartSeen["edge"]>, number][] = [
    ["left", Math.max(0, -x) / w],
    ["right", Math.max(0, x + w - frame.width) / w],
    ["top", Math.max(0, -y) / h],
    ["bottom", Math.max(0, y + h - frame.height) / h],
  ];
  past.sort((a, b) => b[1] - a[1]);
  return { inFrame, edge: past[0]![0] };
}

/** every use of every part, once (a use the page makes again on each frame
 *  is one), its times on the film's clock; and the readings at those times
 *  (the page's clock, by `from`) set on each */
export function partUses(
  listed: readonly PartListed[],
  reads: readonly { t: number; parts: readonly PartRead[] }[],
  o: { from: number; duration: number; layout: { width: number; height: number } },
): ReportPartUse[] {
  const out: ReportPartUse[] = [];
  for (const p of listed) {
    const seen = new Set<string>();
    for (const u of p.uses) {
      const key = `${u.use}|${u.t}|${u.end ?? ""}|${u.label ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const times = [u.t, ...(u.end !== undefined && u.end !== u.t ? [u.end] : [])].map(
        (v) => v - o.from,
      );
      const errors: string[] = [];
      const read: ReportPartSeen[] = [];
      // the ref read again at its time, over the one the use was given when
      // the page set it up (the screens played may have changed since)
      let ref = "";
      const inside = times.filter((t) => t >= -1e-6 && t <= o.duration + 1e-6);
      for (const t of inside) {
        const r = reads.find((x) => Math.abs(x.t - t) < 1e-3)?.parts.find((x) => x.key === p.key);
        if (!r) continue;
        if (r.error || !r.picture) {
          errors.push(`${fmt(t)}: ${r.error ?? "no picture"}`);
          continue;
        }
        ref ||= r.ref ?? "";
        const picture = r.picture.map((v) => Math.round(v * 10) / 10) as Box;
        read.push({
          t: round3(t),
          state: r.state ?? "",
          shown: r.shown !== false,
          ...(r.showing ? { showing: r.showing } : {}),
          on: r.on ?? [],
          picture,
          ...inFrameOf(picture, o.layout),
          covered: r.covered
            ? r.covered.map((c) => ({ what: c.what, share: round3(c.share) }))
            : null,
          drawn: r.drawn === "still" || r.drawn === "recording" ? r.drawn : "screen",
          ...(r.sourcePx !== undefined ? { sourcePx: round2(r.sourcePx) } : {}),
        });
      }
      // why nothing was read, when nothing was
      const note = errors.length
        ? `the part could not be read at ${errors.join("; ")}`
        : read.length
          ? undefined
          : !inside.length
            ? "not read (outside the film)"
            : !p.reads
              ? "no part of components.json was pressed: where it is not read"
              : "not read at its times";
      out.push({
        name: p.name,
        ref: ref || u.ref || p.ref,
        use: u.use,
        t: round3(u.t - o.from),
        ...(u.end !== undefined ? { end: round3(u.end - o.from) } : {}),
        ...(u.label !== undefined ? { label: u.label } : {}),
        seen: read,
        ...(note ? { note } : {}),
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** <img>, <video>, <canvas> and tilted layers drawn bigger than their own
 *  pixels at the samples, by picture: the stretches of samples it was, and
 *  the most frame px per px */
export function pastPixels(
  samples: readonly PageTextSample[],
  every: number,
): FilmReport["pastPixels"]["list"] {
  const runs = new Map<
    string,
    {
      src?: string;
      label: string;
      why?: "tilt";
      spans: { from: number; to: number; ratio: number }[];
    }
  >();
  for (const s of samples)
    for (const m of s.media) {
      if (!m.drawn || !m.natural) continue;
      const ratio = Math.max(m.drawn[2] / m.natural[0], m.drawn[3] / m.natural[1]);
      if (!(ratio > 1.01)) continue;
      const key = `${m.why ?? ""} ${m.src ?? m.label}`;
      let r = runs.get(key);
      if (!r) {
        r = {
          ...(m.src ? { src: m.src } : {}),
          label: m.label,
          ...(m.why ? { why: m.why } : {}),
          spans: [],
        };
        runs.set(key, r);
      }
      const open = r.spans.at(-1);
      if (open && s.t - open.to <= every * 1.5 + 1e-6) {
        if (open.to !== s.t) open.to = s.t;
        open.ratio = Math.max(open.ratio, ratio);
      } else r.spans.push({ from: s.t, to: s.t, ratio });
    }
  return [...runs.values()]
    .flatMap((r) =>
      r.spans.map((x) => ({
        ...(r.src ? { src: r.src } : {}),
        label: r.label,
        from: round3(x.from),
        to: round3(x.to),
        ratio: round2(x.ratio),
        ...(r.why ? { why: r.why } : {}),
      })),
    )
    .sort((a, b) => a.from - b.from);
}

// --- text in pictures ----------------------------------------------------------------------

/** folders (and sizes) of pictures read for text at most */
const PICTURE_GROUPS = 16;
const RASTER = /\.(png|jpe?g|webp|gif|tiff?|bmp|heic)$/i;

/** the text in the <img> pictures on screen, read by the system's text
 *  recognizer from the files themselves (not from the film's frames, which
 *  takes longer): one file per folder and size stands for the rest, and
 *  its lines are set where each picture is drawn at each sample, kept where
 *  their middle shows. Null frames when nothing could be read. */
export async function picturesText(
  samples: readonly PageTextSample[],
  root: string,
  layout: { width: number; height: number },
): Promise<{ frames: FrameText[] | null; pictures: FilmReport["productText"]["pictures"] }> {
  const groupOf = new Map<string, string>();
  const reps: string[] = [];
  let skipped = 0;
  const keyOf = (m: PageTextSample["media"][number]): string | null => {
    if (!m.src || !m.drawn || !m.natural || /^[a-z]+:/i.test(m.src)) return null;
    const file = resolve(root, `.${m.src.startsWith("/") ? "" : "/"}${m.src}`);
    if (!RASTER.test(file) || !existsSync(file)) return null;
    const key = `${dirname(file)}|${m.natural[0]}x${m.natural[1]}`;
    if (!groupOf.has(key)) {
      if (reps.length >= PICTURE_GROUPS) {
        skipped++;
        groupOf.set(key, "");
      } else {
        groupOf.set(key, file);
        reps.push(file);
      }
    }
    return groupOf.get(key) ? key : null;
  };
  const shown = samples.map((s) => s.media.map((m) => ({ m, key: keyOf(m) })));
  if (!reps.length) return { frames: null, pictures: { how: "none on screen", files: 0, skipped } };
  const bin = await ocrHelper();
  const read = bin ? await runOcr(bin, reps).catch(() => null) : null;
  if (!read) return { frames: null, pictures: { how: "not read", files: reps.length, skipped } };
  const linesOf = new Map<string, NonNullable<(typeof read)[number]>["lines"]>();
  const keys = [...groupOf].filter(([, f]) => f);
  for (const [key, file] of keys) {
    const r = read[reps.indexOf(file)];
    if (r) linesOf.set(key, r.lines);
  }
  const area = layout.width * layout.height;
  const frames: FrameText[] = samples.map((s, i) => {
    const lines: OcrLine[] = [];
    for (const { m, key } of shown[i]!) {
      const L = key ? linesOf.get(key) : undefined;
      if (!L || !m.drawn) continue;
      const [dx, dy, dw, dh] = m.drawn;
      const [bx, by, bw, bh] = m.box;
      for (const l of L) {
        const box: Box = [dx + l.x * dw, dy + l.y * dh, l.w * dw, l.h * dh];
        const cx = box[0] + box[2] / 2;
        const cy = box[1] + box[3] / 2;
        if (cx < bx || cy < by || cx > bx + bw || cy > by + bh) continue;
        lines.push({
          box,
          chars: l.s.replace(/\s+/g, "").length,
          conf: l.c,
          text: l.s.slice(0, 60),
        });
      }
    }
    const share = Math.min(1, lines.reduce((a, l) => a + l.box[2] * l.box[3], 0) / area);
    return { t: s.t, how: "ocr", lines, share: round3(share) };
  });
  return { frames, pictures: { how: "read", files: reps.length, skipped } };
}

// --- the report ------------------------------------------------------------------------------

export async function filmReport(opts: FilmReportOptions): Promise<FilmReport> {
  const start = Date.now();
  const every = opts.every ?? 0.5;
  const info = await probeFilm(opts.film);
  const fps = info.fps;
  const duration = info.frames / fps;
  const layout = {
    width: Number(info.record.width) || info.width,
    height: Number(info.record.height) || info.height,
  };
  // a draft draws half size at its own rate: slow text is counted as a
  // master would draw it
  const density = opts.draft ? 1 : Math.max(1, Math.round(opts.supersample ?? 1));
  const eventsFile = opts.events ?? eventsPathFor(opts.film);
  const rawEvents: Record<string, unknown> = existsSync(eventsFile)
    ? (JSON.parse(await readFile(eventsFile, "utf8")) as Record<string, unknown>)
    : {};
  const declared = (Array.isArray(rawEvents.declaredCuts) ? rawEvents.declaredCuts : [])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map((v) => v - info.from);

  const times: number[] = [];
  for (let k = 0; k * every < duration - 0.5 / fps; k++) times.push(round3(k * every));
  const ffmpeg = await resolveFfmpeg();
  // the film's sound, decoded while the picture is read
  const soundPcm = decodeMono(ffmpeg, opts.film).catch((e: Error) => e);
  const gh = Math.max(8, Math.round((PROBE_W * info.height) / info.width / 2) * 2);
  let pageNote: string | undefined;
  const [grey, pageRead] = await Promise.all([
    decodeGrey(ffmpeg, opts.film, PROBE_W, gh, fps),
    readPageText({
      page: opts.page,
      root: opts.root,
      chromePath: opts.chromePath,
      from: info.from,
      times,
      width: layout.width,
      height: layout.height,
      fallback: layout,
      extra: PAGE_JS,
      onConsole: opts.onConsole,
    }).catch((e: Error) => {
      pageNote = `the page could not be played: ${e.message.split("\n")[0]}`;
      return null;
    }),
  ]);

  // the picture's jumps, and what each did to the content
  const energy = frameEnergy(grey);
  const cuts = findCuts(grey, energy);
  const swaps = findSmallSwaps(grey, energy, cuts).map((s) => s.frame);
  const tol = 1.5 / fps;
  const kx = layout.width / grey.w;
  const ky = layout.height / grey.h;
  const jumps: ReportJump[] = [...cuts, ...swaps]
    .sort((a, b) => a - b)
    .map((f) => ({ f, t: frameTime(grey, f) }))
    .filter(({ t }) => !declared.some((d) => Math.abs(d - t) <= tol))
    .map(({ f, t }) => {
      const m = jumpMove(grey, f);
      const dx = m.shift ? m.shift.x * kx : 0;
      const dy = m.shift ? m.shift.y * ky : 0;
      return {
        t: round3(t),
        kind: cuts.includes(f) ? "cut" : "swap",
        changed: round2(m.changed),
        px: m.shift ? Math.round(Math.hypot(dx, dy)) : null,
        dx: Math.round(dx),
        dy: Math.round(dy),
      };
    });

  // the page: the product's words, how it was shot, text that creeps
  let productText: FilmReport["productText"] = {
    how: "not measured",
    note: pageNote ?? "the page was not played",
    pictures: { how: "not read", files: 0, skipped: 0 },
    spans: [],
  };
  let slowText: FilmReport["slowText"] = {
    how: "not measured",
    note: pageNote ?? "the page was not played",
    spans: [],
  };
  let slowFps = fps;
  if (pageRead) {
    const phoneScale = PHONE_W / layout.width;
    const pics = await picturesText(pageRead.samples, pageRead.root, layout);
    const text = textTimeline(pageRead.samples, pics.frames, {
      width: layout.width,
      height: layout.height,
      segments: [],
      every,
    });
    productText = {
      how: "measured",
      ...(pageRead.failed.length
        ? { note: `the page threw at ${pageRead.failed.length} sample time(s), left out` }
        : {}),
      pictures: pics.pictures,
      spans: productTextSpans(text.samples, phoneScale, every, {
        pictures: pics.pictures.how === "read",
      }).map((s) => {
        // the sample its smallest median is from
        let at: number | null = null;
        let low = Number.POSITIVE_INFINITY;
        for (const x of text.samples)
          if (x.t >= s.from - 1e-6 && x.t < s.to - 1e-6 && x.productMedian != null)
            if (x.productMedian < low) {
              low = x.productMedian;
              at = x.t;
            }
        return { from: s.from, to: s.to, share: s.productShare, phone: s.phoneMedian, at };
      }),
    };
    const pts = (v: unknown): Place[] =>
      (Array.isArray(v) ? v : []).map((p) =>
        Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
          ? ([p[0], p[1]] as [number, number])
          : null,
      );
    const drift = pageRead.samples.map((s) => {
      const e = (s.extra ?? {}) as { was?: unknown; now?: unknown };
      return { t: s.t, was: pts(e.was), now: pts(e.now) };
    });
    // each sample beside the one before it (a sample the page threw at
    // leaves a gap, not a step)
    const steps = drift.slice(1).flatMap((s, i) => {
      const p = drift[i]!;
      return s.t - p.t <= every * 1.5 + 1e-6
        ? [{ from: p.t, to: s.t, at: p.now, next: s.was }]
        : [];
    });
    slowFps = opts.draft ? (pageRead.info.fps ?? 60) : fps;
    slowText = { how: "measured", spans: slowTextSpans(steps, density, slowFps) };
  }
  const moving = readMovingMaterial(pageRead?.samples ?? null, pageRead?.root ?? null, {
    ...(pageNote ? { note: pageNote } : {}),
  });

  // the parts the film named: every one, from the samples (a part made late
  // shows in the later ones), then the page played again at their uses' times
  let parts: FilmReport["parts"] = {
    how: "not measured",
    note: pageNote ?? "the page was not played",
    named: 0,
    uses: [],
  };
  if (pageRead) {
    const listed = new Map<string, PartListed>();
    for (const s of pageRead.samples) {
      const got = (s.extra as { parts?: unknown } | undefined)?.parts;
      if (Array.isArray(got)) for (const p of got as PartListed[]) listed.set(p.key, p);
    }
    const all = [...listed.values()];
    const times = [
      ...new Set(
        all
          .flatMap((p) => p.uses.flatMap((u) => [u.t, ...(u.end !== undefined ? [u.end] : [])]))
          .map((v) => round3(v - info.from))
          .filter((t) => t >= -1e-6 && t <= duration + 1e-6),
      ),
    ].sort((a, b) => a - b);
    let note: string | undefined;
    const reads = times.length
      ? await readPageText({
          page: opts.page,
          root: opts.root,
          chromePath: opts.chromePath,
          from: info.from,
          times,
          width: layout.width,
          height: layout.height,
          fallback: layout,
          extra: partsAtJs,
          onConsole: opts.onConsole,
        }).catch((e: Error) => {
          note = `the page could not be played again at the parts' times: ${e.message.split("\n")[0]}`;
          return null;
        })
      : null;
    parts = {
      how: "measured",
      ...(note ? { note } : {}),
      named: all.filter((p) => p.reads).length,
      uses: partUses(
        all,
        (reads?.samples ?? []).map((s) => ({
          t: s.t,
          parts: Array.isArray(s.extra) ? (s.extra as PartRead[]) : [],
        })),
        { from: info.from, duration, layout },
      ),
    };
  }

  // what crossed each boundary, and a strip of it to look at
  const ev = rawEvents as unknown as FilmEvents;
  let seams: FilmReport["seams"];
  if (!Array.isArray(rawEvents.segments) || !rawEvents.curves)
    seams = {
      how: "not measured",
      note: "no beat sheet in the events file",
      list: [],
      strip: null,
    };
  else {
    const list = boundaryCarries(ev, info.from).filter(
      (b) => b.at > 0 && b.at < duration - 0.5 / fps,
    );
    let strip: string | null = null;
    let note: string | undefined;
    if (list.length)
      strip = await seamStrip(ffmpeg, opts.film, list, fps, duration).catch((e: Error) => {
        note = `no strip: ${e.message.split("\n")[0]}`;
        return null;
      });
    seams = { how: "measured", ...(note ? { note } : {}), list, strip };
  }
  // the sound on its own
  let sound: FilmReport["sound"];
  const pcm = await soundPcm;
  if (pcm instanceof Error)
    sound = {
      how: "not measured",
      // a render with no soundtrack has no audio stream to decode
      note: /does not contain any stream|matches no streams|no sound/i.test(pcm.message)
        ? "the film has no sound"
        : (pcm.message.split("\n")[0] ?? ""),
    };
  else
    sound = pcm.length
      ? {
          how: "estimated",
          changes: soundChanges(pcm, { max: SOUND_CHANGES }),
          tuning: tuning(pcm),
        }
      : { how: "not measured", note: "the film has no sound" };
  // the picture against the sound
  let against: FilmReport["against"];
  let picEnergy: ReturnType<typeof pictureEnergyOf> = null;
  try {
    // on this film's clock: parseFilmEvents moves a range's curve to start at its own 0
    picEnergy = rawEvents.curves ? pictureEnergyOf(parseFilmEvents(rawEvents)) : null;
  } catch {
    // an events file listen cannot read: the line says not measured
  }
  if (!picEnergy)
    against = { how: "not measured", note: "no picture.energy in the events file", list: [] };
  else {
    const loud = await momentaryLoudness(ffmpeg, opts.film, duration).catch(() => []);
    if (!loud.length) against = { how: "not measured", note: "the film has no sound", list: [] };
    else {
      against = {
        how: "measured",
        list: pictureAgainstSound(halfSeconds(loud, picEnergy, duration)).opposite,
      };
    }
  }

  return {
    film: opts.film,
    duration: round3(duration),
    fps,
    from: info.from,
    every,
    layout,
    density,
    slowFps,
    fine: (opts.fine ?? []).map((f) => ({
      from: round3(f.from - info.from),
      to: round3(f.to - info.from),
    })),
    fineSupersample: opts.fineSupersample ?? 1,
    turns: Array.isArray(rawEvents.turnsBack)
      ? {
          how: "measured",
          list: (rawEvents.turnsBack as TurnBack[]).map((x) => ({
            ...x,
            from: round3(x.from - info.from),
            to: round3(x.to - info.from),
            at: round3(x.at - info.from),
          })),
        }
      : { how: "not measured", list: [] },
    draft: !!opts.draft,
    pastPixels: pageRead
      ? { how: "measured", list: pastPixels(pageRead.samples, every) }
      : { how: "not measured", note: pageNote ?? "the page was not played", list: [] },
    parts,
    productText,
    jumps: { how: "measured", declared: declared.length, list: jumps },
    moving,
    slowText,
    seams,
    against,
    sound,
    ms: Date.now() - start,
  };
}

/** where a film's strip of boundaries goes: `film.mp4` → `film.seams.jpg` */
export function seamStripPathFor(film: string): string {
  return eventsPathFor(film).replace(/\.events\.json$/, ".seams.jpg");
}

/** one row per boundary, 0.3 s before it, on it, 0.3 s after: a picture of
 *  what each boundary looks like, to open beside the numbers */
async function seamStrip(
  ffmpeg: string,
  film: string,
  list: readonly BoundaryCarry[],
  fps: number,
  duration: number,
): Promise<string> {
  const last = Math.max(0, Math.round(duration * fps) - 1);
  const frames = list.flatMap((b) =>
    [-0.3, 0, 0.3].map((d) => Math.min(last, Math.max(0, Math.round((b.at + d) * fps)))),
  );
  // each frame decoded once, in film order; laid out row by row as the
  // boundaries ask, a frame two boundaries share drawn in both rows
  const pick = [...new Set(frames)].sort((a, b) => a - b);
  const out = seamStripPathFor(film);
  await rm(out, { force: true });
  const tmp = await mkdtemp(join(tmpdir(), "open-take-seams-"));
  try {
    await runTool(ffmpeg, [
      "-v",
      "error",
      "-i",
      film,
      "-vf",
      `select='${pick.map((n) => `eq(n,${n})`).join("+")}',scale=480:-2`,
      "-fps_mode",
      "passthrough",
      join(tmp, "f%05d.png"),
    ]);
    const file = (n: number) => join(tmp, `f${String(pick.indexOf(n) + 1).padStart(5, "0")}.png`);
    const listFile = join(tmp, "rows.txt");
    await writeFile(listFile, frames.map((n) => `file '${file(n)}'\n`).join(""));
    await runTool(ffmpeg, [
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-vf",
      `tile=3x${Math.ceil(frames.length / 3)}:padding=4:color=white`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-y",
      out,
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return out;
}

const fmt = (t: number) => `${t.toFixed(2)} s`;

const direction = (dx: number, dy: number) => {
  const h = dx < 0 ? "left" : "right";
  const v = dy < 0 ? "up" : "down";
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= 2 * ay) return h;
  if (ay >= 2 * ax) return v;
  return `${v}-${h}`;
};

/** jumps with moved content, close ones (under a second apart) as one run */
function jumpRuns(list: readonly ReportJump[]): { big: number; t: number; text: string }[] {
  const moved = list.filter((j) => j.px != null);
  const runs: ReportJump[][] = [];
  for (const j of moved) {
    const last = runs.at(-1);
    if (last && j.t - last.at(-1)!.t < 1) last.push(j);
    else runs.push([j]);
  }
  return runs.map((r) => {
    const big = Math.max(...r.map((j) => j.changed));
    if (r.length === 1) {
      const j = r[0]!;
      return {
        big,
        t: j.t,
        text: `${fmt(j.t)} ${j.px} px ${direction(j.dx, j.dy)} (${pct(j.changed)} of the frame changed)`,
      };
    }
    const px = r.map((j) => j.px!);
    const lo = Math.min(...px);
    const hi = Math.max(...px);
    const dirs = new Set(r.map((j) => direction(j.dx, j.dy)));
    const dir = dirs.size === 1 ? [...dirs][0] : "in different directions";
    return {
      big,
      t: r[0]!.t,
      text: `${fmt(r[0]!.t)}–${fmt(r.at(-1)!.t)} ${r.length} jumps of ${lo === hi ? lo : `${lo}–${hi}`} px ${dir} (up to ${pct(big)} of the frame changed)`,
    };
  });
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** the lines `film render` prints: one per thing measured, then where the
 *  full report is */
export function formatFilmReport(r: FilmReport, o: { probe: string }): string[] {
  const L: string[] = [];
  const w = r.layout.width;
  const clock = r.from
    ? `; times from the film's start, ${fmt(r.from)} on the page's timeline`
    : "";
  L.push(
    `measured on this film (px of the ${w}×${r.layout.height} frame${clock}; facts, not grades):`,
  );

  // the product's words
  const pt = r.productText;
  const P = pt.pictures;
  const from = `its saved screens${
    P.how === "read"
      ? `, and text in its pictures read from ${P.files} file(s), one per folder and size${P.skipped ? ` (${P.skipped} more folder(s) not read)` : ""}`
      : P.how === "not read" && P.files
        ? "; text in pictures not read — no text recognizer here"
        : ""
  }`;
  if (pt.how === "not measured") L.push(`  product's text: not measured — ${pt.note}`);
  else if (!pt.spans.length)
    L.push(
      `  product's text (${from}): in no sample is it most of the text on screen, nor its median under ${PHONE_SMALL_PX} px on a phone ${PHONE_W} px wide`,
    );
  else {
    const scale = PHONE_W / w;
    const shown = pt.spans.slice(0, 3).map((s) => {
      const size =
        s.phone != null
          ? `, median down to ${s.phone} px on a phone (${Math.round(s.phone / scale)} px here${s.at != null ? `, at ${fmt(s.at)}` : ""})`
          : "";
      return `${fmt(s.from)}–${fmt(s.to)} up to ${Math.round(s.share * 100)}% of the text${size}`;
    });
    L.push(
      `  product's text (${from}): most of the text on screen, or its median under ${PHONE_SMALL_PX} px on a phone ${PHONE_W} px wide — ${shown.join("; ")}${pt.spans.length > 3 ? `; ${pt.spans.length - 3} more` : ""}`,
    );
  }

  // jumps not declared as cuts
  const J = r.jumps;
  const runs = jumpRuns(J.list);
  const inPlace = J.list.filter((j) => j.px == null);
  const newPictures = inPlace.filter((j) => j.kind === "cut" && j.changed >= 0.5).length;
  const swapped = inPlace.length - newPictures;
  const rest = [
    newPictures ? `${newPictures} to a new picture` : "",
    swapped
      ? `${swapped} changed in place (a word, a number, a picture swapped where it stood)`
      : "",
  ].filter(Boolean);
  const scope = J.declared
    ? `the page declares ${J.declared} cut(s)`
    : 'the page declares no cuts (events of kind "cut")';
  if (!J.list.length) L.push(`  one-frame jumps not declared as cuts: none (${scope})`);
  else
    L.push(
      `  one-frame jumps not declared as cuts (${scope}): ${[
        runs.length
          ? // the largest changes first in, then in time order
            `content moved — ${[...runs]
              .sort((a, b) => b.big - a.big || a.t - b.t)
              .slice(0, 4)
              .sort((a, b) => a.t - b.t)
              .map((x) => x.text)
              .join("; ")}${runs.length > 4 ? `; ${runs.length - 4} more` : ""}`
          : "",
        ...rest,
      ]
        .filter(Boolean)
        .join(
          "; ",
        )}${runs.length ? ". A part the product moved between saved screens can be kept in place with `hold()` (kit/media.js), when that is wanted" : ""}`,
    );

  // material taken while changing
  const m = r.moving;
  if (m.how === "not measured") L.push(`  pictures taken mid-change: not measured — ${m.note}`);
  else if (!m.matched)
    L.push(
      `  pictures taken mid-change: no picture on screen matched a shoot's log (shots.json, ${m.logs} found)`,
    );
  else if (!m.list.length)
    L.push(
      `  pictures taken mid-change: none (${m.matched} picture(s) on screen matched to a shoot's log${m.unrecorded ? `, ${m.unrecorded} of them from a shoot that did not record it, which says nothing either way` : ""})`,
    );
  else {
    const shown = m.list.slice(0, 3).map((e) => {
      const at =
        e.times.length > 1 ? `${fmt(e.times[0]!)}–${fmt(e.times.at(-1)!)}` : fmt(e.times[0]!);
      const what = e.texts[0]
        ? ` ${JSON.stringify(e.texts[0].before)} → ${JSON.stringify(e.texts[0].after)}`
        : e.moved
          ? " text moved"
          : e.animations
            ? ` ${e.animations} animation(s) running`
            : "";
      return `${e.src} on screen ${at}${what}`;
    });
    L.push(
      `  pictures taken while the product's screen was still changing: ${shown.join("; ")}${m.list.length > 3 ? `; ${m.list.length - 3} more` : ""}`,
    );
  }

  // pictures drawn bigger than their own pixels
  const pp = r.pastPixels;
  const ppScope = `<img>, <video>, <canvas> and tilted layers on the page, every ${fmt(r.every)}`;
  if (pp.how === "not measured")
    L.push(`  pictures drawn past their own pixels: not measured — ${pp.note}`);
  else if (!pp.list.length) L.push(`  pictures drawn past their own pixels (${ppScope}): none`);
  else {
    const shown = pp.list.slice(0, 4).map((x) => {
      const at = x.from === x.to ? fmt(x.from) : `${fmt(x.from)}–${fmt(x.to)}`;
      return x.why === "tilt"
        ? `${x.label} (under a perspective) ${at}, up to ${x.ratio} frame px per px Chrome drew`
        : `${x.src ?? x.label} ${at}, up to ${x.ratio} frame px per source px`;
    });
    L.push(
      `  pictures drawn past their own pixels (${ppScope}): ${shown.join("; ")}${pp.list.length > 4 ? `; ${pp.list.length - 4} more` : ""}`,
    );
    if (pp.list.some((x) => x.why === "tilt"))
      L.push(
        "  a layer under a CSS perspective that would cover more than the frame's area is drawn by Chrome at about the frame's area and stretched, so its text goes soft (--supersample does not change it); a tilted box no bigger than the part it shows (overflow: hidden around it) is drawn sharp",
      );
  }

  // moves that turn back
  const tb = r.turns;
  if (tb.how === "not measured")
    L.push("  moves that turn back: not measured (a draft does not probe its frames)");
  else if (!tb.list.length)
    L.push(
      "  moves of the picture where what it ends up framing heads the wrong way first, or past its place and back: none",
    );
  else {
    const shown = tb.list.slice(0, 4).map((x) => {
      const way = x.axis === "x" ? "across" : "up or down";
      return `${fmt(x.from)}–${fmt(x.to)} ${x.kind === "back" ? "the wrong way first" : "past its place and back"}, ${x.px} px ${way} (at ${fmt(x.at)})`;
    });
    L.push(
      `  moves of the picture where what it ends up framing does not head straight there: ${shown.join("; ")}${tb.list.length > 4 ? `; ${tb.list.length - 4} more` : ""}. A view whose centre and zoom move apart, or that is kept inside the page every frame rather than once per move, bends this way; kit/camera.js moves straight`,
    );
  }

  // live text under a pixel a frame
  const s = r.slowText;
  const drawn = r.draft
    ? ` (counted as a master draws it: full size, ${r.slowFps} fps)`
    : r.density === 1
      ? ""
      : ` (this render draws ${r.density} device px per px)`;
  if (s.how === "not measured") L.push(`  slowly moving live text: not measured — ${s.note}`);
  else if (!s.spans.length)
    L.push(`  live text moving under a device pixel a frame for a second or more: none${drawn}`);
  else {
    const shown = s.spans.slice(0, 3).map((x) => {
      const covered = r.fine.reduce(
        (a, f) => a + Math.max(0, Math.min(f.to, x.to) - Math.max(f.from, x.from)),
        0,
      );
      const share = covered / Math.max(1e-6, x.to - x.from);
      const finer = share >= 0.9 ? r.fineSupersample : 1;
      const every = 1 / (x.speed * r.density * finer);
      const how =
        share >= 0.9
          ? `, drawn at ${r.fineSupersample}×`
          : share > 0.05
            ? `, drawn at ${r.fineSupersample}× for ${Math.round(share * 100)}% of it`
            : "";
      return `${fmt(x.from)}–${fmt(x.to)} ${x.speed} px a frame, the fastest piece ${x.fastest} (at the median, a step about every ${every < 10 ? every.toFixed(1) : Math.round(every)} frames${how})`;
    });
    L.push(
      `  live text moving under a device pixel a frame${drawn}: ${shown.join("; ")}${s.spans.length > 3 ? `; ${s.spans.length - 3} more` : ""}. Chrome draws glyphs on whole device pixels, so such text can move in steps (measured here: where the text is, not the picture); a render without --supersample draws the frames where text moves this slowly at ${FINE_SUPERSAMPLE}× (--supersample 1 does not), and \`film picture\` draws a saved screen as one picture that moves smoothly`,
    );
  }

  // the parts the film named
  const pa = r.parts;
  if (pa.how === "not measured")
    L.push(`  parts named through product(): not measured — ${pa.note}`);
  else if (!pa.named && !pa.uses.length)
    L.push("  parts: none named through product() (kit/media.js)");
  else if (!pa.uses.length)
    L.push(
      `  parts named through product(): ${pa.named}, none used by the camera, the cursor or mark() on the film's clock`,
    );
  else {
    L.push(
      `  parts the film named (through product(); times on the film's clock)${pa.note ? ` — ${pa.note}` : ""}:`,
    );
    for (const u of pa.uses.slice(0, PART_LINES)) L.push(`    ${partLine(u)}`);
    if (pa.uses.length > PART_LINES) L.push(`    … ${pa.uses.length - PART_LINES} more use(s)`);
  }

  // the boundaries, and what crossed each
  const sm = r.seams;
  if (!sm) {
    // a report made before boundaries were read
  } else if (sm.how === "not measured") L.push(`  boundaries: not measured — ${sm.note}`);
  else if (!sm.list.length)
    L.push(
      "  boundaries: none — the beat sheet has no segment ending inside the film (kit/time.js `tl.segment`)",
    );
  else {
    const count = (k: string) => sm.list.filter((b) => b.how.kind === k).length;
    const tally = ["carried", "anchored", "bare", "cut", "words", "unwritten", "not rendered"]
      .map((k) => [k, count(k)] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    L.push(
      `  boundaries (segment ends; a segment's \`carry\` followed from 1 s before to 0.4 s after — carried: still there 0.25 s past it, or grown to fill the frame, and moved or resized; anchored: there unchanged, or only fading out across it; bare: gone by then): ${tally}${sm.strip ? `; each one as a row (−0.3 s, the boundary, +0.3 s): ${sm.strip}` : ""}${sm.note ? ` (${sm.note})` : ""}`,
    );
    for (const b of sm.list.slice(0, BOUNDARY_LINES)) {
      const said = b.handoff ? ` "${b.handoff}"` : "";
      const what = b.carry ? ` ${b.carry}` : "";
      const h = b.how;
      const line = h.measured
        ? `${h.kind}${carryChange(b) ? ` (${carryChange(b)})` : ""}${h.note ? ` — ${h.note}` : ""}`
        : h.kind === "cut"
          ? "a hard cut, on purpose"
          : h.kind === "words"
            ? "nothing named to follow (`carry`)"
            : h.kind === "unwritten"
              ? "nothing written"
              : "outside what was rendered";
      L.push(`    ${fmt(b.at)}${said}${what}: ${line}`);
    }
    if (sm.list.length > BOUNDARY_LINES)
      L.push(`    … ${sm.list.length - BOUNDARY_LINES} more boundary(ies)`);
    // the same change at every carried boundary is easy to miss from inside
    const carried = sm.list.filter((b) => b.how.measured && b.how.kind === "carried");
    const filled = carried.filter((b) => b.how.measured && b.how.fill >= CARRY_FILL).length;
    if (carried.length >= 2 && filled >= 2)
      L.push(`    ${filled} of the ${carried.length} carried thing(s) grew to fill the frame`);
  }

  // the picture against the sound
  const ag = r.against;
  if (!ag) {
    // a report made before the picture was set against the sound
  } else if (ag.how === "not measured")
    L.push(`  picture against sound: not measured — ${ag.note}`);
  else
    L.push(
      `  picture against sound (half seconds; one above this film's median, the other below, reaching its top and bottom thirds): ${
        ag.list.length
          ? [...ag.list]
              .sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from)
              .slice(0, AGAINST_LINES)
              .sort((a, b) => a.from - b.from)
              .map(
                (x) =>
                  `${fmt(x.from)}–${fmt(x.to)} ${x.kind === "busy-quiet" ? "the picture busy while the sound is quiet" : "the picture still while the sound is loud"}`,
              )
              .join("; ") +
            (
              ag.list.length > AGAINST_LINES
                ? `; ${ag.list.length - AGAINST_LINES} shorter one(s) — \`film listen\` lays them all out`
                : ""
            )
          : "nowhere"
      }`,
    );

  // the sound on its own
  const so = r.sound;
  if (so?.how === "not measured") L.push(`  sound: not measured — ${so.note}`);
  else if (so) {
    L.push(
      `  sound, where several things change at once (against the 3 s before; sharpest first): ${
        !so.changes
          ? "too short to set 3 s either side of a moment against each other"
          : so.changes.length
            ? so.changes
                .map(
                  (c) =>
                    `${fmt(c.t)} ${c.parts.join(", ")} — ${c.leadIn ?? "nothing leads into it"}`,
                )
                .join("; ")
            : "nowhere stands out"
      } (${so.changes ? "estimated" : "not measured"})`,
    );
    const reg = so.tuning.registers.filter((x) => x.frames >= 20);
    if (so.tuning.reference != null && reg.length)
      L.push(
        `  sound, in tune: ${reg.map((x) => `${x.name} register ${Math.round(x.inTune * 100)}% of its pitched frames within 15 cents of the piece's tuning`).join(", ")} (estimated)`,
      );
  }

  L.push(
    `full report (text in pictures, camera, sound, beat sheet): ${o.probe} — measured in ${(r.ms / 1000).toFixed(1)} s; --no-report leaves this out`,
  );
  return L;
}

/** uses of parts listed at most, one line each */
const PART_LINES = 8;
/** the sound's sharpest changes listed at the end of a render */
const SOUND_CHANGES = 3;
/** boundaries listed at most, one line each */
const BOUNDARY_LINES = 12;
/** stretches where picture and sound run opposite, listed at most (the longest) */
const AGAINST_LINES = 5;

const USED: Record<string, string> = {
  frame: "framed",
  cut: "cut to",
  click: "clicked",
  move: "moved to",
  type: "typed into",
  drag: "dragged",
  mark: "named",
};

/** one use of a part: who, what, when, then the facts at its times */
function partLine(u: ReportPartUse): string {
  const who = [u.name !== u.ref ? u.name : "", u.ref].filter(Boolean).join(" ");
  const what = `${USED[u.use] ?? u.use}${u.label ? ` (${JSON.stringify(u.label)})` : ""}`;
  const when = u.end !== undefined && u.end !== u.t ? `${fmt(u.t)}–${fmt(u.end)}` : fmt(u.t);
  // at which time, when the use has more than one
  const at = (t: number) => (u.seen.length > 1 ? ` at ${fmt(t)}` : "");
  const facts: string[] = [];
  const off = u.seen.find((x) => !x.shown);
  if (off) {
    const on =
      off.on.length > 4
        ? `${off.on.slice(0, 3).join(", ")}, … ${off.on.length - 3} more`
        : off.on.join(", ");
    facts.push(
      `not on the screen shown then${off.showing ? ` (${off.showing})` : ""}${at(off.t)}; it is on ${on || "no screen"}`,
    );
  }
  if (u.seen.length) {
    const worst = [...u.seen].sort((a, b) => a.inFrame - b.inFrame)[0]!;
    if (worst.inFrame >= 1) facts.push("in frame");
    else if (worst.inFrame <= 0) facts.push(`outside the frame${at(worst.t)}`);
    else facts.push(`off the frame's ${worst.edge} edge ${pct(1 - worst.inFrame)}${at(worst.t)}`);
    const read = u.seen.filter((x) => x.covered);
    const cover = (x: ReportPartSeen) => (x.covered ?? []).reduce((a, c) => a + c.share, 0);
    const most = [...read].sort((a, b) => cover(b) - cover(a))[0];
    if (!read.length) facts.push("what covers it not read");
    else if (most && cover(most) > 0) {
      const by = most.covered!;
      facts.push(
        `${pct(cover(most))} covered by ${by
          .slice(0, 2)
          .map((c) => c.what)
          .join(", ")}${by.length > 2 ? `, ${by.length - 2} more` : ""}${at(most.t)}`,
      );
    }
    const dense = u.seen
      .filter((x) => x.sourcePx !== undefined)
      .sort((a, b) => b.sourcePx! - a.sourcePx!)[0];
    if (dense) {
      const of = dense.drawn === "recording" ? "recording" : "still";
      facts.push(
        `drawn from ${of === "still" ? "a still" : "the recording"} at ${dense.sourcePx!.toFixed(1)} frame px per ${of} px${at(dense.t)}`,
      );
    }
  }
  if (u.note) facts.push(u.note);
  if (!facts.length) facts.push("not read");
  return `${who} ${what} ${when}: ${facts.join("; ")}`;
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
