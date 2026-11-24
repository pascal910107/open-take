// The starter's agent cursors building a screen (starter/lib/swarm.js) as a
// schedule with no page: the same seed gives the same plan; every item is
// built by one agent, once, never un-built; a held agent stops where it is and
// carries on when its hold ends; `end` is when the last item lands and a
// duration is met; events come in time order; items given to an agent stay
// with it in their order; a cursor never jumps; a repeated label is copied only
// from a place it has already landed. Then, in Chrome, a table in a tilted,
// scaled layer: nothing moves while it is built, draws out of order agree, and
// the page is as it was once the last cursor has left; and a picture's boxes
// are masked in and the mask taken off at the end.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchHtmlBrowser } from "../src/html/cdp";
import { serveDirectory } from "../src/html/server";
import * as S from "../starter/lib/swarm.js";
import { findChrome } from "./fixtures/find-chrome";

type Item = Parameters<typeof S.plan>[0][number];

/** an 8 × 3 table: a rule and a line of text per cell, each row one agent's; a header for anyone */
function table(fixed = true): Item[] {
  const items: Item[] = [];
  for (let c = 0; c < 3; c++) items.push({ kind: "text", rect: { x: 100 + c * 400, y: 40, w: 80, h: 18 }, path: Array.from({ length: 5 }, (_, k) => [100 + c * 400 + k * 16, 49] as [number, number]) });
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 3; c++) {
      const x = 100 + c * 400, y = 100 + r * 60;
      const n = 6 + 3 * c;
      items.push({ kind: "rule", rect: { x, y: y + 58, w: 400, h: 1 }, path: [[x, y + 58], [x + 400, y + 58]], agent: fixed ? r : undefined });
      items.push({ kind: "text", rect: { x: x + 20, y: y + 20, w: n * 12, h: 20 }, path: Array.from({ length: n + 1 }, (_, k) => [x + 20 + k * 12, y + 30] as [number, number]), agent: fixed ? r : undefined });
    }
  return items;
}

const sweep = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, k) => from + k * step);

