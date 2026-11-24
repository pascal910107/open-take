// `open-take film study`: a reference pack for a film already made. Read the
// picture once on its native clock, giving the probe a grey copy and keeping
// colour frames for shot stills and candidate strips. Set the shot table
// beside the sound of the mix, with the reading's status written down.
// The frames let someone check the boundaries and read the story, materials
// and intentions that the measurements cannot see.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { resolveFfmpeg, resolveFfprobe, runTool } from "../ffmpeg";
import { type BeatsHow, LISTEN_RATE, median } from "./beats";
import { cameraRuns } from "./probe";
import { type DeclaredBoundary, type Declarations, type DeclarationsSkipped, readDeclarations } from "./study-declared";
import {
  type AcrossKind,
  analyzeStudyPicture,
  boundaryMotion,
  cameraReadings,
  KEPT_WIDTH,
  keptInPlace,
  motionShares,
  motionStates,
  stateSteps,
  type Step,
  type PictureCandidate,
  type StudyFrames,
  studyTime,
} from "./study-picture";
import {
  analyzeStudySound,
  eventTimes,
  shuffledNull,
  SOUND_KINDS,
  soundOffsets,
  type SoundKind,
} from "./study-sound";

type Mark<T> = { value: T; how: BeatsHow };
function mark<T>(value: T, how: BeatsHow = "measured"): Mark<T> {
  return { value, how: value == null ? "not detected" : how };
}
const estimate = <T>(value: T) => mark(value, "estimated");

function estimatedFields<T extends object>(fields: T): { [K in keyof T]: Mark<T[K]> } {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, estimate(v)])) as {
    [K in keyof T]: Mark<T[K]>;
  };
}

const round = (n: number, places = 6) => Number(n.toFixed(places));
const frameFile = "native-%09d.jpg"; // image2 needs a zero-based sequence
const stripName = (index: number, time: number) =>
  `${String(index).padStart(3, "0")}-${time.toFixed(3)}.jpg`;
const shotStill = (index: number) => `shots/${String(index).padStart(3, "0")}.jpg`;
const sides = { before: 3, after: 5 }; // a look at both sides of a whip or jump

type Identity = {
  file: string;
  bytes: number;
  width: number;
  height: number;
  duration: number;
  sha256: string;
  audioPresent: boolean;
  timingMeasured: boolean;
  endMeasured?: boolean;
  durationMeasured?: boolean;
  fpsMeasured?: boolean;
};

function soundReading(pcm: Float32Array | null, duration: number, t0: number, lengths: number[],
  start: number, frameS: number) {
  const sound = pcm?.length ? analyzeStudySound(pcm, duration, t0) : null;
  const events = sound?.events.map((e) => ({
    kind: estimate(e.kind),
    time: estimate(round(e.time)),
    changeDb: estimate(e.changeDb == null ? null : round(e.changeDb, 2)),
    // what the change is read against: the sub before it, or the mix where no sub was
    changeAgainst: estimate(e.changeDb == null ? null : (e.against ?? "sub")),
  })) ?? [];
  const alignment = SOUND_KINDS.map((kind) => {
    const n = shuffledNull(lengths, eventTimes(sound, kind), frameS, { start });
    return {
      kind: mark(kind),
      realShare: estimate(n?.realShare ?? null),
      nullMean: estimate(n?.nullMean ?? null),
      nullP95: estimate(n?.nullP95 ?? null),
      p: estimate(n?.p ?? null),
      uniformShare: estimate(n?.uniformShare ?? null),
      windowS: mark(n?.windowS ?? null),
      shuffles: mark(n?.shuffles ?? null),
      seed: mark(n?.seed ?? null),
      // A per-event upper-tail test at the usual five percent level.
      reading: estimate(n ? n.p <= 0.05 && n.realShare > n.nullMean
        ? "above the shuffled chance range"
        : "no better than chance on this test" : null),
    };
  });
  return {
    sound,
    report: {
      bedShare: mark(sound?.bedShare ?? null),
      bedSpreadDb: mark(sound?.bedSpreadDb ?? null),
      subShare: estimate(sound?.subShare ?? null),
      subRelativeDb: estimate(sound?.subRelativeDb ?? null),
      bpm: estimate(sound?.bpm ?? null),
      events,
      gaps: sound?.gaps.map(estimatedFields) ?? [],
      sections: sound?.sections.map(estimatedFields) ?? [],
      changes: sound?.changes.map((c) => ({
        time: estimate(c.t), size: estimate(c.size), parts: c.parts.map(estimate), leadIn: estimate(c.leadIn),
      })) ?? [],
      alignment,
    },
  };
}

/** what the page wrote about a boundary, and what its render measured of the carry */
function declaredReading(d: DeclaredBoundary) {
  return {
    time: mark(round(d.at)),
    as: mark(d.labels.join("; ") || d.kinds.join(", ") || null),
    handoff: mark(d.handoff ?? null),
    carry: mark(d.carry ?? null),
    carried: mark(d.carried?.kind ?? null),
    change: mark(d.carried ? d.carried.change || d.carried.note || null : null),
  };
}

function candidateReading(g: StudyFrames, c: PictureCandidate, index: number, clock: "measured" | "estimated",
  kept: number | null) {
  const time = studyTime(g, c.frame);
  // a cut the grey copy saw nothing cross, with a small part seen staying put
  const across: AcrossKind | null = kept && c.across && c.across !== "carried" ? "small part kept" : c.across;
  const lo = Math.max(0, c.frame - sides.before);
  const hi = Math.min(g.count - 1, c.frame + sides.after);
  return {
    index: mark(index),
    frame: mark(c.frame),
    time: mark(round(time), clock),
    verified: estimate(c.verified),
    verdict: mark(c.verdict, c.verdict === "unresolved" ? "not detected" : "estimated"),
    across: estimate(across),
    nominations: c.nominations.map(({ source, frame, from, to }) => ({
      source: mark(source), frame: mark(frame), from: mark(from), to: mark(to),
    })),
    evidence: {
      previousFrame: mark(c.frame - 1),
      change: mark(round(c.energy)),
      nearbyChange: mark(round(c.nearbyEnergy)),
      changedBlocks: mark(round(c.changed)),
      alignedSupport: estimate(c.fit ? round(c.fit.support) : null),
      alignedResidual: estimate(c.fit ? round(c.fit.error) : null),
      scale: estimate(c.fit ? round(c.fit.s) : null),
      keptInPlace: estimate(kept == null ? null : round(kept, 4)),
    },
    strip: mark(`strips/${stripName(index, time)}`),
    stripFrames: Array.from({ length: hi - lo + 1 }, (_, k) => ({
      frame: mark(lo + k), time: mark(round(studyTime(g, lo + k)), clock),
    })),
  };
}

