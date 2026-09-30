// `open-take states` on a synthetic take: a capture.json with three actions
// and five saved states written into a temp dir. What is pinned is the
// contract a launch film is written against — actions numbered a1..aN in
// capture order, elements named per state (s1:e6) — and the grouping that
// keeps the listing readable: an added subtree is one line, a swapped-out
// panel is one "was → now" line, a child that rode along with its parent is
// not repeated, a failed fidelity check is loud, and a pixel change no
// element accounts for says so.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeTake, formatTakeStates, outlineState } from "../src/states-list";

type Box = [number, number, number, number];
type El = {
  id: string;
  path: number[];
  tag: string;
  box: Box;
  role?: string;
  name?: string;
  text?: string;
  interactive?: true;
};

const el = (id: string, path: number[], tag: string, box: Box, extra: Partial<El> = {}): El => ({
  id,
  path,
  tag,
  box,
  ...extra,
});
const labelled = (
  id: string,
  path: number[],
  tag: string,
  box: Box,
  label: string,
  extra: Partial<El> = {},
): El => el(id, path, tag, box, { name: label, text: label, ...extra });
const button = (id: string, path: number[], box: Box, label: string): El =>
  labelled(id, path, "button", box, label, { role: "button", interactive: true });

const frame = (): El[] => [
  el("e0", [], "html", [0, 0, 1280, 720]),
  el("e1", [1], "body", [0, 0, 1280, 720]),
  el("e2", [1, 0], "header", [0, 0, 1280, 48]),
];

// s0: an empty panel, a Depth slider row, a small tagged box
const S0: El[] = [
  ...frame(),
  labelled("e3", [1, 0, 0], "span", [16, 14, 60, 20], "Inbox"),
  button("e4", [1, 0, 1], [1180, 8, 84, 32], "Compose"),
  el("e5", [1, 1], "main", [0, 48, 1280, 672]),
  el("e6", [1, 1, 0], "div", [40, 80, 400, 200]),
  labelled("e7", [1, 1, 0, 0], "p", [56, 96, 200, 20], "Nothing selected"),
  el("e8", [1, 1, 1], "div", [900, 100, 200, 24]),
  labelled("e9", [1, 1, 1, 0], "span", [900, 104, 50, 16], "Depth"),
  el("e10", [1, 1, 1, 1], "input", [960, 100, 80, 20], { role: "slider", interactive: true }),
  labelled("e11", [1, 1, 1, 2], "span", [1050, 104, 40, 16], "2.2×"),
  el("e12", [1, 1, 2], "div", [600, 400, 100, 50]),
  labelled("e13", [1, 1, 2, 0], "span", [610, 410, 30, 16], "tag"),
];

// s1 (after a1 clicked Compose): the panel now holds a compose card, the
// header count changed, a toast appeared
const S1: El[] = [
  ...frame(),
  labelled("e3", [1, 0, 0], "span", [16, 14, 60, 20], "Inbox (1)"),
  button("e4", [1, 0, 1], [1180, 8, 84, 32], "Compose"),
  el("e5", [1, 1], "main", [0, 48, 1280, 672]),
  el("e6", [1, 1, 0], "div", [40, 80, 400, 200]),
  labelled("e7", [1, 1, 0, 0], "h2", [56, 96, 200, 24], "New message", { role: "heading" }),
  el("e8", [1, 1, 0, 1], "input", [56, 130, 300, 28], {
    role: "textbox",
    name: "To",
    interactive: true,
  }),
  button("e9", [1, 1, 0, 2], [56, 170, 80, 32], "Send"),
  el("e10", [1, 1, 1], "div", [900, 100, 200, 24]),
  labelled("e11", [1, 1, 1, 0], "span", [900, 104, 50, 16], "Depth"),
  el("e12", [1, 1, 1, 1], "input", [960, 100, 80, 20], { role: "slider", interactive: true }),
  labelled("e13", [1, 1, 1, 2], "span", [1050, 104, 40, 16], "2.2×"),
  el("e14", [1, 1, 2], "div", [600, 400, 100, 50]),
  labelled("e15", [1, 1, 2, 0], "span", [610, 410, 30, 16], "tag"),
  el("e16", [1, 1, 3], "div", [900, 600, 300, 60]),
  labelled("e17", [1, 1, 3, 0], "span", [910, 610, 60, 20], "Saved"),
  button("e18", [1, 1, 3, 1], [1100, 612, 60, 28], "Undo"),
];

