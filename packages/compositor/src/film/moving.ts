// `film probe`'s line on product material taken while it was still changing.
//
// A product animates its own values — a total counts up from 0 whenever it
// changes, a panel slides in — and a still shot a moment after the input can
// catch it on its way. `open-take shoot` reads the screen just before and
// just after each still and writes what changed into shots.json (`moving`:
// the texts that read differently, before and after). The probe knows which
// pictures the film's page shows at each sampled time (their files); this
// finds each one's still in the shoots' logs under the served folder and says
// which of them were taken while the screen was changing, and what was
// changing. A derived copy (a crop, a JPEG beside the PNG) is matched by its
// name, the still's file name without its extension.
//
// Information only: nothing is graded. A still taken on its way can be what
// the film wants (the motion itself); a log from before the field (no
// `steady` in it) says nothing either way, and the line says how many were.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

type LogStill = {
  file?: unknown;
  name?: unknown;
  state?: unknown;
  moving?: {
    texts?: { before?: unknown; after?: unknown }[];
    more?: unknown;
    moved?: unknown;
    animations?: unknown;
  };
};
type ShotLog = { path: string; dir: string; records: boolean; stills: LogStill[] };

/** one picture on screen, its still and how it was taken */
export type MovingShown = {
  /** the picture's file, from the served folder */
  src: string;
  /** the shoot's log it was found in, from the served folder */
  log: string;
  still: string;
  /** sampled times it was on screen, film seconds */
  times: number[];
  /** texts that read differently just before and after the still was taken */
  texts: { before: string; after: string }[];
  more: number;
  moved: boolean;
  animations: number;
};

export type MovingMaterial = {
  how: "measured" | "not measured";
  note?: string;
  /** shots.json logs found under the served folder */
  logs: number;
  /** pictures on screen matched to a still of one of them */
  matched: number;
  /** of those, matched in a log from before `moving` was recorded */
  unrecorded: number;
  /** the matched pictures whose still was taken while the screen changed */
  list: MovingShown[];
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".shoot"]);

/** every shots.json under `root` (a few levels down, dot folders left out) */
export function findShotLogs(root: string, depth = 6, max = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (out.length >= max) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    if (names.includes("shots.json")) out.push(join(dir, "shots.json"));
    if (d <= 0) return;
    for (const n of names) {
      if (n.startsWith(".") || SKIP_DIRS.has(n) || n === "states") continue;
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) walk(p, d - 1);
      } catch {}
    }
  };
  walk(resolve(root), depth);
  return out;
}

function readLog(path: string): ShotLog | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { stills?: unknown; steady?: unknown };
    if (!Array.isArray(j.stills)) return null;
    return {
      path,
      dir: dirname(path),
      records: typeof j.steady === "boolean",
      stills: j.stills as LogStill[],
    };
  } catch {
    return null;
  }
}

const stem = (f: string) => basename(f, extname(f));

/** the still a picture shows: a saved screen by its folder (states/<id>/),
 *  any other file by its name without the extension; among several logs,
 *  the one whose folder shares most of the picture's path */
export function stillFor(
  file: string,
  logs: readonly ShotLog[],
): { log: ShotLog; still: LogStill } | null {
  const parts = file.split(sep);
  const st = parts.lastIndexOf("states");
  const stateId = st >= 0 && parts.length === st + 3 ? parts[st + 1] : null;
  const found: { log: ShotLog; still: LogStill }[] = [];
  for (const log of logs)
    for (const still of log.stills) {
      const hit = stateId
        ? still.state === stateId
        : typeof still.file === "string" && stem(still.file) === stem(file);
      if (hit) found.push({ log, still });
    }
  if (found.length <= 1) return found[0] ?? null;
  const shared = (dir: string) => {
    const a = dir.split(sep);
    let k = 0;
    while (k < a.length && k < parts.length && a[k] === parts[k]) k++;
    return k;
  };
  return found.reduce((best, f) => (shared(f.log.dir) > shared(best.log.dir) ? f : best));
}

/** Which pictures on screen (per sample: time and the files shown, paths
 *  from `root`) were taken while the screen was still changing. */
