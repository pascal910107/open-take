// The starter's information layer (starter/lib/hud.js) as numbers, with no
// page: each piece's at(t) is a function of film time — the same t gives the
// same answer in any order — and keeps the timings it says it measured: a
// chip grows from a dot and opens in 6 frames, changes by closing and
// reopening, retracts and is gone; a typing runs fast then slow and lands
// its last character when it says; a voice's words land 3–16 frames apart
// and say how much of the line is out, for the prompt that carries it on; a
// press holds 4 frames at 0.61×; a detection box counts in 2-frame steps; an
// agent's label rides its point and leaves in 3 frames; a 3D point lands
// where a camera sees it. Counts in frames land on the frame they say at 24,
// 30 and 60 fps, read at the renderer's own frame times. Then, in Chrome, an
// upright film on a light and a dark scene.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import * as H from "../starter/lib/hud.js";
import { findChrome } from "./fixtures/find-chrome";

const F = 1 / 24;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const FPS = [24, 30, 60];
/** the renderer's time of frame n after a start on the frame grid */
const frameAt = (t0: number, n: number, fps: number) => (Math.round(t0 * fps) + n) / fps;
/** whole 24 fps frames in n frames at fps, by integers */
const frames24 = (n: number, fps: number) => Math.floor((n * 24) / fps);
/** starts on the grid of every fps tested */
const STARTS = [0, 0.5, 1.25, 2.2, 4.75, 6.4, 8, 9.3].filter((t0) => FPS.every((fps) => near(t0 * fps, Math.round(t0 * fps), 1e-9)));

test("chip: dot → capsule in 2 + 6 frames, a change closes and reopens, out retracts to nothing", () => {
  const c = H.chip(null, {
    steps: [
      { t: 1, text: "Drafting the blueprint" },
      { t: 3, text: "Building pages", x: 1400 },
    ],
    out: 5,
    frame: { width: 1920, height: 1080 },
  });
  assert.equal(c.el, null);
  assert.equal(c.at(0.99).visible, false, "nothing before its first step");
  const born = c.at(1 + F);
  assert.ok(born.visible && born.scale > 0 && born.scale < 1 && born.open === 0, "a dot growing");
  assert.equal(c.at(1 + 2 * F).scale, 1);
  assert.ok(c.at(1 + 5 * F).open > 0 && c.at(1 + 5 * F).open < 1, "opening");
  assert.equal(c.at(1 + 8 * F).open, 1, "open after 2 + 6 frames");
  assert.equal(c.at(2).text, "Drafting the blueprint");
  // the change: the old text closes over 4 frames, the new one opens after
  const closing = c.at(3 + 2 * F);
  assert.equal(closing.text, "Drafting the blueprint");
  assert.ok(closing.open < 1);
  assert.equal(c.at(3 + 4 * F).text, "Building pages");
  assert.equal(c.at(3 + 4 * F).open, 0, "a circle at the change");
  assert.equal(c.at(4).open, 1);
  // it slides to the new place in 7 frames, from where it was
  assert.equal(c.at(2).x, Math.round(0.035 * 1920));
  assert.ok(c.at(3 + 3 * F).x > c.at(2).x && c.at(3 + 3 * F).x < 1400);
  assert.ok(near(c.at(3 + 7 * F).x, 1400));
  // out: closed in 4 frames, a dot shrinking in 3, then gone on the 7th frame
  assert.ok(c.at(5 + 2 * F).open < 1);
  assert.ok(c.at(5 + 5 * F).scale < 1 && c.at(5 + 5 * F).visible);
  assert.equal(c.at(5 + 7 * F).visible, false);
  // the same t, the same answer, in any order
  const first = c.at(3.05);
  c.at(4.7);
  c.at(0.2);
  assert.deepEqual(first, c.at(3.05));
});

test("chip, open: the new text shows on the frame the change's 4 frames end, at 24, 30 and 60 fps", () => {
  for (const fps of FPS)
    for (const t0 of STARTS) {
      const c = H.chip(null, { steps: [{ t: t0, text: "one" }, { t: t0 + 1, text: "two" }], frame: { width: 1920, height: 1080 } });
      for (let n = 0; n < 12; n++) {
        const t = frameAt(t0 + 1, n, fps);
        const want = frames24(n, fps) >= 4 ? "two" : "one";
        assert.equal(c.at(t).text, want, `${fps} fps from ${t0}: frame ${n}`);
      }
    }
});

test("chip, mode type: typed at ~125 a second, deleted at ~110, a line exit for mode open", () => {
  const c = H.chip(null, { t: 0, text: "Rigging", mode: "type", out: 2 });
  assert.equal(c.at(2 * F).text, "");
  assert.equal(c.at(2 * F + 3 / 125).text, "Rig");
  assert.equal(c.at(1).text, "Rigging");
  assert.equal(c.at(2 + 2 / 110).text, "Riggi", "deleted from the end");
  assert.equal(c.at(2 + 7 / 110 + 3 * F).visible, false);
  const l = H.chip(null, { t: 0, text: "Assembling game", exit: "line", out: 1 });
  assert.ok(l.at(1 + 5 * F).scaleY < 1 && l.at(1 + 5 * F).scaleY > 0.06);
  assert.equal(l.at(1 + 10 * F).visible, false, "a line, then gone, in 10 frames");
  // typed on the frame the count says, at each rate
  for (const fps of FPS)
    for (const t0 of STARTS) {
      const k = H.chip(null, { t: t0, text: "x".repeat(300), mode: "type" });
      for (let n = 2; n < 40; n++) {
        const want = Math.floor(((n * 24 - 2 * fps) * 125) / (24 * fps));
        assert.equal(k.at(frameAt(t0, n, fps)).text.length, Math.max(0, want), `${fps} fps from ${t0}: frame ${n}`);
      }
    }
});