/** The reference pack as data. Frame ranges are zero-based and end-exclusive.
 *  Times may be native PTS; the end of the picture is supplied separately. */
export function analyzeStudy(
  g: StudyFrames,
  identity: Identity,
  pictureEnd: number,
  pcm: Float32Array | null = null,
  soundStart = 0,
  /** `declared`: what the film's own events file says of its boundaries.
   *  `keptAt`: for a cut at this frame, the share of the picture seen staying
   *  put on a finer copy (keptInPlace), or null where it was not read. */
  also: {
    declared?: Declarations | DeclarationsSkipped | null;
    keptAt?: (frame: number) => number | null;
  } = {},
) {
  const { candidates, steps, means } = analyzeStudyPicture(g);
  const cuts = candidates.filter((c) => c.verified);
  const edges = [0, ...cuts.map((c) => c.frame), g.count];
  const clock = identity.timingMeasured ? "measured" : "estimated";
  const endClock = identity.endMeasured === false ? "estimated" : clock;
  const edgeTime = (f: number) => f === g.count ? pictureEnd : studyTime(g, f);
  const lengths = edges.slice(1).map((edge, i) => edgeTime(edge) - edgeTime(edges[i]!));
  // Step i compares frames i − 1 and i: it took the time between them. A
  // frame held long on a variable-rate film is a long step of no motion,
  // not more of the move before it.
  const durations = steps.map((_, i) => i > 0 ? edgeTime(i) - edgeTime(i - 1) : edgeTime(1) - edgeTime(0));
  // Millisecond containers round the native interval. Allow that rounding
  // when checking cadence, and keep the actual PTS in the shot table.
  const intervals = durations.slice(1);
  const cadence = identity.timingMeasured && intervals.length >= 2
    ? intervals.every((dt) => Math.abs(dt - intervals[0]!) <= 0.001001)
    : null;
  const frameSeconds = intervals.length ? median(intervals) || 1 / g.fps : 1 / g.fps;
  const { sound, report } = soundReading(pcm, identity.duration, soundStart, lengths, edgeTime(0), 1 / g.fps);
  const cutFrames = new Set(cuts.map((c) => c.frame));
  // each shot's steps over a thirtieth of a second or more: its travel, drift
  // and hold, and the camera's path on a film faster than 30 fps
  const spanned = edges.slice(0, -1).map((from, i) => stateSteps(g, steps, from, edges[i + 1]!, frameSeconds));
  const spans = new Map<number, { step: Step; seconds: number }>();
  spanned.forEach((span, i) => {
    span.steps.forEach((step, k) => {
      if (span.seconds[k]! > frameSeconds * 1.5) spans.set(edges[i]! + 1 + k, { step, seconds: span.seconds[k]! });
    });
  });
  const runs = cameraRuns(cameraReadings(g, steps, cutFrames, spans), g.fps);
  const table = candidates.map((c, i) => candidateReading(g, c, i + 1, clock,
    c.verified && c.across !== "carried" ? also.keptAt?.(c.frame) ?? null : null));
  const byFrame = new Map(table.map((c) => [c.frame.value, c]));
  // The page's declarations against the picture's cuts: a declared boundary
  // within a frame and a half of a cut is that cut (film probe's window);
  // one with no cut there keeps the reading of a candidate at that frame.
  // declared times are the page's, from 0; the picture's clock may start later
  const declarations = also.declared && "boundaries" in also.declared
    ? { file: also.declared.file, boundaries: also.declared.boundaries.map((d) => ({ ...d, at: d.at + edgeTime(0) })) }
    : null;
  const near = 1.5 * frameSeconds;
  const nearest = <T>(list: readonly T[], time: (v: T) => number, t: number) => {
    const best = list.reduce<T | null>((b, v) =>
      Math.abs(time(v) - t) < (b == null ? Infinity : Math.abs(time(b) - t)) ? v : b, null);
    return best != null && Math.abs(time(best) - t) <= near ? best : null;
  };
  const declaredAt = (t: number) => nearest(declarations?.boundaries ?? [], (d) => d.at, t);
  const detected = (c: (typeof table)[number]) => ({
    candidate: c.index, verdict: c.verdict, whatMovesAcross: c.across, strip: c.strip,
  });
  const boundaryList = [
    ...cuts.map((c) => {
      const d = declaredAt(studyTime(g, c.frame));
      return {
        time: mark(round(studyTime(g, c.frame)), clock),
        source: mark(d ? "both" as const : "detected" as const),
        declared: d ? declaredReading(d) : mark(null),
        detected: detected(byFrame.get(c.frame)!),
      };
    }),
    ...(declarations?.boundaries ?? [])
      .filter((d) => !nearest(cuts, (c) => studyTime(g, c.frame), d.at))
      .map((d) => {
        const c = nearest(table, (v) => v.time.value, d.at);
        return {
          time: mark(round(d.at)),
          source: mark("declared" as const),
          declared: declaredReading(d),
          detected: c ? detected(c) : mark(null),
        };
      }),
  ].sort((a, b) => a.time.value - b.time.value);
  const frameStates: ReturnType<typeof motionStates> = [];
  const motionSeconds: number[] = [];
  const motionRuns: {
    state: Mark<string>;
    from: Mark<number>;
    to: Mark<number>;
    seconds: Mark<number>;
  }[] = [];
  const readShares = (share: ReturnType<typeof motionShares>) => ({
    travel: estimate(share?.travel ?? null),
    drift: estimate(share?.drift ?? null),
    hold: estimate(share?.hold ?? null),
    sampledSeconds: mark(share ? round(share.seconds) : 0, endClock),
  });
  const shots = edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1]!;
    const a = edgeTime(from);
    const b = edgeTime(to);
    const seconds = durations.slice(from + 1, to);
    const span = spanned[i]!;
    const states = motionStates(span.steps, g.w, seconds, span.seconds);
    // one by one: a shot of hours has more steps than a call takes arguments
    for (const v of states) frameStates.push(v);
    for (const v of seconds) motionSeconds.push(v);
    // Keep the display frame convention at constant cadence. On a
    // variable-rate film the run covers the intervals the steps measured.
    const motionEdge = (k: number) => edgeTime(from + k + (cadence === false ? 0 : 1));
    for (let k = 0; k < states.length;) {
      let end = k + 1;
      while (end < states.length && states[end] === states[k]) end++;
      // Shorter stretches are in the shares. Half a second reads as a run
      // on the launch reel motion tables.
      const startTime = motionEdge(k);
      const atPictureEnd = from + 1 + end === g.count;
      const endTime = atPictureEnd ? edgeTime(g.count) : motionEdge(end);
      if (endTime - startTime >= 0.5) motionRuns.push({
        state: estimate(states[k]!),
        from: mark(round(startTime), clock),
        to: mark(round(endTime), atPictureEnd ? endClock : clock),
        seconds: mark(round(endTime - startTime), atPictureEnd ? endClock : clock),
      });
      k = end;
    }
    const share = motionShares(states, seconds);
    const dominant = runs.reduce<{ label: string; length: number } | null>((best, r) => {
      const length = Math.min(r.end, b) - Math.max(r.start, a);
      return length > (best?.length ?? 0) ? { label: `${r.what} ${r.dir}`, length } : best;
    }, null);
    const c = cuts[i];
    const evidence = c && byFrame.get(c.frame);
    const boundary = c && evidence ? (() => {
      const m = boundaryMotion(g, steps, c, from, edges[i + 2]!);
      const s = soundOffsets(sound, b);
      const nearestByKind = Object.fromEntries(SOUND_KINDS.map((k) => [k, estimate(s.byKind[k])])) as
        Record<SoundKind, Mark<number | null>>;
      const d = declaredAt(b);
      // The thing the page named, followed across by its render, is a
      // measurement of that one thing; the picture's own reading stays beside it.
      const crossed = d?.carried && d.carried.kind !== "bare";
      return {
        candidate: evidence.index,
        kind: estimate("picture_cut" as const),
        source: mark(d ? "both" as const : "detected" as const),
        declared: d ? declaredReading(d) : mark(null),
        verdict: evidence.verdict,
        whatMovesAcross: crossed ? mark<AcrossKind | null>("carried") : evidence.across,
        pictureReading: evidence.across,
        before: m.before ? estimatedFields(m.before) : mark(null),
        after: m.after ? estimatedFields(m.after) : mark(null),
        directionContinues: estimate(m.continues),
        atPeakSpeed: estimate(m.atPeak),
        scaleStep: estimate(m.scale == null ? null : round(m.scale)),
        sound: {
          nearest: estimate(s.event?.kind ?? null),
          time: estimate(s.event ? round(s.event.time) : null),
          offset: estimate(s.offset == null ? null : round(s.offset)),
          nearestByKind,
        },
        strip: evidence.strip,
      };
    })() : mark(null);
    return {
      index: mark(i + 1),
      fromFrame: mark(from),
      toFrame: mark(to),
      from: mark(round(a), clock),
      to: mark(round(b), to === g.count ? endClock : clock),
      length: mark(round(b - a), to === g.count ? endClock : clock),
      frames: mark(to - from),
      picture: {
        middleFrame: mark(Math.floor((from + to - 1) / 2)),
        medianGrey: mark(round(median(Array.from(means.subarray(from, to))))),
        still: mark(shotStill(i + 1)),
      },
      camera: {
        ...readShares(share),
        dominantMove: estimate(dominant?.label ?? (share?.hold === 1 ? "hold" : null)),
      },
      boundaryOut: boundary,
    };
  });
  return {
    version: mark(1),
    identity: {
      file: mark(identity.file),
      bytes: mark(identity.bytes),
      width: mark(identity.width),
      height: mark(identity.height),
      fps: mark(g.fps, identity.fpsMeasured === false ? "estimated" : "measured"),
      frames: mark(g.count),
      duration: mark(identity.duration, identity.durationMeasured ? "measured" : endClock),
      pictureStart: mark(round(edgeTime(0)), clock),
      pictureEnd: mark(round(pictureEnd), endClock),
      constantCadence: mark(cadence),
      sha256: mark(identity.sha256),
      audioPresent: mark(identity.audioPresent),
    },
    picture: {
      candidates: mark(candidates.length),
      verified: estimate(cuts.length),
      shares: readShares(motionShares(frameStates, motionSeconds)),
      runs: runs.map(estimatedFields),
      motionRuns,
    },
    sound: report,
    boundaries: {
      eventsFile: mark(declarations?.file ?? null),
      unread: mark(also.declared && "skipped" in also.declared
        ? `${also.declared.file}: ${also.declared.skipped}` : null),
      list: boundaryList,
    },
    shots,
    candidates: table,
  };
}

