// Smoke tests for FfmpegCompositor against the system ffmpeg binary.
// Catches the kind of regression that bit Session 4 v0: the tmp output
// filename had no .mp4 extension and ffmpeg refused to pick a muxer.
//
// Uses ffmpeg's testsrc + sine sources to synthesize input, so no
// fixture files are checked in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_PROFILE_ID,
  FfmpegCompositor,
  CANONICAL_WIDTH,
  CANONICAL_HEIGHT,
  CANONICAL_FPS,
  probeDurationMs,
} from "../src/index.js";

type ProbeResult = {
  video: Record<string, string>;
  audio: Record<string, string>;
  format: Record<string, string>;
};

function probeStream(path: string, sel: "v:0" | "a:0"): Record<string, string> {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", sel,
      "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,sample_rate,channels",
      "-of", "default=nw=1",
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `ffprobe ${sel} failed: ${r.stderr}`);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const [k, v] = line.split("=");
    if (k && v) out[k] = v;
  }
  return out;
}

function probe(path: string): ProbeResult {
  const fmt = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1", path],
    { encoding: "utf8" },
  );
  const format: Record<string, string> = {};
  for (const line of fmt.stdout.split("\n")) {
    const [k, v] = line.split("=");
    if (k && v) format[k] = v;
  }
  return {
    video: probeStream(path, "v:0"),
    audio: probeStream(path, "a:0"),
    format,
  };
}

function synthWebm(path: string, durationSec: number, w = 640, h = 360): void {
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi",
      "-i", `testsrc=size=${w}x${h}:rate=15:duration=${durationSec}`,
      "-c:v", "libvpx",
      "-b:v", "200k",
      "-pix_fmt", "yuv420p",
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `synthWebm failed: ${r.stderr}`);
}

test("CANONICAL_PROFILE_ID matches D21 spec string", () => {
  assert.equal(CANONICAL_PROFILE_ID, "h264-1080p30-yuv420p-aac48k-v1");
});

