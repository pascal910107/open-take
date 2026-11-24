// A grey picture with a known motion, and a sound bed with known band steps.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveFfmpeg, runTool } from "../src/ffmpeg";
import { analyzeStudy, coveredShare, filmStudy, formatStudyMarkdown } from "../src/film/study";
import {
  analyzeStudyPicture, keptInPlace, motionShares, motionStates, type Step, type StudyFrames,
} from "../src/film/study-picture";
import { declaredBoundaries, readDeclarations } from "../src/film/study-declared";
import type { FilmEvents } from "../src/film/render";
import { analyzeStudySound, findSubSteps, shuffledNull } from "../src/film/study-sound";
import { LISTEN_RATE } from "../src/film/beats";

function picture(scales: readonly number[], cut = Infinity): StudyFrames {
  const w = 96;
  const h = 64;
  const data = new Uint8Array(w * h * scales.length);
  const draw = (x: number, y: number, other: boolean) => other
    ? 130 + 42 * Math.cos(x * 0.34 + y * 0.23) + 36 * Math.cos(y * 0.54)
    : 112 + 28 * Math.cos(x * 0.28 + y * 0.64) + 50 * Math.sin(x * 0.45) * Math.sin(y * 0.22)
      + 40 * Math.cos(x * 0.15 - y * 0.31);
  for (const [i, scale] of scales.entries()) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = draw((x - w / 2) / scale, (y - h / 2) / scale, i >= cut);
        data[(i * h + y) * w + x] = Math.round(v);
      }
    }
  }
  return { w, h, count: scales.length, fps: 30, data };
}

test("a smooth fast zoom verifies no cuts, then a one-frame jump inside it verifies a cut", () => {
  const scales = [1, 1, 1, 1.03, 1.08, 1.16, 1.26, 1.38, 1.50, 1.60, 1.67, 1.70, 1.70, 1.70];
  const continuous = analyzeStudyPicture(picture(scales));
  assert.ok(continuous.candidates.some((c) => c.verdict === "fast_move"));
  assert.deepEqual(continuous.candidates.filter((c) => c.verified), []);

  for (const multiplier of [1.55, 1 / 1.55]) {
    const jumped = analyzeStudyPicture(picture(scales.map((s, i) => i >= 7 ? s * multiplier : s)));
    const cuts = jumped.candidates.filter((c) => c.verified);
    assert.deepEqual(cuts.map((c) => [c.frame, c.verdict]), [[7, "scale_jump"]]);
    assert.equal(cuts[0]!.across, "carried");
  }
});

test("travel, drift and hold shares close duplicate holes inside each shot", () => {
  const travel = { motion: { s: 1.008, x: 0, y: 0 }, localPx: null, energy: 0.01 };
  const pan = { ...travel, motion: { s: 1, x: 2, y: 0 } };
  const local = { ...travel, motion: null, localPx: 3 };
  const drift = { motion: { s: 1, x: 0.5, y: 0 }, localPx: null, energy: 0.003 };
  const hold = { motion: null, localPx: null, energy: 0 };
  const states = motionStates([travel, pan, local, hold, travel, pan, local,
    drift, drift, drift, drift, drift, hold, hold, hold, hold, hold], 640);
  assert.deepEqual(states, [
    ...Array(7).fill("travel"), ...Array(5).fill("drift"), ...Array(5).fill("hold"),
  ]);
  assert.deepEqual(motionShares(states, states.map(() => 1)), {
    travel: 7 / 17, drift: 5 / 17, hold: 5 / 17, seconds: 17,
  });
  assert.deepEqual(motionStates([hold, hold, hold, hold, hold], 640), Array(5).fill("hold"));
  assert.equal(motionShares([], []), null);
});