test("chip, mode type: out or a change before the typing is done deletes what is on screen, never more", () => {
  const text = "Generating the whole level geometry now";
  const c = H.chip(null, { t: 0, text, mode: "type", out: 0.2 });
  const atOut = c.at(0.2).text.length;
  assert.ok(atOut > 0 && atOut < text.length, "out comes mid-typing");
  let last = atOut;
  for (let t = 0.2; t < 0.6; t += 1 / 60) {
    const n = c.at(t).text.length;
    assert.ok(n <= last, `never grows on the way out: ${n} after ${last} at ${t.toFixed(3)}`);
    last = n;
  }
  assert.equal(c.at(0.2 + atOut / 110 + 3 * F).visible, false, "deleted, shrunk, gone");
  const s = H.chip(null, { steps: [{ t: 0, text: "Drafting the blueprint for everything" }, { t: 0.2, text: "Build" }], mode: "type" });
  const before = s.at(0.2 - 1 / 60).text;
  const after = s.at(0.2).text;
  assert.ok(after.length <= before.length + 2, `no jump to the whole old text at the change: ${JSON.stringify(after)}`);
  assert.ok("Drafting the blueprint for everything".startsWith(after));
  assert.equal(s.at(2).text, "Build");
});

test("typeAt: the measured curve runs fast then slow; even runs evenly; from carries a line on", () => {
  const text = "Make a AAA game. Location: Miami Beach. Now";
  const ty = H.typeAt(0, 0, text);
  assert.equal(ty.n, 0);
  assert.ok(near(ty.end, text.length / 48), "48 characters a second on average");
  const n = (t: number) => H.typeAt(t, 0, text).n;
  const firstHalf = n(ty.end / 2);
  assert.ok(firstHalf > text.length * 0.7, `fast first: ${firstHalf} of ${text.length} in the first half`);
  assert.equal(n(ty.end), text.length);
  assert.equal(n(ty.end + 5), text.length);
  for (let t = 0; t < ty.end; t += 0.01) assert.ok(n(t + 0.01) >= n(t), "never takes a character back");
  // each character's birth is the first moment it is on screen
  for (const i of [0, 10, 30, text.length - 1]) {
    const b = ty.born(i);
    assert.ok(H.typeAt(b + 1e-6, 0, text).n > i, `character ${i} there at its birth`);
    assert.ok(H.typeAt(b - 1e-3, 0, text).n <= i, `character ${i} not there before`);
  }
  const even = H.typeAt(0.5, 0, "that flies across the map", { curve: "even" });
  assert.equal(even.n, 12, "24 a second: 12 characters in 0.5 s");
  const carried = H.typeAt(1, 1, "Make it fly across the map", { from: 12 });
  assert.equal(carried.text, "Make it fly ", "the part already said is there at once");
  assert.equal(carried.born(3), -Infinity);
  assert.ok(near(carried.end, 1 + 14 / 48));
  // a character a frame on the frame, at each rate
  for (const fps of FPS)
    for (const t0 of STARTS)
      for (let k = 0; k < 30; k++)
        assert.equal(H.typeAt(frameAt(t0, k, fps), t0, "x".repeat(40), { curve: "even" }).n, frames24(k, fps), `${fps} fps from ${t0}: frame ${k}`);
});

test("typeAt and inkHtml count the characters a reader sees: an emoji is one, never half", () => {
  const ty = H.typeAt(1 / 48, 0, "🙂a");
  assert.equal(ty.text, "🙂");
  for (let t = 0; t < 0.1; t += 0.002) assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(H.typeAt(t, 0, "a🙂b👍🏽c").text), "no lone half");
  const html = H.inkHtml(1 / 48, ty);
  assert.match(html, /🙂/);
  assert.ok(!html.includes("�"));
  assert.equal(H.typeAt(10, 0, "👍🏽ok").n, 3, "a skin-toned thumb is one");
  assert.throws(() => H.typeAt(1, 0, "", { cps: 0 }), /cps/, "no rate is an error, not NaN");
});

test("inkHtml: the newest characters warm, cooling to ink; escaped; any CSS colour", () => {
  const ty = H.typeAt(0.2, 0, "a <b> & c", { curve: "even", cps: 24 });
  const html = H.inkHtml(0.2, ty, { ink: "#ffffff", fresh: "#ff0000" });
  assert.ok(!html.includes("<b>"), "text escaped");
  assert.match(html, /&lt;/);
  assert.match(html, /rgb\(255, \d+, \d+\)/, "fresh characters coloured");
  const later = H.inkHtml(5, H.typeAt(5, 0, "abc"), { ink: "#ffffff" });
  assert.equal(later, "abc", "settled text is plain");
  // a named colour is that colour, not black
  const named = H.inkHtml(0.05, H.typeAt(0.05, 0, "hello", { curve: "even" }), { ink: "white", fresh: "orange" });
  assert.match(named, /color:rgb\(255, (1[6-9]\d|2\d\d), \d+\)/, named);
  assert.deepEqual(H.readColour("orange"), [255, 165, 0, 1]);
  assert.deepEqual(H.readColour("rgb(10 20 30 / 50%)"), [10, 20, 30, 0.5]);
  assert.deepEqual(H.readColour("rgba(10, 20, 30, 0.25)"), [10, 20, 30, 0.25]);
  assert.deepEqual(H.readColour("#0f08"), [0, 255, 0, 136 / 255]);
  assert.deepEqual(H.readColour("hsl(0, 100%, 50%)")?.map(Math.round), [255, 0, 0, 1]);
  assert.equal(H.readColour("not-a-colour"), null);
  assert.throws(() => H.inkHtml(0.05, H.typeAt(0.05, 0, "hi", { curve: "even" }), { fresh: "not-a-colour" }), /not a colour/);
});

