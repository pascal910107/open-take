// <film>.events.json: what the page says happens (window.__film.events), its
// curves sampled once a frame (window.__film.curves), and the cuts — written
// beside every render for the score to read (kit/audio.mjs readEvents). The
// browser tests need Chrome for Testing and skip without it.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { curveOf, readEvents } from "../kit/audio.mjs";
import { speed, timeline } from "../kit/time.js";
import {
  checkEvents,
  eventsPathFor,
  type FilmEvents,
  filmEvents,
  patchEvents,
  patchFilm,
  renderFilm,
} from "../src/film/render";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-events-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (file: string) => JSON.parse(await readFile(file, "utf8")) as FilmEvents;

test("the events file goes beside the film, named after it", () => {
  assert.equal(eventsPathFor("/a/film.mp4"), "/a/film.events.json");
  assert.equal(eventsPathFor("/a.b/film"), "/a.b/film.events.json");
  assert.equal(eventsPathFor("/a/film.v2.mp4"), "/a/film.v2.events.json");
});

test("a page's events: checked, in time order, the bad ones left out and said so", () => {
  const warnings: string[] = [];
  const ev = checkEvents(
    [
      { t: 2, kind: "click", x: 10, y: 20, force: 3, label: "go" },
      { t: 1, kind: "key", x: "no" },
      { t: 1, kind: "land" },
      { kind: "key" },
      { t: Number.NaN, kind: "key" },
      { t: 3 },
      null,
    ],
    warnings,
  );
  assert.deepEqual(ev, [
    { t: 1, kind: "key" },
    { t: 1, kind: "land" },
    { t: 2, kind: "click", x: 10, y: 20, force: 1, label: "go" },
  ]);
  assert.match(warnings.join("\n"), /4 event\(s\) without a time/);
  assert.deepEqual(checkEvents(null), []);
  const w2: string[] = [];
  assert.deepEqual(checkEvents({ t: 1 }, w2), []);
  assert.match(w2[0]!, /no list/);
});

test("cuts: the page's own and where the probe found a frame's shutter change on one side", () => {
  const film = { fps: 10, f0: 0, f1: 10, total: 10 };
  const sides = [0, 0, 1, 0, 0, -1, 0, 0, 0, -1];
  const rows = Array.from({ length: 10 }, (_, i) =>
    i === 4 ? null : { zoom: 1 + i / 10, speed: i === 3 ? null : i },
  );
  const ev = filmEvents(
    film,
    [
      { t: 0.2, kind: "cut" },
      { t: 0.8, kind: "cut" },
      { t: 0.5, kind: "click" },
    ],
    sides,
    rows,
    true,
  );
  assert.equal(ev.version, 1);
  assert.equal(ev.duration, 1);
  assert.equal(ev.range, undefined, "the whole film");
  // side 1 at frame 2: frame 2 is the new picture; side -1 at frame 5: frame 6
  // is; side -1 on the last frame has no next frame
  assert.deepEqual(ev.detectedCuts, [0.2, 0.6]);
  assert.deepEqual(ev.declaredCuts, [0.2, 0.8]);
  assert.deepEqual(ev.cuts, [0.2, 0.6, 0.8], "the same cut, declared and found, once");
  assert.deepEqual(ev.curves.names, ["zoom", "speed"]);
  assert.equal(ev.curves.t0, 0);
  assert.equal(ev.curves.dt, 0.1);
  assert.equal(ev.curves.rows.length, 10);
  assert.deepEqual(ev.curves.rows[3], [1.3, null]);
  assert.deepEqual(ev.curves.rows[4], [null, null], "a frame the page gave nothing");
  // not probed (a draft): nothing is found, the page's cuts still are there
  const draft = filmEvents(film, [{ t: 0.2, kind: "cut" }], sides, [], false);
  assert.deepEqual(draft.detectedCuts, []);
  assert.deepEqual(draft.cuts, [0.2]);
  assert.deepEqual(draft.curves, { names: [], t0: 0, dt: 0.1, rows: [] });
  // a range: its rows start where it does
  const part = filmEvents(
    { fps: 10, f0: 5, f1: 8, total: 10 },
    [],
    [1, 0, 0],
    [{ a: 1 }, { a: 2 }, { a: 3 }],
    true,
  );
  assert.deepEqual(part.range, [0.5, 0.8]);
  assert.equal(part.curves.t0, 0.5);
  assert.deepEqual(part.detectedCuts, [0.5]);
});