test("transcodeToCanonical: webm → mp4 conforms to D21", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const webm = join(work, "src.webm");
    const mp4 = join(work, "out.mp4");
    synthWebm(webm, 0.5);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, mp4);

    assert.ok(existsSync(mp4), "output mp4 must exist");
    assert.ok(statSync(mp4).size > 1024, "output mp4 must be > 1 KiB");

    const p = probe(mp4);
    assert.equal(p.video.codec_name, "h264", `expected h264, got ${p.video.codec_name}`);
    assert.equal(p.video.pix_fmt, "yuv420p", `expected yuv420p, got ${p.video.pix_fmt}`);
    assert.equal(p.video.width, String(CANONICAL_WIDTH), `width mismatch`);
    assert.equal(p.video.height, String(CANONICAL_HEIGHT), `height mismatch`);
    assert.match(p.video.profile ?? "", /Baseline/i, `expected baseline profile, got ${p.video.profile}`);
    assert.equal(p.audio.codec_name, "aac", `expected aac audio`);
    assert.equal(p.audio.sample_rate, "48000", `audio sample rate must be 48 kHz`);
    assert.equal(p.audio.channels, "2", `audio must be stereo`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("transcodeToCanonical: pads non-16:9 input to canvas without crop", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const webm = join(work, "src.webm");
    const mp4 = join(work, "out.mp4");
    // 4:3 source — must end up letterboxed at 1920x1080 (16:9), not cropped.
    synthWebm(webm, 0.3, 640, 480);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, mp4);

    const p = probe(mp4);
    assert.equal(p.video.width, String(CANONICAL_WIDTH));
    assert.equal(p.video.height, String(CANONICAL_HEIGHT));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("concatSegments: stream-copy two canonical segments", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const c = new FfmpegCompositor();
    const w1 = join(work, "1.webm");
    const w2 = join(work, "2.webm");
    const m1 = join(work, "1.mp4");
    const m2 = join(work, "2.mp4");
    const out = join(work, "concat.mp4");
    synthWebm(w1, 0.4);
    synthWebm(w2, 0.4);
    await c.transcodeToCanonical(w1, m1);
    await c.transcodeToCanonical(w2, m2);
    await c.concatSegments([{ mp4Path: m1 }, { mp4Path: m2 }], { outPath: out });

    assert.ok(existsSync(out), "concat mp4 must exist");
    const p = probe(out);
    assert.equal(p.video.codec_name, "h264");
    assert.equal(p.video.width, String(CANONICAL_WIDTH));
    const dur = Number(p.format.duration);
    assert.ok(dur > 0.5, `concat duration ${dur} too short (expected ~0.8s)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("concatSegments: single-segment fast-path", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const c = new FfmpegCompositor();
    const w1 = join(work, "1.webm");
    const m1 = join(work, "1.mp4");
    const out = join(work, "concat.mp4");
    synthWebm(w1, 0.3);
    await c.transcodeToCanonical(w1, m1);
    await c.concatSegments([{ mp4Path: m1 }], { outPath: out });

    assert.ok(existsSync(out));
    const p = probe(out);
    assert.equal(p.video.width, String(CANONICAL_WIDTH));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("zoom: produces a canonical-shape mp4 same size as input", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const webm = join(work, "src.webm");
    const m1 = join(work, "canonical.mp4");
    synthWebm(webm, 1.0);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, m1);

    // Zoom into the center 800x400 region, 2x, over 500 ms.
    const zoomed = await c.zoom(m1, [560, 340, 800, 400], 2, 500);
    assert.ok(existsSync(zoomed), "zoom output mp4 must exist");
    assert.ok(statSync(zoomed).size > 1024, "zoom output must be > 1 KiB");
    const p = probe(zoomed);
    assert.equal(p.video.codec_name, "h264");
    assert.equal(p.video.pix_fmt, "yuv420p");
    assert.equal(p.video.width, String(CANONICAL_WIDTH));
    assert.equal(p.video.height, String(CANONICAL_HEIGHT));
    assert.match(p.video.profile ?? "", /Baseline/i);
    // Duration should match the source (zoompan emits one output per
    // input frame at d=1; the zoom ramp happens within the segment).
    const sourceDur = Number(probe(m1).format.duration);
    const zoomedDur = Number(p.format.duration);
    assert.ok(
      Math.abs(zoomedDur - sourceDur) < 0.15,
      `zoom output duration ${zoomedDur} drifted too far from source ${sourceDur}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("zoom: rejects scale <= 1 and durationMs <= 0", async () => {
  const c = new FfmpegCompositor();
  await assert.rejects(() => c.zoom("/dev/null", [0, 0, 100, 100], 1, 500), /scale must be > 1/);
  await assert.rejects(() => c.zoom("/dev/null", [0, 0, 100, 100], 2, 0), /durationMs must be > 0/);
});

function synthMp3(path: string, durationSec: number): void {
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi",
      "-i", `sine=frequency=440:duration=${durationSec}`,
      "-c:a", "libmp3lame",
      "-b:a", "32k",
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `synthMp3 failed: ${r.stderr}`);
}

test("muxSegment: audio shorter than video → output sized to video (audio padded with silence)", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const webm = join(work, "src.webm");
    const m1 = join(work, "canonical.mp4");
    const audio = join(work, "narration.mp3");
    const muxed = join(work, "muxed.mp4");
    synthWebm(webm, 1.0);
    synthMp3(audio, 0.4);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, m1);
    const r = await c.muxSegment({ videoPath: m1, audioPath: audio, outPath: muxed });
    assert.equal(r.mp4Path, muxed);
    assert.ok(existsSync(muxed));

    const p = probe(muxed);
    assert.equal(p.video.codec_name, "h264");
    assert.equal(p.video.width, String(CANONICAL_WIDTH));
    assert.equal(p.audio.codec_name, "aac");
    assert.equal(p.audio.sample_rate, "48000");
    assert.equal(p.audio.channels, "2");
    const videoMs = await probeDurationMs(m1);
    const muxedMs = await probeDurationMs(muxed);
    assert.ok(
      Math.abs(muxedMs - videoMs) < 100,
      `expected muxed (${muxedMs}ms) ≈ video (${videoMs}ms) when audio is shorter`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("muxSegment: audio longer than video → output sized to audio (last frame cloned)", async () => {
  // The bug Session 8 carried into Session 10: mock-tts narrations
  // typically run ~3-4 s while the silent recorded webm is sub-second.
  // The old -shortest behavior truncated the muxed segment to the
  // video's length, silently throwing away most of the spoken audio
  // and producing the wrong startMs/durationMs in the embed manifest.
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const webm = join(work, "src.webm");
    const m1 = join(work, "canonical.mp4");
    const audio = join(work, "narration.mp3");
    const muxed = join(work, "muxed.mp4");
    synthWebm(webm, 0.3);
    synthMp3(audio, 2.0);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, m1);
    await c.muxSegment({ videoPath: m1, audioPath: audio, outPath: muxed });
    assert.ok(existsSync(muxed));

    const p = probe(muxed);
    assert.equal(p.video.codec_name, "h264");
    assert.equal(p.video.pix_fmt, "yuv420p");
    assert.equal(p.video.width, String(CANONICAL_WIDTH));
    assert.equal(p.audio.codec_name, "aac");
    assert.equal(p.audio.sample_rate, "48000");

    const audioMs = await probeDurationMs(audio);
    const muxedMs = await probeDurationMs(muxed);
    assert.ok(
      Math.abs(muxedMs - audioMs) < 150,
      `expected muxed (${muxedMs}ms) ≈ audio (${audioMs}ms) when audio outlasts video`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("muxSegment: extended segment concat-stream-copies with a sibling canonical segment", async () => {
  // Regression on the most fragile case: the audio-longer-than-video
  // branch re-encodes the video stream, so we must verify the output
  // still concats with `-c copy` against a plain canonical segment.
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const c = new FfmpegCompositor();
    const w1 = join(work, "1.webm");
    const w2 = join(work, "2.webm");
    const m1 = join(work, "1.mp4");
    const m2silent = join(work, "2-silent.mp4");
    const audio = join(work, "2.mp3");
    const m2 = join(work, "2.mp4");
    const out = join(work, "concat.mp4");
    synthWebm(w1, 0.4);
    synthWebm(w2, 0.2);
    synthMp3(audio, 1.5);
    await c.transcodeToCanonical(w1, m1);
    await c.transcodeToCanonical(w2, m2silent);
    await c.muxSegment({ videoPath: m2silent, audioPath: audio, outPath: m2 });
    await c.concatSegments([{ mp4Path: m1 }, { mp4Path: m2 }], { outPath: out });

    const p = probe(out);
    assert.equal(p.video.codec_name, "h264");
    assert.equal(p.video.width, String(CANONICAL_WIDTH));
    // Stream-copy concat must report a duration that is at least the
    // audio length of the second segment — anything shorter would mean
    // the re-encoded segment got truncated again at concat time.
    const dur = Number(p.format.duration);
    assert.ok(dur > 1.5, `concat duration ${dur} too short — segment likely truncated`);
    assert.ok(dur < 4.0, `concat duration ${dur} unexpectedly long`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("muxSegment: missing audio falls back to silent canonical stereo", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const webm = join(work, "src.webm");
    const m1 = join(work, "canonical.mp4");
    const muxed = join(work, "muxed.mp4");
    synthWebm(webm, 0.5);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, m1);
    await c.muxSegment({ videoPath: m1, outPath: muxed });
    const p = probe(muxed);
    assert.equal(p.audio.codec_name, "aac");
    assert.equal(p.audio.sample_rate, "48000");
    assert.equal(p.audio.channels, "2");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("mixAudio: single track is normalized to canonical sample rate", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const a1 = join(work, "1.mp3");
    synthMp3(a1, 0.4);
    const c = new FfmpegCompositor();
    const out = await c.mixAudio([{ path: a1 }]);
    assert.ok(existsSync(out));
    const sr = spawnSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "default=nw=1:nk=1", out],
      { encoding: "utf8" },
    );
    assert.equal(sr.status, 0);
    assert.equal(sr.stdout.trim(), "48000");
    rmSync(out, { force: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("mixAudio: two tracks merge without volume drop (normalize=0)", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const a1 = join(work, "1.mp3");
    const a2 = join(work, "2.mp3");
    synthMp3(a1, 0.4);
    synthMp3(a2, 0.4);
    const c = new FfmpegCompositor();
    const out = await c.mixAudio([{ path: a1 }, { path: a2, gainDb: -6 }]);
    assert.ok(existsSync(out));
    const sr = spawnSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,codec_name", "-of", "default=nw=1", out],
      { encoding: "utf8" },
    );
    assert.equal(sr.status, 0);
    assert.match(sr.stdout, /codec_name=mp3/);
    assert.match(sr.stdout, /sample_rate=48000/);
    rmSync(out, { force: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("mixAudio: zero tracks throws", async () => {
  const c = new FfmpegCompositor();
  await assert.rejects(() => c.mixAudio([]), /tracks is empty/);
});

test("muxSegment: missing videoPath throws", async () => {
  const c = new FfmpegCompositor();
  await assert.rejects(
    () => c.muxSegment({ videoPath: "", outPath: "/tmp/x.mp4" }),
    /videoPath is required/,
  );
});

test("probeDurationMs: returns milliseconds for an mp4 and matches ffprobe", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-probe-"));
  try {
    const webm = join(work, "src.webm");
    const mp4 = join(work, "out.mp4");
    synthWebm(webm, 0.7);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, mp4);
    const ms = await probeDurationMs(mp4);
    // Sanity bounds: must be a positive number under a second-ish for
    // the 0.7s source (transcode + silent-audio injection can stretch
    // the output, but not by orders of magnitude).
    assert.ok(ms > 100 && ms < 5000, `expected positive ms under 5s, got ${ms}`);
    // Round-trip against the test's own ffprobe call.
    const sec = Number(probe(mp4).format.duration);
    assert.ok(
      Math.abs(ms / 1000 - sec) < 0.05,
      `probeDurationMs ${ms}ms vs ffprobe ${sec}s diverged > 50ms`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("probeDurationMs: throws on non-media input", async () => {
  await assert.rejects(() => probeDurationMs("/dev/null"));
});

test("transcodeToCanonical: canonical mp4 has fps=30 grid", async () => {
  const work = mkdtempSync(join(tmpdir(), "od-compositor-"));
  try {
    const webm = join(work, "src.webm");
    const mp4 = join(work, "out.mp4");
    synthWebm(webm, 1.0);
    const c = new FfmpegCompositor();
    await c.transcodeToCanonical(webm, mp4);

    // r_frame_rate is reported as "30/1" for true 30fps CFR; the
    // dryrun's per-segment short windows produce a different effective
    // rate, but a 1-second source should land on 30/1 exactly.
    const r = spawnSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate",
        "-of", "default=nw=1:nk=1",
        mp4,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), `${CANONICAL_FPS}/1`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