test("the closing fills holes between travel and adds none at a shot's edges", () => {
  const T = { motion: { s: 1, x: 4, y: 0 }, localPx: null, energy: 0.02 };
  const H = { motion: null, localPx: null, energy: 0 };
  assert.deepEqual(motionStates([H, T, H], 640), ["hold", "travel", "hold"]);
  assert.deepEqual(motionStates([H, H, H, T, H, H, H], 640), [...Array(3).fill("hold"), "travel", ...Array(3).fill("hold")]);
  assert.deepEqual(motionStates([T, H, T, H, H], 640), ["travel", "travel", "travel", "hold", "hold"]);
  assert.deepEqual(motionStates([T, H, T], 640, [0.04, 1, 0.04]), ["travel", "hold", "travel"]);
  const frames = [T, H, H, H, H, H, T];
  const seconds = frames.map((_, i) => (100 + (i + 3) / 60) - (100 + (i + 2) / 60));
  assert.deepEqual(motionStates(frames, 640, seconds), frames.map(() => "travel"));
});

test("one motion read at 24, 30 and 60 fps gives the same shares", () => {
  // a second of each: a pan at 90 px/s, a drift at 12 px/s, a hold
  const shares = (fps: number) => {
    const steps: Step[] = [];
    for (let i = 0; i < 3 * fps; i++) {
      const px = i < fps ? 90 / fps : i < 2 * fps ? 12 / fps : 0;
      steps.push({ motion: px ? { s: 1, x: px, y: 0 } : null, localPx: null, energy: px ? 0.004 * 30 / fps : 0 });
    }
    const seconds = steps.map(() => 1 / fps);
    return motionShares(motionStates(steps, 640, seconds), seconds)!;
  };
  for (const fps of [24, 60]) {
    const a = shares(30);
    const b = shares(fps);
    for (const k of ["travel", "drift", "hold"] as const)
      assert.ok(Math.abs(a[k] - b[k]) < 0.02, `${fps} fps ${k}: ${b[k]} against ${a[k]} at 30`);
  }
  assert.ok(Math.abs(shares(30).travel - 1 / 3) < 0.02);
});

test("a 60 fps master reads its camera and its boundaries as its 30 fps copy does", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-study-fps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ffmpeg = await resolveFfmpeg();
  const still = join(dir, "still.png");
  await runTool(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "mandelbrot=s=1920x1080:end_pts=1:start_scale=1.5",
    "-frames:v", "1", "-y", still]);
  // a gentle zoom out, 1.12× to 1× eased over a second, between half-second holds:
  // a 60 fps frame moves too little to read on the grey copy, a 30 fps one does not
  const z = "if(lt(it,0.5),1.12,if(gt(it,1.5),1,1.12-0.12*(it-0.5)*(it-0.5)*(3-2*(it-0.5))))";
  const read = async (fps: number) => {
    const film = join(dir, `zoom${fps}.mp4`);
    await runTool(ffmpeg, ["-v", "error", "-loop", "1", "-i", still, "-vf",
      `fps=${fps},zoompan=z='${z}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=960x540:fps=${fps}`,
      "-t", "2.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-y", film]);
    const { study } = await filmStudy({ input: film, out: join(dir, `study${fps}`) });
    return {
      runs: study.picture.runs.map((r) => `${r.what.value} ${r.dir.value}`),
      verdicts: study.candidates.map((c) => c.verdict.value),
    };
  };
  const a = await read(30);
  const b = await read(60);
  assert.deepEqual(a.runs, ["zoom out"], JSON.stringify(a));
  assert.deepEqual(b, a);
});

test("travel starts at the 24 fps reference's rates on the 640 px ruler", () => {
  const base = { motion: null, localPx: null, energy: 0.002 };
  const steps = [
    { ...base, motion: { s: 1, x: 1.1, y: 0 } },
    { ...base, motion: { s: Math.exp(0.0042), x: 0, y: 0 } },
    { ...base, localPx: 1.6 },
  ];
  assert.deepEqual(motionStates(steps, 640, steps.map(() => 1 / 24)), Array(3).fill("travel"));
});