test("a range put into a master: its curves and found cuts in place of the master's there", () => {
  const master = filmEvents(
    { fps: 10, f0: 0, f1: 10, total: 10 },
    [{ t: 0.1, kind: "cut" }],
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
    Array.from({ length: 10 }, (_, i) => ({ v: i })),
    true,
  );
  const range = filmEvents(
    { fps: 10, f0: 2, f1: 5, total: 10 },
    [{ t: 0.9, kind: "cut" }],
    [0, 0, 1],
    [
      { v: 102, w: 1 },
      { v: 103, w: 1 },
      { v: 104, w: 1 },
    ],
    true,
  );
  const p = patchEvents(master, range)!;
  assert.equal(p.range, undefined);
  assert.deepEqual(p.events, [{ t: 0.9, kind: "cut" }], "the page's events as they are now");
  assert.deepEqual(p.detectedCuts, [0.4, 0.7], "0.3 was in the range and is gone; 0.4 is new");
  assert.deepEqual(p.cuts, [0.4, 0.7, 0.9]);
  assert.deepEqual(p.curves.names, ["v", "w"]);
  assert.deepEqual(
    p.curves.rows.map((r) => r[0]),
    [0, 1, 102, 103, 104, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(p.curves.rows[0], [0, null]);
  assert.deepEqual(p.curves.rows[3], [103, 1]);
  // not this master: another rate, or a range of its own
  assert.equal(patchEvents({ ...master, fps: 30 }, range), null);
  assert.equal(patchEvents(range, range), null);
});

test("the timeline declares events and curves for the page to hand over", () => {
  const tl = timeline({ at: { hook: 0, search: 2.5 } });
  assert.equal(tl.bpm, undefined, "no tempo unless the film chooses one");
  assert.throws(() => tl.beat(1), /no bpm/);
  assert.equal(tl.event("search", "click", { x: 640, y: 380, force: 1.4, label: "Search" }), 2.5);
  tl.event(2.6, "key", { label: "s" });
  tl.event(0, "land");
  assert.throws(() => tl.event("nope", "click"), /no moment named/);
  assert.throws(() => tl.event(1, "click", { x: Number.NaN }), /x is NaN/);
  assert.throws(() => tl.event(1, ""), /needs a kind/);
  assert.deepEqual(tl.events(), [
    { t: 0, kind: "mark", label: "hook", id: "hook" },
    { t: 0, kind: "land" },
    { t: 2.5, kind: "mark", label: "search", id: "search" },
    { t: 2.5, kind: "click", x: 640, y: 380, force: 1, label: "Search" },
    { t: 2.6, kind: "key", label: "s" },
  ]);
  tl.curve("zoom", (t) => 1 + t);
  tl.curve("gone", () => Number.NaN);
  tl.curve(
    "pos",
    speed((t) => ({ x: 300 * t, y: 400 * t })),
  );
  const c = tl.curves(1);
  assert.equal(c.zoom, 2);
  assert.ok(!("gone" in c), "a curve with no number at t is left out");
  assert.ok(Math.abs(c.pos! - 500) < 1e-6, `speed by difference (${c.pos})`);
  const hooks = tl.hooks();
  assert.equal(hooks.events().length, 5);
  assert.equal(hooks.curves(0).zoom, 1);
  assert.throws(() => timeline({ bpm: 0 }), /bpm/);
  assert.equal(timeline({ bpm: 90 }).beat(3), 2);
});

/** a 1 s page, 64×64 at 30 fps, that cuts at 0.5 s; kit/time.js beside it */
/** `hooks`: the kit's (true), none (false), or a script of the page's own */
async function eventPage(page: string, opts: { hooks: boolean | string; curveBase?: number }) {
  await mkdir(join(page, "kit"), { recursive: true });
  await copyFile(join(import.meta.dirname, "..", "kit", "time.js"), join(page, "kit", "time.js"));
  const hooks =
    typeof opts.hooks === "string"
      ? opts.hooks
      : opts.hooks
        ? `tl.event("cut", "cut");
tl.event(0.2, "click", { x: 16, y: 32, force: 0.5, label: "go" });
tl.curve("v", (t) => ${opts.curveBase ?? 0} + t);
Object.assign(window.__film, tl.hooks());`
        : "";
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:64px;height:64px;overflow:hidden;background:#000}
div{position:absolute;left:8px;top:8px;width:30px;height:30px}</style></head><body>
<div id="a" style="background:#f00"></div><div id="b" style="background:#00f;display:none"></div>
<script type="module">
import { timeline } from "./kit/time.js";
const tl = timeline({ at: { cut: 0.5 } });
window.__film = { duration: 1, width: 64, height: 64, fps: 30 };
${hooks}
window.__render = (t) => {
  const after = t >= tl.t("cut");
  document.getElementById("a").style.display = after ? "none" : "block";
  document.getElementById("b").style.display = after ? "block" : "none";
};
</script></body></html>`,
  );
}

test("a render writes the page's events, its curves once a frame and the cuts beside the film", {
  skip,
}, async () => {
  const page = join(dir, "events");
  await eventPage(page, { hooks: true });
  const out = join(dir, "events.mp4");
  const r = await renderFilm({ page, out, chromePath: chrome!, workers: 2, audio: null });
  assert.equal(r.events, join(dir, "events.events.json"));
  const ev = readEvents(r.events!);
  assert.equal(ev.duration, 1);
  assert.equal(ev.fps, 30);
  assert.deepEqual(
    ev.events.map((e) => [e.t, e.kind]),
    [
      [0.2, "click"],
      [0.5, "mark"],
      [0.5, "cut"],
    ],
  );
  assert.deepEqual(ev.events[0], { t: 0.2, kind: "click", x: 16, y: 32, force: 0.5, label: "go" });
  assert.deepEqual(ev.declaredCuts, [0.5]);
  // the blur probe saw the picture change in the first half of frame 15's shutter
  assert.deepEqual(ev.detectedCuts, [0.5]);
  assert.deepEqual(ev.cuts, [0.5]);
  assert.deepEqual(ev.curves.names, ["v"]);
  assert.equal(ev.curves.rows.length, 30, "one row a frame");
  for (const [i, row] of ev.curves.rows.entries())
    assert.ok(Math.abs(row[0]! - i / 30) < 1e-9, `frame ${i}`);
  const v = curveOf(ev, "v", (x) => x * 2);
  assert.ok(Math.abs(v(0.25) - 0.5) < 1e-9, "linear between frames");
  assert.equal(v(5), (29 / 30) * 2, "held past the end");
  assert.throws(() => curveOf(ev, "nope"), /has no curve "nope" \(it has: v\)/);
});

test("without the hooks the file is still written, with nothing in it but the cuts found", {
  skip,
}, async () => {
  const page = join(dir, "bare");
  await eventPage(page, { hooks: false });
  const out = join(dir, "bare.mp4");
  const r = await renderFilm({ page, out, chromePath: chrome!, workers: 1, audio: null });
  const ev = await read(r.events!);
  assert.deepEqual(ev.events, []);
  assert.deepEqual(ev.declaredCuts, []);
  assert.deepEqual(ev.cuts, [0.5], "the clock's own cut");
  assert.deepEqual(ev.curves, { names: [], t0: 0, dt: 1 / 30, rows: [] });
  // a draft probes nothing: no cut is found
  const d = await renderFilm({
    page,
    out: join(dir, "bare-draft.mp4"),
    chromePath: chrome!,
    draft: true,
    audio: null,
  });
  assert.deepEqual((await read(d.events!)).cuts, []);
});

test("hooks that throw or are not functions cost the film nothing: said, and left out", {
  skip,
}, async () => {
  const page = join(dir, "broken");
  await eventPage(page, {
    hooks: `window.__film.events = () => { throw new Error("nope"); };
window.__film.curves = (t) => { if (t > 0.5) throw new Error("late"); return { v: t }; };`,
  });
  const r = await renderFilm({
    page,
    out: join(dir, "broken.mp4"),
    chromePath: chrome!,
    draft: true,
    workers: 1,
    audio: null,
  });
  const ev = await read(r.events!);
  assert.deepEqual(ev.events, []);
  assert.ok(r.warnings.some((w) => /^window\.__film\.events threw .*nope/.test(w)));
  assert.ok(r.warnings.some((w) => /^window\.__film\.curves threw/.test(w)));
  assert.equal(ev.curves.rows.length, 30, "a row for every frame");
  assert.equal(ev.curves.rows[3]![0], 0.1);
  assert.equal(ev.curves.rows[29]![0], null, "where it threw");
  const listed = join(dir, "listed");
  await eventPage(listed, { hooks: `window.__film.events = [{ t: 0.2, kind: "click" }];` });
  const l = await renderFilm({
    page: listed,
    out: join(dir, "listed.mp4"),
    chromePath: chrome!,
    draft: true,
    audio: null,
  });
  assert.deepEqual((await read(l.events!)).events, []);
  assert.ok(l.warnings.some((w) => /events is not a function/.test(w)));
});

test("a range rendered into a master puts its curves into the master's events file", {
  skip,
}, async () => {
  const page = join(dir, "patched");
  await eventPage(page, { hooks: true });
  const master = join(dir, "patched.mp4");
  await renderFilm({ page, out: master, chromePath: chrome!, blur: false, audio: null });
  await eventPage(page, { hooks: true, curveBase: 100 });
  const r = await patchFilm({
    page,
    out: master,
    into: master,
    from: 0.2,
    to: 0.4,
    chromePath: chrome!,
    blur: false,
  });
  assert.equal(r.events, join(dir, "patched.events.json"));
  const ev = await read(r.events!);
  assert.equal(ev.range, undefined);
  assert.equal(ev.curves.rows.length, 30);
  const v = ev.curves.rows.map((row) => row[0]!);
  assert.ok(Math.abs(v[5]! - 5 / 30) < 1e-9, "before the range: as it was");
  assert.ok(Math.abs(v[6]! - (100 + 6 / 30)) < 1e-9, "the range: new");
  assert.ok(Math.abs(v[11]! - (100 + 11 / 30)) < 1e-9, "its last frame: new");
  assert.ok(Math.abs(v[12]! - 12 / 30) < 1e-9, "after it: as it was");
});
