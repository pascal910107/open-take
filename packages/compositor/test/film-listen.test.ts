// `film listen`: the analysis on sound built here with known answers, then
// the whole command on files (ffmpeg; the picture only with Chrome).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg, runTool } from "../src/ffmpeg";
import {
  bestLag,
  chanceWithin,
  changedMoments,
  creditLines,
  estimateTempo,
  filmListen,
  findSections,
  formatPictureAgainst,
  halfSeconds,
  LISTEN_RATE,
  nearestOffset,
  onsetStrength,
  parseFilmEvents,
  pickOnsets,
  pictureAgainstSound,
  pictureEnergyOf,
  repeatedBars,
  spectrum,
  spectrumDiff,
  typicalDiff,
} from "../src/film/listen";
import { findChrome } from "./fixtures/find-chrome";

const R = LISTEN_RATE;

/** a short pitched knock at t: a sine with a fast attack and a 60 ms decay */
function knock(x: Float32Array, t: number, hz: number, amp = 0.6) {
  const a = Math.round(t * R);
  for (let i = 0; i < R * 0.25 && a + i < x.length; i++) {
    const env = Math.min(1, i / (R * 0.001)) * Math.exp(-i / (R * 0.06));
    x[a + i] = x[a + i]! + amp * env * Math.sin((2 * Math.PI * hz * i) / R);
  }
}

/** a steady tone over [a, b) */
function tone(x: Float32Array, a: number, b: number, hz: number, amp: number) {
  for (let i = Math.round(a * R); i < Math.min(x.length, Math.round(b * R)); i++)
    x[i] = x[i]! + amp * Math.sin((2 * Math.PI * hz * i) / R);
}

/** 16 s at 120 BPM: the same bar (four knocks, the first lower) over and
 *  over; from 8 s a bright hat between the beats and a high pad change the
 *  texture */
function groove(): { pcm: Float32Array; beats: number[] } {
  const pcm = new Float32Array(R * 16);
  const beats: number[] = [];
  for (let k = 0; k < 32; k++) {
    const t = 0.25 + k * 0.5;
    beats.push(t);
    knock(pcm, t, k % 4 ? 220 : 110);
    if (t >= 8) knock(pcm, t + 0.25, 6000, 0.25);
  }
  tone(pcm, 8, 16, 1800, 0.08);
  return { pcm, beats };
}

test("onsets land on the knocks, within a few ms", () => {
  const { pcm, beats } = groove();
  const s = spectrum(pcm);
  const onsets = pickOnsets(s, onsetStrength(s), pcm);
  for (const b of beats) {
    const d = nearestOffset(onsets, b);
    assert.ok(d != null && Math.abs(d) <= 0.006, `beat ${b}: nearest onset ${d}`);
  }
});

test("the tempo is the pulse, not a multiple of its period, and the grid sits on it", () => {
  const { pcm, beats } = groove();
  const s = spectrum(pcm);
  const env = onsetStrength(s);
  const onsets = pickOnsets(s, env, pcm);
  const t = estimateTempo(s, env, onsets, 16);
  assert.ok(t, "a tempo");
  assert.ok(Math.abs(t.bpm - 120) < 2, `bpm ${t.bpm}`);
  assert.ok(t.strength > 0.3, `strength ${t.strength}`);
  assert.ok(t.gridFit >= 0.9, `grid fit ${t.gridFit}`);
  // the grid's phase is the beats', not the hats' between them
  assert.ok(
    t.beats.some((b) => Math.abs(b - beats[4]!) < 0.03),
    `grid ${t.beats.slice(0, 6)}`,
  );
});

test("silence has no onsets and no tempo", () => {
  const silent = new Float32Array(R * 8);
  const s = spectrum(silent);
  const env = onsetStrength(s);
  assert.deepEqual(pickOnsets(s, env, silent), []);
  assert.equal(estimateTempo(s, env, [], 8), null);
});

test("a section boundary where the texture changes", () => {
  const { pcm } = groove();
  const s = spectrum(pcm);
  const onsets = pickOnsets(s, onsetStrength(s), pcm);
  const sections = findSections(s, onsets, 16);
  assert.ok(sections.length >= 2, JSON.stringify(sections));
  assert.ok(
    sections.some((x) => x.start > 0 && Math.abs(x.start - 8) <= 0.75),
    `starts ${sections.map((x) => x.start)}`,
  );
  // the second half is brighter and busier
  const last = sections[sections.length - 1]!;
  assert.ok(last.centroidHz > sections[0]!.centroidHz);
  assert.ok(last.onsetsPerS > sections[0]!.onsetsPerS);
});