test("voice: words 3–16 frames apart, white in 2 frames, gone a frame before the cut; chars for the carry", () => {
  const v = H.voice(null, { t: 1, text: "Make it fly across the map", until: 4 });
  assert.equal(v.times.length, 6);
  assert.ok(near(v.times[0]!, 1.2));
  for (let i = 1; i < v.times.length; i++) {
    const gap = v.times[i]! - v.times[i - 1]!;
    assert.ok(gap >= 3 * F - 1e-9 && gap <= 16 * F + 1e-9, `gap ${gap}`);
  }
  assert.equal(v.at(0.9).visible, false);
  assert.ok(v.at(1 + F).orb > 0 && v.at(1 + F).orb < 1, "the orb grows over 2 frames");
  const w0 = v.at(1.2 + F).words[0]!;
  assert.ok(w0.shown && w0.white > 0 && w0.white < 1, "grey → white over 2 frames");
  assert.equal(v.at(1.2 + 2 * F).words[0]!.white, 1);
  assert.equal(v.at(1.21).words[1]!.shown, false);
  assert.equal(v.at(4 - F).visible, false, "gone a frame before the cut");
  assert.equal(v.at(4 - 2 * F).visible, true);
  assert.equal(v.chars(1.1), 0);
  assert.equal(v.chars(v.times[2]!), "Make it fly ".length, "three words said, and the space after");
  assert.equal(v.chars(10), v.text.length);
  const given = H.voice(null, { t: 0, text: "one two", times: [0.5, 1.5] });
  assert.deepEqual(given.times, [0.5, 1.5]);
  // played back and forth, the same bars for the same t
  const once = given.at(1).bars;
  given.at(2);
  given.at(0.3);
  assert.deepEqual(given.at(1).bars, once, "bars the same for the same t, after a rewind");
  // a word given a frame's time is shown on that frame
  for (const fps of FPS) {
    const w = H.voice(null, { t: 0, text: "a b c", times: [frameAt(0, 7, fps), frameAt(0.5, 3, fps), frameAt(1.25, 1, fps)] });
    assert.equal(w.at(7 / fps).said, 1, `${fps} fps`);
    assert.equal(w.at(6 / fps).said, 0, `${fps} fps`);
  }
});

test("prompt: rises in 3 frames, presses 2 / holds 4 / lets go in 3 at 0.61×, closes in when asked", () => {
  const p = H.prompt(null, { t: 0, text: "Make a AAA game", send: 2, collapse: true, frame: { width: 1920, height: 1080 } });
  assert.ok(p.at(F).y > 540, "rising");
  assert.equal(p.at(3 * F).y, 540);
  assert.equal(p.at(1.9).press, 1);
  assert.ok(near(p.at(2 + 2 * F).press, 0.61));
  assert.ok(near(p.at(2 + 5 * F).press, 0.61));
  assert.equal(p.at(2 + 3 * F).pressed, true);
  assert.equal(p.at(2 + 9 * F).press, 1, "no rebound past 1");
  assert.ok(p.at(2 + 9 * F + 0.01).press <= 1);
  assert.ok(p.at(2 + 4 * F).wave != null);
  assert.equal(p.at(2 + 10 * F).wave, null);
  const w = Math.round(0.62 * 1920);
  assert.equal(p.at(2 + 6 * F).w, w);
  assert.ok(near(p.at(2 + 11 * F).w, w * 0.63));
  assert.ok(p.at(2 + 3 * F).burst?.visible, "the burst on send");
  assert.equal(p.at(1.5).typed.text, "Make a AAA game");
  // held on frames 2–5 after the send, on the frame, at each rate
  for (const fps of FPS)
    for (const t0 of STARTS) {
      const q = H.prompt(null, { t: 0, text: "x", send: t0 + 1, frame: { width: 1920, height: 1080 } });
      for (let n = -1; n < 12; n++) {
        const k = frames24(n, fps);
        assert.equal(q.at(frameAt(t0 + 1, n, fps)).pressed, k >= 2 && k < 6, `${fps} fps from ${t0 + 1}: frame ${n}`);
      }
    }
});

test("prompt: the light wave crosses about 640 px of a 1920 frame in 8 frames, right to left", () => {
  const p = H.prompt(null, { t: 0, text: "x", send: 1, frame: { width: 1920, height: 1080 } });
  const start = p.at(1 + F).waveX!;
  const end = p.at(1 + 9 * F - 1e-5).waveX!;
  assert.ok(near(start, 960 + Math.round(0.62 * 1920) / 2), "from the box's right end");
  assert.ok(Math.abs(start - end - 640) < 1, `640 px: ${start - end}`);
  const tall = H.prompt(null, { t: 0, text: "x", send: 1, frame: { width: 1080, height: 1920 } });
  assert.ok(Math.abs(tall.at(1 + F).waveX! - tall.at(1 + 9 * F - 1e-5).waveX! - 360) < 1, "a third of the frame's width");
});

test("burst: 1.2 % of the frame to 12 % in 5 frames, then thinning out", () => {
  const b = H.burst(null, { t: 1, at: [960, 540], frame: { width: 1920, height: 1080 } });
  const A = 1920 * 1080;
  const share = (t: number) => (Math.PI * b.at(t).r ** 2) / A;
  assert.equal(b.at(0.99).visible, false);
  assert.ok(near(share(1), 0.012, 1e-6));
  assert.ok(near(share(1 + 5 * F), 0.12, 1e-6));
  assert.ok(b.at(1 + 9 * F).level < 1);
  assert.equal(b.at(1 + 14 * F).visible, false);
  assert.equal(b.at(1 + 13 * F).visible, true);
});