test("a variable-rate film times each step by the frames it compares", () => {
  // 0–0.20 s moving 4 px a frame every 0.04 s, then the last picture held
  // until 1.20 s and a few more still frames
  const times = [0, 0.04, 0.08, 0.12, 0.16, 0.20, 1.20, 1.24, 1.28, 1.32, 1.36, 1.40];
  const g = picture(Array(times.length).fill(1));
  const size = g.w * g.h;
  const still = g.data.slice(0, size);
  for (let i = 0; i < times.length; i++) {
    const dx = 4 * Math.min(i, 5);
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) g.data[i * size + y * g.w + x] = still[y * g.w + Math.min(g.w - 1, Math.max(0, x - dx))]!;
  }
  const vfr = { ...g, fps: 25, times, t0: 0 };
  const study = analyzeStudy(vfr, {
    file: "vfr.mp4", bytes: 1, width: g.w, height: g.h, duration: 1.44, sha256: "x",
    audioPresent: false, timingMeasured: true,
  }, 1.44);
  const travel = study.picture.shares.travel.value!;
  // 0.2 s of 1.4 moved (the closing may add a step)
  assert.ok(travel > 0.1 && travel < 0.2, `travel ${travel}`);
  const run = study.picture.motionRuns.find((r) => r.state.value === "travel");
  assert.ok(!run || run.to.value <= 0.3, JSON.stringify(run));
  const hold = study.picture.motionRuns.find((r) => r.state.value === "hold");
  assert.deepEqual([hold?.from.value, hold?.to.value], [0.2, 1.44]);
});

test("a white flash at the very end is a flash, not a cut", () => {
  const g = picture(Array(6).fill(1));
  const size = g.w * g.h;
  for (const i of [3]) g.data.fill(235, i * size, (i + 1) * size);
  const mid = analyzeStudyPicture(g).candidates.map((c) => c.verdict);
  const end = picture(Array(5).fill(1));
  end.data.fill(235, 3 * size, 4 * size);
  const atEnd = analyzeStudyPicture(end).candidates;
  assert.deepEqual(mid, ["flash_or_fade", "flash_or_fade"]);
  assert.deepEqual(atEnd.map((c) => [c.frame, c.verdict, c.verified]), [
    [3, "flash_or_fade", false], [4, "flash_or_fade", false],
  ]);
});

test("the share of time near an onset counts overlaps once", () => {
  assert.equal(coveredShare([], 0.1, 4), 0);
  assert.ok(Math.abs(coveredShare([1, 1.1, 3], 0.1, 4) - 0.5 / 4) < 1e-9);
  assert.ok(Math.abs(coveredShare([0, 4], 0.5, 4) - 1 / 4) < 1e-9);
});

test("the same picture under a scrim or a local panel stays in one shot", () => {
  const g = picture(Array(18).fill(1));
  const size = g.w * g.h;
  for (let i = 8; i < g.count; i++) {
    for (let k = 0; k < size; k++) {
      const j = i * size + k;
      g.data[j] = Math.round(g.data[j]! * 0.68);
      if (i >= 12 && k % g.w >= 24 && k % g.w < 64 &&
        Math.floor(k / g.w) >= 16 && Math.floor(k / g.w) < 40) {
        g.data[j] = 220;
      }
    }
  }
  const { candidates } = analyzeStudyPicture(g);
  assert.equal(candidates.find((c) => c.frame === 8)?.verdict, "flash_or_fade");
  assert.equal(candidates.find((c) => c.frame === 12)?.verdict, "in_picture_change");
  assert.ok(candidates.every((c) => !c.verified));
});