test("bars that loop are counted as repeats of the first; a changed bar is not", () => {
  const pcm = new Float32Array(R * 16);
  const beats: number[] = [];
  for (let k = 0; k < 32; k++) {
    const t = 0.25 + k * 0.5;
    beats.push(t);
    // bar 5 (beats 16–19) plays other notes
    knock(pcm, t, k >= 16 && k < 20 ? 330 + k * 20 : k % 4 ? 220 : 110);
  }
  const s = spectrum(pcm);
  const r = repeatedBars(s, beats);
  assert.equal(r.bars, 7); // the eighth bar has no beat after it to end it
  const repeating = r.repeats.map((x) => x.bar);
  assert.ok(!repeating.includes(5), `repeats ${JSON.stringify(r.repeats)}`);
  for (const bar of [2, 3, 4, 6, 7]) assert.ok(repeating.includes(bar), `bar ${bar}: ${repeating}`);
  assert.ok(r.repeats.every((x) => x.of === 1));
  // a stretch never overlaps the one it repeats: bars 3–4 are bars 1–2
  assert.deepEqual(r.longestRun, { from: 3, to: 4, of: 1 });
});

test("offsets, chance, the events file read leniently", () => {
  assert.equal(nearestOffset([1, 2, 3], 2.03), -0.03);
  assert.equal(nearestOffset([1, 2, 3], 0.5), 0.5);
  assert.equal(nearestOffset([], 1), null);
  // two onsets, each ±40 ms, one overlapping the start: 0.04 + 0.08 of 10 s
  assert.equal(chanceWithin([0, 5], 10), 0.01);
  const ev = parseFilmEvents({
    duration: 10,
    fps: 30,
    events: [
      { t: 2, kind: "key" },
      { t: "x" },
      { t: 1, kind: "click", x: 4, force: 0.5, junk: 1 },
      null,
    ],
    cuts: [5, "no", 3],
    curves: { names: ["zoom"], rows: [[1], ["bad"], [2]] },
  });
  assert.deepEqual(
    ev.events.map((e) => [e.t, e.kind]),
    [
      [1, "click"],
      [2, "key"],
    ],
  );
  assert.deepEqual(ev.events[0], { t: 1, kind: "click", x: 4, force: 0.5 });
  assert.deepEqual(ev.cuts, [3, 5]);
  assert.equal(ev.curves.dt, 1 / 30);
  assert.ok(Number.isNaN(ev.curves.rows[1]![0]!));
  assert.deepEqual(parseFilmEvents(null).events, []);
  // a render of 4–6 s of the page: its own clock starts at 4 s
  const part = parseFilmEvents({
    duration: 10,
    range: [4, 6],
    fps: 30,
    events: [
      { t: 3, kind: "before" },
      { t: 4.5, kind: "in" },
      { t: 7, kind: "after" },
    ],
    cuts: [2, 5, 9],
    curves: { names: ["picture.energy"], t0: 4, dt: 1 / 30, rows: [[0.1]] },
  });
  assert.deepEqual(
    part.events.map((e) => [e.t, e.kind]),
    [[0.5, "in"]],
  );
  assert.deepEqual(part.cuts, [1]);
  assert.equal(part.curves.t0, 0);
  assert.equal(part.duration, 2);
});