test("the same seed gives the same plan; another seed another one", () => {
  const o = { agents: 8, seed: 4, start: 1, duration: 6 };
  const a = S.plan(table(false), o);
  const b = S.plan(table(false), o);
  assert.deepEqual(JSON.stringify(a.slots), JSON.stringify(b.slots));
  assert.deepEqual(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.deepEqual([3.3, 5.1].map((t) => a.agentAt(2, t)), [3.3, 5.1].map((t) => b.agentAt(2, t)));
  const c = S.plan(table(false), { ...o, seed: 5 });
  assert.notEqual(JSON.stringify(a.slots.map((s) => s.agent)), JSON.stringify(c.slots.map((s) => s.agent)), "another seed shares the work out differently");
});

test("every item is built by one agent, once, and stays built", () => {
  const items = table(false);
  const P = S.plan(items, { agents: 8, seed: 1, start: 0.5, duration: 7 });
  const works = P.segs.flat().filter((s) => s.kind === "work").map((s) => s.item).sort((x, y) => x - y);
  assert.deepEqual(works, items.map((_, i) => i), "one work stretch per item");
  assert.equal(P.events.filter((e) => e.kind === "done").length, items.length);
  for (let i = 0; i < items.length; i++) {
    const sl = P.slots[i]!;
    assert.ok(sl.start >= P.start && sl.end > sl.start, `item ${i} is built after the start`);
    let last = 0, lastP = 0;
    for (const t of sweep(0, P.gone + 0.5, 1 / 60)) {
      const st = P.itemAt(i, t);
      assert.ok(st.phase >= last, `item ${i} never goes back (t ${t})`);
      if (st.phase === 1 && last === 1) assert.ok(st.p >= lastP - 1e-12, "its progress never goes back");
      last = st.phase;
      lastP = st.p;
    }
    assert.equal(last, 2);
  }
});

test("a held agent stops where it is and carries on from there", () => {
  const hold = { agent: 5, from: 3.9, to: 5.9, color: "#fbbf24", label: "F · needs you" };
  const P = S.plan(table(), { agents: 8, seed: 3, start: 0.6, duration: 7.5, holds: [hold] });
  const at = (t: number) => P.agentAt(5, t)!;
  const still = at(hold.from + 0.001);
  assert.equal(still.state, "hold");
  assert.deepEqual(still.held, hold);
  for (const t of sweep(hold.from, hold.to - 0.001, 0.05)) {
    const a = at(t);
    assert.ok(Math.abs(a.x - still.x) < 1e-9 && Math.abs(a.y - still.y) < 1e-9, `it does not move while held (t ${t})`);
    assert.equal(a.state, "hold");
    if (a.seg === "work") assert.equal(P.itemAt(a.item, t).p, P.itemAt(a.item, hold.from).p, "nor does its work");
  }
  const inside = P.events.filter((e) => e.agent === 5 && e.t > hold.from + 1e-9 && e.t < hold.to - 1e-9);
  assert.deepEqual(inside, [], "nothing of its own starts or lands while it waits");
  assert.ok(P.events.some((e) => e.kind === "hold" && e.agent === 5 && e.t === hold.from));
  assert.ok(P.events.some((e) => e.kind === "resume" && e.agent === 5 && e.t === hold.to));
  assert.notEqual(at(hold.to + 0.3).state, "hold", "and carries on");
  // the others never wait for it
  for (const t of sweep(hold.from, hold.to, 0.25)) assert.notEqual(P.agentAt(2, t)?.state, "hold");
});

test("end is when the last item lands; a duration is met; events in time order", () => {
  const P = S.plan(table(false), { agents: 8, seed: 2, start: 2, duration: 6 });
  assert.equal(P.end, Math.max(...P.slots.map((s) => s.end)));
  assert.ok(Math.abs(P.end - 8) < 1e-3, `start + duration: ${P.end}`);
  assert.ok(P.gone > P.end, "the cursors leave after the last item lands");
  for (let k = 1; k < P.events.length; k++) assert.ok(P.events[k]!.t >= P.events[k - 1]!.t, "sorted by time");
  const slow = S.plan(table(false), { agents: 8, seed: 2, start: 2, speed: 0.5 });
  const fast = S.plan(table(false), { agents: 8, seed: 2, start: 2, speed: 2 });
  assert.ok(slow.end - 2 > 2.5 * (fast.end - 2), "speed scales the build");
});

test("items given to an agent stay with it, in their order, after what they wait for", () => {
  const items = table();
  items[4] = { ...items[4]!, order: 5 }; // row 0's first text goes last in its row
  items.push({ kind: "text", rect: { x: 900, y: 900, w: 60, h: 18 }, after: 4, agent: 3 });
  const P = S.plan(items, { agents: 8, seed: 7, start: 0 });
  items.forEach((it, i) => { if (it.agent != null) assert.equal(P.slots[i]!.agent, it.agent % 8, `item ${i}`); });
  const row0 = items.map((_, i) => i).filter((i) => items[i]!.agent === 0).sort((a, b) => P.slots[a]!.start - P.slots[b]!.start);
  assert.equal(row0[row0.length - 1], 4, "an order sorts it after the rest");
  const last = items.length - 1;
  assert.ok(P.slots[last]!.start >= P.slots[4]!.end, "`after` waits for the item it names");
});

test("a cursor never jumps: before the start nothing, then a continuous path, then gone", () => {
  const P = S.plan(table(false), { agents: 8, seed: 9, start: 1, duration: 5 });
  for (let a = 0; a < 8; a++) {
    assert.equal(P.agentAt(a, 0.99), null, "not before the start");
    assert.equal(P.agentAt(a, P.gone + 0.01), null, "gone after the end");
    let prev: { x: number; y: number } | null = null;
    for (const t of sweep(1, P.gone, 1 / 480)) {
      const q = P.agentAt(a, t);
      if (q && prev) assert.ok(Math.hypot(q.x - prev.x, q.y - prev.y) < 30, `agent ${a} at ${t.toFixed(3)} s moved ${Math.hypot(q.x - prev.x, q.y - prev.y).toFixed(1)} px in 1/480 s`);
      prev = q;
    }
  }
});

test("a repeated label is copied only from a place where it has already landed", () => {
  const items = table();
  for (let r = 0; r < 8; r++) items[3 + r * 6 + 3] = { ...items[3 + r * 6 + 3]!, group: 0 };
  const P = S.plan(items, { agents: 8, seed: 3, start: 0, duration: 6 });
  const copies = P.items.map((it, i) => ({ it, i })).filter(({ it }) => it.kind === "copy");
  assert.ok(copies.length > 0, "some are copied");
  for (const { it, i } of copies) {
    const src = it.copyOf!;
    assert.equal(P.items[src]!.group, 0);
    assert.ok(P.slots[src]!.end <= P.slots[i]!.start, "its source had landed");
    assert.deepEqual(it.src, items[src]!.rect);
    assert.ok(P.events.some((e) => e.item === i && e.kind === "copy"));
  }
  assert.ok(P.items.some((it) => it.group === 0 && it.kind === "text"), "the first of them is typed");
});

test("in Chrome: a table in a tilted, scaled layer is built in place and left as it was", { skip: findChrome() ? false : "no Chrome for Testing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-swarm-test-"));
  const lib = fileURLToPath(new URL("../starter/lib/", import.meta.url));
  await copyFile(join(lib, "anim.js"), join(dir, "anim.js"));
  await copyFile(join(lib, "swarm.js"), join(dir, "swarm.js"));
  const rows = Array.from({ length: 4 }, (_, r) => `<tr data-swarm-agent="${r}"><td>Row ${r}</td><td><span class="chip">running</span></td><td>finding number ${r}</td></tr>`).join("");
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><style>html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #0b0c10; color: #eee; font: 16px sans-serif }
#cam { position: absolute; inset: 0; perspective: 1600px; transform: scale(1.2) }
#win { position: absolute; left: 140px; top: 80px; width: 900px; padding: 24px; background: #15171d; border-radius: 12px; transform: rotateX(14deg) rotateY(-12deg) }
td { padding: 10px 14px; border-bottom: 1px solid #333 } .chip { background: #1e2b3d; padding: 3px 8px; border-radius: 6px; display: inline-flex }
img { width: 300px; height: 150px; display: block }</style>
<div id="cam"><div id="win"><h2>Agents <b>at</b> work</h2><table><tbody>${rows}</tbody></table></div></div>
<div id="pic" style="position: absolute; left: 900px; top: 500px"><canvas id="c" width="300" height="150"></canvas></div>
<script type="module">
import { swarm, swarmBoxes } from "./swarm.js";
const win = document.getElementById("win");
const before = win.innerHTML;
const rects = () => [...win.querySelectorAll("td, h2, .chip")].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(","); }).join(";");
const r0 = rects();
const sw = swarm(win, { agents: 4, seed: 2, start: 1, duration: 3, labels: ["A", "B", "C", "D"], holds: [{ agent: 2, from: 2, to: 2.6, label: "C · needs you" }], lift: 30 });
const c = document.getElementById("c"); const g = c.getContext("2d"); g.fillStyle = "#345"; g.fillRect(0, 0, 300, 150); g.fillStyle = "#9ab"; g.fillRect(20, 20, 100, 30);
const pic = swarmBoxes(c, [{ x: 0, y: 0, w: 300, h: 150 }, { x: 20, y: 20, w: 100, h: 30, kind: "text" }], { agents: 2, seed: 1, start: 0.5, duration: 2 });
const strip = () => { const k = win.cloneNode(true); k.querySelector(".swarm-layer")?.remove(); for (const e of k.querySelectorAll("[class]")) { e.classList.remove("swarm-still", "swarm-nopaint", "swarm-hide"); if (!e.classList.length) e.removeAttribute("class"); } return k.innerHTML; };
/** the text a viewer sees: what is not in an invisible twin */
const shownText = (e) => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let s = ""; for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement.closest("swarm-ghost")) s += n.data; return s; };
const page = () => { const k = win.cloneNode(true); k.querySelector(".swarm-layer")?.remove(); for (const e of k.querySelectorAll("[class]")) e.className = [...e.classList].sort().join(" "); return k.innerHTML; };
const vis = () => [...win.querySelectorAll(".swarm-layer *")].filter((e) => e.checkVisibility()).map((e) => [e.className, e.style.transform, e.style.width, e.style.height, e.style.opacity, e.textContent].join(":")).join(";");
window.run = (t) => { sw.draw(t); pic.draw(t); return {
  html: page() + vis(), clean: strip(), rects: rects(), shown: [...win.querySelectorAll("td")].map(shownText).join("|"),
  ghosts: win.querySelectorAll("swarm-ghost").length, layerInRoot: !!win.querySelector(":scope > .swarm-layer"),
  layer: getComputedStyle(win.querySelector(".swarm-layer")).display, mask: c.style.mask || c.style.webkitMask || "",
  agents: sw.agentsAt(t), end: sw.end, events: sw.events.length, preserve: win.style.transformStyle,
}; };
window.before = before; window.r0 = r0;
</script>`,
  );
  const server = await serveDirectory(dir);
  const b = await launchHtmlBrowser({ chromePath: findChrome()!, url: `${server.url}/index.html`, width: 1280, height: 720 });
  type Got = { html: string; clean: string; rects: string; shown: string; ghosts: number; layerInRoot: boolean; layer: string; mask: string; agents: { visible: boolean; state: string; label: string }[]; end: number; events: number; preserve: string };
  try {
    for (let i = 0; i < 50 && !(await b.evaluate<boolean>("typeof window.run === 'function'")); i++) await new Promise((r) => setTimeout(r, 100));
    const before = await b.evaluate<string>("window.before");
    const r0 = await b.evaluate<string>("window.r0");
    const pre = await b.evaluate<Got>("window.run(0.5)");
    assert.ok(pre.layerInRoot, "the overlay sits inside the root, so its transforms carry the cursors");
    assert.equal(pre.preserve, "preserve-3d", "lift keeps the overlay in 3D above the surface");
    assert.equal(pre.layer, "none", "no cursors before the start");
    assert.equal(pre.shown.replace(/\|/g, ""), "", "before the start no text shows");
    assert.equal(pre.rects, r0, "and nothing has moved");
    assert.ok(pre.events > 0 && pre.end > 1 && pre.end <= 4.001, `end ${pre.end}`);
    const mid = await b.evaluate<Got>("window.run(2.3)");
    assert.equal(mid.rects, r0, "half built, nothing has moved");
    assert.notEqual(mid.layer, "none");
    assert.ok(mid.agents.some((a) => a.state === "hold" && a.label === "C · needs you"), "the held agent shows its hold");
    assert.match(mid.mask, /linear-gradient/, "the picture is masked while its boxes are built");
    const late = await b.evaluate<Got>("window.run(3.6)");
    const again = await b.evaluate<Got>("window.run(2.3)");
    assert.equal(again.html, mid.html, "a frame drawn again, out of order, is the same");
    const after = await b.evaluate<Got>("window.run(9)");
    assert.equal(after.layer, "none", "the cursors have left");
    assert.equal(after.ghosts, 0);
    assert.equal(after.clean, before, "the page is as it was");
    assert.equal(after.rects, r0);
    assert.equal(after.mask, "", "the picture's mask is taken off");
    assert.ok(late.shown.length > mid.shown.length || late.shown === after.shown, "more is typed later");
  } finally {
    await b.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