test("the shuffled null keeps lengths, is seeded, and includes ties in the upper tail", () => {
  const sample = () => shuffledNull([1, 2, 4, 8], [1, 3, 7], 1 / 30, { seed: 45, shuffles: 1000 });
  const result = sample()!;
  assert.deepEqual(result, sample());
  assert.equal(result.realShare, 1);
  assert.equal(result.shuffles, 1000);
  // Across all permutations the three prefixes match with probabilities
  // 1/4, 1/6 and 1/4. A single order matches all three.
  assert.ok(Math.abs(result.nullMean - 2 / 9) < 0.03 && result.nullP95 < 1);
  assert.ok(result.p > 0 && result.p < 0.1);
  assert.equal(shuffledNull([1, 1, 1], [1, 2], 0.03)!.p, 1);
  assert.equal(shuffledNull([3], [2], 0.03), null);
  assert.equal(shuffledNull([1, 2], [], 0.03), null);
});

test("sub counts what is under 60 Hz, not a bass note just above it", () => {
  const tone = (hz: number) =>
    Float32Array.from({ length: 4 * LISTEN_RATE }, (_, i) => 0.2 * Math.sin(2 * Math.PI * hz * i / LISTEN_RATE));
  assert.ok(analyzeStudySound(tone(45), 4).subShare > 0.9);
  assert.ok(analyzeStudySound(tone(59), 4).subShare > 0.9);
  for (const hz of [65, 80, 440]) {
    const share = analyzeStudySound(tone(hz), 4).subShare;
    assert.ok(hz === 65 ? share < 0.1 : share === 0, `${hz} Hz: sub ${share}`);
  }
});

test("sound coming back after digital silence is not a sub entrance or a hit", () => {
  const pcm = Float32Array.from({ length: 5 * LISTEN_RATE }, (_, i) => {
    const t = i / LISTEN_RATE;
    if (t >= 2 && t < 2.4) return 0;
    return 0.15 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 45 * t);
  });
  const sound = analyzeStudySound(pcm, 5);
  assert.deepEqual(sound.events.filter((e) => e.kind !== "onset" && e.time > 1.5 && e.time < 3), []);
  assert.ok(sound.gaps.some((g) => g.kind === "silence" && Math.abs(g.start - 2) < 0.02 && Math.abs(g.end - 2.4) < 0.02));
});

test("sub steps pick sustained entries and exits, filtering an isolated bump", () => {
  const steps = findSubSteps(Array.from({ length: 100 }, (_, i) => ({
    time: i * 0.05,
    db: i === 12 ? -12 : i >= 30 && i < 70 ? -17 : -41,
  })));
  assert.deepEqual(steps, [
    { kind: "sub_entry", time: 1.5, changeDb: 24 },
    { kind: "sub_exit", time: 3.5, changeDb: -24 },
  ]);
});

test("a sub entering where there was none is read against the mix before it, not the floor", () => {
  // no sub (the −80 dBFS floor) under a −22 dBFS mix, then a sub at −13.5 dBFS
  const steps = findSubSteps(Array.from({ length: 60 }, (_, i) => ({
    time: i * 0.05,
    db: i >= 30 ? -13.5 : -80,
    mixDb: i >= 30 ? -12 : -22,
  })));
  assert.deepEqual(steps, [{ kind: "sub_entry", time: 1.5, changeDb: 8.5, against: "mix" }]);
});

test("a mono mix reads bed, sub, and an absolute silence on the same clock", () => {
  const duration = 4;
  const pcm = Float32Array.from({ length: duration * LISTEN_RATE }, (_, i) => {
    const t = i / LISTEN_RATE;
    if (t >= 3.5) return 0;
    return 0.095 * Math.sin(2 * Math.PI * 320 * t) +
      (t >= 1 && t < 3 ? 0.045 : 0.002) * Math.sin(2 * Math.PI * 43 * t);
  });
  const sound = analyzeStudySound(pcm, duration);
  assert.ok(Math.abs(sound.bedShare - 0.875) < 0.01);
  assert.ok(sound.subShare > 0.43 && sound.subShare < 0.57);
  assert.ok(sound.subRelativeDb! < -7 && sound.subRelativeDb! > -12);
  assert.ok(sound.events.some((e) => e.kind === "sub_entry" && Math.abs(e.time - 1) < 0.12));
  assert.ok(sound.gaps.some((e) => e.kind === "silence" && Math.abs(e.start - 3.5) < 0.02));
});