// --- the command on files ------------------------------------------------------------

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-listen-test-"));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function wav(pcm: Float32Array): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  pcm.forEach((v, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(R, 24);
  h.writeUInt32LE(R * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("film listen on a score with events and stems: report, data, clips", async () => {
  // music: a pad and a pulse; action: clicks at four of the five events
  const music = new Float32Array(R * 12);
  tone(music, 0, 12, 140, 0.15);
  for (let k = 0; k < 24; k++) knock(music, 0.25 + k * 0.5, 90, 0.3);
  // a breath: the music stops 9–10 s
  music.fill(0, 9 * R, 10 * R);
  const action = new Float32Array(R * 12);
  const clicks = [1.6, 3.1, 5.35, 7.8];
  for (const t of clicks) knock(action, t, 2500, 0.5);
  const mix = Float32Array.from(music, (v, i) => v + action[i]!);
  const stems = join(dir, "stems");
  await mkdir(stems, { recursive: true });
  await writeFile(join(stems, "music.wav"), wav(music));
  await writeFile(join(stems, "action.wav"), wav(action));
  await writeFile(join(dir, "score.wav"), wav(mix));
  // the default events file: beside the input, same name
  await writeFile(
    join(dir, "score.events.json"),
    JSON.stringify({
      version: 1,
      duration: 12,
      fps: 60,
      events: [
        ...clicks.map((t) => ({ t, kind: "click" })),
        { t: 6.6, kind: "land", label: "card" },
      ],
      cuts: [2.25, 4.4],
      curves: {
        names: ["zoom"],
        t0: 0,
        dt: 1 / 60,
        rows: Array.from({ length: 720 }, (_, i) => [1 + i / 720]),
      },
    }),
  );
  const chrome = findChrome();
  const r = await filmListen({
    input: join(dir, "score.wav"),
    stems,
    clips: true,
    chromePath: chrome ?? undefined,
  });
  assert.equal(r.md, join(dir, "score.listen", "listen.md"));
  const l = r.listen;
  assert.ok(Math.abs(l.duration - 12) < 0.01);
  assert.ok(l.loudness.integratedLufs != null && l.loudness.integratedLufs < 0);
  assert.ok(l.loudness.momentary.length > 100);
  // the land at 6.6 s has no sound; the clicks do
  assert.deepEqual(
    l.events.unvoiced.map((e) => e.t),
    [6.6],
  );
  // a cut on a beat (2.25) and one off it (4.4: the beats are at 4.25, 4.75)
  const cut = new Map(l.cuts.list.map((c) => [c.t, c.nearestOnset]));
  assert.equal(l.cuts.source, "events");
  assert.ok(Math.abs(cut.get(2.25)!) <= 0.006);
  assert.ok(Math.abs(cut.get(4.4)!) >= 0.1);
  // each click's sound is found in the action stem, over the music
  assert.equal(l.stems.eventWindows.length, 4);
  assert.ok(l.stems.eventWindows.every((w) => w.stem === "action" && w.overRestDb > 0));
  assert.ok(l.silences.list.some((s) => s.start >= 8.9 && s.end <= 10.1 && s.end - s.start > 0.5));
  assert.equal(l.curves.names[0], "zoom");
  for (const f of ["solo/action.m4a", "solo/music.m4a", "mute/action.m4a", "mute/music.m4a"])
    assert.ok(existsSync(join(dir, "score.listen", f)), f);
  const md = await readFile(r.md, "utf8");
  assert.match(md, /integrated -?[\d.]+ LUFS, .*\(measured\)/);
  assert.match(md, /tempo ≈ .*\(estimated\)/);
  assert.match(md, /4 of 5 events have a sound onset within 40 ms/);
  assert.match(md, /6\.60s land "card"/);
  assert.match(md, /"action": 4; it sits \+/);
  // information, not grades
  assert.doesNotMatch(md.replace(/score\.\w+/g, ""), /\b(score|pass|fail|good|bad|should)\b/i);
  const json = JSON.parse(await readFile(r.json, "utf8"));
  assert.equal(json.events.list.length, 5);
  if (chrome) {
    assert.ok(r.png && existsSync(r.png));
    const png = await readFile(r.png);
    assert.equal(png.readUInt32BE(16), 2922); // `film sheet`'s width for a landscape film
  } else assert.equal(r.png, null);
});

test("film listen without events or stems says what it did not measure", async () => {
  const { pcm } = groove();
  await writeFile(join(dir, "groove.wav"), wav(pcm));
  const r = await filmListen({ input: join(dir, "groove.wav"), out: join(dir, "g") });
  const md = await readFile(r.md, "utf8");
  assert.match(md, /no events file .*\(not measured\)/);
  assert.match(md, /needs --stems \(not measured\)/);
  assert.match(md, /no cuts known .*\(not measured\)/);
  assert.equal(r.png, null);
  await assert.rejects(filmListen({ input: join(dir, "nope.wav") }), /no file at/);
  await assert.rejects(
    filmListen({ input: join(dir, "groove.wav"), events: join(dir, "missing.json") }),
    /no events file/,
  );
});

test("film listen on a film whose sound ends before its picture: silence to the end, rows aligned", async () => {
  const ffmpeg = await resolveFfmpeg();
  const { pcm } = groove();
  await writeFile(join(dir, "short.wav"), wav(pcm.subarray(0, R * 4)));
  const film = join(dir, "short-sound.mp4");
  await runTool(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=320x180:r=30:d=8",
    "-i",
    join(dir, "short.wav"),
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-y",
    film,
  ]);
  const chrome = findChrome();
  const r = await filmListen({ input: film, chromePath: chrome ?? undefined });
  const l = r.listen;
  assert.ok(l.duration > 7.9);
  // the 4 s after the sound ends are silence on the film's time
  assert.ok(
    l.silences.list.some((s) => s.start <= 4.2 && s.end >= l.duration - 0.05),
    JSON.stringify(l.silences.list),
  );
  assert.ok(l.silences.list.every((s) => s.end <= l.duration));
  // a grey picture that never changes, read from the film (no events file)
  assert.equal(l.picture.source, "picture");
  assert.equal(l.picture.energy!.values.length, 240);
  assert.ok(l.picture.energy!.values.every((v) => v === 0));
  assert.equal(l.picture.halves.length, 16);
  if (chrome && r.png) {
    // the sections row (the sixth, under the picture's change, with no events,
    // stems or curves) is drawn where it belongs, not left showing tiles of
    // the rows above it
    const ppm = join(dir, "px.ppm");
    await runTool(ffmpeg, [
      "-v",
      "error",
      "-i",
      r.png,
      "-vf",
      "crop=1:1:130:604",
      "-pix_fmt",
      "rgb24",
      "-y",
      ppm,
    ]);
    const rgb = [...(await readFile(ppm)).subarray(-3)];
    // the first section's fill, #fff3bf
    assert.ok(
      Math.abs(rgb[0]! - 0xff) + Math.abs(rgb[1]! - 0xf3) + Math.abs(rgb[2]! - 0xbf) < 12,
      String(rgb),
    );
  }
});

