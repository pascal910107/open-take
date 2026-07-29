// notes — the editor→agent channel, and the only part of the dailies loop the
// agent can't see by looking at files it already knows about.
//
// The editor's Agent panel POSTs a note; edit-server appends one line to
// `<base>.notes.md`. That file is durable but PASSIVE: nothing tells a running
// agent it grew, so a note left in the browser sat unread until the user went
// back to the terminal and said so. This module is the active half:
//
//   readNotes(take)          → the notes appended since you last looked
//   waitForNotes(take, …)    → BLOCKS until a new one lands, then returns it
//
// `waitForNotes` is what makes `open-take notes <take> --wait` a wake-up: an
// agent starts it as a background process when it hands the editor over, and
// the process EXITS the moment the user leaves a note — which is exactly the
// signal every agent harness already understands (a finished command with
// output). No watcher daemon, no harness-specific hook.
//
// Read position is a byte offset in a sidecar (`<base>.notes.cursor`) rather
// than a mark inside the log, because only the reader writes the sidecar. A
// read-modify-write of notes.md itself would race the server's append and could
// silently swallow a note — the one failure this channel must never have.

import { readFile, stat, writeFile } from "node:fs/promises";
import type { TakePaths } from "./take";

export type NotesRead = {
  /** notes appended since the cursor, oldest first */
  notes: string[];
  /** how many notes the whole log holds */
  total: number;
  /** the byte offset now consumed */
  cursor: number;
};

export type WaitNotesResult = NotesRead & {
  /** true when the deadline passed with nothing new (`notes` is then empty) */
  timedOut: boolean;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fileSize = async (p: string): Promise<number> => (await stat(p).catch(() => null))?.size ?? 0;

const readBytes = async (p: string): Promise<Buffer> =>
  await readFile(p).catch(() => Buffer.alloc(0));

const readCursor = async (p: string): Promise<number> => {
  const n = Number((await readFile(p, "utf8").catch(() => "")).trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** `- opening is too slow` → `opening is too slow`; blank lines and stray text
 *  are tolerated. Notes are free text in any language — never parsed for meaning. */
const parseNotes = (buf: Buffer): string[] =>
  buf
    .toString("utf8")
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter((l) => l.length > 0);

export type ReadNotesOpts = {
  /** ignore the cursor and return every note in the log (still advances it) */
  all?: boolean;
  /** report without advancing the cursor — the next read sees them again */
  peek?: boolean;
};

/** The notes appended since the last read, and how many the log holds.
 *  Advances the cursor unless `peek`, so a note is delivered exactly once. */
export async function readNotes(take: TakePaths, opts: ReadNotesOpts = {}): Promise<NotesRead> {
  const buf = await readBytes(take.notesPath);
  const saved = await readCursor(take.notesCursorPath);
  // A cursor past EOF means the log was truncated or replaced — start over
  // rather than sit silently past the end of a file that has notes in it.
  const from = opts.all || saved > buf.length ? 0 : saved;
  // Only consume WHOLE lines: an append that lands mid-read would otherwise
  // leave half a note consumed and the rest orphaned behind the cursor.
  const end = buf.lastIndexOf(0x0a) + 1;
  const slice = end > from ? buf.subarray(from, end) : Buffer.alloc(0);
  const cursor = Math.max(from, end);
  if (!opts.peek && cursor !== saved) {
    await writeFile(take.notesCursorPath, `${cursor}\n`).catch(() => {});
  }
  return { notes: parseNotes(slice), total: parseNotes(buf).length, cursor };
}

export type WaitNotesOpts = ReadNotesOpts & {
  /** give up after this long and return `timedOut` (default 30 min) */
  timeoutMs?: number;
  /** how often to stat the log (default 500ms) */
  pollMs?: number;
  /** after the log grows, wait this long before reading so a burst of notes
   *  arrives as ONE batch instead of waking the agent once per line
   *  (default 800ms) */
  settleMs?: number;
  /** stop waiting early (returns timedOut with no notes) */
  signal?: AbortSignal;
};

/** Block until at least one unread note exists, then return it (and consume
 *  it). Returns immediately when the log already has unread notes — a waiter
 *  started after the user typed still delivers, which is what makes restarting
 *  one between rounds lossless. */
export async function waitForNotes(
  take: TakePaths,
  opts: WaitNotesOpts = {},
): Promise<WaitNotesResult> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 500;
  const settleMs = opts.settleMs ?? 800;
  const deadline = Date.now() + timeoutMs;

  let last = await readNotes(take, opts);
  if (last.notes.length) return { ...last, timedOut: false };
  // Watch the SIZE we last observed, not the cursor: a log whose final line
  // has no newline yet leaves cursor < size, and polling against the cursor
  // would then re-read on every tick forever.
  let seen = await fileSize(take.notesPath);

  while (!opts.signal?.aborted && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    if (opts.signal?.aborted) break;
    // `!==` not `>`: a truncated/rewritten log is a change too, and readNotes
    // knows how to restart from 0 when the cursor no longer fits.
    if ((await fileSize(take.notesPath)) === seen) continue;
    if (settleMs > 0) await sleep(settleMs);
    last = await readNotes(take, { ...opts, all: false });
    seen = await fileSize(take.notesPath); // the settle window may have grown it
    if (last.notes.length) return { ...last, timedOut: false };
  }
  return { ...last, notes: [], timedOut: true };
}

const rel = (p: string): string => p.replace(`${process.cwd()}/`, "");

/** The wake-up message. Written for an agent reading a finished background
 *  command: what came in, and the one thing it must re-read before editing. */
export function formatNotes(
  take: TakePaths,
  res: NotesRead & { timedOut?: boolean },
  opts: { waited?: boolean } = {},
): string {
  if (!res.notes.length) {
    if (opts.waited && res.timedOut) return `no notes · ${take.name} (waited out)\n`;
    return res.total
      ? `no new notes · ${take.name} (${res.total} already read in ${rel(take.notesPath)})\n`
      : `no notes yet · ${take.name} (${rel(take.notesPath)})\n`;
  }
  const head = `${res.notes.length} new note${res.notes.length > 1 ? "s" : ""} from the editor · ${take.name}`;
  return [
    head,
    ...res.notes.map((n) => `- ${n}`),
    `(re-read ${rel(take.compositionPath)} before editing it — the editor may have changed it too)`,
    "",
  ].join("\n");
}
