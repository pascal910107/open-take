// The film kit's seams (kit/seams.js): each is checked against what its
// comment promises — the speed on both sides of the cut, the blur matched
// across it, the side at rest drawn from its own layout ("none"), a part
// carried at its own size — and `seams` against the timeline it declares on.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  curve,
  depth,
  dipCut,
  ease,
  matchText,
  morph,
  parallax,
  pushCut,
  seams,
  waterfall,
  whip,
} from "../kit/seams.js";
import { timeline } from "../kit/time.js";

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const H = 1e-5;

test("the eases: power curves, exponential, back.out, a CSS cubic-bezier", () => {
  near(ease.in(4)(0.5), 0.0625, 1e-12, "p⁴");
  near(ease.out(4)(0.5), 0.9375, 1e-12, "1 − (1 − p)⁴");
  near(ease.inOut(3)(0.5), 0.5, 1e-12, "in-out middle");
  near(ease.inOut(3)(0.25), 0.0625, 1e-12, "in-out first half: 4p³");
  near(ease.expoOut(1), 1, 0, "exponential lands on 1");
  let peak = 0;
  for (let i = 0; i <= 1000; i++) peak = Math.max(peak, ease.backOut(0.7)(i / 1000));
  near(peak, 1.0177, 2e-4, "back.out(0.7) peaks ≈ 1.8 % past");
  const lin = ease.bezier(0.25, 0.25, 0.75, 0.75);
  near(lin(0.3), 0.3, 1e-6, "a straight bezier is linear");
  const m = ease.bezier(0.85, 0, 0.15, 1);
  near(m(0.5), 0.5, 1e-6, "the match curve is symmetric");
  assert.ok(m(0.25) < 0.1, "slow out of the start");
});

test("curve: the cut at the fastest frame, the same speed and way on both sides", () => {
  const at = 6;
  const before = (curve(at - H, at).a.x - curve(at - 2 * H, at).a.x) / H;
  const after = (curve(at + 2 * H, at).b.x - curve(at + H, at).b.x) / H;
  near(before, -3066.67, 5, "outgoing speed at the cut (230 px, 0.30 s: 4·D/T)");
  near(after, -3066.67, 5, "incoming speed at the cut");
  near(curve(at, at).speed, 3066.67, 0.01, "speed said");
  const last = curve(at - 1 / 60, at).a;
  assert.ok(last.visible && last.opacity < 0.1, "gone by the cut, not yet at the edge");
  assert.ok(Math.abs(last.x) < 230, "still short of its distance");
  assert.equal(curve(at, at).a.visible, false);
  near(curve(at, at).b.opacity, 0.35, 1e-12, "the incoming starts at 0.35");
  const done = curve(at + 0.3, at).b;
  assert.equal(done.transform, "none", "at rest: its own layout");
  assert.equal(done.filter, "none");
  assert.equal(curve(at - 1, at).a.transform, "none", "before: untouched");
  const up = curve(at - 0.1, at, { dir: "up" }).a;
  assert.ok(up.y < 0 && up.x === 0, "up moves up");
  assert.throws(() => curve(0, 1, { dir: "sideways" as never }), /dir is/);
});

test("waterfall: words leave in reading order, the last gone at the cut; the gaps shrink", () => {
  const at = 3;
  const w = waterfall(at - 0.2, at, 4, 3);
  assert.ok(w.out[0]!.x < w.out[3]!.x, "the first word is further gone");
  assert.equal(
    waterfall(at, at, 4, 3).out.every((s) => !s.visible),
    true,
    "every word gone at the cut",
  );
  const inn = waterfall(at + 0.04, at, 4, 3).in;
  assert.ok(inn[0]!.visible && !inn[1]!.visible, "the second word 0.05 s after the first");
  near(w.end, at + 0.05 + 0.042 + 0.3, 1e-9, "the last lands after the shrinking gaps");
  const late = waterfall(w.end, at, 4, 3).in;
  assert.ok(
    late.every((s) => s.transform === "none"),
    "all at rest",
  );
});