test("film listen on silence says nothing was found", async () => {
  await writeFile(join(dir, "silent.wav"), wav(new Float32Array(R * 5)));
  const r = await filmListen({ input: join(dir, "silent.wav"), out: join(dir, "s") });
  assert.equal(r.listen.loudness.how, "not detected");
  assert.equal(r.listen.sections.list[0]!.centroidHz, 0);
  const md = await readFile(r.md, "utf8");
  assert.match(md, /nothing sounds above .*\(not detected\)/);
  assert.match(md, /0\.00s–5\.00s: silent/);
});

// --- beside a previous version (--vs) -------------------------------------------------

test("--vs pieces: the stretch that changed, the lag, the credits read leniently", () => {
  const { pcm } = groove();
  const changed = Float32Array.from(pcm);
  knock(changed, 5.1, 3000, 0.6);
  const a = spectrum(changed);
  const b = spectrum(pcm);
  const m = changedMoments(spectrumDiff(a, b), a.hopS, 16);
  assert.ok(m.length >= 1 && m[0]!.start <= 5.1 && m[0]!.end >= 5.2, JSON.stringify(m));
  assert.ok(m.every((x, i) => !i || x.diffDb <= m[i - 1]!.diffDb));
  // the moment stands well above what the two differ by anywhere
  assert.ok(typicalDiff(spectrumDiff(a, b), a.hopS, 16) < m[0]!.diffDb / 4);
  // the same sound: nothing differs
  assert.deepEqual(changedMoments(spectrumDiff(b, b), b.hopS, 16), []);
  assert.equal(typicalDiff(spectrumDiff(b, b), b.hopS, 16), 0);
  // the previous one 300 ms later
  const late = new Float32Array(pcm.length);
  late.set(pcm.subarray(0, pcm.length - Math.round(R * 0.3)), Math.round(R * 0.3));
  const lag = bestLag(onsetStrength(b), onsetStrength(spectrum(late)), b.hopS);
  assert.ok(lag != null && Math.abs(lag - 0.3) <= 0.015, String(lag));
  assert.equal(bestLag(onsetStrength(b), new Float32Array(1000), b.hopS), null);

  assert.equal(creditLines({ events: [] }), null);
  assert.equal(creditLines(null), null);
  assert.deepEqual(creditLines({ credits: "Music: me" }), ["Music: me"]);
  assert.deepEqual(
    creditLines({
      credits: [
        "a.wav — CC0",
        { title: "Click", by: "someone", license: "CC0", url: "https://x" },
        { text: "as written" },
        null,
      ],
    }),
    ["a.wav — CC0", "Click, by someone, CC0, https://x", "as written"],
  );
  // the shape `film render` writes (render.ts FilmCredit)
  assert.deepEqual(
    creditLines({
      credits: [
        { what: "font: Inter", licence: "OFL-1.1" },
        { what: "music", by: "me", text: "Music by me" },
      ],
    }),
    ["font: Inter, OFL-1.1", 'music, by me — "Music by me"'],
  );
  assert.deepEqual(creditLines({ credits: { music: "me" } }), ["music: me"]);
  assert.deepEqual(creditLines({ credits: [] }), []);
});