// s2 (after a2 dragged the slider): the value changed, the tagged box moved
// (its span with it), the toast went
const S2: El[] = S1.slice(0, 16).map((e) => {
  if (e.id === "e13") return labelled("e13", e.path, "span", e.box, "1.6×");
  if (e.id === "e14") return el("e14", e.path, "div", [700, 450, 100, 50]);
  if (e.id === "e15") return labelled("e15", e.path, "span", [710, 460, 30, 16], "tag");
  return e;
});

const OK = { psnr: 41.2, diffFrac: 0.002, ok: true };
const BAD = { psnr: 21.4, diffFrac: 0.31, ok: false };

async function writeTake(
  dir: string,
  opts: { states?: boolean; movingS2?: boolean } = {},
): Promise<void> {
  const items: { id: string; tMs: number; step?: number; fidelity?: typeof OK; moving?: true }[] = [
    { id: "s0", tMs: 900, fidelity: OK },
    { id: "s1", tMs: 3500, step: 0, fidelity: OK },
    // a moment the page was still moving at: logged, nothing saved
    opts.movingS2
      ? { id: "s2", tMs: 8000, step: 1, moving: true }
      : { id: "s2", tMs: 8000, step: 1, fidelity: BAD },
    { id: "s3", tMs: 11000, step: 2, fidelity: OK },
    // its folder is never written — a state the capture lost
    { id: "s4", tMs: 12000, step: 3, fidelity: OK },
  ];
  const log = {
    video: { width: 1280, height: 720, fps: 60 },
    viewport: { w: 1280, h: 720 },
    start: { x: 100, y: 600 },
    events: [
      {
        kind: "click",
        x: 1222,
        y: 24,
        box: { x: 1180, y: 8, w: 84, h: 32 },
        tMs: 2000,
        sel: "Compose",
        state: "s1",
        target: "e4",
        effectBox: { x: 40, y: 80, w: 400, h: 200 },
        changeCoverage: 0.09,
      },
      {
        kind: "drag",
        x: 1000,
        y: 110,
        to: { x: 980, y: 110 },
        tMs: 5000,
        sel: "input[type=range]",
        durationMs: 800,
        state: "s2",
        effectBox: { x: 600, y: 400, w: 200, h: 100 },
        changeCoverage: 0.03,
      },
      {
        kind: "click",
        x: 1222,
        y: 24,
        box: { x: 1180, y: 8, w: 84, h: 32 },
        tMs: 9000,
        sel: "Compose",
        state: "s3",
        target: "e4",
        effectBox: { x: 0, y: 48, w: 1280, h: 672 },
        changeCoverage: 0.6,
      },
    ],
    tEndMs: 12500,
    ...(opts.states === false ? {} : { states: { dir: "states", items } }),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "capture.json"), JSON.stringify(log));
  if (opts.states === false) return;
  const bodies: Record<string, El[]> = { s0: S0, s1: S1, s2: S2, s3: S2 };
  for (const it of items) {
    const elements = bodies[it.id];
    if (!elements || it.moving) continue;
    const folder = join(dir, "states", it.id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "state.html"), "<!doctype html><html></html>");
    await writeFile(
      join(folder, "index.json"),
      JSON.stringify({
        version: 1,
        id: it.id,
        url: "http://app.test/",
        title: "Mail",
        tMs: it.tMs,
        ...(it.step != null ? { step: it.step } : {}),
        viewport: { w: 1280, h: 720, dpr: 1 },
        scroll: { x: 0, y: 0 },
        elements,
        layers: ["e2", "e5"],
        fidelity: it.fidelity,
      }),
    );
  }
}

async function scene(): Promise<{
  dir: string;
  text: string;
  data: ReturnType<typeof describeTake>;
}> {
  const root = await mkdtemp(join(tmpdir(), "open-take-states-test-"));
  const dir = join(root, "mail.take");
  await writeTake(dir);
  const data = describeTake(dir);
  return { dir, text: formatTakeStates(data), data };
}