test("burst: as large against an upright film's width, small squares, never past the frame's edge", () => {
  const wide = H.burst(null, { t: 1, at: [960, 540], frame: { width: 1920, height: 1080 } });
  const tall = H.burst(null, { t: 1, at: [540, 960], frame: { width: 1080, height: 1920 } });
  assert.ok(near(tall.at(1 + 5 * F).r, wide.at(1 + 5 * F).r, 1e-6), "the same size against the short side");
  // a send button 60 px from the right edge of an upright film
  const edge = H.burst(null, { t: 1, at: [1020, 1500], frame: { width: 1080, height: 1920 } });
  for (let k = 0; k <= 13; k++) {
    const a = edge.at(1 + k * F);
    assert.ok(a.x + a.r <= 1080 - 0.02 * 1080 + 1e-6 || a.r <= 0.02 * 1080 + 1e-6, `frame ${k}: r ${a.r}`);
  }
  // squares of 0.02 of the short side: about 25 across at its widest
  const across = (2 * wide.at(1 + 5 * F).r) / Math.round(0.02 * 1080);
  assert.ok(across > 20 && across < 30, `${across} across`);
});

test("agent: pops in over 3 frames from its own, rides its point, leaves in 3; hidden while its point is off", () => {
  const a = H.agent(null, { name: "wrist_ik.R", t: 1, out: 3, at: (t: number) => (t < 2.5 ? [100 * t, 50] : null) });
  assert.equal(a.at(0.9).visible, false);
  assert.ok(a.at(1).visible && a.at(1).scale > 0, "on screen on its first frame");
  assert.ok(a.at(1 + F).scale > 1, "pops past full size");
  assert.ok(near(a.at(1 + 2 * F).scale, 1));
  assert.equal(a.at(2).x, 200, "on its point");
  assert.equal(a.at(2.6).visible, false, "point off screen");
  const b = H.agent(null, { name: "shape_smile", t: 0, out: 1, at: [10, 10] });
  assert.ok(b.at(1 + F).scale < 1 && b.at(1 + F).visible);
  assert.equal(b.at(1 + 3 * F).visible, false);
  for (const fps of FPS)
    for (const t0 of STARTS) {
      const c = H.agent(null, { name: "x", t: t0, at: [0, 0] });
      assert.equal(c.at(frameAt(t0, 0, fps)).visible, true, `${fps} fps from ${t0}`);
      assert.equal(c.at(frameAt(t0, -1, fps)).visible, false, `${fps} fps from ${t0}`);
    }
});

test("detect: a letter a frame, outline in 0.25 s, the number 48 → 60 → 72 → 84 → 96 in 2-frame steps", () => {
  const d = H.detect(null, { t: 0, rect: { x: 100, y: 100, w: 400, h: 300 }, label: "Condition", value: 96 });
  assert.equal(d.at(0).label, "C");
  assert.equal(d.at(4 * F).label, "Condi");
  assert.equal(d.at(5 * F).text, "", "no number before 6 frames");
  const steps = [6, 8, 10, 12, 14].map((f) => d.at(f * F).value);
  assert.deepEqual(steps, [48, 60, 72, 84, 96], "the film's own count");
  assert.equal(d.at(15 * F).value, 96);
  assert.equal(d.at(1).text, "96%");
  assert.ok(near(d.at(2 * F + 0.25).stroke, 1));
  assert.equal(H.gauge(16), "#ea1a4c");
  assert.equal(H.gauge(67), "#f8e53e");
  assert.equal(H.gauge(96), "#7ad13a");
  const one = H.detect(null, { t: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, value: 80, steps: 0 });
  assert.equal(one.at(1).text, "80%", "steps 0 counts in one step, not NaN");
  // a letter a frame and a step every 2, on the frame, at each rate
  for (const fps of FPS)
    for (const t0 of STARTS) {
      const e = H.detect(null, { t: t0, rect: { x: 0, y: 0, w: 1, h: 1 }, label: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", value: 96 });
      for (let n = 0; n < 60; n++) {
        const f = frames24(n, fps);
        const a = e.at(frameAt(t0, n, fps));
        assert.equal(a.label.length, Math.min(26, f + 1), `${fps} fps from ${t0}: letters at frame ${n}`);
        const k = f < 6 ? -1 : Math.min(4, Math.floor((f - 6) / 2));
        assert.equal(a.value, k < 0 ? null : 48 + 12 * k, `${fps} fps from ${t0}: count at frame ${n}`);
      }
    }
});

test("title: letters out of blur 1.5 frames apart, each sharp in 3.5; out upward", () => {
  const ti = H.title(null, { text: "GPU HARNESS", t: 1, out: 3, size: 100 });
  const at = ti.at(1 + 2 * F);
  assert.equal(at.letters[0]!.blur > 0 && at.letters[0]!.blur < 22, true);
  assert.equal(at.letters[3]!.text, " ");
  assert.equal(ti.at(2).letters.every((l) => l.blur === 0 && l.opacity === 1), true);
  assert.ok(near(ti.at(0).done, 1 + 9 * 1.5 * F + 3.5 * F), "10 letters: the last starts 9 staggers in");
  assert.ok(ti.at(3.2).letters[0]!.y < 0, "leaving upward");
  assert.equal(ti.at(3.3).visible, false);
});

test("the frame is read when first used: window.__film set after the pieces lays an upright film out upright", () => {
  const g = globalThis as { __film?: unknown };
  const had = g.__film;
  try {
    delete g.__film;
    const c = H.chip(null, { t: 0, text: "Listening" });
    const v = H.voice(null, { t: 0, text: "Make a launch film for our app", until: 5 });
    const p = H.prompt(null, { t: 0, text: "x" });
    g.__film = { duration: 5, width: 1080, height: 1920 };
    assert.equal(c.at(1).x, Math.round(0.035 * 1080));
    assert.equal(c.at(1).y, Math.round(0.9 * 1920));
    assert.equal(v.at(1).x, 540);
    assert.equal(p.at(1).x, 540);
    assert.equal(p.at(1).w, Math.round(0.86 * 1080), "a wider box in an upright film");
    // sizes from the short side: a caption 65 px, not 115; above the chip, not on it
    const chipTop = Math.round(0.9 * 1920) - Math.round(Math.round(0.04 * 1080) * 1.9) / 2;
    const captionBottom = v.at(1).y + 0.6 * Math.round(0.06 * 1080);
    assert.ok(captionBottom < chipTop, `caption ${captionBottom} above the chip ${chipTop}`);
    g.__film = { duration: 5, width: 1920, height: 1080 };
    assert.equal(c.at(1).y, Math.round(0.9 * 1080), "and follows the frame if it changes");
    const land = H.voice(null, { t: 0, text: "x" });
    assert.ok(land.at(0.5).y + 0.6 * 65 < Math.round(0.9 * 1080) - Math.round(43 * 1.9) / 2, "apart in a landscape film too");
  } finally {
    if (had === undefined) delete g.__film;
    else g.__film = had;
  }
});

test("project: a camera's view of a 3D point, in the frame; null behind the lens", () => {
  // a camera at the origin looking down −z, 90° vertical field, 16:9
  const f = 1 / Math.tan(Math.PI / 4);
  const aspect = 16 / 9;
  const near_ = 0.1;
  const far = 100;
  const P = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near_) / (near_ - far), -1, 0, 0, (2 * far * near_) / (near_ - far), 0];
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const cam = { projectionMatrix: { elements: P }, matrixWorldInverse: { elements: I } };
  const frame = { width: 1920, height: 1080 };
  const mid = H.project(cam, [0, 0, -5], { frame })!;
  assert.ok(near(mid[0], 960) && near(mid[1], 540));
  const up = H.project(cam, [0, 5, -5], { frame })!;
  assert.ok(near(up[1], 0, 1e-6), "45° up is the top edge");
  assert.equal(H.project(cam, [0, 0, 5], { frame }), null, "behind the lens");
  assert.equal(H.project(cam, [0, 0, -500], { frame }), null, "past the far plane");
});