test("whip: one strip, the seam moving with it, the speed the same across it", () => {
  const view = { width: 1920, height: 1080 };
  const at = 10;
  const mid = whip(at, at, view);
  near(mid.a.x - mid.b.x, -1920, 1e-6, "the incoming docked one width beyond");
  near(mid.speed, (3 * 1920) / 0.55, 1e-6, "3·W/T at the middle");
  const v = (whip(at + H, at, view).a.x - whip(at - H, at, view).a.x) / (2 * H);
  near(Math.abs(v), mid.speed, 1, "measured at the middle");
  near(mid.edge ?? Number.NaN, 1920 + mid.a.x, 1e-9, "where they meet");
  assert.equal(mid.a.blur, 0, "the shutter's smear by default: no blur of its own");
  const b = whip(at, at, view, { blur: 16 });
  near(b.a.blur, 16, 0.01, "asked: the blur peaks with the speed");
  assert.equal(b.a.blurAxis, "x", "along the path only");
  assert.equal(whip(at + 0.3, at, view, { blur: 16 }).b.filter, "none", "at rest: no filter");
  assert.equal(whip(at + 0.3, at, view).b.transform, "none");
  const up = whip(at, at, view, { dir: "up" });
  near(up.a.y - up.b.y, -1080, 1e-6, "vertical: one height");
});

test("depth: the blur the same on both sides of the swap; the incoming grows to its own size", () => {
  const at = 4;
  const a = depth(at - 1e-6, at).a;
  const b = depth(at, at).b;
  near(a.blur, 10, 1e-3, "outgoing at the cut");
  near(b.blur, 10, 1e-9, "incoming at the cut");
  near(a.scale, 1.2, 1e-4, "flew at the lens");
  near(b.scale, 0.75, 1e-9, "built at full size, from smaller");
  assert.equal(depth(at + 0.5, at).b.filter, "none", "sharp when it lands");
  assert.equal(depth(at + 0.5, at).b.transform, "none");
  const inv = depth(at, at, { inverse: true }).b;
  near(inv.scale, 1.25, 1e-9, "inverse: arrives oversized");
  near(depth(at - 1e-6, at, { inverse: true }).a.scale, 0.8, 1e-4, "inverse: the old recedes");
});

test("matchText: one curve, the swap at its middle, the motion running on", () => {
  const z = (t: number) => {
    const r = matchText(t, 0, 2);
    return r.a.visible ? Math.log(r.a.scale) : Math.log(r.b.scale) + 2 * Math.log(1.7);
  };
  const r = matchText(1 - 1e-9, 0, 2);
  near(r.cut, 1, 0, "the swap at the middle");
  near(r.a.scale, 1.7, 1e-3, "the outgoing has grown to k");
  near(matchText(1, 0, 2).b.scale, 1 / 1.7, 1e-3, "the incoming starts at 1/k");
  near((z(1 - 1e-6) - z(1 - 2e-6)) / 1e-6, (z(1 + 2e-6) - z(1 + 1e-6)) / 1e-6, 0.05, "log speed");
  assert.equal(matchText(2, 0, 2).b.transform, "none");
  const s = matchText(1, 0, 2, { mode: "slide", dist: 100 });
  near(s.b.x, 100, 1e-6, "slide: arrives from the far side");
  const tr = matchText(0, 0, 2, { mode: "track" });
  near(tr.spacing ?? Number.NaN, 0.22, 1e-9, "track: from +0.22 em");
  assert.throws(() => matchText(0, 0, 1, { mode: "spin" as never }), /mode is/);
});

