// `film init`'s starter: START.md, PLAN.md, reference/, lib/ and samples/
// beside the kit, at the paths lib/sampler.mjs reads them from (../kit,
// ../samples). A file the author changed is kept, --force replaces it — PLAN.md
// never, once written in. The sampler plays from an initialised folder through
// the folder's own kit/audio.mjs (ffmpeg decodes), and lib/anim.js loads in Node.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveFfmpeg } from "../src/ffmpeg";
import { filmInitLines, filmStarterDir, initFilm, STARTER_PARTS } from "../src/film/kit";

const exec = promisify(execFile);
let dir = "";
let film = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-film-starter-test-"));
  film = join(dir, "film");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** the starter's files, relative, as init copies them: .DS_Store left out */
function starterFiles(): string[] {
  const root = filmStarterDir();
  const walk = (rel: string): string[] =>
    readdirSync(join(root, rel), { withFileTypes: true })
      .filter((e) => e.name !== ".DS_Store")
      .flatMap((e) => (e.isDirectory() ? walk(join(rel, e.name)) : [join(rel, e.name)]));
  return STARTER_PARTS.flatMap((p) => (p.endsWith(".md") ? [p] : walk(p))).sort();
}

const rel = (fs: string[]) => fs.map((f) => relative(film, f)).sort();
const show = (p: string) => relative(dir, p);

test("film init writes the kit and the starter at the film's paths; a second run changes nothing", async () => {
  const files = starterFiles();
  for (const f of [
    "START.md",
    "PLAN.md",
    "reference/structure.md",
    "reference/motion.md",
    "lib/anim.js",
    "lib/sampler.mjs",
    "samples/manifest.json",
    "samples/NOTICE.txt",
  ])
    assert.ok(files.includes(f), `the starter has ${f}`);
  const samples = files.filter((f) => f.startsWith("samples/"));
  assert.ok(samples.length > 100, `${samples.length} sample files`);

  const first = await initFilm({ dir: film });
  assert.equal(first.dir, film);
  assert.deepEqual(rel(first.starter.written), files, "every starter file, at its own path");
  assert.deepEqual(first.starter.kept, []);
  assert.deepEqual(first.starter.same, []);
  const root = filmStarterDir();
  for (const f of ["START.md", "lib/sampler.mjs", "samples/manifest.json", samples[0]!])
    assert.deepEqual(
      await readFile(join(film, f)),
      await readFile(join(root, f)),
      `${f} as shipped`,
    );
  // the kit beside it, as the sampler imports it, and the page
  const kit = rel(first.written);
  for (const f of ["kit/audio.mjs", "kit/time.js", "kit/three.module.min.js", "index.html"])
    assert.ok(kit.includes(f), `${f} written`);
  assert.ok(
    !kit.some((f) => !f.startsWith("kit/") && f !== "index.html"),
    "the kit's list holds the kit and the page",
  );
  assert.equal(first.start, join(film, "START.md"));
  const page = await readFile(join(film, "index.html"), "utf8");
  assert.match(page, /START\.md in this folder is what to read first/);

  // what the CLI prints: a line a kit file, samples/ as one line, START.md last
  const lines = filmInitLines(first, show);
  assert.ok(lines.includes("wrote film/kit/camera.js"));
  assert.ok(lines.includes("wrote film/START.md"));
  assert.ok(lines.includes("wrote film/lib/sampler.mjs"));
  assert.ok(
    lines.includes(
      `wrote film/samples/ (${samples.length} files — recorded instruments; NOTICE.txt has their licences)`,
    ),
    lines.join("\n"),
  );
  assert.ok(!lines.some((l) => /samples\/piano/.test(l)), "no line a sample");
  assert.ok(lines.length < 30, `${lines.length} lines`);
  assert.equal(lines.at(-1), "Read film/START.md first.");

  // again: nothing written, nothing kept, all of it already the same
  const before = (await stat(join(film, samples[0]!))).mtimeMs;
  const again = await initFilm({ dir: film });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.kept, []);
  assert.deepEqual(again.starter.written, []);
  assert.deepEqual(again.starter.kept, []);
  assert.deepEqual(rel(again.starter.same), files);
  assert.equal((await stat(join(film, samples[0]!))).mtimeMs, before, "not written again");
  const quiet = filmInitLines(again, show);
  assert.equal(quiet.length, 2, quiet.join("\n"));
  assert.match(
    quiet[0]!,
    new RegExp(
      `^already the same in film/: kit/ \\(\\d+ files\\), START\\.md, PLAN\\.md, reference/ \\(2 files\\), lib/ \\(2 files\\), samples/ \\(${samples.length} files\\)$`,
    ),
  );
  assert.equal(quiet[1], "Read film/START.md first.");
});