test("project: three.js cameras that moved and turned, perspective and orthographic, as three.js sees them", () => {
  const frame = { width: 1920, height: 1080 };
  const persp = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  persp.position.set(3, 2, 8);
  persp.lookAt(0, 0.5, 0);
  persp.updateMatrixWorld();
  const ortho = new THREE.OrthographicCamera(-4, 4, 2.25, -2.25, 0.1, 50);
  ortho.position.set(-5, 6, 5);
  ortho.lookAt(0, 0, 0);
  ortho.updateMatrixWorld();
  for (const cam of [persp, ortho])
    for (const p of [[0, 0, 0], [1, 1, -1], [-0.5, 0.2, 0.7]] as [number, number, number][]) {
      const v = new THREE.Vector3(...p).project(cam);
      const got = H.project(cam, p, { frame })!;
      assert.ok(got, `${cam.type} sees ${p}`);
      assert.ok(near(got[0], ((v.x + 1) / 2) * 1920, 1e-6) && near(got[1], ((1 - v.y) / 2) * 1080, 1e-6), `${cam.type} ${p}`);
    }
  // behind the orthographic camera: on its axis, the other way
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(ortho.quaternion).multiplyScalar(3).add(ortho.position);
  assert.equal(H.project(ortho, [back.x, back.y, back.z], { frame }), null, "behind an orthographic lens");
  const behind = new THREE.Vector3(0, 0, 1).applyQuaternion(persp.quaternion).multiplyScalar(3).add(persp.position);
  assert.equal(H.project(persp, [behind.x, behind.y, behind.z], { frame }), null, "behind a perspective lens");
});

test("burst: a cell of 0 or less draws in whole pixels, and draw returns", () => {
  // the smallest page burst() needs: a canvas that counts its squares
  let squares = 0;
  const node = () => ({ style: {}, dataset: {}, appendChild() {}, className: "" });
  const doc = {
    getElementById: () => ({}),
    head: { appendChild() {} },
    createElement: (tag: string) =>
      Object.assign(node(), tag === "canvas" ? { width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() { squares++; }, fillStyle: "" }) } : {}),
  };
  const g = globalThis as { document?: unknown };
  g.document = doc;
  try {
    for (const cell of [0, -3, Number.NaN]) {
      const b = H.burst(node() as unknown as HTMLElement, { t: 0, at: [100, 100], cell, frame: { width: 400, height: 300 } });
      squares = 0;
      b.draw(3 * F);
      assert.ok(squares > 0 && squares < 400 * 300, `cell ${cell}: ${squares} squares`);
    }
  } finally {
    delete g.document;
  }
});