test("sub timing lands on the step after a slow ramp", () => {
  const start = 0.35;
  const entry = 1.37;
  const exit = 3;
  const pcm = Float32Array.from({ length: 4 * LISTEN_RATE }, (_, i) => {
    const t = i / LISTEN_RATE;
    const ramp = Math.min(1, Math.max(0, (t - (entry - 0.3)) / 0.3));
    const level = 12 * ramp + (t >= entry && t < exit ? 25 : 0);
    return 0.002 * 10 ** (level / 20) * Math.sin(2 * Math.PI * 45 * t);
  });
  const { events } = analyzeStudySound(pcm, 4 + start, start);
  for (const [kind, expected] of [["sub_entry", start + entry], ["sub_exit", start + exit]] as const) {
    const event = events.find((e) => e.kind === kind && e.time > start + 0.5);
    assert.ok(event && Math.abs(event.time - expected) <= 0.02,
      `${kind} at ${event?.time}, expected ${expected}`);
  }
});

test("study.json tags every reading and derives shots only from verified boundaries", () => {
  const g = picture(Array(21).fill(1), 10);
  // a panel lit inside the second shot: a candidate that is not a cut
  const size = g.w * g.h;
  for (let i = 15; i < g.count; i++)
    for (let y = 20; y < 36; y++) for (let x = 30; x < 60; x++) g.data[i * size + y * g.w + x] = 230;
  const study = analyzeStudy(g, {
    file: "fixture.mp4", bytes: 2000, width: g.w, height: g.h,
    duration: g.count / g.fps, sha256: "fixture", audioPresent: false, timingMeasured: false,
  }, g.count / g.fps);
  const json = JSON.parse(JSON.stringify(study));
  function check(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(check);
      return;
    }
    assert.ok(value && typeof value === "object");
    if ("how" in value) {
      assert.ok(["measured", "estimated", "not detected"].includes(String(value.how)));
      assert.ok("value" in value);
      if (value.value === null) assert.equal(value.how, "not detected");
      return;
    }
    Object.values(value).forEach(check);
  }
  check(json);
  assert.ok(study.candidates.some((c) => c.frame.value === 15 && c.verdict.value !== "hard_cut"),
    JSON.stringify(study.candidates.map((c) => [c.frame.value, c.verdict.value])));
  assert.equal(study.shots.length, 2);
  assert.deepEqual(study.shots.map((s) => [s.fromFrame.value, s.toFrame.value]), [[0, 10], [10, 21]]);
  assert.deepEqual(study.candidates[0]!.verdict, { value: "hard_cut", how: "estimated" });
  assert.deepEqual(study.identity.frames, { value: 21, how: "measured" });
  assert.deepEqual(study.sound.subShare, { value: null, how: "not detected" });
  assert.deepEqual(study.candidates[0]!.stripFrames.map((f) => f.frame.value), [7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(study.shots.map(({ picture }) => [picture.middleFrame.value, picture.still]), [
    [4, { value: "shots/001.jpg", how: "measured" }],
    [15, { value: "shots/002.jpg", how: "measured" }],
  ]);
  const md = formatStudyMarkdown(study);
  assert.match(md, /\| Time \[measured\] \| Shot \[measured\] \| Picture \[measured\] \| Camera \[estimated\] \| Boundary out \[estimated\] \| Sound at boundary \[estimated\] \|/);
  assert.match(md, /\| 0\.000 s–0\.333 s \[estimated\] \| 1 \| \[Still\]\(shots\/001\.jpg\) \|/);
  assert.match(md, /\[hard_cut\]\(strips\//);
  assert.doesNotMatch(md, /hard_cut \[estimated\]|%.* grey/);
  for (const line of md.match(/^- .*$/gm) ?? [])
    assert.match(line, /^- \[(measured|estimated|not detected)\] (?!.*\[(measured|estimated|not detected)\])/);  // the tool's blind spots are said about any film, so they carry no status
  assert.match(md, /What this reading does not see, in any film[^\n]*\n\n1\. A dissolve/);
  assert.match(md, /unresolved, fast_move, flash_or_fade or in_picture_change/);
  assert.deepEqual(md.match(/^## .*/gm), [
    "## Identity & provenance", "## Brand Kit", "## Narrative grammar", "## Visual hierarchy",
    "## Timing & motion", "## Materials & sound", "## Invariants", "## Replaceable inputs", "## Review",
  ]);
  assert.doesNotMatch(md, /^\d\. \[(measured|estimated|not detected)\]/m);
});

test("the study reads the default audio stream on its own clock, gaps filled", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-study-sound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ffmpeg = await resolveFfmpeg();
  const file = join(dir, "two.mkv");
  // a tone the whole time on the first stream; on the second, the default,
  // starting at 0.5 s: a burst at film time 1.5–1.8 s
  await runTool(ffmpeg, [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=30:d=3",
    "-f", "lavfi", "-i", "sine=f=330:d=3",
    "-itsoffset", "0.5", "-f", "lavfi", "-i", "aevalsrc='if(between(t,1,1.3),0.4*sin(2*PI*440*t),0)':d=2.5",
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-c:a", "pcm_s16le",
    "-disposition:a:0", "0", "-disposition:a:1", "default", file,
  ]);
  const { study } = await filmStudy({ input: file, out: join(dir, "two.study") });
  const loud = study.sound.gaps.filter((g) => g.kind.value === "silence");
  // silence until the burst, and after it
  assert.ok(loud.some((g) => Math.abs(g.end.value - 1.5) < 0.03), JSON.stringify(loud));
  assert.ok(loud.some((g) => Math.abs(g.start.value - 1.8) < 0.03), JSON.stringify(loud));
});

test("a timestamp gap stays silent and a long final video gap does not extend the picture", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-study-gaps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "gaps.mkv");
  await runTool(await resolveFfmpeg(), [
    "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=25:d=0.2",
    "-f", "lavfi", "-i", "sine=f=330:d=1.8",
    "-vf", "setpts='PTS+gte(N,4)/TB'", "-fps_mode", "passthrough",
    "-af", "asetpts='PTS+gte(T,0.5)/TB'", "-c:v", "libx264", "-c:a", "pcm_s16le", file,
  ]);
  const { study } = await filmStudy({ input: file, out: join(dir, "study") });
  assert.ok(study.sound.gaps.some((g) => g.kind.value === "silence" &&
    Math.abs(g.start.value - 0.51) < 0.04 && Math.abs(g.end.value - 1.51) < 0.04));
  assert.equal(study.shots.at(-1)?.to.value, 1.2);
});

