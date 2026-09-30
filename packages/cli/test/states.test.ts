// `open-take states`, driven through the real binary on a synthetic take: the
// verb resolves any member of a take like its siblings, refuses unknown
// flags, tells a take made without --states how to get them, and prints the
// a<N> / s<N>:e<N> map (or the same as JSON). Hermetic: no Chrome, no render.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = import.meta.resolve("tsx/esm");

function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.once("error", rej);
    p.once("close", (code) => res({ code: code ?? -1, out, err }));
  });
}

const box = (x: number, y: number, w: number, h: number) => [x, y, w, h];
const page = (label: string) => [
  { id: "e0", path: [], tag: "html", box: box(0, 0, 1280, 720) },
  { id: "e1", path: [1], tag: "body", box: box(0, 0, 1280, 720) },
  { id: "e2", path: [1, 0], tag: "main", box: box(0, 0, 1280, 720) },
  {
    id: "e3",
    path: [1, 0, 0],
    tag: "button",
    role: "button",
    name: "Save",
    text: "Save",
    box: box(100, 100, 80, 32),
    interactive: true,
  },
  { id: "e4", path: [1, 0, 1], tag: "span", name: label, text: label, box: box(100, 160, 120, 20) },
];

/** demos/app.mp4 + demos/app.take/ with two saved states around one click */
async function takeWithStates(dir: string): Promise<void> {
  const take = join(dir, "demos", "app.take");
  await mkdir(take, { recursive: true });
  await writeFile(join(dir, "demos", "app.mp4"), "not really an mp4");
  await writeFile(
    join(take, "capture.json"),
    JSON.stringify({
      video: { width: 1280, height: 720 },
      viewport: { w: 1280, h: 720 },
      events: [
        {
          kind: "click",
          x: 140,
          y: 116,
          box: { x: 100, y: 100, w: 80, h: 32 },
          tMs: 2000,
          sel: "Save",
          state: "s1",
          target: "e3",
        },
      ],
      states: {
        dir: "states",
        items: [
          { id: "s0", tMs: 900, fidelity: { psnr: 40, diffFrac: 0.01, ok: true } },
          { id: "s1", tMs: 3200, step: 0, fidelity: { psnr: 40, diffFrac: 0.01, ok: true } },
        ],
      },
    }),
  );
  for (const [id, label, tMs] of [
    ["s0", "Unsaved", 900],
    ["s1", "Saved", 3200],
  ] as const) {
    const folder = join(take, "states", id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "state.html"), "<!doctype html><html></html>");
    await writeFile(
      join(folder, "index.json"),
      JSON.stringify({
        version: 1,
        id,
        url: "http://app.test/",
        title: "App",
        tMs,
        viewport: { w: 1280, h: 720, dpr: 1 },
        scroll: { x: 0, y: 0 },
        elements: page(label),
        layers: ["e2"],
      }),
    );
  }
}

test("states prints the a<N> / s<N>:e<N> map for any member of the take, and the same as JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-states-cli-"));
  await takeWithStates(dir);
  const r = await run(["states", "demos/app.mp4"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^app\.take — 2 saved states/m);
  assert.match(r.out, /^a1 {2}click "Save" · 2\.00s · on s0:e3$/m);
  assert.match(r.out, /^ {4}~ s1:e4 "Unsaved" → "Saved" · \[100,160,120,20\]$/m);

  // the working dir and a file inside it resolve to the same take
  const viaDir = await run(["states", "demos/app.take"], dir);
  assert.equal(viaDir.out, r.out);
  const viaFile = await run(["states", "demos/app.take/capture.json"], dir);
  assert.equal(viaFile.out, r.out);

  const json = await run(["states", "demos", "--json"], dir);
  assert.equal(json.code, 0, json.err);
  const data = JSON.parse(json.out) as { actions: { id: string }[]; states: { id: string }[] };
  assert.deepEqual(
    data.actions.map((a) => a.id),
    ["a1"],
  );
  assert.deepEqual(
    data.states.map((s) => s.id),
    ["s0", "s1"],
  );

  const outline = await run(["states", "demos/app.mp4", "--state", "s1"], dir);
  assert.equal(outline.code, 0, outline.err);
  assert.match(outline.out, /^e2 {3}main \[0,0,1280,720\]/m);
  assert.match(outline.out, /e3 button "Save" \[100,100,80,32\]/);
});

test("a take made without --states is told to re-record with it; flags are checked like every verb", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-take-states-cli-"));
  const take = join(dir, "demos", "plain.take");
  await mkdir(take, { recursive: true });
  await writeFile(join(dir, "demos", "plain.mp4"), "not really an mp4");
  await writeFile(
    join(take, "capture.json"),
    JSON.stringify({
      video: { width: 1280, height: 720 },
      viewport: { w: 1280, h: 720 },
      events: [],
    }),
  );
  const r = await run(["states", "demos/plain.mp4"], dir);
  assert.equal(r.code, 1);
  assert.match(
    r.err,
    /plain\.take has no saved states — re-record it with `open-take make --states`/,
  );

  const missing = await run(["states"], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /states: missing <take>/);

  const unknown = await run(["states", "demos/plain.mp4", "--draft"], dir);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /states: unknown flag --draft/);
  assert.match(unknown.err, /--state --json/, "lists what states does accept");

  const help = await run(["--help"], dir);
  assert.equal(help.code, 0);
  assert.match(help.out, /open-take states <take> \[--state <id>\] \[--json\]/);
});