test("chip: keeps clear of the rects it is told to avoid, a step at a time; its text's share while it opens", () => {
  const frame = { width: 1920, height: 1080 };
  const product = { x: 0, y: 900, w: 700, h: 180 }; // the product's own bar, low left, from 3 s
  const c = H.chip(null, {
    frame,
    steps: [{ t: 1, text: "Reading the brief" }, { t: 3, text: "Drafting" }, { t: 5, text: "Done" }],
    avoid: (t: number) => (t >= 3 && t < 5 ? [product, null] : []),
  });
  const home = c.at(2);
  assert.deepEqual([home.x, home.y], [Math.round(0.035 * 1920), Math.round(0.9 * 1080)], "its own place while nothing is in the way");
  const moved = c.at(4);
  assert.equal(moved.y, Math.round(0.9 * 1080), "still low");
  assert.ok(moved.x > 700 + 20, `clear of the bar, to its right: x ${moved.x}`);
  near(c.at(3 + 7 * F).x, moved.x) || assert.fail("there 7 frames after the change");
  assert.ok(c.at(3 + 2 * F).x > home.x && c.at(3 + 2 * F).x < moved.x, "sliding there as it changes");
  assert.equal(c.at(4.9).x, moved.x, "and it stays put until its next step");
  assert.deepEqual([c.at(6).x, c.at(6).y], [home.x, home.y], "home again when the way is clear");
  // the first step shows where it is clear, with no slide from a place it never was
  const top = H.chip(null, { frame, t: 1, text: "Reading", avoid: [{ x: 0, y: 800, w: 1920, h: 280 }] });
  assert.equal(top.at(1).y, Math.round(0.1 * 1080), "nothing low is clear: high left, from its first frame");
  // nothing clear anywhere: the place that covers least, and never an error
  const full = H.chip(null, { frame, t: 1, text: "Reading", avoid: [{ x: 0, y: 0, w: 1920, h: 1080 }] });
  assert.ok(Number.isFinite(full.at(2).x));
  // a step that says where it goes is not moved
  const said = H.chip(null, { frame, steps: [{ t: 1, text: "a", x: 300, y: 950 }], avoid: [product] });
  assert.deepEqual([said.at(3).x, said.at(3).y], [300, 950]);
  // the text's share: none in a capsule nearly shut, all of it once open
  assert.equal(c.at(1 + 2 * F).ink, 0);
  assert.equal(c.at(1 + 8 * F).ink, 1);
  const mid = c.at(3 + 3.5 * F).ink;
  assert.ok(mid > 0 && mid < 1, `thinning while it closes on a change: ${mid}`);
  assert.equal(c.at(0.5).ink, 0);
});

test("counter: fields change in place, 4 frames a changed character; a number runs in 2-frame steps; clock", () => {
  assert.equal(H.clock(18 * 60 + 42), "6:42 PM");
  assert.equal(H.clock(0), "12:00 AM");
  assert.equal(H.clock(12 * 60 + 5), "12:05 PM");
  assert.equal(H.clock(9 * 60, { h24: true }), "09:00");
  assert.equal(H.clock(24 * 60 + 61), "1:01 AM");
  const c = H.counter(null, {
    frame: { width: 1920, height: 1080 },
    fields: [
      { steps: [{ t: 1, value: 18 * 60 + 42 }, { t: 5, value: 21 * 60 + 15 }], format: H.clock, run: 0.5 },
      { steps: [{ t: 2, value: 0 }, { t: 6, value: 1 }], format: (n: number) => `${n} of 3 checks` },
    ],
    out: 9,
  });
  assert.equal(c.at(0.5).visible, false);
  assert.equal(c.at(1.5).text, "6:42 PM", "a field shows from its own first step");
  assert.equal(c.at(3).text, "6:42 PM · 0 of 3 checks");
  assert.deepEqual([c.at(3).x, c.at(3).y], [Math.round(0.965 * 1920), 108], "top right by default");
  near(c.at(1 + F).scale, 0.75) || assert.fail("grows in 2 frames, as the chip does");
  // the count changes over 4 frames; the clock beside it is untouched
  for (const fps of FPS) {
    const mid = c.at(frameAt(6, 2 * fps / 24, fps)).fields[1]!;
    assert.equal(mid.text, "1 of 3 checks");
    assert.equal(mid.was, "0 of 3 checks");
    assert.ok(mid.p > 0 && mid.p < 1, `mid-change at ${fps} fps: ${mid.p}`);
    assert.equal(c.at(frameAt(6, 4 * fps / 24, fps)).fields[1]!.p, 1, `changed 4 frames on at ${fps} fps`);
    assert.equal(c.at(frameAt(6, 2 * fps / 24, fps)).fields[0]!.p, 1, "the other field stands still");
  }
  // the clock runs 6:42 PM → 9:15 PM in 0.5 s: a new figure every 2 frames, fast then slowing, there on time
  const shown = Array.from({ length: 13 }, (_, f) => c.at(5 + f * F).fields[0]!.text);
  assert.equal(shown[0], shown[1], "held 2 frames");
  assert.notEqual(shown[1], shown[2]);
  assert.equal(shown[12], "9:15 PM");
  assert.equal(c.at(5 + 0.5 - 1.5 * F).fields[0]!.text, "9:15 PM", "its last step lands on the frame the run ends");
  const mins = (s: string) => { const m = /(\d+):(\d+)/.exec(s)!; return ((+m[1]! % 12) + 12) * 60 + +m[2]!; };
  assert.ok(mins(shown[2]!) - mins(shown[0]!) > mins(shown[10]!) - mins(shown[8]!), "fast, then slowing");
  // gone 4 frames after `out`
  assert.equal(c.at(9 + 3 * F).visible, true);
  assert.equal(c.at(9 + 4 * F).visible, false);
  assert.deepEqual(c.at(3), c.at(3), "the same t, the same answer");
  assert.throws(() => H.counter(null, { fields: [] }), /give it fields/);
});

test("inkHtml: with no colour named the fresh ink is the ink itself, lighter — never a colour of its own", () => {
  const ty = H.typeAt(0.05, 0, "hello", { curve: "even" });
  const html = H.inkHtml(0.05, ty, { ink: "#102030", caret: true });
  const fresh = [...html.matchAll(/color:(rgba?\([^)]*\))/g)].map((m) => m[1]!);
  assert.ok(fresh.length > 0, "the newest characters are marked");
  for (const c of fresh) assert.match(c, /^rgba?\(16, 32, 48(, 0\.\d+)?\)$/, `the ink's own hue: ${c}`);
  assert.match(html, /hud-caret" style="background:#102030"/, "the caret in the ink");
});