export type FilmStudy = ReturnType<typeof analyzeStudy>;

const show = <T>(v: Mark<T>, fmt: (value: NonNullable<T>) => string = String) =>
  v.value == null ? "[not detected]" : `${fmt(v.value!)} [${v.how}]`;
const cell = <T>(v: Mark<T>, how: BeatsHow, fmt: (value: NonNullable<T>) => string = String) =>
  v.how === how && v.value != null ? fmt(v.value!) : show(v, fmt);
const estimated = <T>(v: Mark<T>, fmt?: (value: NonNullable<T>) => string) =>
  cell(v, "estimated", fmt);
const reading = <T>(name: string, v: Mark<T>, fmt: (value: NonNullable<T>) => string = String) =>
  `- [${v.how}] ${name}${v.value == null ? "" : ` — ${fmt(v.value!)}`}`;
const secs = (v: number) => `${v.toFixed(3)} s`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const db = (v: number) => `${v.toFixed(1)} dB`;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 1000).toFixed(1)} ms`;
const sharesText = (
  s: FilmStudy["picture"]["shares"],
  format = (v: Mark<number | null>) => show(v, pct),
) => `${format(s.travel)} travel, ${format(s.drift)} drift, ${format(s.hold)} hold`;
const escapeCell = (s: string) => s.replace(/[\\|`\n\r]/g, (c) => c === "\n" || c === "\r" ? " " : `\\${c}`);