test("morph: the panel shrunk onto the card and grown back; a shared part at its own size", () => {
  const card = { x: 100, y: 600, w: 300, h: 160, r: 16 };
  const panel = { x: 360, y: 90, w: 1200, h: 900, r: 24 };
  const inCard = { x: 120, y: 620, w: 200, h: 30 };
  const inPanel = { x: 400, y: 130, w: 400, h: 60 };
  const m0 = morph(0, 0, 1, card, panel);
  near(m0.container.box.x, 100, 1e-9, "on the card");
  near(m0.container.sx, 0.25, 1e-9, "shrunk to it");
  const p0 = m0.part(inCard, inPanel);
  near(p0.scale, 0.5, 1e-9, "the part at its card size, uniformly");
  // the part's frame position: box + s·(home − panel + d)
  const m = morph(0.4, 0, 1, card, panel);
  const p = m.part(inCard, inPanel);
  const tr = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+), ([-\d.]+)\)/.exec(
    p.transform,
  )!;
  const fx = m.container.box.x + m.container.sx * (inPanel.x - panel.x + Number(tr[1]));
  const sxTot = m.container.sx * Number(tr[3]);
  const syTot = m.container.sy * Number(tr[4]);
  near(sxTot, syTot, 1e-4, "not stretched");
  near(sxTot, p.scale, 1e-4, "its own scale");
  const ex = 120 + (400 - 120) * m.p;
  near(fx, ex, 0.01, "between its two places");
  assert.ok(m0.a.opacity === 1 && m0.b.opacity === 0);
  assert.equal(morph(0.3, 0, 1, card, panel).a.opacity, 0, "the card's own content gone by 30 %");
  const end = morph(1, 0, 1, card, panel);
  assert.equal(end.container.transform, "none", "the panel's own DOM at the end");
  assert.equal(end.part(inCard, inPanel).transform, "none");
});

test("parallax: the card covers the view, the scene built at full size and shrunk onto the card", () => {
  const view = { width: 1920, height: 1080 };
  const card = { x: 700, y: 400, w: 320, h: 180 };
  const others = [{ x: 1100, y: 400, w: 320, h: 180 }];
  const p0 = parallax(0, 0, 2, card, others, view);
  // the scene's centre lands on the card's centre at the start
  const tr = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(p0.scene.transform)!;
  const sc = Number(tr[3]);
  near(Number(tr[1]) + sc * 960, 860, 0.01, "centre x");
  near(Number(tr[2]) + sc * 540, 490, 0.01, "centre y");
  near(sc, 1 / 6, 1e-4, "1/S: the card's width is a sixth of the view");
  const end = parallax(2, 0, 2, card, others, view);
  assert.equal(end.scene.transform, "none", "the scene at its own size");
  assert.equal(end.others[0]!.visible, false);
  const mid = parallax(1, 0, 2, card, others, view);
  assert.ok(mid.others[0]!.x > 0, "the card to the right flies right");
  const back = parallax(0, 0, 2, card, others, view, { reverse: true });
  assert.equal(back.scene.transform, "none", "reverse starts on the scene");
});

test("pushCut and dipCut: a hard cut that reads as meant", () => {
  const at = 5;
  near(pushCut(at - 1e-6, at).a.scale, 1.04, 1e-4, "pushed in to the cut");
  near(pushCut(at, at).b.scale, 1.04 / 1.07, 1e-9, "the incoming carries the push on");
  assert.equal(pushCut(at + 0.36, at).b.transform, "none", "and lands on its own size");
  near(pushCut(at, at).flash.opacity, 0.2, 1e-9, "the flash peaks at the cut");
  assert.equal(pushCut(at + 2 / 60, at).flash.opacity, 0, "dead two frames later");
  assert.equal(pushCut(at - 2 / 60, at).flash.opacity, 0, "not before the last frame");
  assert.equal(dipCut(at - 2 / 60, at).a.brightness, 0.6, "dark for the last frames");
  assert.equal(dipCut(at - 4 / 60, at).a.filter, "none");
  near(dipCut(at, at, { settle: 1.03 }).b.scale, 1.03, 1e-9, "a cut on a rebound");
});

