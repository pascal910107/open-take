// The information lines that point from a measurement to the tools that act on
// it: probe's text lane (parts of a screen), listen's tempo (grid on the page),
// check's material (a still that could keep the interface). Information only:
// each says where a tool is, none is a target.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type FilmCheck,
  filmCheckScope,
  formatFilmCheck,
  pageMaterialNote,
  readPageMaterial,
} from "../src/film/check";
import { gridOnPage } from "../src/film/listen";
import { PHONE_SMALL_PX, productTextSpans, type TextSample, textTimeline } from "../src/film/probe";
import type { PageTextSample } from "../src/film/probe-text";

const sample = (t: number, o: Partial<TextSample>): TextSample => ({
  t,
  own: 0,
  product: 0,
  picture: 0,
  share: 0,
  ownChars: 0,
  productChars: 0,
  pictureChars: 0,
  chars: 0,
  smallest: null,
  median: null,
  ...o,
});

test("probe: the product's words most of the text, or small on the phone, run into spans", () => {
  const scale = 390 / 1920;
  const S = [
    // the film's own title only
    sample(0, { own: 0.05, share: 0.05, median: 80 }),
    // the product's screen: most of the text, small
    sample(0.5, {
      own: 0.01,
      product: 0.09,
      share: 0.1,
      productChars: 300,
      median: 24,
      productMedian: 22,
    }),
    sample(1, {
      own: 0.01,
      picture: 0.12,
      share: 0.13,
      pictureChars: 200,
      median: 26,
      productMedian: 24,
    }),
    // the film's large caption over a little of the product, the product's
    // words small: the product's own median counts, not the frame's
    sample(1.5, {
      own: 0.08,
      product: 0.02,
      share: 0.1,
      productChars: 120,
      median: 60,
      productMedian: 30,
    }),
    // back to the film's own words, large
    sample(2, { own: 0.06, share: 0.06, median: 90 }),
    sample(2.5, {
      own: 0,
      product: 0.2,
      share: 0.2,
      productChars: 80,
      median: 60,
      productMedian: 60,
    }),
  ];
  const spans = productTextSpans(S, scale, 0.5);
  assert.equal(spans.length, 2);
  assert.deepEqual(
    { from: spans[0]!.from, to: spans[0]!.to },
    { from: 0.5, to: 2 },
    "0.5–2 s: the product's, then small",
  );
  assert.equal(spans[0]!.productShare, 0.92);
  assert.ok(spans[0]!.phoneMedian! < PHONE_SMALL_PX);
  assert.deepEqual({ from: spans[1]!.from, to: spans[1]!.to }, { from: 2.5, to: 3 });
  // nothing of the product's: no span, however small the film's own text
  assert.deepEqual(
    productTextSpans([sample(0, { own: 0.1, share: 0.1, median: 10 })], scale, 0.5),
    [],
  );
  // the film's own small headline and a stray mark read in a picture (two
  // characters): not the product's words
  assert.deepEqual(
    productTextSpans(
      [
        sample(0, {
          own: 0.14,
          picture: 0.012,
          share: 0.152,
          ownChars: 61,
          pictureChars: 2,
          median: 34,
          productMedian: 20,
        }),
      ],
      scale,
      0.5,
    ),
    [],
  );
  // pictures read by edges hold the film's own text too: saved screens only
  const edges = sample(0, { own: 0.1, picture: 0.2, share: 0.2, median: 30 });
  assert.equal(productTextSpans([edges], scale, 0.5).length, 1);
  assert.deepEqual(productTextSpans([edges], scale, 0.5, { pictures: false }), []);
});

test("probe: the product's words' median leaves the film's own pieces out", () => {
  const grid = Array.from({ length: 54 }, () => "0".repeat(96));
  const page: PageTextSample[] = [
    {
      t: 0,
      // a large headline of the film's own, most of the characters
      own: [{ text: 'h1 "Plans"', chars: 300, px: 34, boxes: [[100, 100, 1200, 120]] }],
      product: { chars: 100, pieces: 8 },
      sizes: [
        [12, 100],
        [34, 300],
      ],
      ownShare: 0.08,
      productShare: 0.02,
      grid,
      media: [],
      subjects: {},
    },
  ];
  const { samples } = textTimeline(page, null, {
    width: 1920,
    height: 1080,
    segments: [],
    every: 0.5,
  });
  assert.equal(samples[0]!.median, 34, "the frame's median is the headline's");
  assert.equal(samples[0]!.productMedian, 12, "the product's words alone");
  const spans = productTextSpans(samples, 390 / 1920, 0.5);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.phoneMedian, 2.4);
});