test("a changed START.md is kept and replaced with force; a changed PLAN.md is kept even with force", async () => {
  const shipped = await readFile(join(filmStarterDir(), "START.md"), "utf8");
  await writeFile(join(film, "START.md"), "# mine\n");
  await writeFile(join(film, "PLAN.md"), "# Plan\n\nthe film: a photo, 2.79 MB → 276 kB\n");
  // a sample gone is written again, alone
  const gone = join(film, "samples", "piano", "piano_69_8.opus");
  await unlink(gone);
  const kept = await initFilm({ dir: film });
  assert.deepEqual(rel(kept.starter.kept), ["PLAN.md", "START.md"]);
  assert.deepEqual(rel(kept.starter.written), ["samples/piano/piano_69_8.opus"]);
  assert.equal(await readFile(join(film, "START.md"), "utf8"), "# mine\n");
  const lines = filmInitLines(kept, show);
  assert.ok(lines.includes("wrote film/samples/piano/piano_69_8.opus"), lines.join("\n"));
  assert.ok(
    lines.includes("kept film/START.md — yours differs from the starter's (--force replaces it)"),
  );
  assert.ok(
    lines.includes(
      "kept film/PLAN.md — the film's plan, written in: never replaced, with or without --force",
    ),
  );
  assert.equal(
    lines.at(-1),
    "Read film/START.md first.",
    "a kept START.md is still the one to read",
  );

  const forced = await initFilm({ dir: film, force: true });
  assert.deepEqual(rel(forced.starter.written), ["START.md"]);
  assert.deepEqual(rel(forced.starter.kept), ["PLAN.md"]);
  assert.equal(await readFile(join(film, "START.md"), "utf8"), shipped);
  assert.match(await readFile(join(film, "PLAN.md"), "utf8"), /2\.79 MB → 276 kB/);
  assert.ok(
    filmInitLines(forced, show).includes(
      "kept film/PLAN.md — the film's plan, written in: never replaced, with or without --force",
    ),
  );

  // many samples changed: one line, not one a sample
  const piano = readdirSync(join(film, "samples", "piano")).slice(0, 8);
  for (const f of piano) await writeFile(join(film, "samples", "piano", f), "not a sample");
  const many = filmInitLines(await initFilm({ dir: film }), show).filter((l) =>
    l.startsWith("kept"),
  );
  assert.equal(many.length, 2, many.join("\n"));
  assert.match(many[0]!, /^kept film\/PLAN\.md/);
  assert.match(
    many[1]!,
    /^kept 8 files in film\/samples\/ — yours differ from the starter's \(--force replaces them\): piano\/\S+, piano\/\S+, piano\/\S+, …$/,
  );
  await initFilm({ dir: film, force: true });
});

test("starter: false writes the kit and the page, none of the starter", async () => {
  const bare = join(dir, "bare");
  const r = await initFilm({ dir: bare, starter: false });
  assert.deepEqual(r.starter, { written: [], same: [], kept: [] });
  assert.equal(r.start, null);
  assert.ok(r.written.some((f) => f.endsWith("kit/audio.mjs")));
  for (const p of STARTER_PARTS)
    await assert.rejects(stat(join(bare, p)), { code: "ENOENT" }, `${p} not written`);
  assert.doesNotMatch(
    await readFile(join(bare, "index.html"), "utf8"),
    /START\.md|lib\/|samples\//,
  );
  assert.ok(!filmInitLines(r, show).some((l) => /START\.md/.test(l)), "nothing to point at");
});

/** RMS of x from sample a to b */
const rms = (x: Float32Array, a: number, b: number) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! ** 2;
  return Math.sqrt(s / Math.max(1, b - a));
};