test("actions are numbered a1..aN in capture order and sit between the states they act on and produce", async () => {
  const { dir, text, data } = await scene();
  try {
    assert.deepEqual(
      data.actions.map((a) => a.id),
      ["a1", "a2", "a3"],
    );
    assert.equal(data.states[1]!.after, "a1");
    assert.equal(data.states[0]!.after, undefined);
    const order = ["s0 ", "a1 ", "s1 ", "a2 ", "s2 ", "a3 ", "s3 ", "s4 "].map((k) =>
      text.split("\n").findIndex((l) => l.startsWith(k)),
    );
    assert.ok(
      order.every((i) => i >= 0),
      `every state and action has a line: ${order}`,
    );
    assert.deepEqual(
      [...order].sort((p, q) => p - q),
      order,
      "in timeline order",
    );
    assert.match(
      text,
      /^a1 {2}click "Compose" · 2\.00s · on s0:e4$/m,
      "the target lives in the state before",
    );
    assert.match(
      text,
      /^mail\.take — 5 saved states · page 1280×720 CSS px · fidelity 3\/5 ok \(s2 FAILED\)$/m,
    );
    assert.match(text, /ids are per state/, "the per-state id contract is stated up front");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an added subtree is one line at its outermost element, with its content", async () => {
  const { dir, text, data } = await scene();
  try {
    const s1 = data.states[1]!.changes!;
    const toast = s1.find((c) => c.ref === "s1:e16");
    assert.ok(toast, "the toast is a line");
    assert.equal(toast.kind, "added");
    assert.equal(toast.content, "Saved · Undo");
    assert.equal(toast.card, true, "two labels, 2% of the page: liftable");
    assert.ok(
      !s1.some((c) => c.ref === "s1:e17" || c.ref === "s1:e18"),
      "its children are not repeated",
    );
    assert.match(text, /^ {4}\+ s1:e16 card \[900,600,300,60\] "Saved · Undo"$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a panel whose children were swapped out is one was → now line", async () => {
  const { dir, text, data } = await scene();
  try {
    const s1 = data.states[1]!.changes!;
    const panel = s1.find((c) => c.ref === "s1:e6");
    assert.ok(panel);
    assert.equal(panel.kind, "replaced");
    assert.equal(panel.was, "Nothing selected");
    assert.equal(panel.content, "New message · To · Send");
    assert.ok(
      !s1.some((c) => ["s1:e7", "s1:e8", "s1:e9", "s0:e7"].includes(c.ref)),
      "the swapped children are folded in",
    );
    assert.match(
      text,
      /^ {4}~ s1:e6 card \[40,80,400,200\] "Nothing selected" → "New message · To · Send"$/m,
    );
    assert.equal(s1.length, 3, "header relabel + panel swap + toast, nothing else");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a text change prints old → new with the element's box", async () => {
  const { dir, text } = await scene();
  try {
    assert.match(text, /^ {4}~ s1:e3 "Inbox" → "Inbox \(1\)" · \[16,14,60,20\]$/m);
    assert.match(text, /^ {4}~ s2:e13 "2\.2×" → "1\.6×" · \[1050,104,40,16\]$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a drag has no box: its target is the element under the drag start, in the state before", async () => {
  const { dir, text, data } = await scene();
  try {
    const drag = data.actions[1]!;
    assert.equal(drag.kind, "drag");
    assert.equal(drag.before, "s1");
    assert.deepEqual(
      { ref: drag.target?.ref, by: drag.target?.by, role: drag.target?.role },
      { ref: "s1:e12", by: "point", role: "slider" },
      "the smallest interactive element containing the point, not the row around it",
    );
    assert.match(
      text,
      /^a2 {2}drag "input\[type=range\]" → \(980,110\) · 5\.00s–5\.80s · from s1:e12 \(slider\)$/m,
    );
    assert.equal(data.actions[0]!.target?.by, "capture", "a click keeps the capture's own match");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a child that moved exactly with its parent is not repeated; a removal names the previous state's id", async () => {
  const { dir, text, data } = await scene();
  try {
    const s2 = data.states[2]!.changes!;
    const box = s2.find((c) => c.ref === "s2:e14");
    assert.ok(box);
    assert.deepEqual(box.from, [600, 400, 100, 50]);
    assert.ok(!s2.some((c) => c.ref === "s2:e15"), "the span rode along");
    assert.match(text, /^ {4}~ s2:e14 moved \[600,400,100,50\] → \[700,450,100,50\]$/m);
    assert.match(text, /^ {4}- s1:e16 card \[900,600,300,60\] "Saved · Undo"$/m);
    assert.equal(s2.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed fidelity check is loud, a missing state is named, and pixels no element explains are flagged", async () => {
  const { dir, text, data } = await scene();
  try {
    assert.equal(data.states[2]!.status, "failed");
    assert.match(
      text,
      /^s2 {2}after a2 · 8\.00s · FIDELITY FAILED 21\.4 dB — use the recording here$/m,
    );
    assert.equal(data.states[4]!.status, "missing");
    assert.match(
      text,
      /^s4 {2}after step 4 \(no action\) · 12\.00s · MISSING — no saved state at/m,
    );
    // a3 repainted most of the page and changed no element: a paint / style change
    assert.equal(data.states[3]!.changes!.length, 0);
    assert.equal(data.states[3]!.pixels?.unexplained, true);
    assert.match(text, /^ {4}pixels {2}\[0,48,1280,672\] — no element changed there/m);
    // a1's pixels sit where the panel changed: explained, printed plain
    assert.equal(data.states[1]!.pixels?.unexplained, false);
    assert.match(text, /^ {4}pixels {2}\[40,80,400,200\]$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a moment the page was still moving at is named as such, and the next state is compared with the last saved one", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-take-states-test-"));
  const dir = join(root, "mail.take");
  try {
    await writeTake(dir, { movingS2: true });
    const data = describeTake(dir);
    const text = formatTakeStates(data);
    assert.equal(data.states[2]!.moving, true);
    assert.match(
      text,
      /^s2 {2}after a2 · 8\.00s · MOVING — not saved: the page never went quiet here; use the recording$/m,
    );
    // s3 differs from s1 (the last saved screen), not from the unsaved s2
    assert.ok(data.states[3]!.changes!.length > 0, "s3 is diffed against s1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--state outlines one state: regions, the cards a film could lift, and every control and text with its box", async () => {
  const { dir, data } = await scene();
  try {
    const o = outlineState(data, "s1");
    assert.deepEqual(
      o.regions.map((r) => [r.id, r.name]),
      [
        ["e2", "header"],
        ["e5", "main"],
      ],
    );
    const main = o.regions[1]!;
    assert.deepEqual(
      main.cards.map((c) => c.id),
      ["e6", "e10", "e16"],
      "the compose panel, the slider row and the toast qualify; the tagged box (one label) does not",
    );
    const compose = main.cards[0]!;
    assert.equal(compose.content, "New message · To · Send");
    assert.deepEqual(
      compose.leaves.map((l) => [l.id, l.role, l.label]),
      [
        ["e7", "heading", "New message"],
        ["e8", "textbox", "To"],
        ["e9", "button", "Send"],
      ],
    );
    assert.deepEqual(
      main.leaves.map((l) => l.id),
      ["e15"],
      "a text outside every card sits under its region",
    );
    const text = formatTakeStates(data, { state: "s1" });
    assert.match(
      text,
      /^s1 {2}after a1 · 3\.50s · ok · 19 elements · "Mail" http:\/\/app\.test\/$/m,
    );
    assert.match(text, /^ {5}card e6 \[40,80,400,200\] "New message · To · Send"$/m);
    assert.match(text, /e8 textbox "To" \[56,130,300,28\]/);
    assert.match(text, /^e2 {3}header \[0,0,1280,48\] {2}"Inbox \(1\) · Compose"$/m);
    assert.throws(() => outlineState(data, "s9"), /no state s9 in mail\.take/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--json is the same data: plain JSON with the actions, the states and their changes", async () => {
  const { dir, data } = await scene();
  try {
    const json = JSON.parse(JSON.stringify(data)) as typeof data;
    assert.deepEqual(Object.keys(json).sort(), [
      "actions",
      "dir",
      "fidelity",
      "states",
      "take",
      "viewport",
    ]);
    assert.equal(json.take, "mail.take");
    assert.deepEqual(json.fidelity, { ok: 3, total: 5, failed: ["s2"] });
    assert.deepEqual(json.viewport, { w: 1280, h: 720, dpr: 1 });
    assert.equal(json.actions[0]!.target?.ref, "s0:e4");
    assert.equal(json.actions[1]!.endMs, 5800);
    assert.equal(json.states[1]!.regions?.[0]?.ref, "s1:e2");
    assert.equal(json.states[1]!.changes?.[1]?.kind, "replaced");
    assert.equal(json.states[4]!.error?.includes("index.json"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a take recorded without --states says how to get them", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-take-states-test-"));
  const dir = join(root, "plain.take");
  try {
    await writeTake(dir, { states: false });
    assert.throws(
      () => describeTake(dir),
      /plain\.take has no saved states — re-record it with `open-take make --states`/,
    );
    assert.throws(() => describeTake(join(root, "nothing.take")), /no capture log at/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