test("listen: the tempo as kit/cut.js grid takes it", () => {
  const line = gridOnPage({ bpm: 112, periodS: 60 / 112.04, beats: [0.4321, 0.968] });
  assert.match(line, /grid\(\{ bpm: 112\.04, offset: 0\.432 \}\)/);
  assert.match(line, /kit\/cut\.js/);
  assert.match(line, /film beats/);
  assert.doesNotMatch(line, /should|must/);
  // beats that follow the onsets: the pulse is named as even, the file as keeping them
  const loose = gridOnPage({ bpm: 112, periodS: 60 / 112, beats: [0.5], steady: false });
  assert.match(loose, /even pulse/);
  assert.match(loose, /beats file keeps them/);
});

test("check: PNG stills from a shoot and no saved screen get one information line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "film-material-"));
  try {
    await mkdir(join(dir, "film"), { recursive: true });
    await writeFile(join(dir, "film", "index.html"), "<!doctype html><title>f</title>");
    await mkdir(join(dir, "shots", "calc"), { recursive: true });
    const stills = Array.from({ length: 3 }, (_, i) => ({ file: `00${i}-calc.png`, name: "calc" }));
    await writeFile(join(dir, "shots", "calc", "shots.json"), JSON.stringify({ stills }));
    // not a shoot log
    await writeFile(join(dir, "shots", "other.json"), "{}");
    await mkdir(join(dir, "film", "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "film", "node_modules", "x", "state.html"), "");

    const m = await readPageMaterial(join(dir, "film"), dir);
    assert.deepEqual(m.logs, [
      { file: join("shots", "calc", "shots.json"), stills: 3, withState: 0 },
    ]);
    assert.equal(m.states, 0, "node_modules is not entered");
    const note = pageMaterialNote(m);
    assert.ok(note);
    assert.match(note, /3 PNG stills from shots\/calc\/shots\.json/);
    assert.match(note, /lift/);
    assert.match(note, /Information, not a step/);

    // in the report, once
    const report = formatFilmCheck({
      file: "f.mp4",
      durationS: 1,
      video: null,
      audio: null,
      stalls: [],
      cadence: [],
      cuts: [],
      flashes: [],
      blanks: [],
      black: [],
      silences: [],
      clicks: [],
      marks: [],
      page: null,
      layout: null,
      unreadText: null,
      smallestText: null,
      material: m,
      issues: [],
    });
    assert.equal(report.split("\n").filter((l) => l.startsWith("material: ")).length, 1);

    // it says what it measured and what it does not, and an empty list as no more than that
    assert.doesNotMatch(report, /no issues/);
    assert.match(report, /^measured: the format\n/m);
    assert.match(report, /^not measured: the text's layout .*--page/m);
    assert.match(report, /film probe/);
    assert.match(report, /^found: nothing in what was measured$/m);

    // a saved screen anywhere served, or a still that names one: no line
    await mkdir(join(dir, "shots", "calc", "states", "calc"), { recursive: true });
    await writeFile(join(dir, "shots", "calc", "states", "calc", "state.html"), "");
    assert.equal(pageMaterialNote(await readPageMaterial(join(dir, "film"), dir)), null);
    assert.equal(
      pageMaterialNote({ root: dir, logs: [{ file: "a", stills: 2, withState: 1 }], states: 0 }),
      null,
    );
    assert.equal(pageMaterialNote({ root: dir, logs: [], states: 0 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check: the report says what it measured, from what it read", () => {
  const base: FilmCheck = {
    file: "f.mp4",
    durationS: 2,
    video: {
      codec: "h264",
      profile: null,
      width: 1920,
      height: 1080,
      fps: 60,
      pixFmt: "yuv420p",
      frames: 120,
    },
    audio: { codec: "aac", sampleRate: 48_000, channels: 2, lufs: -16, lra: 4, truePeak: -2 },
    stalls: [],
    cadence: [],
    cuts: [],
    flashes: [],
    blanks: [],
    black: [],
    silences: [],
    clicks: [],
    marks: [],
    page: { file: "film/index.html", width: 1920, height: 1080, every: 0.25 },
    layout: [],
    unreadText: [],
    smallestText: null,
    issues: [],
  };
  const s = filmCheckScope(base);
  assert.match(s.measured, /cuts/);
  assert.match(s.measured, /clicks/);
  assert.match(s.measured, /read every 0\.25s/);
  assert.doesNotMatch(s.notMeasured, /--page/, "the page was read");
  assert.match(s.notMeasured, /film probe/);
  assert.match(s.notMeasured, /while it moves/);
  // no sound, no page: neither is claimed
  const bare = filmCheckScope({ ...base, audio: null, page: null });
  assert.doesNotMatch(bare.measured, /clicks|smallest text/);
  assert.match(bare.notMeasured, /^the text's layout/);
  // findings listed: no "nothing found" line
  const report = formatFilmCheck({ ...base, issues: [{ severity: "warn", message: "x" }] });
  assert.doesNotMatch(report, /^found: nothing/m);
  assert.match(report, /^not measured: /m);
});