test("a long shot counts every hold step", () => {
  const count = 140_000;
  const g = { w: 8, h: 8, count, fps: 30, data: new Uint8Array(8 * 8 * count) };
  const study = analyzeStudy(g, {
    file: "hold", bytes: 1, width: g.w, height: g.h, duration: count / g.fps, sha256: "x",
    audioPresent: false, timingMeasured: false,
  }, count / g.fps);
  assert.equal(study.shots.length, 1);
  assert.equal(study.picture.shares.hold.value, 1);
  assert.ok(Math.abs(study.picture.shares.sampledSeconds.value - (count - 1) / g.fps) < 1e-6);
});

// a 10 s film at 30 fps as its page would declare it: a cut at 1/3 s with one
// thing named and followed across, a whip at 0.5 s the picture shows no cut at
function declaredFilm(over: Partial<FilmEvents> = {}): FilmEvents {
  const fps = 30;
  const names = ["x", "y", "w", "h", "o", "fw", "fh"].map((f) => `carry@0.333:${f}`);
  // the thing sits at the left before the cut and has moved right after it
  const rows = Array.from({ length: 30 }, (_, i) => [i < 10 ? 100 : 600 + i * 10, 200, 160, 160, 1, 1920, 1080]);
  return {
    version: 1, duration: 0.7, fps,
    events: [
      { t: 0, kind: "mark", label: "open" },
      { t: 0.333, kind: "cut", label: "momentum cut down" },
      { t: 0.5, kind: "whip", label: "whip left" },
    ],
    cuts: [0.333], declaredCuts: [0.333], detectedCuts: [],
    curves: { names, t0: 0, dt: 1 / fps, rows },
    segments: [
      { from: 0, to: 0.333, label: "one", handoff: "the face flies down", carry: "#face" },
      { from: 0.333, to: 0.5, label: "two", handoff: "whip" },
      { from: 0.5, to: 0.7, label: "three" },
    ],
    credits: [], sources: [],
    ...over,
  };
}