type Boundary = Exclude<FilmStudy["shots"][number]["boundaryOut"], Mark<null>>;

// The reading is of what was seen on a small copy, and says so on the page.
const acrossWords = (v: string) => v === "nothing carried" ? "nothing seen carried" : v;
const carriedBy = (d: ReturnType<typeof declaredReading>) => d.carried.value == null ? ""
  : `${escapeCell(d.carry.value ?? "the thing named")} ${d.carried.value === "bare" ? "not across" : d.carried.value}${
    d.change.value ? ` (${escapeCell(d.change.value)})` : ""}`;

function describeBoundary(b: Boundary) {
  const side = (s: Boundary["before"]) => "dir" in s
    ? `${estimated(s.dir)} at ${estimated(s.pxPerSecond, (v) => `${v.toFixed(2)} px/s`)}`
    : estimated(s);
  const direction = b.directionContinues.value == null ? "" : ` · direction continues ${estimated(b.directionContinues)}`;
  const peak = b.atPeakSpeed.value == null ? "" : ` · peak at boundary ${estimated(b.atPeakSpeed)}`;
  // what the page declared here and what its render measured, before the picture's reading
  const declared = "as" in b.declared
    ? `declared${b.declared.as.value ?? b.declared.handoff.value
      ? ` “${escapeCell((b.declared.as.value ?? b.declared.handoff.value)!)}”` : ""}${
      b.declared.carried.value ? `, the render followed ${carriedBy(b.declared)}` : ""} [measured] · picture: `
    : "";
  return `${declared}[${estimated(b.verdict)}](${b.strip.value}) · ${estimated(b.pictureReading, acrossWords)} · ${side(b.before)} → ${side(b.after)}${direction}${peak} · scale ${estimated(b.scaleStep, (v) => `${v.toFixed(2)}×`)}`;
}