test("in Chrome: every piece takes the layer's accent; with none, no colour of the measured films'", { skip: findChrome() ? false : "no Chrome for Testing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-hud-accent-"));
  const lib = fileURLToPath(new URL("../starter/lib/", import.meta.url));
  await copyFile(join(lib, "anim.js"), join(dir, "anim.js"));
  await copyFile(join(lib, "hud.js"), join(dir, "hud.js"));
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><style>html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #14161c }
#css { --hud-accent: #00aa55 }</style><div id="css"></div>
<script type="module">
import { layer, chip, counter, clock, statusLine, voice, prompt, agent } from "./hud.js";
window.__film = { duration: 9, width: 1920, height: 1080 };
const make = (hud) => ({
  hud,
  c: chip(hud, { steps: [{ t: 0, text: "Reading the whole brief" }, { t: 4, text: "Drafting the first cut" }] }),
  n: counter(hud, { fields: [{ steps: [{ t: 0, value: 1122 }], format: clock }, { steps: [{ t: 0, text: "0 of 3" }, { t: 4, text: "1 of 3" }] }] }),
  s: statusLine(hud, { t: 3.9, lines: ["Reading 41 merged pull requests"], x: 200, y: 300 }),
  v: voice(hud, { t: 0, text: "Make a launch film", until: 9 }),
  p: prompt(hud, { t: 0, text: "Run the checks.", send: 3.9, model: "Model" }),
  a: agent(hud, { name: "wrist_ik.R", t: 0, at: [400, 200] }),
});
const sets = { accent: make(layer(document.body, { accent: "#d97757" })), css: make(layer(document.getElementById("css"))), none: make(layer()) };
const paint = (e) => { const cs = getComputedStyle(e); return cs.backgroundColor + " " + cs.backgroundImage; };
window.run = (which, t) => {
  const k = sets[which];
  for (const l of Object.values(sets)) l.hud.style.visibility = l === k ? "visible" : "hidden";
  for (const p of [k.c, k.n, k.s, k.v, k.p, k.a]) p.draw(t);
  const label = k.c.el.children[1];
  return {
    html: k.hud.innerHTML,
    star: k.c.el.querySelector("svg g").getAttribute("stroke"),
    send: paint(k.p.el.querySelector(".hud-send")), sendInk: getComputedStyle(k.p.el.querySelector(".hud-send")).color,
    orb: paint(k.v.el.querySelector(".hud-orb")),
    tag: paint(k.a.el.querySelector("span")), tagInk: getComputedStyle(k.a.el.querySelector("span")).color,
    line: k.s.el.querySelector(".hud-line").style.backgroundImage,
    mask: label.style.maskImage || label.style.webkitMaskImage, clip: k.c.el.style.clipPath, chipText: label.textContent,
    counter: k.n.el.textContent, cells: k.n.el.querySelectorAll(".hud-cell").length,
    counterBox: (() => { const r = k.n.el.getBoundingClientRect(); return [r.left, r.right]; })(),
  };
};
</script>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({ chromePath: findChrome()!, url: `${server.url}/index.html`, width: 1920, height: 1080 });
  type Got = { html: string; star: string; send: string; sendInk: string; orb: string; tag: string; tagInk: string; line: string; mask: string; clip: string; chipText: string; counter: string; cells: number; counterBox: [number, number] };
  // the measured films' own colours, which a film with another brand must never be handed
  const theirs = /#39d8ff|57, 216, 255|#f0703a|#f0743a|#ff8a4c|255, 138, 76|240, 11[26], 58|255, 170, 110|#f2c94c|242, 201, 76|224, 85, 154|194, 29, 120|#3d7bff|61, 123, 255|#7b5cff|123, 92, 255|#d37762/i;
  try {
    const t = 4 + 2 / 24; // two frames into the chip's change and the status line's sweep
    const acc = await b.evaluate<Got>(`window.run("accent", ${t})`);
    assert.equal(acc.star, "#d97757", "the chip's mark");
    assert.match(acc.send, /rgb\(217, 119, 87\)/, "the send button");
    assert.match(acc.orb, /rgb\(217, 119, 87\)/, "the orb");
    assert.match(acc.tag, /rgb\(217, 119, 87\)/, "an agent's label");
    assert.match(acc.line, /rgb\((2[0-9]{2}), (1[0-9]{2}), (\d+)\)/, "the status line's fresh ink is a tone of it");
    assert.doesNotMatch(acc.html, theirs, "none of the measured films' colours");
    const css = await b.evaluate<Got>(`window.run("css", ${t})`);
    assert.equal(css.star, "#00aa55", "an accent set in the page's own CSS");
    assert.match(css.send, /rgb\(0, 170, 85\)/);
    const none = await b.evaluate<Got>(`window.run("none", ${t})`);
    assert.doesNotMatch(none.html, theirs, "with no accent, none of the measured films' colours either");
    assert.equal(none.star, "#ffffff", "the mark in the chip's own text colour");
    assert.match(none.send, /rgb\(244, 242, 246\)/, "the send button in the ink");
    assert.match(none.sendInk, /rgb\(0, 0, 0\)/, "its arrow dark on it");
    assert.match(none.tag, /rgb\(58, 60, 68\)/, "an agent's label dark");
    assert.match(none.tagInk, /rgb\(255, 255, 255\)/);
    assert.match(none.line, /rgba\(244, 242, 246, 0\.\d+\)/, "the status line's fresh ink is the ink, faint");
    // a frame caught in the chip's change: the capsule is part shut, and the text fades toward its ends
    assert.match(none.clip, /^inset\(/, "the capsule is closing");
    assert.equal(none.chipText, "Reading the whole brief");
    assert.match(none.mask, /^linear-gradient\(90deg, (transparent|rgba\(0, 0, 0, 0\)) -?[\d.]+px, /, `the text's ends fade: ${none.mask}`);
    const open = await b.evaluate<Got>(`window.run("none", 6)`);
    assert.equal(open.mask + open.clip, "", "open, nothing is masked or clipped");
    // the counter: only the character that changed is a moving cell; its right end holds
    assert.equal(none.counter, "6:42 PM · 01 of 3", "the old and the new figure, mid-change");
    assert.equal(none.cells, 1);
    assert.equal(open.counter, "6:42 PM · 1 of 3");
    assert.equal(open.cells, 0);
    near(none.counterBox[1], Math.round(0.965 * 1920), 1) || assert.fail(`its right end at its anchor: ${none.counterBox}`);
    near(open.counterBox[1], none.counterBox[1], 0.5) || assert.fail("and it does not shift as it changes");
  } finally {
    await b.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("in Chrome: an upright film, words on a light and a dark scene, __film declared last", { skip: findChrome() ? false : "no Chrome for Testing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-hud-test-"));
  const lib = fileURLToPath(new URL("../starter/lib/", import.meta.url));
  await copyFile(join(lib, "anim.js"), join(dir, "anim.js"));
  await copyFile(join(lib, "hud.js"), join(dir, "hud.js"));
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><style>html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden }
#light, #dark { position: absolute; inset: 0 } #light { background: #f3f3f0 } #dark { background: linear-gradient(#11131c, #1d2440); visibility: hidden }</style>
<div id="light"></div><div id="dark"></div>
<script type="module">
import { layer, chip, statusLine, voice, detect, title } from "./hud.js";
const hud = layer();
const c = chip(hud, { t: 0, text: "Analyzing the product" });
const s = statusLine(hud, { t: 0, lines: ["Reading 41 merged pull requests", "and the release notes"] });
const v = voice(hud, { t: 0, text: "Make a launch film for our app, the one we ship on Friday", until: 9 });
const d = detect(hud, { t: 0, rect: { x: 160, y: 700, w: 300, h: 220 }, label: "Coverage", value: 70 });
const ti = title(hud, { t: 0, text: "Ship it tonight, the whole thing" });
window.__film = { duration: 9, width: 1080, height: 1920 };
const box = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
const ink = (e) => getComputedStyle(e).color;
window.run = (scene) => {
  document.getElementById("dark").style.visibility = scene === "dark" ? "visible" : "hidden";
  for (const p of [c, s, v, d, ti]) p.draw(4);
  const lines = [...s.el.querySelectorAll(".hud-line")];
  return {
    layer: [hud.offsetWidth, hud.offsetHeight],
    chip: box(c.el), caption: box(v.el.lastElementChild), title: box(ti.el), status: lines.map(box),
    label: box(d.el.children[1]), num: box(d.el.children[2]),
    statusInk: lines[0].style.backgroundImage, captionInk: ink(v.el.lastElementChild.firstElementChild),
    labelInk: ink(d.el.children[1]), titleInk: ink(ti.el),
  };
};
</script>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({ chromePath: findChrome()!, url: `${server.url}/index.html`, width: 1080, height: 1920 });
  type Box = [number, number, number, number];
  type Got = { layer: number[]; chip: Box; caption: Box; title: Box; status: Box[]; label: Box; num: Box; statusInk: string; captionInk: string; labelInk: string; titleInk: string };
  const inside = (r: Box) => r[0] >= 0 && r[1] >= 0 && r[2] <= 1080 && r[3] <= 1920;
  const apart = (a: Box, c: Box) => a[2] <= c[0] || c[2] <= a[0] || a[3] <= c[1] || c[3] <= a[1];
  const dark = (rgb: string) => {
    const [r, g, bl] = (rgb.match(/\d+/g) ?? []).map(Number);
    return r! + g! + bl! < 200;
  };
  try {
    const light = await b.evaluate<Got>(`window.run("light")`);
    assert.deepEqual(light.layer, [1080, 1920], "the layer is the declared frame");
    for (const [name, r] of Object.entries({ chip: light.chip, caption: light.caption, title: light.title, line1: light.status[0]!, line2: light.status[1]! }))
      assert.ok(inside(r as Box), `${name} inside the upright frame: ${JSON.stringify(r)}`);
    assert.ok(apart(light.chip, light.caption), `caption ${JSON.stringify(light.caption)} clear of the chip ${JSON.stringify(light.chip)}`);
    assert.ok(apart(light.label, light.num), "the number clear of the label");
    assert.ok(light.num[0] >= 160 && light.num[2] <= 460 && light.num[1] >= 700, `the number inside the box: ${JSON.stringify(light.num)}`);
    assert.ok(dark(light.captionInk) && dark(light.labelInk) && dark(light.titleInk), `dark ink on light: ${light.captionInk} ${light.labelInk} ${light.titleInk}`);
    assert.match(light.statusInk, /rgb\(28, 28, 33\)/, "the status line settles to dark ink on light");
    const night = await b.evaluate<Got>(`window.run("dark")`);
    assert.ok(!dark(night.captionInk) && !dark(night.labelInk) && !dark(night.titleInk), `light ink on dark: ${night.captionInk} ${night.labelInk} ${night.titleInk}`);
    assert.match(night.statusInk, /rgb\(244, 242, 246\)/, "the status line settles to light ink on dark");
  } finally {
    await b.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
