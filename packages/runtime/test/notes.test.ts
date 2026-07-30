// notes — the editor→agent channel. The properties that matter: a note is
// delivered EXACTLY once (a cursor the reader owns), a waiter exits on the
// first note (that exit is the agent's wake-up), a waiter started late still
// finds what it missed, and a burst arrives as one batch.

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { startEditServer } from "../src/edit-server.js";
import { formatNotes, readNotes, waitForNotes } from "../src/notes.js";
import { resolveTakePaths } from "../src/take.js";

let dir: string;
let take: Awaited<ReturnType<typeof resolveTakePaths>>;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-take-notes-"));
  take = await resolveTakePaths(join(dir, "demo.mp4"));
  await mkdir(take.dir, { recursive: true });
  await writeFile(take.compositionPath, "{}");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const note = (t: string) => appendFile(take.notesPath, `- ${t}\n`);
const reset = async () => {
  await rm(take.notesPath, { force: true });
  await rm(take.notesCursorPath, { force: true });
};

test("the notes sidecars live in the working dir, and resolve back to the take", async () => {
  const t = await resolveTakePaths("out/demo.mp4");
  assert.equal(t.notesPath, resolve("out/demo.take/notes.md"));
  assert.equal(t.notesCursorPath, resolve("out/demo.take/notes.cursor"));
  assert.equal((await resolveTakePaths("out/demo.take/notes.md")).base, resolve("out/demo"));
  assert.equal((await resolveTakePaths("out/demo.take/notes.cursor")).base, resolve("out/demo"));
});

test("no notes file yet is empty, not an error", async () => {
  await reset();
  const res = await readNotes(take);
  assert.deepEqual(res.notes, []);
  assert.equal(res.total, 0);
});

test("each note is delivered exactly once", async () => {
  await reset();
  await note("the opening is too slow");
  await note("no zoom on beat 3");
  const first = await readNotes(take);
  assert.deepEqual(first.notes, ["the opening is too slow", "no zoom on beat 3"]);
  assert.equal(first.total, 2);

  // second read: nothing new, but the log still knows how many it holds
  const second = await readNotes(take);
  assert.deepEqual(second.notes, []);
  assert.equal(second.total, 2);

  await note("hold the ending longer");
  const third = await readNotes(take);
  assert.deepEqual(third.notes, ["hold the ending longer"]);
});

test("--all re-reads the whole log; --peek leaves the cursor alone", async () => {
  await reset();
  await note("a");
  await readNotes(take);
  assert.deepEqual((await readNotes(take, { all: true })).notes, ["a"]);

  await note("b");
  assert.deepEqual((await readNotes(take, { peek: true })).notes, ["b"]);
  assert.deepEqual((await readNotes(take)).notes, ["b"], "peek must not consume");
});

test("a truncated log restarts from the top instead of going silent", async () => {
  await reset();
  await note("old note");
  await readNotes(take);
  await writeFile(take.notesPath, "- fresh\n"); // shorter than the saved cursor
  assert.deepEqual((await readNotes(take)).notes, ["fresh"]);
});

test("a half-written final line is left for the next read", async () => {
  await reset();
  await writeFile(take.notesPath, "- whole\n- partial");
  assert.deepEqual((await readNotes(take)).notes, ["whole"]);
  await appendFile(take.notesPath, " and the rest\n");
  assert.deepEqual((await readNotes(take)).notes, ["partial and the rest"]);
});

// Deliberately multi-byte: the cursor is a BYTE offset, so a note that is not
// pure ASCII is the case that catches measuring it in characters instead. Notes
// are free text in whatever language the user speaks — keep this one non-Latin.
test("the cursor is a byte offset the reader owns", async () => {
  await reset();
  await note("開頭太慢");
  const res = await readNotes(take);
  assert.equal(Number((await readFile(take.notesCursorPath, "utf8")).trim()), res.cursor);
  assert.equal(res.cursor, (await readFile(take.notesPath)).length);
});

test("waiting returns immediately for notes left before the waiter started", async () => {
  await reset();
  await note("already left before you asked");
  const res = await waitForNotes(take, { timeoutMs: 2000, pollMs: 10, settleMs: 0 });
  assert.equal(res.timedOut, false);
  assert.deepEqual(res.notes, ["already left before you asked"]);
});

test("waiting wakes on the note that lands while it blocks", async () => {
  await reset();
  const waiting = waitForNotes(take, { timeoutMs: 5000, pollMs: 10, settleMs: 10 });
  setTimeout(() => void note("different closing shot"), 60);
  const res = await waiting;
  assert.equal(res.timedOut, false);
  assert.deepEqual(res.notes, ["different closing shot"]);
});

test("a burst typed together wakes the agent once, with every note", async () => {
  await reset();
  const waiting = waitForNotes(take, { timeoutMs: 5000, pollMs: 10, settleMs: 120 });
  setTimeout(async () => {
    await note("one");
    await note("two");
    await note("three");
  }, 40);
  const res = await waiting;
  assert.deepEqual(res.notes, ["one", "two", "three"]);
});

test("a wait that times out reports it and consumes nothing", async () => {
  await reset();
  const res = await waitForNotes(take, { timeoutMs: 120, pollMs: 10, settleMs: 0 });
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.notes, []);
  await note("late");
  assert.deepEqual((await readNotes(take)).notes, ["late"], "the timeout must not eat a note");
});

// The two halves of the channel are written in different files (the server
// appends, the reader consumes) — this is the seam where a renamed convention
// would silently swallow every note.
test("a note POSTed to a live edit-server is what the waiter hands the agent", async () => {
  await reset();
  await writeFile(take.captureLogPath, JSON.stringify({ events: [] }));
  await writeFile(take.capturePath, "");
  const server = await startEditServer({ takePath: take.compositionPath, port: 0, open: false });
  try {
    const waiting = waitForNotes(take, { timeoutMs: 5000, pollMs: 10, settleMs: 10 });
    const r = await fetch(`${server.url}api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "no zoom on beat 3" }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await waiting).notes, ["no zoom on beat 3"]);
  } finally {
    await server.close();
  }
});

test("the wake-up message names the notes and points at the composition", async () => {
  // non-ASCII on purpose: the wake-up line is relayed verbatim, whatever the
  // user wrote it in
  const out = formatNotes(take, { notes: ["開頭太慢"], total: 1, cursor: 0 });
  assert.match(out, /1 new note from the editor/);
  assert.match(out, /- 開頭太慢/);
  assert.match(out, /demo\.take[/\\]composition\.json/);
  assert.match(formatNotes(take, { notes: [], total: 3, cursor: 0 }), /no new notes/);
});