export function formatStudyMarkdown(study: FilmStudy): string {
  const id = study.identity;
  const s = study.sound;
  const motion = study.picture.shares;
  const l = [
    "# Film study", "",
    "## Identity & provenance", "",
    reading("File", id.file, (v) => `\`${escapeCell(v)}\``),
    `- [measured] Encoded size — ${id.width.value} × ${id.height.value} px, ${id.bytes.value} bytes`,
    reading("Frame count", id.frames),
    reading("Frame rate", id.fps, (v) => `${v.toFixed(3)} fps`),
    reading("Duration", id.duration, secs),
    reading("Picture start", id.pictureStart, secs),
    reading("Picture end", id.pictureEnd, secs),
    reading("SHA-256", id.sha256, (v) => `\`${v}\``), "",
    "## Brand Kit", "",
    "- [not detected] Logo, type, colour and voice: read them in the frames and the shot stills.", "",
    "## Narrative grammar", "",
    "### Story & timing", "",
    "The rows follow boundaries read from adjacent frames. Each still shows the middle frame of its shot. Follow the boundary link for the consecutive frames around it.", "",
    "| Time [measured] | Shot [measured] | Picture [measured] | Camera [estimated] | Boundary out [estimated] | Sound at boundary [estimated] |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const shot of study.shots) {
    const b = shot.boundaryOut;
    const boundary = "verdict" in b ? describeBoundary(b) : "End of picture";
    const sound = "sound" in b && b.sound.nearest.value != null
      ? `${estimated(b.sound.nearest)} ${estimated(b.sound.offset, signed)}` : "[not detected]";
    const camera = shot.camera.travel.value == null ? "[not detected]"
      : `${sharesText(shot.camera, (v) => estimated(v, pct))} · ${estimated(shot.camera.dominantMove)}`;
    const time = shot.from.how === shot.to.how
      ? cell(mark(`${secs(shot.from.value)}–${secs(shot.to.value)}`, shot.from.how), "measured")
      : `${cell(shot.from, "measured", secs)}–${cell(shot.to, "measured", secs)}`;
    l.push(`| ${time} | ${cell(shot.index, "measured")} | [Still](${shot.picture.still.value}) | ${camera} | ${boundary} | ${sound} |`);
  }
  const bs = study.boundaries;
  l.push("", "### Declared and detected boundaries", "");
  if (bs.eventsFile.value == null) {
    l.push(bs.unread.value == null
      ? "- [not detected] The film's own declarations: no events file beside it, so every boundary here is read from the picture alone."
      : `- [not detected] The film's own declarations: the events file beside it was not read (${escapeCell(bs.unread.value)}).`);
  } else {
    l.push(reading("The film's own declarations", bs.eventsFile, (v) => `\`${escapeCell(v)}\``), "",
      "Both: the page declared a boundary and the picture shows a cut within a frame and a half of it. Declared: the page wrote one and the picture shows no cut there (a whip, a lift, a push through). Detected: a cut in the picture the page did not write down. The carry is the one thing the page named, followed across by its render: carried (it crossed and moved or changed size), anchored (it crossed unchanged) or not across.", "",
      "| Time [measured] | Source [measured] | Declared [measured] | Carry followed by the render [measured] | Picture reading [estimated] |",
      "| --- | --- | --- | --- | --- |");
    for (const b of bs.list) {
      const d = "as" in b.declared ? b.declared : null;
      const p = "verdict" in b.detected ? b.detected : null;
      const words = d ? [d.as.value, d.handoff.value && d.handoff.value !== d.as.value ? `handoff: ${d.handoff.value}` : null]
        .filter(Boolean).map((v) => escapeCell(v!)).join(" · ") || "a segment ends" : "—";
      const picture = p
        ? `[${estimated(p.verdict)}](${p.strip.value})${p.whatMovesAcross.value ? ` · ${estimated(p.whatMovesAcross, acrossWords)}` : ""}`
        : "no candidate at this frame";
      l.push(`| ${cell(b.time, "measured", secs)} | ${b.source.value} | ${words} | ${d && carriedBy(d) || "—"} | ${picture} |`);
    }
  }
  l.push("", "## Visual hierarchy", "",
    "- [not detected] What leads each frame, what supports it and what is background: read it in the shot stills.");
  l.push("", "## Timing & motion", "",
    motion.travel.value == null ? "- [not detected] Picture motion shares"
      : `- [estimated] Picture across the film — ${sharesText(motion, (v) => estimated(v, pct))}.`,
    reading("Time covered by within-shot steps", motion.sampledSeconds, secs), "",
    "Travel reads the whole picture’s shift and scale, or median local displacement. Drift includes changes below the travel thresholds. A hold is a picture below the change and motion floors. Closing fills holes left by repeated frames within a shot.",
    "Direction follows the picture on screen. Speeds use a common-width picture ruler.", "");
  for (const r of study.picture.runs) l.push(
    `- [estimated] ${r.what.value} ${r.dir.value}, ${secs(r.start.value)}–${secs(r.end.value)}, ${r.what.value === "zoom" ? `${r.amount.value.toFixed(3)}×` : pct(r.amount.value)}`,
  );
  if (!study.picture.runs.length) l.push("- [not detected] Camera runs");
  if (study.picture.motionRuns.length) {
    l.push("", "Longer stretches of travel, drift and hold", "",
      "| Motion [estimated] | Start [measured] | End [measured] | Length [measured] |",
      "| --- | --- | --- | --- |");
    for (const r of study.picture.motionRuns) l.push(
      `| ${estimated(r.state)} | ${cell(r.from, "measured", secs)} | ${cell(r.to, "measured", secs)} | ${cell(r.seconds, "measured", secs)} |`,
    );
  }
  l.push("", "## Materials & sound", "",
    "- [not detected] Sources of the picture’s materials",
    reading("Time above the silence floor", s.bedShare, pct),
    reading("Active level spread between deciles", s.bedSpreadDb, db),
    reading("Time with sub present", s.subShare, pct),
    reading("Sub level relative to the mix", s.subRelativeDb, db),
    reading("Tempo", s.bpm, (v) => `${v} BPM`), "",
    "### Sound structure", "");
  for (const sec of s.sections) l.push(`- [estimated] ${secs(sec.start.value)}–${secs(sec.end.value)}, ${sec.levelDb.value.toFixed(1)} dBFS, ${sec.onsetsPerS.value} onsets/s.`);
  for (const kind of SOUND_KINDS) {
    const events = s.events.filter((e) => e.kind.value === kind);
    const list = kind === "onset" || !events.length ? "" : ` at ${events.map((e) =>
      `${secs(e.time.value)}${e.changeDb.value == null ? "" : ` (${db(e.changeDb.value)}${
        e.changeAgainst?.value === "mix"
          ? kind === "sub_exit" ? " against the mix after it, no sub there" : " against the mix before it, no sub there"
          : ""})`}`).join(", ")}`;
    const name = kind.replaceAll("_", " ");
    l.push(events.length ? `- [estimated] ${name} — ${events.length}${list}.` : `- [not detected] ${name}`);
  }
  for (const gap of s.gaps) l.push(`- [estimated] ${gap.kind.value.replaceAll("_", " ")} ${secs(gap.start.value)}–${secs(gap.end.value)}, low point ${gap.deepestDb.value.toFixed(1)} ${gap.kind.value === "silence" ? "dBFS" : "dB"}.`);
  if (!s.gaps.length) l.push("- [not detected] Absolute silences and relative gaps");
  for (const c of s.changes) l.push(`- [estimated] Sound changes at ${secs(c.time.value)}. See the spectral reading in \`study.json\`.`);
  l.push("", "### Cuts against sound", "",
    "The chance test permutes the shot lengths with a fixed seed, keeping the picture’s start and end. It checks the fraction of cuts within one nominal frame of each kind of event. Shares, p values and readings are estimated.", "",
    "| Event | Cut share | Shuffled mean | Shuffled 95th percentile | Empirical p | Reading |",
    "| --- | --- | --- | --- | --- | --- |");
  for (const row of s.alignment) l.push(`| ${row.kind.value} | ${estimated(row.realShare, pct)} | ${estimated(row.nullMean, pct)} | ${estimated(row.nullP95, pct)} | ${estimated(row.p, (v) => v.toFixed(3))} | ${estimated(row.reading)} |`);
  const test = s.alignment.find((row) => row.windowS.value != null);
  if (test?.windowS.value != null)
    l.push("", `- [measured] Window ±${secs(test.windowS.value)}, ${test.shuffles.value} shuffles, seed ${test.seed.value}.`);
  l.push("", "The offsets below are estimated. A positive offset puts the sound after the cut.", "",
    "| Boundary [measured] | Onset | Hit | Sub entry | Sub exit | Drop |",
    "| --- | --- | --- | --- | --- | --- |");
  for (const shot of study.shots) {
    const b = shot.boundaryOut;
    if ("sound" in b) l.push(`| ${cell(shot.to, "measured", secs)} | ${SOUND_KINDS.map((k) => estimated(b.sound.nearestByKind[k], signed)).join(" | ")} |`);
  }
  l.push("", "## Invariants", "");
  if (id.constantCadence.value) l.push("- [measured] The native picture cadence holds across the film.");
  if (!id.audioPresent.value) l.push("- [measured] The file has no audio stream.");
  const continuousBed = s.bedShare.value != null && Math.abs(s.bedShare.value - 1) < 1e-9;
  if (continuousBed) l.push("- [measured] The sound stays over the silence floor across the film.");
  if (!id.constantCadence.value && id.audioPresent.value && !continuousBed)
    l.push("- [not detected] Film-wide invariants");
  const onsets = s.events.filter((e) => e.kind.value === "onset").map((e) => e.time.value);
  const near = test?.windowS.value ?? 1 / id.fps.value;
  const heard = id.duration.value;
  l.push("",
    "## Replaceable inputs", "",
    "- [not detected] Which footage, copy, product screens and music could be swapped for another product's: decide it from the story.", "",
    "## Review", "",
    reading("Candidate count", study.picture.candidates),
    reading("Cuts after the adjacent-frame check", study.picture.verified),
    "",
    "What this reading does not see, in any film (found by checking it frame by frame against launch reels where every boundary was known):", "",
    "1. A dissolve (one of 6 frames was missed) and a morph over about 10 frames: no single pair of frames differs enough.",
    "2. A cut hidden in blur during a 3D camera move, a white flash of 1–2 frames, and a scale jump whose two sides do not register on the 96 px grey copy: these come out unresolved, fast_move, flash_or_fade or in_picture_change, not as cuts. Read the strip of every candidate that is not a cut where you suspect one.",
    "3. Stems: voice, music and effects are not told apart; the sound is read from the mono mix.",
    onsets.length && heard > 0
      ? `4. This film has ${(onsets.length / heard).toFixed(1)} onsets a second. A time picked uniformly across the film has a ${pct(coveredShare(onsets, near, heard))} chance of lying within ±${secs(near)} of an onset. Read cut closeness beside the shuffled baseline.`
      : "4. No onsets were found, so closeness to them says nothing here.",
    "5. A small thing carried across a cut. “Carried” needs textured picture over a tenth of the frame to stay or be followed; “small part kept” needs a patch to stay exactly where it was (a pinned caption, a logo, an avatar the next scene opens on). An avatar that flies across a cut, or lands on a different ground, is read as nothing seen carried. Where the film's own events file sits beside it, the carry its page named and its render followed is shown instead.", "",
    "Look at the strips for ambiguous boundaries, colour-only changes and small carried objects. Read the story, words, depth and subjects in the film.", "",
    "| Time [measured] | Adjacent frames [measured] | Verdict [estimated] | Strip [measured] |",
    "| --- | --- | --- | --- |");
  for (const c of study.candidates) l.push(`| ${cell(c.time, "measured", secs)} | f${cell(c.evidence.previousFrame, "measured")} → f${cell(c.frame, "measured")} | ${estimated(c.verdict)} | [frames](${c.strip.value}) |`);
  return `${l.join("\n")}\n`;
}