test("seams: every boundary declared as a cut; a boundary that names none is on the curve", () => {
  const tl = timeline({ at: { map: 6 } });
  const els = new Map<string, { style: Record<string, string> }>();
  const el = (n: unknown) => {
    const k = String(n);
    if (!els.has(k)) els.set(k, { style: {} });
    return els.get(k) as unknown as Element;
  };
  const s = seams(
    tl,
    [
      { at: "map", from: "intro", to: "map" },
      { at: 12, from: "map", to: "table", kind: "cut" },
    ],
    { el },
  );
  const cutsDeclared = tl.events().filter((e) => e.kind === "cut");
  assert.deepEqual(
    cutsDeclared.map((e) => [e.t, e.label]),
    [
      [6, "seam: curve"],
      [12, "seam: cut"],
    ],
  );
  assert.deepEqual(
    s.list().map((x) => x.kind),
    ["curve", "cut"],
  );
  s.apply(5.9);
  assert.match(els.get("intro")!.style.transform!, /translate\(-/, "the outgoing on its way");
  assert.equal(els.get("map")!.style.visibility, "hidden");
  s.apply(20);
  assert.equal(els.get("intro")!.style.transform, "", "closed: back to rest");
  assert.equal(s.at(6.1)[0]!.kind, "curve");
  assert.throws(() => seams(tl, [{ at: 1, from: "a", to: "b", kind: "spin" }]), /not one of/);
});

test("film probe: a hard cut where neither side moves and nothing crosses is named", async () => {
  const { seamsAtCuts } = await import("../src/film/probe.ts");
  const fps = 60;
  const energy = new Float32Array(240);
  // a still shot, a cut at 60 (still on both sides); a cut at 180 with the
  // incoming shot moving
  energy[60] = 0.4;
  energy[180] = 0.4;
  for (let i = 181; i < 200; i++) energy[i] = 0.01;
  const list = seamsAtCuts(
    [
      { frame: 60, t: 1, across: "nothing carried" },
      { frame: 180, t: 3, across: "nothing carried" },
    ],
    energy,
    fps,
    [{ t: 1.005, label: "seam: cut" }],
  );
  assert.deepEqual(
    list.map((x) => [x.t, x.before, x.after, x.nothing, x.declared]),
    [
      [1, "still", "still", true, "seam: cut"],
      [3, "still", "moving", false, null],
    ],
  );
});

test("a dip cut counts its dark frames at the rate the film is drawn at", async () => {
  const { dipCut } = await import("../kit/seams.js");
  const g = globalThis as { __filmFps?: number };
  const dark = (t: number) => dipCut(t, 10).a.brightness < 1;
  try {
    g.__filmFps = 30; // a draft
    assert.ok(dark(10 - 2.5 / 30) && !dark(10 - 3.5 / 30), "3 frames at 30 fps");
    delete g.__filmFps;
    assert.ok(dark(10 - 2.5 / 60) && !dark(10 - 3.5 / 60), "3 frames at 60 fps when nothing says");
    assert.ok(dipCut(10 - 2.5 / 24, 10, { fps: 24 }).a.brightness < 1, "or as given");
  } finally {
    delete g.__filmFps;
  }
});

test("film probe knows a handoff as performed by the same names the kit does", async () => {
  const { KINDS, ALIASES, kindOf } = await import("../kit/seams.js");
  const { SEAM_KINDS } = await import("../src/film/probe");
  const names = [...KINDS, ...Object.keys(ALIASES)];
  for (const n of names) assert.ok(SEAM_KINDS.test(n), `probe does not know "${n}"`);
  // and nothing the kit would not perform
  const listed = SEAM_KINDS.source.replace(/^\^\(|\)\$$/g, "").split("|");
  for (const p of listed)
    for (const n of p.includes("[") ? [p.replace("[ -]", " "), p.replace("[ -]", "-")] : [p])
      assert.ok(kindOf(n), `probe knows "${n}", the kit does not`);
});
