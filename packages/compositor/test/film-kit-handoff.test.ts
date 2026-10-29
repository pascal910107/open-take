// A beat sheet's handoff, performed: a seam's kind named on tl.segment is
// handed over by scenes(…, { seams }) between the two scenes that meet
// there; words stay words, and a boundary that names nothing is left alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as seamKit from "../kit/seams.js";
import { kindOf, seamCall, seams } from "../kit/seams.js";
import { scenes, timeline } from "../kit/time.js";

type Style = { visibility: string; opacity: string; transform: string; filter: string };
const fakeEls = (names: string[]) =>
  Object.fromEntries(
    names.map((n) => [
      n,
      { style: { visibility: "", opacity: "", transform: "", filter: "" } as Style },
    ]),
  );

test("kindOf: the kinds, the functions' names and a beat sheet's words for them", () => {
  assert.equal(kindOf("whip"), "whip");
  assert.equal(kindOf("Whip"), "whip");
  assert.equal(kindOf("pushCut"), "push");
  assert.equal(kindOf("dipCut"), "dip");
  assert.equal(kindOf("into the lens"), "depth");
  assert.equal(kindOf("hard cut"), "cut");
  assert.equal(kindOf("the rows fold into a file"), null, "words stay words");
  assert.equal(kindOf("morph"), null, "a call of its own is not a kind");
  assert.match(String(seamCall("morph")), /morph\(t, start, end, from, to\)/);
  assert.equal(seamCall("whip"), null);
});

test("seams(): a function's name works as its kind; a call of its own says how to call it", () => {
  const s = seams(null, [{ at: 2, from: {}, to: {}, kind: "pushCut" }]);
  assert.equal(s.list()[0]!.kind, "push");
  assert.throws(
    () => seams(null, [{ at: 2, from: {}, to: {}, kind: "morph" }]),
    /"morph" is a call of its own, not a kind: morph\(t, start, end, from, to\)/,
  );
  assert.throws(() => seams(null, [{ at: 2, from: {}, to: {}, kind: "swoosh" }]), /is not one of/);
});

test("tl.segment: a handoff with options keeps its kind and its options apart", () => {
  const tl = timeline();
  tl.segment(0, 4, { handoff: { kind: "whip", dir: "up", dur: 0.4, note: { x: 1 } } });
  tl.segment(4, 6, { handoff: "the panel slides away" });
  const [a, b] = tl.segments();
  assert.equal(a!.handoff, "whip");
  assert.deepEqual(a!.seam, { dir: "up", dur: 0.4 }, "numbers and words kept, the rest left out");
  assert.equal(b!.handoff, "the panel slides away");
  assert.equal(b!.seam, undefined);
  assert.throws(() => tl.segment(6, 7, { handoff: { dir: "up" } as never }), /needs its kind/);
});

test("scenes with seams: a named kind is performed at its boundary, words and silence are not", () => {
  const tl = timeline();
  const els = fakeEls(["rows", "map", "hex", "end"]);
  const sc = scenes(
    { rows: [0, 4], map: [4, 10], hex: [10, 15], end: [15, 18] },
    { tl, seams: seamKit, el: (n) => els[n] ?? null },
  );
  // the sheet written after the scenes, as a page may
  tl.segment(0, 4, { handoff: "depth" });
  tl.segment(4, 10, { handoff: "the panel slides away" });
  tl.segment(10, 15, { handoff: { kind: "curve", dir: "up" } });
  // a handoff is at its segment's `to`: 4 s by name, 10 s in words (left to the page), 15 s by name
  assert.deepEqual(
    sc.seams().map((s) => [s.at, s.kind, s.from, s.to]),
    [
      [4, "depth", "rows", "map"],
      [15, "curve", "hex", "end"],
    ],
  );
  // a depth seam: the outgoing scene goes into the lens just before 4 s
  sc.show(3.95);
  assert.equal(els.rows!.style.visibility, "inherit");
  assert.match(els.rows!.style.transform, /scale/);
  assert.match(els.rows!.style.filter, /blur/);
  // out of every window: back at rest, only visibility is the scenes'
  sc.show(7);
  assert.deepEqual(
    [els.rows!.style.transform, els.rows!.style.filter, els.map!.style.transform],
    ["", "", ""],
  );
  assert.equal(els.map!.style.visibility, "inherit");
  assert.equal(els.rows!.style.visibility, "hidden");
  // 10 s, words: nothing written on either side
  sc.show(9.9);
  assert.equal(els.map!.style.transform, "");
  // the curve at 15 s travels up, as the options said
  sc.show(14.9);
  assert.match(els.hex!.style.transform, /-\d/);
});

test("scenes with seams: a sheet written after a first show(t) is still performed", () => {
  const tl = timeline();
  const els = fakeEls(["a", "b"]);
  const sc = scenes({ a: [0, 4], b: [4, 8] }, { tl, seams: seamKit, el: (n) => els[n] ?? null });
  sc.show(0); // a first paint, before the sheet
  assert.deepEqual(sc.seams(), []);
  tl.segment(0, 4, { handoff: "depth" });
  assert.deepEqual(
    sc.seams().map((s) => [s.at, s.kind]),
    [[4, "depth"]],
  );
  sc.show(3.95);
  assert.match(els.a!.style.transform, /scale/);
});

test("the cut a named boundary declares is labelled with its seam", () => {
  const tl = timeline();
  const els = fakeEls(["a", "b", "c"]);
  scenes({ a: [0, 2], b: [2, 4], c: [4, 6] }, { tl, seams: seamKit, el: (n) => els[n] ?? null });
  tl.segment(0, 2, { handoff: "whip" });
  tl.segment(2, 4, { handoff: "a hand-made dissolve" });
  const cuts = tl.events().filter((e) => e.kind === "cut");
  assert.deepEqual(
    cuts.map((e) => [e.t, e.label]),
    [
      [2, "seam: whip"],
      [4, "c"],
    ],
  );
});

test("scenes without seams: unchanged — the handoff is a note, the cut keeps the scene's name", () => {
  const tl = timeline();
  const els = fakeEls(["a", "b"]);
  const sc = scenes({ a: [0, 2], b: [2, 4] }, { tl, el: (n) => els[n] ?? null });
  tl.segment(0, 2, { handoff: "whip" });
  assert.deepEqual(sc.seams(), []);
  sc.show(1.9);
  assert.equal(els.a!.style.transform, "");
  assert.deepEqual(
    tl
      .events()
      .filter((e) => e.kind === "cut")
      .map((e) => e.label),
    ["b"],
  );
});