export function readMovingMaterial(
  samples: readonly { t: number; media: readonly { src?: string }[] }[] | null,
  root: string | null,
  o: { note?: string; logs?: readonly string[] } = {},
): MovingMaterial {
  if (!samples || !root)
    return {
      how: "not measured",
      note: o.note ?? "the page was not played",
      logs: 0,
      matched: 0,
      unrecorded: 0,
      list: [],
    };
  const logs = (o.logs ?? findShotLogs(root)).map(readLog).filter((l): l is ShotLog => !!l);
  const byFile = new Map<string, MovingShown | null>();
  const matched = new Set<string>();
  const unrecorded = new Set<string>();
  for (const s of samples)
    for (const m of s.media) {
      if (!m.src || /^[a-z]+:/i.test(m.src)) continue;
      const file = resolve(root, `.${m.src.startsWith("/") ? "" : "/"}${m.src}`);
      if (!existsSync(file)) continue;
      let entry = byFile.get(file);
      if (entry === undefined) {
        const hit = stillFor(file, logs);
        entry = null;
        if (hit) {
          matched.add(file);
          if (!hit.log.records) unrecorded.add(file);
          const mv = hit.still.moving;
          if (mv && typeof mv === "object") {
            const texts = (Array.isArray(mv.texts) ? mv.texts : []).map((x) => ({
              before: String(x?.before ?? ""),
              after: String(x?.after ?? ""),
            }));
            entry = {
              src: relative(root, file),
              log: relative(root, hit.log.path),
              still: String(hit.still.name ?? hit.still.file ?? ""),
              times: [],
              texts,
              more: typeof mv.more === "number" ? mv.more : 0,
              moved: mv.moved === true,
              animations: typeof mv.animations === "number" ? mv.animations : 0,
            };
          }
        }
        byFile.set(file, entry);
      }
      if (entry && !entry.times.includes(s.t)) entry.times.push(s.t);
    }
  const list = [...byFile.values()]
    .filter((e): e is MovingShown => !!e)
    .sort((a, b) => a.times[0]! - b.times[0]!);
  return {
    how: "measured",
    ...(o.note ? { note: o.note } : {}),
    logs: logs.length,
    matched: matched.size,
    unrecorded: unrecorded.size,
    list,
  };
}

const fmt = (t: number) => `${(Math.round(t * 100) / 100).toFixed(2)} s`;

/** the probe.md section */
export function formatMovingMaterial(m: MovingMaterial): string[] {
  const L = ["## Product material taken while it was changing"];
  if (m.how === "not measured") {
    L.push(`[not measured] ${m.note ?? "the page was not played"}`);
    return L;
  }
  const scope = `pictures on screen at the sampled times, matched by file name to ${m.logs} shoot log(s) (shots.json) under the served folder: ${m.matched} matched`;
  const old = m.unrecorded
    ? `; ${m.unrecorded} of them from a shoot that did not record this, which says nothing either way`
    : "";
  if (!m.list.length) {
    L.push(
      `[measured at the shoot] no picture on screen was taken while the product's screen was changing (${scope}${old}).`,
    );
    return L;
  }
  L.push(
    `[measured at the shoot] ${m.list.length} picture(s) on screen were taken while the product's screen was still changing — the still shows a moment on its way (a count-up, a slide), as \`moving\` in shots.json records it (${scope}${old}):`,
  );
  const shown = m.list.slice(0, 12);
  for (const e of shown) {
    const at =
      e.times.length > 1 ? `${fmt(e.times[0]!)}–${fmt(e.times.at(-1)!)}` : fmt(e.times[0]!);
    const what = [
      e.texts.length
        ? e.texts
            .slice(0, 3)
            .map((x) => `${JSON.stringify(x.before)} → ${JSON.stringify(x.after)}`)
            .join(", ") +
          (e.texts.length + e.more > 3 ? ` (+${e.texts.length + e.more - 3} more)` : "")
        : null,
      e.moved ? "text moved" : null,
      e.animations ? `${e.animations} animation(s) running` : null,
    ]
      .filter(Boolean)
      .join("; ");
    L.push(`- ${at}: ${e.src} (still "${e.still}" in ${e.log})${what ? ` — ${what}` : ""}`);
  }
  if (m.list.length > shown.length) L.push(`- … ${m.list.length - shown.length} more`);
  L.push(
    "A shoot waits for the screen to stop changing before each still unless told not to (steady in `skill film material`); these were taken with that off, or the screen did not stop within the wait, or it changed again between the readings just before and after the picture.",
  );
  return L;
}
