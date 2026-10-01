// film-kit: pure helpers, and a page built with them draws exactly what the
// same page built by hand draws. Browser tests skip without Chrome for Testing.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  beat,
  bezier,
  count,
  ease,
  flight,
  noise,
  progress,
  rand,
  reveal,
  spring,
  stagger,
  tempo,
} from "../src/film/kit";
import { filmKitPath } from "../src/film/kit-file";
import { filmStills, renderFilm } from "../src/film/render";
import { filmReview, packMoments } from "../src/film/review";
import { findChrome } from "./fixtures/find-chrome";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome for Testing";
let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-kit-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a beat grid: seconds of beats and bars", () => {
  assert.equal(beat(4, 120), 2);
  const T = tempo(96);
  assert.equal(T.beat, 0.625);
  assert.equal(T.at(1), 0);
  assert.equal(T.at(3), 5);
  assert.equal(T.at(3, 2), 6.25);
  assert.equal(T.beats(6), 3.75);
  assert.equal(T.nearest(5.2), 5);
  assert.equal(tempo(120, 0.3).at(2), 2.3);
});

test("curves start at 0, end at 1, and a CSS bezier matches the browser's", () => {
  for (const e of Object.values(ease)) {
    assert.ok(Math.abs(e(0)) < 1e-9);
    assert.ok(Math.abs(e(1) - 1) < 1e-9);
  }
  // CSS `ease` = cubic-bezier(0.25, 0.1, 0.25, 1); at x = 0.5 the browser gives ≈ 0.8024
  assert.ok(Math.abs(bezier(0.25, 0.1, 0.25, 1)(0.5) - 0.8024) < 0.002);
  assert.equal(progress(1, 2, 1), 0);
  assert.equal(progress(2.5, 2, 1), 0.5);
  assert.equal(progress(9, 2, 1), 1);
  assert.equal(stagger(3, 0.05, 1), 1.15);
});

test("a spring leaves from `from`, overshoots when underdamped, and settles at `to`", () => {
  assert.equal(spring(0, { from: 10, to: 20 }), 10);
  assert.ok(Math.abs(spring(3, { from: 10, to: 20 }) - 20) < 1e-3);
  let peak = 0;
  for (let t = 0; t < 2; t += 0.005)
    peak = Math.max(peak, spring(t, { stiffness: 300, damping: 10 }));
  assert.ok(peak > 1.2, `an underdamped spring overshoots (${peak})`);
  for (const damping of [2 * Math.sqrt(170), 60]) {
    let over = 0;
    for (let t = 0; t < 3; t += 0.005) over = Math.max(over, spring(t, { damping }));
    assert.ok(over <= 1 + 1e-9, "critically and over-damped springs do not overshoot");
  }
});

test("reveal: nothing before, itself after, and out reverses it", () => {
  for (const kind of ["fade", "rise", "drop", "scale", "blur"] as const) {
    assert.equal(reveal(0, { at: 1, kind }).opacity, "0", `${kind} before`);
    const done = reveal(5, { at: 1, kind });
    assert.equal(done.opacity, "1");
    assert.ok(
      /none|translateY\(0\.000px\)|scale\(1\.00000\)/.test(done.transform),
      `${kind} after: ${done.transform}`,
    );
  }
  assert.equal(reveal(0, { at: 1, kind: "mask-up" }).clipPath, "inset(100.000% 0 0 0)");
  assert.equal(reveal(5, { at: 1, kind: "mask-left" }).clipPath, "inset(0 0.000% 0 0)");
  assert.equal(reveal(10, { at: 1, out: { at: 8, dur: 1 } }).opacity, "0");
});