/** the share of [0, duration) within ±window of some time */
export function coveredShare(times: readonly number[], window: number, duration: number): number {
  if (!(duration > 0)) return 0;
  let covered = 0;
  let reach = 0;
  for (const t of [...times].sort((a, b) => a - b)) {
    const a = Math.max(reach, t - window, 0);
    const b = Math.min(t + window, duration);
    if (b > a) covered += b - a;
    reach = Math.max(reach, b);
  }
  return covered / duration;
}

export function formatFilmStudy(s: FilmStudy): string {
  return [
    `picture — ${show(s.identity.frames)} frames, ${show(s.identity.duration, secs)}`,
    `boundaries — ${show(s.picture.candidates)} candidates, ${show(s.picture.verified)} cuts from adjacent frames`,
    ...(s.boundaries.eventsFile.value == null
      ? [s.boundaries.unread.value == null ? "declared — no events file beside the film; boundaries are read from the picture alone"
        : `declared — events file not read (${s.boundaries.unread.value})`]
      : [`declared — ${(["both", "declared", "detected"] as const).map((k) =>
        `${s.boundaries.list.filter((b) => b.source.value === k).length} ${k === "both" ? "declared and detected" : `${k} only`}`).join(", ")}`]),
    `motion — ${sharesText(s.picture.shares)}`,
    `sound — bed ${show(s.sound.bedShare, pct)}, sub present ${show(s.sound.subShare, pct)}`,
    ...s.sound.alignment.filter((r) => r.p.value != null).map((r) =>
      `cuts near ${r.kind.value} — ${show(r.realShare, pct)}, shuffled ${show(r.nullMean, pct)}, p ${show(r.p, (v) => v.toFixed(3))} · ${show(r.reading)}`),
  ].join("\n");
}

export type FilmStudyOptions = {
  input: string;
  /** default is <input without extension>.study/ */
  out?: string;
};

type Stream = {
  index?: number;
  codec_type: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  start_time?: string;
  sample_aspect_ratio?: string;
  disposition?: { attached_pic?: number; default?: number };
  side_data_list?: { rotation?: number }[];
};
const ratio = (s: string | undefined, divider: string) => {
  const [a, b] = (s ?? "").split(divider).map(Number);
  return a && b ? a / b : 0;
};

/** One audio stream as mono samples at LISTEN_RATE, on the stream's own
 *  clock: a gap in its timestamps is filled with silence, so what follows
 *  stays at its time instead of moving up to meet what came before. */