test("film listen --vs: what changed against the previous version, with A/B clips; credits printed", async () => {
  const sub = join(dir, "vs");
  await mkdir(sub, { recursive: true });
  const music = new Float32Array(R * 10);
  tone(music, 0, 10, 140, 0.15);
  for (let k = 0; k < 20; k++) knock(music, 0.25 + k * 0.5, 90, 0.3);
  // this version: clicks at 1.6, 3.1 and 7.6 (all off the beat); the previous: 1.6, 3.1 and one at the land (6.6)
  const now = Float32Array.from(music);
  const before = Float32Array.from(music);
  for (const t of [1.6, 3.1, 7.6]) knock(now, t, 2500, 0.5);
  for (const t of [1.6, 3.1, 6.6]) knock(before, t, 2500, 0.5);
  await writeFile(join(sub, "film.wav"), wav(now));
  await writeFile(join(sub, "previous.wav"), wav(before));
  await writeFile(
    join(sub, "film.events.json"),
    JSON.stringify({
      version: 1,
      duration: 10,
      fps: 60,
      events: [
        { t: 1.6, kind: "click" },
        { t: 3.1, kind: "click" },
        { t: 6.6, kind: "land", label: "card" },
        { t: 7.6, kind: "click" },
      ],
      cuts: [],
      credits: [{ what: "Click", by: "someone", licence: "CC0" }],
    }),
  );
  const r = await filmListen({ input: join(sub, "film.wav"), vs: join(sub, "previous.wav") });
  const v = r.listen.vs!;
  assert.ok(v, "a comparison");
  assert.deepEqual(
    v.events.gained.map((e) => e.t),
    [7.6],
  );
  assert.deepEqual(v.events.lost, [{ t: 6.6, kind: "land", label: "card" }]);
  assert.ok(
    v.onsets.onlyThis.some((t) => Math.abs(t - 7.6) < 0.01),
    String(v.onsets.onlyThis),
  );
  assert.ok(v.onsets.onlyPrevious.some((t) => Math.abs(t - 6.6) < 0.01));
  // the two moments that differ are the two clicks, nothing else
  assert.equal(v.moments.list.length >= 2, true, JSON.stringify(v.moments.list));
  for (const t of [6.6, 7.6])
    assert.ok(
      v.moments.list.slice(0, 2).some((m) => m.start <= t && m.end >= t + 0.1),
      `${t}: ${JSON.stringify(v.moments.list)}`,
    );
  assert.equal(v.offset.seconds, 0);
  for (const f of v.clips) assert.ok(existsSync(f), f);
  assert.ok(existsSync(join(sub, "film.listen", "vs", "aba.m4a")));
  assert.ok(existsSync(join(sub, "film.listen", "vs", "moment-1.previous.m4a")));
  const md = await readFile(r.md, "utf8");
  assert.match(md, /## Beside the previous version — previous\.wav/);
  assert.match(md, /gained a sound .*7\.60s click \(measured\)/);
  assert.match(md, /lost one .*6\.60s land "card" \(measured\)/);
  assert.match(md, /loudness: integrated this -?[\d.]+, previous -?[\d.]+ LUFS/);
  assert.match(md, /## Credits[^\n]*\n\n- Click, by someone, CC0/);
  assert.match(md, /the median stretch differs by [\d.]+ dB/);
  assert.ok(v.moments.typicalDb < v.moments.list[0]!.diffDb);
  assert.doesNotMatch(md, /\b(pass|fail|good|bad|should|better|worse)\b/i);
  await assert.rejects(
    filmListen({ input: join(sub, "film.wav"), vs: join(sub, "nope.wav"), out: join(sub, "x") }),
    /no file at .*--vs/,
  );
});

test("the picture's change against the sound: half-seconds, the top five, where they run opposite", () => {
  // the curve from the events file, by name, wherever it is among the page's
  const ev = parseFilmEvents({
    fps: 2,
    duration: 2,
    curves: {
      names: ["v", "picture.energy"],
      t0: 0,
      dt: 0.5,
      rows: [
        [1, 0],
        [1, 0.2],
        [1, null],
      ],
    },
  });
  assert.deepEqual(pictureEnergyOf(ev), { t0: 0, dt: 0.5, values: [0, 0.2, Number.NaN] });
  assert.equal(pictureEnergyOf(parseFilmEvents({ curves: { names: ["v"], rows: [[1]] } })), null);
  assert.equal(pictureEnergyOf(null), null);

  // 10 s: the sound loud in the middle and down at 8 s, the picture busy at the
  // start and at 8 s; elsewhere both at their usual level
  const momentary = Array.from({ length: 100 }, (_, i) => {
    const t = (i + 1) / 10;
    const c = t - 0.2;
    return { t, lufs: c >= 4 && c < 7 ? -12 : c < 1 ? -120 : c >= 8 && c < 8.5 ? -40 : -30 };
  });
  const fps = 10;
  const values = Array.from({ length: 100 }, (_, i) => {
    const t = i / fps;
    return t < 2 ? 0.02 : t >= 8 && t < 8.5 ? 0.05 : t >= 4 && t < 7 ? 0.001 : 0.005;
  });
  const halves = halfSeconds(momentary, { t0: 0, dt: 1 / fps, values }, 10);
  assert.equal(halves.length, 20);
  assert.deepEqual(halves[0], { t: 0, lufs: -120, energy: 0.02 });
  assert.deepEqual(halves[10], { t: 5, lufs: -12, energy: 0.001 });
  assert.deepEqual(halves[16], { t: 8, lufs: -40, energy: 0.05 });
  const a = pictureAgainstSound(halves);
  assert.equal(a.top, 5);
  assert.deepEqual(a.loudest, [4, 4.5, 5, 5.5, 6]);
  assert.deepEqual(a.busiest, [8, 0, 0.5, 1, 1.5]);
  assert.equal(a.shared, 0);
  assert.deepEqual(
    a.opposite.map((o) => [o.from, o.to, o.kind]),
    // a stretch runs on through the pieces at the usual level (here just over
    // the picture's median, just under the sound's) next to where they are opposite
    [
      [0, 4, "busy-quiet"],
      [4, 7, "still-loud"],
      [7, 10, "busy-quiet"],
    ],
  );
  assert.equal(a.opposite[1]!.lufs, -12);
  const lines = formatPictureAgainst({
    picture: {
      how: "measured",
      source: "events",
      energy: { t0: 0, dt: 0.1, values },
      halves,
      against: a,
    },
  });
  assert.match(
    lines[0]!,
    /the events file's "picture\.energy"\): per half-second, median .* most 0\.050 at 8\.0s–8\.5s/,
  );
  assert.match(
    lines[1]!,
    /^- the 5 loudest half-seconds vs the 5 busiest half-seconds of picture: 0 shared; loudest at 4\.0s/,
  );
  assert.match(
    lines[2]!,
    /0\.0s–4\.0s the picture busy \(0\.01\d\) while the sound is quiet .*; 4\.0s–7\.0s the picture changing little frame to frame \(0\.0010\) while the sound is loud \(-12 LUFS\); 7\.0s–10\.0s/,
  );
  // the two together: nothing opposite
  const same = halfSeconds(
    momentary,
    { t0: 0, dt: 1 / fps, values: values.map((_, i) => (i >= 40 && i < 70 ? 0.05 : 0.001)) },
    10,
  );
  const b = pictureAgainstSound(same);
  assert.equal(b.shared, 5);
  assert.deepEqual(b.opposite, []);
  assert.match(
    formatPictureAgainst({
      picture: {
        how: "measured",
        source: "picture",
        energy: { t0: 0, dt: 0.1, values },
        halves: same,
        against: b,
      },
    })[2]!,
    /nowhere \(not detected\)/,
  );
  // no picture: said
  assert.match(
    formatPictureAgainst({
      picture: { how: "not measured", source: "none", energy: null, halves: [], against: null },
    })[0]!,
    /no picture and no "picture\.energy" curve \(not measured\)/,
  );
});