test("flight: from the first box to the second, lifted by its arc", () => {
  const from = { x: 0, y: 0, width: 100, height: 50 };
  const to = { x: 400, y: 200, width: 200, height: 100 };
  const a = flight(0, from, to);
  const b = flight(1, from, to);
  assert.deepEqual([a.x, a.y, a.width, a.height], [0, 0, 100, 50]);
  assert.deepEqual([b.x, b.y, b.width, b.height], [400, 200, 200, 100]);
  const mid = flight(0.5, from, to, { ease: ease.linear, arc: 80 });
  const straight = flight(0.5, from, to, { ease: ease.linear });
  assert.equal(straight.y - mid.y, 80);
  assert.equal(a.transform, "translate(0.000px, 0.000px) rotate(0.000deg) scale(1.00000, 1.00000)");
});

test("count, rand and noise", () => {
  assert.equal(count(0, { at: 1, to: 3376 }), "0");
  assert.equal(count(9, { at: 1, to: 3376 }), "3,376");
  assert.equal(rand("card"), rand("card"));
  assert.notEqual(rand("card"), rand("cards"));
  for (let i = 0; i < 200; i++) {
    const r = rand(i);
    assert.ok(r >= 0 && r < 1);
  }
  let worst = 0;
  for (let t = 0; t < 5; t += 0.001)
    worst = Math.max(worst, Math.abs(noise("p", t + 0.001) - noise("p", t)));
  assert.ok(worst < 0.01, `noise is continuous (largest step ${worst})`);
  assert.equal(noise("p", 1.234), noise("p", 1.234));
});

test("a page built with the kit draws exactly what the same page built by hand draws", {
  skip,
}, async () => {
  const kit = join(dir, "kit");
  await mkdir(kit, { recursive: true });
  await copyFile(filmKitPath(), join(kit, "film-kit.js"));
  const css = `body{margin:0;width:320px;height:180px;background:#102030;font:700 28px sans-serif;color:#fff}
#card{position:absolute;left:0;top:0;width:60px;height:40px;background:#e94}#n{position:absolute;left:20px;top:120px}#t{position:absolute;left:180px;top:20px}`;
  const body = `<div id="card"></div><div id="n"></div><div id="t">Hi</div>`;
  await writeFile(
    join(kit, "with.html"),
    `<!doctype html><html><head><style>${css}</style></head><body>${body}<script type="module">
import { flight, count, reveal, ease } from "./film-kit.js";
const from = { x: 0, y: 0, width: 60, height: 40 }, to = { x: 220, y: 120, width: 90, height: 60 };
window.__film = { duration: 1, width: 320, height: 180 };
window.__render = (t) => {
  document.getElementById('card').style.transform = flight(t, from, to, { arc: 30 }).transform;
  document.getElementById('n').textContent = count(t, { at: 0.1, dur: 0.7, to: 3076 });
  Object.assign(document.getElementById('t').style, reveal(t, { at: 0.2, dur: 0.5, kind: 'rise' }));
};
</script></body></html>`,
  );
  await writeFile(
    join(kit, "by-hand.html"),
    `<!doctype html><html><head><style>${css}</style></head><body>${body}<script>
const clamp = (x) => Math.min(1, Math.max(0, x));
const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const out = (p) => 1 - (1 - p) ** 3;
window.__film = { duration: 1, width: 320, height: 180 };
window.__render = (t) => {
  const q = inOut(clamp(t));
  const w = 60 + 30 * q, h = 40 + 20 * q;
  const cx = 30 + (265 - 30) * q, cy = 20 + (150 - 20) * q - 30 * 4 * q * (1 - q);
  const x = cx - w / 2, y = cy - h / 2;
  document.getElementById('card').style.transform =
    'translate(' + x.toFixed(3) + 'px, ' + y.toFixed(3) + 'px) rotate(0.000deg) scale(' + (w / 60).toFixed(5) + ', ' + (h / 40).toFixed(5) + ')';
  document.getElementById('n').textContent = Math.round(3076 * out(clamp((t - 0.1) / 0.7))).toLocaleString('en-US');
  const p = out(clamp((t - 0.2) / 0.5));
  const s = document.getElementById('t').style;
  s.opacity = String(p); s.transform = 'translateY(' + ((1 - p) * 24).toFixed(3) + 'px)'; s.clipPath = 'none'; s.filter = 'none';
};
</script></body></html>`,
  );
  const at = [0, 0.25, 0.5, 0.75, 1];
  const a = await filmStills({
    page: join(kit, "with.html"),
    root: kit,
    chromePath: chrome!,
    at,
    outDir: join(dir, "with"),
    blur: false,
  });
  const b = await filmStills({
    page: join(kit, "by-hand.html"),
    root: kit,
    chromePath: chrome!,
    at,
    outDir: join(dir, "by-hand"),
    blur: false,
  });
  for (let i = 0; i < at.length; i++)
    assert.ok(
      (await readFile(a[i]!)).equals(await readFile(b[i]!)),
      `identical frames at ${at[i]} s`,
    );
});