function decodeSound(ffmpeg: string, file: string, index = 0): Promise<Float32Array> {
  return new Promise((ok, fail) => {
    const p = spawn(ffmpeg, [
      "-v", "error", "-i", file, "-map", `0:${index}`, "-af", "aresample=async=1",
      "-ac", "1", "-ar", String(LISTEN_RATE), "-f", "f32le", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", fail);
    p.on("close", (code) => {
      if (code !== 0) return fail(new Error(`film study: ffmpeg could not decode the sound of ${file}: ${err.trim().slice(-400)}`));
      const all = Buffer.concat(chunks);
      ok(new Float32Array(all.buffer.slice(all.byteOffset, all.byteOffset + (all.length & ~3))));
    });
  });
}

async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// legible tiled frames on the contact sheet, and the copy keptInPlace reads
const thumbSize = (displayRatio: number) =>
  ({ w: KEPT_WIDTH, h: Math.max(2, Math.round(KEPT_WIDTH / displayRatio / 2) * 2) });

/** The share of the picture that stays put across the cut into `frame`, read
 *  from the two colour frames already written for the strips (their label
 *  band cropped off); null when they cannot be read. */
function keptAcross(ffmpeg: string, tmp: string, frame: number, displayRatio: number): number | null {
  const { w, h } = thumbSize(displayRatio);
  const r = spawnSync(ffmpeg, [
    "-v", "error", "-start_number", String(frame - 1), "-i", join(tmp, frameFile), "-frames:v", "2",
    "-vf", `crop=${w}:${h}:0:0,format=gray`, "-f", "rawvideo", "-",
  ], { maxBuffer: 2 * w * h + 4096 });
  if (r.status !== 0 || r.stdout.length !== 2 * w * h) return null;
  return keptInPlace(r.stdout.subarray(0, w * h), r.stdout.subarray(w * h), w, h);
}

function decodePicture(
  ffmpeg: string, input: string, tmp: string, width: number, height: number, displayRatio: number,
  fps: number, videoStart: number,
): Promise<StudyFrames> {
  const font = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Windows/Fonts/arial.ttf",
  ].find(existsSync);
  const fontArg = font ? `fontfile='${font}':` : "";
  // A small colour copy to look at, and a grey copy to measure. Both branches
  // use passthrough timing and read from the same video decoder.
  const { w: thumbW, h: thumbH } = thumbSize(displayRatio);
  // Round before splitting seconds and milliseconds so they carry together.
  const ms = "round(t*1000)";
  const label = `f%{n}  %{eif\\:floor(${ms}/1000)\\:d}.%{eif\\:mod(${ms},1000)\\:d\\:3} s`;
  const filters = "[0:V:0]showinfo=checksum=0,split[measure][strip];" +
    `[measure]scale=${width}:${height}:flags=area,format=gray[gray];` +
    `[strip]scale=${thumbW}:${thumbH}:flags=area,setsar=1,pad=iw:ih+24:0:0:color=0x181818,` +
    `drawtext=${fontArg}text='${label}':fontcolor=white:fontsize=15:x=8:y=h-20[jpeg]`;
  return new Promise((ok, fail) => {
    const p = spawn(ffmpeg, [
      "-hide_banner", "-nostats", "-loglevel", "info", "-copyts", "-start_at_zero",
      "-i", input, "-filter_complex", filters,
      "-map", "[gray]", "-fps_mode", "passthrough", "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "-",
      "-map", "[jpeg]", "-fps_mode", "passthrough", "-q:v", "4", "-start_number", "0", join(tmp, frameFile),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const times: number[] = [];
    const tail: string[] = [];
    let timebase = 0;
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    createInterface({ input: p.stderr }).on("line", (line) => {
      const tb = /config in time_base: (\d+\/\d+)/.exec(line);
      if (tb) timebase = ratio(tb[1], "/");
      const pts = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(\S+)/.exec(line);
      if (pts) times[Number(pts[1])] = timebase ? Number(pts[2]) * timebase : Number(pts[3]);
      tail.push(line);
      if (tail.length > 12) tail.shift();
    });
    p.on("error", fail);
    p.on("close", (code) => {
      if (code !== 0) return fail(new Error(`film study: ffmpeg could not read ${input}\n${tail.join("\n")}`));
      const data = Buffer.concat(chunks);
      const count = data.length / (width * height);
      if (!Number.isInteger(count) || count < 1)
        return fail(new Error(`film study: ${input} has no complete decoded frame`));
      const clock = times.length === count && Array.from(times).every((t, i) =>
        Number.isFinite(t) && (i === 0 || t > times[i - 1]!)) ? times : undefined;
      ok({ w: width, h: height, count, fps, data, times: clock, t0: clock?.[0] ?? videoStart });
    });
  });
}

async function writeStrips(ffmpeg: string, tmp: string, stage: string, study: FilmStudy) {
  await mkdir(join(stage, "strips"));
  // A three-by-three sheet keeps the first three frames together above the
  // boundary. Start at the first available native frame near the ends.
  for (const c of study.candidates) {
    const n = c.stripFrames.length;
    await runTool(ffmpeg, [
      "-v", "error", "-start_number", String(c.stripFrames[0]!.frame.value),
      "-i", join(tmp, frameFile), "-frames:v", "1", "-update", "1", "-q:v", "3",
      "-vf", `tile=3x${Math.ceil(n / 3)}:nb_frames=${n}:padding=3:margin=3:color=0x222222`,
      join(stage, c.strip.value),
    ]);
  }
}

async function writeShotStills(tmp: string, stage: string, study: FilmStudy) {
  await mkdir(join(stage, "shots"));
  for (const { picture } of study.shots) {
    const frame = frameFile.replace("%09d", String(picture.middleFrame.value).padStart(9, "0"));
    await copyFile(join(tmp, frame), join(stage, picture.still.value));
  }
}

function imagePaths(study: Partial<Pick<FilmStudy, "candidates" | "shots">>): string[] {
  return [
    ...(Array.isArray(study.candidates) ? study.candidates.flatMap((c) => {
      const path = c?.strip?.value;
      return typeof path === "string" && /^strips\/\d+-\d+\.\d{3}\.jpg$/.test(path) ? [path] : [];
    }) : []),
    ...(Array.isArray(study.shots) ? study.shots.flatMap((s) => {
      const path = s?.picture?.still?.value;
      return typeof path === "string" && /^shots\/\d{3,}\.jpg$/.test(path) ? [path] : [];
    }) : []),
  ];
}

export async function filmStudy(opts: FilmStudyOptions) {
  const input = resolve(opts.input);
  const file = await stat(input).catch(() => null);
  if (!file?.isFile()) throw new Error(`film study: no file at ${input}`);
  const out = resolve(opts.out ?? `${input.replace(/\.[^./]+$/, "")}.study`);
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
  const info = JSON.parse(await runTool(ffprobe, [
    "-v", "error", "-show_entries",
    "stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,duration,start_time,sample_aspect_ratio:stream_disposition=attached_pic,default:stream_side_data=rotation:format=duration,start_time",
    "-of", "json", input,
  ])) as { streams?: Stream[]; format?: { duration?: string; start_time?: string } };
  const video = info.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  // the sound ffmpeg would play: the default audio stream, else the first;
  // its start and its samples are read from that one stream
  const sounds = info.streams?.filter((s) => s.codec_type === "audio") ?? [];
  const audio = sounds.find((s) => s.disposition?.default) ?? sounds[0];
  if (!video?.width || !video.height) throw new Error(`film study: ${input} has no picture`);
  const formatStart = Number(info.format?.start_time) || 0;
  const relativeStart = (stream?: Stream) => {
    const start = Number(stream?.start_time);
    return Number.isFinite(start) ? Math.max(0, start - formatStart) : 0;
  };
  const videoStart = relativeStart(video);
  const audioStart = relativeStart(audio);
  const metadataFps = ratio(video.avg_frame_rate, "/") || ratio(video.r_frame_rate, "/");
  const fps = metadataFps || 30; // only when the container names neither rate
  const aspect = video.width / video.height * (ratio(video.sample_aspect_ratio, ":") || 1);
  const rotation = video.side_data_list?.find((s) => s.rotation != null)?.rotation ?? 0;
  const displayRatio = Math.abs(rotation) % 180 === 90 ? 1 / aspect : aspect;
  // A 96 px-wide grey copy keeps registration practical at native cadence.
  // For a tall picture the longer edge uses the same pixel budget.
  const greyW = Math.max(16, Math.round(Math.min(96, 96 * displayRatio) / 8) * 8);
  const greyH = Math.max(16, Math.round(Math.min(96, 96 / displayRatio) / 8) * 8);
  await mkdir(out, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), "open-take-study-"));
  let stage: string | undefined;
  try {
    const readings = await Promise.allSettled([
      decodePicture(ffmpeg, input, tmp, greyW, greyH, displayRatio, fps, videoStart),
      audio ? decodeSound(ffmpeg, input, audio.index) : Promise.resolve(null),
      sha256(input),
    ] as const);
    const [g, pcm, sha] = readings.map((r) => {
      if (r.status === "rejected") throw r.reason;
      return r.value;
    }) as [StudyFrames, Float32Array | null, string];
    const last = studyTime(g, g.count - 1);
    const namedEnd = g.t0! + (Number(video.duration) || 0);
    const containerEnd = Number(info.format?.duration) || 0;
    // the last frame shows for a usual frame's time, not for the gap before
    // it, which on a variable-rate file can be a held second
    const lastStep = g.count > 1
      ? median(Array.from({ length: g.count - 1 }, (_, i) => studyTime(g, i + 1) - studyTime(g, i)))
      : 1 / fps;
    const pictureEnd = namedEnd > last ? namedEnd :
      !audio && containerEnd > last ? containerEnd : last + lastStep;
    const duration = Math.max(pictureEnd, containerEnd);
    const study = analyzeStudy(g, {
      file: input, bytes: file.size, width: video.width, height: video.height, duration,
      sha256: sha, audioPresent: !!audio, timingMeasured: g.times != null, fpsMeasured: !!metadataFps,
      endMeasured: namedEnd > last || (!audio && containerEnd > last),
      durationMeasured: containerEnd >= pictureEnd,
    }, pictureEnd, pcm, audioStart, {
      declared: await readDeclarations(input, pictureEnd - studyTime(g, 0), 1 / fps),
      keptAt: (frame) => keptAcross(ffmpeg, tmp, frame, displayRatio),
    });
    stage = await mkdtemp(join(out, ".study-"));
    await writeStrips(ffmpeg, tmp, stage, study);
    await writeShotStills(tmp, stage, study);
    await writeFile(join(stage, "STUDY.md"), formatStudyMarkdown(study));
    await writeFile(join(stage, "study.json"), `${JSON.stringify(study, null, 2)}\n`);
    const md = join(out, "STUDY.md");
    const json = join(out, "study.json");
    const strips = join(out, "strips");
    // Only clear files named by an earlier pack. A folder can hold the
    // author's own notes or other images beside the generated files.
    const previous = await readFile(json, "utf8").then((raw) => {
      try { return JSON.parse(raw) as Partial<Pick<FilmStudy, "candidates" | "shots">> | null; }
      catch { return undefined; }
    }, () => undefined);
    await mkdir(strips, { recursive: true });
    await mkdir(join(out, "shots"), { recursive: true });
    const nextFiles = new Set(imagePaths(study));
    for (const path of nextFiles) await rename(join(stage, path), join(out, path));
    await rename(join(stage, "STUDY.md"), md);
    await rename(join(stage, "study.json"), json);
    for (const path of imagePaths(previous ?? {}))
      if (!nextFiles.has(path)) await rm(join(out, path), { force: true });
    return { study, md, json, strips };
  } finally {
    await Promise.all([rm(tmp, { recursive: true, force: true }),
      stage ? rm(stage, { recursive: true, force: true }) : Promise.resolve()]);
  }
}