test("lib/sampler.mjs in a film folder plays a piano note and a kick through the folder's kit", async () => {
  // the ffmpeg the rest of the suite uses, for the folder's kit/audio.mjs load()
  process.env.OPEN_TAKE_FFMPEG ??= await resolveFfmpeg();
  const audio = await import(pathToFileURL(join(film, "kit", "audio.mjs")).href);
  const { sampler, n } = await import(pathToFileURL(join(film, "lib", "sampler.mjs")).href);
  const SR = 48000;
  const S = sampler();
  assert.equal(n("A4"), 69);
  assert.equal(n("C4"), 60);

  // one piano note, held 0.5 s and released over 0.25 s: 0.75 s of sound
  const note = S.sound("piano", n("A4"), { vel: 0.6, dur: 0.5, release: 0.25 });
  assert.equal(note.length, 2);
  assert.equal(note.sampleRate, SR);
  assert.equal(note[0].length, Math.round(0.75 * SR));
  assert.ok(rms(note[0], 0, Math.round(0.5 * SR)) > 0.01, "the note sounds");

  const B = audio.buses(2, ["keys", "drums"]);
  const at = S.note(B.keys, "piano", n("A4"), 0.25, { vel: 0.6, dur: 0.5, release: 0.25 });
  assert.ok(Math.abs(at.start - 0.25) < 1e-3, `starts at 0.25 s (${at.start})`);
  assert.ok(Math.abs(at.end - at.start - 0.75) < 1e-3, `0.75 s long (${at.end - at.start})`);
  const keys = B.keys[0];
  assert.equal(keys.length, 2 * SR, "the bus is as long as asked");
  assert.equal(rms(keys, 0, Math.round(0.24 * SR)), 0, "silent before the note");
  assert.ok(rms(keys, Math.round(0.26 * SR), Math.round(0.75 * SR)) > 0.01, "the note in the bus");
  assert.equal(rms(keys, Math.round(1.01 * SR), 2 * SR), 0, "silent after its release");

  // one kick, its recorded attack on 1.0 s
  const hit = S.hit(B.drums, "pk_kick", 1.0, { vel: 0.8, align: "onset" });
  assert.ok(hit.end > hit.start && hit.end <= 2.5, `a hit (${hit.start}–${hit.end} s)`);
  const drums = B.drums[0];
  assert.ok(rms(drums, Math.round(1.0 * SR), Math.round(1.2 * SR)) > 0.01, "the kick in the bus");
  assert.ok(rms(drums, 0, Math.round(0.9 * SR)) < 1e-4, "nothing before it");

  // the instruments used, credited: the piano needs CC BY 3.0, the kick nothing
  const credits: { what: string; licence: string; text: string }[] = S.credits();
  const piano = credits.find((c) => /piano/.test(c.what));
  assert.ok(piano, JSON.stringify(credits));
  assert.equal(piano.licence, "CC-BY-3.0");
  assert.match(piano.text, /Salamander Grand Piano V3 by Alexander Holm, CC BY 3\.0/);
  const kick = credits.find((c) => /pk_kick/.test(c.what));
  assert.ok(kick, JSON.stringify(credits));
  assert.match(kick.licence, /CC0/);
  assert.equal(credits.length, 2, "only what was played");
});

test("lib/anim.js in a film folder loads in Node, its functions of t as it says", async () => {
  // plain Node, as a film's own script runs: the folder has no package.json,
  // and Node takes the .js as a module by its syntax (tsx, which runs these
  // tests, would load it as CommonJS instead)
  const { stdout } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const A = await import(${JSON.stringify(pathToFileURL(join(film, "lib", "anim.js")).href)});
const ks = [[1, { x: 0, s: 1 }], [3, { x: 100, s: 4 }, "linear"]];
const eases = Object.fromEntries(["linear", "inOut3", "out5", "push", "count", "pull", "fling"].map((n) => [n, [A.ease[n](0), A.ease[n](1)]]));
console.log(JSON.stringify({
  clamp: [A.clamp(1.3), A.clamp(-0.2), A.clamp(5, 0, 10)],
  lerp: A.lerp(0, 100, 0.25),
  prog: [A.prog(2.3, 2, 2.6), A.prog(9, 2, 2.6)],
  eases,
  keys: [A.keys(0, ks), A.keys(1, ks), A.keys(2, ks), A.keys(3, ks), A.keys(9, ks)],
  typeOn: A.typeOn(1.5, 1, "hello", 4),
  fmt: A.fmt(2576),
}));`,
    ],
    { cwd: film, env: { ...process.env, NODE_OPTIONS: "" } },
  );
  const A = JSON.parse(stdout);
  assert.deepEqual(A.clamp, [1, 0, 5]);
  assert.equal(A.lerp, 25);
  assert.ok(Math.abs(A.prog[0] - 0.5) < 1e-9);
  assert.equal(A.prog[1], 1, "held at 1 after b");
  for (const [name, [at0, at1]] of Object.entries(A.eases as Record<string, number[]>)) {
    assert.ok(Math.abs(at0!) < 1e-9, `${name}(0) is 0`);
    assert.ok(Math.abs(at1! - 1) < 1e-9, `${name}(1) is 1`);
  }
  const [before, first, mid, last, beyond] = A.keys;
  assert.deepEqual(before, { x: 0, s: 1 }, "the first key held before it");
  assert.deepEqual(first, { x: 0, s: 1 });
  assert.deepEqual(last, { x: 100, s: 4 });
  assert.deepEqual(beyond, { x: 100, s: 4 }, "the last key held after it");
  assert.equal(mid.x, 50);
  assert.ok(Math.abs(mid.s - 2) < 1e-9, "a zoom mixes in log space");
  assert.equal(A.typeOn, "he");
  assert.equal(A.fmt, "2,576");
});