test("review finds a caption over the embedded page's text and a number running into a badge", {
  skip,
}, async () => {
  const page = join(dir, "review");
  await mkdir(page, { recursive: true });
  await writeFile(
    join(page, "ui.html"),
    `<!doctype html><html><body style="margin:0;font:16px sans-serif"><nav style="padding:20px 24px">Home · Pricing · Docs · Sign in</nav><p style="padding:0 24px">The real interface, with its own text.</p></body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>
body{margin:0;width:640px;height:360px;background:#fff;font:700 40px sans-serif}
iframe{position:absolute;left:0;top:0;width:640px;height:360px;border:0}
#cap{position:absolute;left:24px;top:12px;font-size:30px;color:#111}
#num{position:absolute;left:40px;top:220px;font-size:72px;color:#c33;white-space:nowrap}
#vs{position:absolute;left:330px;top:228px;width:70px;height:70px;border-radius:50%;background:#234;color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center}
</style></head><body>
<iframe src="ui.html"></iframe><div id="cap">Find your next gym.</div><div id="num"></div><div id="vs">vs</div>
<script>
window.__film = { duration: 2, width: 640, height: 360 };
window.__render = (t) => {
  document.getElementById('cap').style.opacity = t >= 0.5 && t < 1.5 ? '1' : '0';
  document.getElementById('num').textContent = 'NT$' + Math.round(3376 * Math.min(1, t)).toLocaleString('en-US');
};
</script></body></html>`,
  );
  const film = join(dir, "review.mp4");
  await renderFilm({ page, out: film, chromePath: chrome!, blur: false, workers: 1, audio: null });
  const r = await filmReview({ film, page, chromePath: chrome!, out: join(dir, "review-pack") });
  const caption = r.layout!.find((l) => l.a.includes("#cap") && l.kind === "text-over-text");
  assert.ok(caption, `the caption over the page's text: ${JSON.stringify(r.layout)}`);
  assert.ok(
    caption.from >= 0.5 && caption.to < 1.5,
    `only while it shows: ${caption.from}–${caption.to}`,
  );
  const badge = r.layout!.find((l) => l.a.includes("#num") && l.kind === "text-over-badge");
  assert.ok(
    badge?.b?.includes("#vs"),
    `the number running into the badge: ${JSON.stringify(r.layout)}`,
  );
  assert.ok(badge!.from > 0.5, "only once it has grown into it");
  // moments closer than a clip apart are one moment, with every reason it was picked
  const why = r.moments.flatMap((m) => m.why).join(" | ");
  assert.ok(why.includes("#cap") && why.includes("#num"), why);
  for (const m of r.moments) {
    assert.ok((await readFile(m.clip)).length > 0);
    assert.ok((await readFile(m.strip)).length > 0);
  }
  assert.match(await readFile(r.index, "utf8"), /## Not measured/);
});

test("review: text the film's own window hides is not a collision", { skip }, async () => {
  const page = join(dir, "clipped");
  await mkdir(page, { recursive: true });
  // the interface sits in a 300 px window (overflow hidden) scaled up as a camera
  // move; the caption is outside the window, over interface text the window hides
  await writeFile(
    join(page, "ui.html"),
    `<!doctype html><html><body style="margin:0;font:16px sans-serif">${Array.from({ length: 30 }, (_, i) => `<p style="margin:4px 8px">row ${i} of the real interface text</p>`).join("")}</body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>
body{margin:0;width:640px;height:360px;background:#123}
#win{position:absolute;left:340px;top:30px;width:280px;height:300px;overflow:hidden;border-radius:12px;background:#fff}
#win iframe{width:640px;height:800px;border:0;transform-origin:0 0;transform:scale(1.4) translate(-120px,-40px)}
#cap{position:absolute;left:20px;top:150px;color:#fff;font:700 28px sans-serif}
</style></head><body><div id="win"><iframe src="ui.html"></iframe></div><div id="cap">Every gym, one place.</div>
<script>window.__film = { duration: 0.5, width: 640, height: 360 }; window.__render = () => {};</script></body></html>`,
  );
  const film = join(dir, "clipped.mp4");
  await renderFilm({ page, out: film, chromePath: chrome!, blur: false, workers: 1, audio: null });
  const r = await filmReview({ film, page, chromePath: chrome!, out: join(dir, "clipped-pack") });
  assert.deepEqual(r.layout, [], `nothing collides: ${JSON.stringify(r.layout)}`);
});

test("a ready promise that waits on a frame inside an iframe does not hang", { skip }, async () => {
  const page = join(dir, "frame-ready");
  await mkdir(page, { recursive: true });
  await writeFile(
    join(page, "inner.html"),
    `<!doctype html><html><body style="margin:0;background:#0a0"></body></html>`,
  );
  await writeFile(
    join(page, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;width:160px;height:90px}iframe{width:160px;height:90px;border:0}</style></head><body>
<iframe id="f" src="inner.html"></iframe><script>
const f = document.getElementById('f');
window.__film = { duration: 0.5, width: 160, height: 90,
  ready: new Promise((ok) => f.addEventListener('load', () => f.contentWindow.requestAnimationFrame(() => ok()))) };
window.__render = () => {};
</script></body></html>`,
  );
  const t0 = Date.now();
  const files = await filmStills({
    page,
    chromePath: chrome!,
    at: [0.2],
    outDir: join(dir, "frame-ready-stills"),
    blur: false,
  });
  assert.equal(files.length, 1);
  assert.ok(Date.now() - t0 < 30_000, "well before the 45 s ready timeout");
});

test("review: a full pack keeps asked, measured and quiet moments, and spreads layout over the film", () => {
  const picked = new Map<number, string[]>();
  // twenty layout problems, one every 2 s, a measured stall at 39 s, a time asked
  // for at 30.5 s, a quiet stretch at 41 s
  for (let i = 0; i < 20; i++) picked.set(i * 2, [`layout: caption ${i}`]);
  picked.set(39, ["a frame repeats inside motion (measured)"]);
  picked.set(30.5, ["asked for"]);
  picked.set(41, ["6.0 s with no hard cut and no fast motion (38–44 s)"]);
  const { kept, left } = packMoments(picked, 8);
  assert.equal(kept.length, 8);
  assert.ok(
    kept.includes(30.5) && kept.includes(39) && kept.includes(41),
    "asked, measured and quiet moments are kept",
  );
  assert.ok(
    kept.some((t) => t >= 20 && t < 39),
    "layout moments come from late in the film too",
  );
  assert.ok(kept[0] === 0 && kept.includes(38), "spread from the first to the last");
  assert.deepEqual(
    [...kept].sort((a, b) => a - b),
    kept,
    "in time order",
  );
  assert.equal(kept.length + left.length, picked.size);
  assert.ok(
    left.every((t) => picked.get(t)![0]!.startsWith("layout:")),
    "layout is what gives way",
  );
});