test("a film's declarations are read as boundaries with what its render followed across", () => {
  const list = declaredBoundaries(declaredFilm(), 1.5 / 30);
  assert.deepEqual(list.map((b) => b.at), [0.333, 0.5]);
  assert.deepEqual(list[0]!.kinds, ["cut"]);
  assert.equal(list[0]!.handoff, "the face flies down");
  assert.equal(list[0]!.carry, "#face");
  assert.equal(list[0]!.carried?.kind, "carried");
  assert.match(list[0]!.carried!.change, /moved \d+% of the diagonal/);
  assert.deepEqual([list[1]!.kinds, list[1]!.labels, list[1]!.carried], [["whip"], ["whip left"], undefined]);
  // a render of part of the film: times move to the film's own clock
  const part = declaredBoundaries(declaredFilm({ range: [0.2, 0.7] }), 1.5 / 30);
  assert.deepEqual(part.map((b) => +b.at.toFixed(3)), [0.133, 0.3]);
});

test("the study marks each boundary declared, detected or both, and a named carry is not called nothing carried", () => {
  const g = picture(Array(21).fill(1), 10);
  const identity = {
    file: "fixture.mp4", bytes: 2000, width: g.w, height: g.h,
    duration: g.count / g.fps, sha256: "fixture", audioPresent: false, timingMeasured: false,
  };
  const end = g.count / g.fps;
  const outside = analyzeStudy(g, identity, end);
  assert.deepEqual(outside.boundaries.list.map((b) => b.source.value), ["detected"]);
  assert.equal(outside.boundaries.eventsFile.value, null);
  assert.match(formatStudyMarkdown(outside), /no events file beside it, so every boundary here is read from the picture alone/);
  const cut = outside.shots[0]!.boundaryOut;
  assert.ok("verdict" in cut && cut.source.value === "detected" && "how" in cut.declared);

  const declared = { file: "fixture.events.json", boundaries: declaredBoundaries(declaredFilm(), 1.5 / 30) };
  const own = analyzeStudy(g, identity, end, null, 0, { declared });
  assert.deepEqual(own.boundaries.list.map((b) => [b.time.value, b.source.value]), [[0.333333, "both"], [0.5, "declared"]]);
  const b = own.shots[0]!.boundaryOut;
  assert.ok("verdict" in b && "as" in b.declared);
  assert.equal(b.source.value, "both");
  assert.deepEqual(b.whatMovesAcross, { value: "carried", how: "measured" });
  assert.equal(b.pictureReading.how, "estimated");
  assert.equal(b.declared.carry.value, "#face");
  const md = formatStudyMarkdown(own);
  assert.match(md, /declared “momentum cut down”, the render followed #face carried \(moved \d+% of the diagonal\) \[measured\] · picture: \[hard_cut\]/);
  assert.match(md, /\| 0\.500 s \| declared \| whip left · handoff: whip \| — \| /);
  // the shot table is still the picture's: a declared whip does not split a shot
  assert.equal(own.shots.length, 2);
  // an events file that is not this film's is named and left unread
  const skipped = analyzeStudy(g, identity, end, null, 0, { declared: { file: "x.events.json", skipped: "it describes 40.00 s" } });
  assert.deepEqual(skipped.boundaries.list.map((x) => x.source.value), ["detected"]);
  assert.match(formatStudyMarkdown(skipped), /the events file beside it was not read \(x\.events\.json: it describes 40\.00 s\)/);
});

test("a small part that stays put across a cut is seen; scattered agreement and a new picture are not", () => {
  const w = 320;
  const h = 180;
  const noise = (seed: number) => {
    const out = new Uint8Array(w * h);
    let v = seed;
    for (let i = 0; i < out.length; i++) {
      v = (v * 1103515245 + 12345) & 0x7fffffff;
      out[i] = 40 + (v >> 16) % 160;
    }
    return out;
  };
  const a = noise(1);
  const b = noise(2);
  assert.equal(keptInPlace(a, b, w, h), 0, "two unrelated pictures");
  // one lone block agrees by chance
  const lone = b.slice();
  for (let y = 80; y < 88; y++) for (let x = 80; x < 88; x++) lone[y * w + x] = a[y * w + x]!;
  assert.equal(keptInPlace(a, lone, w, h), 0, "a single block is not a thing that stayed");
  // an avatar-sized patch, 24 × 24 px, stays where it was
  const kept = b.slice();
  for (let y = 80; y < 104; y++) for (let x = 160; x < 184; x++) kept[y * w + x] = a[y * w + x]!;
  const share = keptInPlace(a, kept, w, h);
  assert.ok(Math.abs(share - 9 / (40 * 22)) < 1e-9, String(share));
  // a flat ground that stays is not texture
  const flatA = new Uint8Array(w * h).fill(90);
  assert.equal(keptInPlace(flatA, flatA.slice(), w, h), 0);

  const g = picture(Array(21).fill(1), 10);
  const identity = {
    file: "fixture.mp4", bytes: 2000, width: g.w, height: g.h,
    duration: g.count / g.fps, sha256: "fixture", audioPresent: false, timingMeasured: false,
  };
  const plain = analyzeStudy(g, identity, g.count / g.fps);
  const seen = analyzeStudy(g, identity, g.count / g.fps, null, 0, { keptAt: (f) => (f === 10 ? share : null) });
  const across = (s: typeof plain) => s.candidates.find((c) => c.frame.value === 10)!.across.value;
  assert.notEqual(across(plain), "carried");
  assert.equal(across(seen), "small part kept");
  assert.equal(seen.candidates.find((c) => c.frame.value === 10)!.evidence.keptInPlace.value, +share.toFixed(4));
  assert.match(formatStudyMarkdown(seen), /\[hard_cut\]\(strips\/[^)]*\) · small part kept/);
});

test("an events file beside a film is read only when it is that film's", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ot-declared-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const film = join(dir, "film.mp4");
  assert.equal(await readDeclarations(film, 0.7, 1 / 30), null, "a film from elsewhere has none");
  await writeFile(join(dir, "film.events.json"), JSON.stringify(declaredFilm()));
  const own = await readDeclarations(film, 0.7, 1 / 30);
  assert.ok(own && "boundaries" in own && own.boundaries.length === 2);
  const other = await readDeclarations(film, 12, 1 / 30);
  assert.ok(other && "skipped" in other && /describes 0\.70 s and the picture runs 12\.00 s/.test(other.skipped));
  await writeFile(join(dir, "film.events.json"), "{ not json");
  const broken = await readDeclarations(film, 0.7, 1 / 30);
  assert.ok(broken && "skipped" in broken);
});
