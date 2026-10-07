// `open-take film gallery`: what each building block of the film kit does,
// drawn — so a film's author can see a block before choosing it, and see it
// on its own product rather than on a grey box.
//
// Every block of kit/motion.js, every camera option of kit/camera.js and the
// helpers of kit/cut.js (when the kit has one) gets one PNG: the block at six
// instants, its value over time and its speed, with the default and three
// other settings side by side — defaults are one choice among many, and seeing
// them next to others keeps them from becoming every film's look. The blocks
// run as the film would run them: the kit's own functions (the film's copy
// when a film folder is given), their numbers put into CSS on a stage of the
// film's size, of which each cell shows a window.
//
// With --with, the stage is the product's own material: a picture, a saved
// screen (`make --states`, its live.png and the boxes of everything on it) or
// a take (its first saved screen, else a frame of its recording); one element
// of it (--subject, or one chosen and said) is what the blocks lift and move.
//
// The numbers under each setting — when it settles, how far it swings past its
// rest, its top speed — are measured on the function's output, sampled every
// millisecond; one that never happens in the window is "not detected". None
// of them is a target.

import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFfmpeg, resolveFfprobe, runTool } from "../ffmpeg";
import { launchHtmlBrowser } from "../html/cdp";
import { readStateIndex, type StateElement, type StateIndex } from "../state-index";
import { filmKitDir } from "./kit";
import { filmPicture } from "./picture";

// --- what comes back ------------------------------------------------------------------

/** a region of the stage, CSS px */
export type GalleryBox = { x: number; y: number; width: number; height: number };

export type GalleryMaterial = {
  /** what the stage shows: a neutral stand-in when no --with was given */
  kind: "placeholder" | "image" | "state" | "video";
  /** what --with named (null for the stand-in) */
  source: string | null;
  /** the picture used (a saved screen's live.png, the take's frame, the image) */
  picture: string | null;
  width: number;
  height: number;
  /** what the blocks lift and move */
  subject: GalleryBox & {
    label: string;
    /** how it was picked: given, chosen automatically (and from what), or a fallback */
    how: string;
  };
  /** a second region, unlike the subject: where a match cut lands */
  other: GalleryBox & { label: string };
  /** what type/untype write: the subject's own text when it has some */
  text: string;
  notes: string[];
};

/** one setting's numbers, measured on the function's output (1 ms apart) */
export type GalleryStats = {
  /** the value where the block starts and where it comes to rest */
  from: number;
  to: number;
  /** s after the block starts until it stays within 1 % of its travel (or of
   *  its peak, for a move that comes back to where it was); null: not detected
   *  in the window measured */
  settle: number | null;
  /** how far it first goes past its rest, as a share of the travel; null for a
   *  move that comes back to where it was */
  swing: number | null;
  /** the largest distance from its rest, for a move that comes back (a kick, a
   *  shake, a press); null otherwise */
  peak: number | null;
  /** the top speed (value units a second) and when (s after the start) */
  peakSpeed: number;
  peakSpeedAt: number;
  /** the window each speed is the change over (s): 2 ms, or a stepping value's */
  speedOver: number;
  /** when the value jumps (a cut: a quarter of its travel within 1 ms), s
   *  after the start; its "speed" there is the jump over 2 ms, not a speed */
  jump: number | null;
  /** how long was measured (s after the start) */
  window: number;
};

export type GalleryRow = {
  label: string;
  stats: GalleryStats | null;
  /** what the PNG and index.md say under the setting */
  text: string;
  error?: string;
};

export type GalleryEntry = {
  name: string;
  group: "motion" | "camera" | "cut";
  /** the call, as the film writes it */
  signature: string;
  /** where its defaults come from */
  note: string;
  /** what the plotted value is, and its unit */
  value: string;
  /** the PNG (absolute), or null when it could not be drawn */
  png: string | null;
  rows: GalleryRow[];
  /** why it could not be drawn (a kit changed under it, a missing export) */
  error?: string;
};

export type FilmGalleryOptions = {
  chromePath: string;
  /** the folder to write the PNGs, index.md and gallery.json into */
  out: string;
  /** a film folder (its kit/ is used) or a kit folder; default: the kit this package ships */
  kit?: string;
  /** names (rise, camera.shake), or groups (motion, camera, cut); default all */
  blocks?: string[];
  /** a picture, a saved screen (state folder or its state.html) or a take */
  with?: string;
  /** the element to move: a saved screen's element id (e12), its text, or x,y,w,h */
  subject?: string;
  /** a beats file (`open-take film beats`): kit/cut.js is drawn on the film's
   *  own music; default a stand-in pulse */
  beats?: string;
};

export type FilmGalleryResult = {
  out: string;
  index: string;
  json: string;
  kit: string;
  material: GalleryMaterial;
  entries: GalleryEntry[];
};

// --- the kit --------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: the kit is the film's own JavaScript, untyped here
type Mod = Record<string, any>;
type Kit = { dir: string; motion: Mod; camera: Mod; cut: Mod | null };

/** the kit folder a --kit names: a film's kit/, or a kit folder itself */
export function galleryKitDir(given?: string): string {
  if (!given) return filmKitDir();
  const dir = resolve(given);
  if (existsSync(join(dir, "kit", "motion.js"))) return join(dir, "kit");
  if (existsSync(join(dir, "motion.js"))) return dir;
  throw new Error(
    `film gallery: no kit at ${given} (neither kit/motion.js nor motion.js is there)`,
  );
}

async function loadKit(dir: string): Promise<Kit> {
  // a fresh copy each time: the film's author may have just changed it
  const load = async (name: string): Promise<Mod | null> => {
    const file = join(dir, name);
    if (!existsSync(file)) return null;
    const m = (await import(`${pathToFileURL(file).href}?gallery=${Date.now()}`)) as Mod;
    // a kit outside any package.json may come back as CommonJS (a loader that
    // transpiles it): its exports are then on `default`
    return m.default && typeof m.default === "object" ? { ...m.default, ...m } : m;
  };
  return {
    dir,
    motion: (await load("motion.js")) ?? {},
    camera: (await load("camera.js")) ?? {},
    cut: await load("cut.js"),
  };
}

// --- the material ---------------------------------------------------------------------

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"]);
const VIDEO = new Set([".mp4", ".webm", ".mov", ".mkv"]);
const DEFAULT_TEXT = "typed on the film's time";

const area = (b: GalleryBox) => b.width * b.height;

/** the subject a --subject names in a saved screen, or why none */
export function pickSubject(
  index: Pick<StateIndex, "viewport" | "elements">,
  given?: string,
): { box: GalleryBox; label: string; how: string; text?: string } {
  const vw = index.viewport.w;
  const vh = index.viewport.h;
  const boxOf = (e: StateElement): GalleryBox => ({
    x: e.box[0],
    y: e.box[1],
    width: e.box[2],
    height: e.box[3],
  });
  const onScreen = (b: GalleryBox) =>
    b.width >= 4 &&
    b.height >= 4 &&
    b.x < vw &&
    b.y < vh &&
    b.x + b.width > 0 &&
    b.y + b.height > 0;
  const name = (e: StateElement) => (e.name ?? e.text ?? "").trim();
  const describe = (e: StateElement) =>
    `${e.id} <${e.tag}${e.role ? ` role=${e.role}` : ""}>${name(e) ? ` "${name(e).slice(0, 40)}"` : ""}`;
  if (given) {
    const rect = given.split(",").map(Number);
    if (rect.length === 4 && rect.every(Number.isFinite)) {
      const [x, y, width, height] = rect as [number, number, number, number];
      if (!(width > 0 && height > 0))
        throw new Error(`film gallery: --subject ${given}: a box needs a width and a height`);
      return { box: { x, y, width, height }, label: `box ${given}`, how: "given (--subject)" };
    }
    const byId = index.elements.find((e) => e.id === given);
    const exact = index.elements.filter((e) => name(e) === given && onScreen(boxOf(e)));
    const part = index.elements.filter((e) => name(e).includes(given) && onScreen(boxOf(e)));
    // the smallest element carrying the text is the one that is it, not its container
    const smallest = (es: StateElement[]) =>
      [...es].sort((a, b) => area(boxOf(a)) - area(boxOf(b)))[0];
    const e = byId ?? smallest(exact) ?? smallest(part);
    if (!e)
      throw new Error(
        index.elements.length
          ? `film gallery: --subject ${given}: no element of the saved screen has that id or text (or x,y,w,h)`
          : `film gallery: --subject ${given}: a picture or the stand-in has no elements to name — give a box, x,y,w,h`,
      );
    return { box: boxOf(e), label: describe(e), how: "given (--subject)", text: name(e) };
  }
  // the first control of a size a viewer can see, in the page's order: what a
  // film most often lifts. Said, so another can be asked for.
  const share = (b: GalleryBox) => area(b) / (vw * vh);
  const fits = (e: StateElement) => {
    const b = boxOf(e);
    return onScreen(b) && share(b) >= 0.001 && share(b) <= 0.08 && b.x >= 0 && b.y >= 0;
  };
  const rank = (e: StateElement) =>
    e.role === "button" || e.tag === "button" ? 0 : e.role === "link" || e.tag === "a" ? 1 : 2;
  const controls = index.elements
    .filter((e) => e.interactive && fits(e) && name(e))
    .sort((a, b) => rank(a) - rank(b));
  const any = controls[0] ?? index.elements.find((e) => fits(e) && name(e));
  if (any)
    return {
      box: boxOf(any),
      label: describe(any),
      how: `chosen automatically — the first ${any.interactive ? "control" : "element"} with a name and a visible size (--subject <id|text|x,y,w,h> picks another)`,
      text: name(any),
    };
  return {
    box: middle(vw, vh),
    label: "the middle of the screen",
    how: "no element to choose — the middle of the picture (--subject picks one)",
  };
}

const middle = (w: number, h: number): GalleryBox => ({
  x: w / 3,
  y: h / 3,
  width: w / 3,
  height: h / 3,
});

/** a second element of a saved screen, unlike the subject in place and shape
 *  (where a match cut lands); else the subject mirrored through the centre */
export function pickOther(
  index: Pick<StateIndex, "viewport" | "elements">,
  subject: GalleryBox,
): GalleryBox & { label: string } {
  const vw = index.viewport.w;
  const vh = index.viewport.h;
  const aspect = (b: GalleryBox) => b.width / b.height;
  const apart = (a: GalleryBox, b: GalleryBox) =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  // a control first, as the subject is chosen; then any element
  const order = [
    ...index.elements.filter((e) => e.interactive),
    ...index.elements.filter((e) => !e.interactive),
  ];
  for (const e of order) {
    const b = { x: e.box[0], y: e.box[1], width: e.box[2], height: e.box[3] };
    const share = area(b) / (vw * vh);
    const name = (e.name ?? e.text ?? "").trim();
    if (
      name &&
      share >= 0.002 &&
      share <= 0.15 &&
      b.x >= 0 &&
      b.y >= 0 &&
      b.x + b.width <= vw &&
      b.y + b.height <= vh &&
      apart(b, subject) &&
      Math.abs(Math.log(aspect(b) / aspect(subject))) > 0.4
    )
      return { ...b, label: `${e.id} <${e.tag}> "${name.slice(0, 40)}"` };
  }
  return mirrored(vw, vh, subject);
}

/** the subject mirrored through the picture's centre, twice as wide: another
 *  place and another shape */
const mirrored = (w: number, h: number, s: GalleryBox): GalleryBox & { label: string } => {
  const width = Math.min(w / 2, s.width * 2);
  return {
    x: Math.max(0, w - s.x - s.width / 2 - width / 2),
    y: Math.max(0, h - s.y - s.height),
    width,
    height: s.height,
    label: "the subject's mirror image, twice as wide",
  };
};

/** a neutral stand-in interface: greys only, so no look comes from the gallery */
function placeholderSvg(w: number, h: number, s: GalleryBox): string {
  const cards: string[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 2; j++) {
      const x = 340 + i * 420;
      const y = 150 + j * 330;
      cards.push(
        `<rect x="${x}" y="${y}" width="380" height="290" rx="18" fill="#f6f6f4"/>` +
          `<rect x="${x + 28}" y="${y + 34}" width="200" height="22" rx="6" fill="#c9c9c5"/>` +
          `<rect x="${x + 28}" y="${y + 78}" width="300" height="14" rx="5" fill="#dcdcd8"/>` +
          `<rect x="${x + 28}" y="${y + 104}" width="260" height="14" rx="5" fill="#dcdcd8"/>`,
      );
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#e9e9e6"/>
<rect width="${w}" height="80" fill="#d5d5d1"/><rect x="40" y="26" width="160" height="28" rx="8" fill="#b4b4af"/>
<rect y="80" width="280" height="${h - 80}" fill="#dfdfdb"/>
${[0, 1, 2, 3, 4].map((i) => `<rect x="36" y="${130 + i * 64}" width="200" height="20" rx="6" fill="#c4c4bf"/>`).join("")}
${cards.join("\n")}
<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${Math.min(s.height / 2, 24)}" fill="#4a4a47"/>
<text x="${s.x + s.width / 2}" y="${s.y + s.height / 2 + 13}" font-family="ui-monospace, Menlo, monospace" font-size="36" fill="#f4f4f2" text-anchor="middle">subject</text>
</svg>`;
}

/** the take folder a path names: a .take folder, or a take's MP4 with its .take beside it */
function takeDir(p: string): string | null {
  if (statSync(p).isDirectory())
    return existsSync(join(p, "states")) || existsSync(join(p, "capture.mp4")) ? p : null;
  const beside = p.replace(/\.[^./\\]+$/, ".take");
  return beside !== p && existsSync(beside) && statSync(beside).isDirectory() ? beside : null;
}

/** a take's saved screens, in recording order, the faithful ones first */
function takeStates(take: string): { dir: string; index: StateIndex }[] {
  const root = join(take, "states");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => join(root, id))
    .filter((d) => existsSync(join(d, "index.json")))
    .map((dir) => ({ dir, index: readStateIndex(dir) }))
    .filter((s): s is { dir: string; index: StateIndex } => typeof s.index !== "string")
    .sort(
      (a, b) =>
        Number(a.index.fidelity?.ok === false) - Number(b.index.fidelity?.ok === false) ||
        a.index.tMs - b.index.tMs,
    );
}

async function videoFrame(video: string, out: string): Promise<void> {
  let at = 0;
  try {
    const d = Number(
      (
        await runTool(await resolveFfprobe(), [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=nw=1:nk=1",
          video,
        ])
      ).trim(),
    );
    if (Number.isFinite(d) && d > 0) at = d / 3;
  } catch {
    /* no duration: its first frame */
  }
  await runTool(await resolveFfmpeg(), [
    "-v",
    "error",
    "-y",
    "-ss",
    at.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    out,
  ]);
}

/** the stage the blocks run on, copied into `tmp` as material.<ext> */
async function resolveMaterial(
  opts: Pick<FilmGalleryOptions, "with" | "subject" | "chromePath">,
  tmp: string,
): Promise<GalleryMaterial & { file: string }> {
  const notes: string[] = [];
  if (!opts.with) {
    const w = 1920;
    const h = 1080;
    const s = { x: 1180, y: 620, width: 380, height: 110 };
    let subject = { ...s, label: "the stand-in's dark button", how: "the stand-in's own" };
    if (opts.subject) {
      const p = pickSubject({ viewport: { w, h, dpr: 1 }, elements: [] }, opts.subject);
      subject = { ...p.box, label: p.label, how: p.how };
    }
    const file = join(tmp, "material.svg");
    await writeFile(file, placeholderSvg(w, h, subject));
    return {
      kind: "placeholder",
      source: null,
      picture: null,
      file,
      width: w,
      height: h,
      subject,
      other: { x: 760, y: 150, width: 380, height: 290, label: "the stand-in's second card" },
      text: DEFAULT_TEXT,
      notes: [
        "no --with: a neutral stand-in interface; --with <picture|state|take> shows the product's own",
      ],
    };
  }
  const given = resolve(opts.with);
  if (!existsSync(given)) throw new Error(`film gallery: --with ${opts.with}: nothing there`);
  let stateDir: string | null = null;
  const take = takeDir(given);
  if (statSync(given).isDirectory() && existsSync(join(given, "index.json"))) stateDir = given;
  else if (extname(given).toLowerCase() === ".html") stateDir = dirname(given);
  else if (take) {
    const states = takeStates(take);
    if (states[0]) {
      stateDir = states[0].dir;
      const others = states.slice(1).map((s) => s.index.id);
      notes.push(
        `the take's saved screen ${states[0].index.id} (the first${states[0].index.fidelity?.ok === false ? "" : " faithful one"} in recording order)` +
          (others.length
            ? `; others: ${others.join(", ")} — --with ${relative(process.cwd(), join(take, "states")) || "."}/<id> shows one`
            : ""),
      );
    } else if (existsSync(join(take, "capture.mp4"))) {
      const file = join(tmp, "material.png");
      await videoFrame(join(take, "capture.mp4"), file);
      notes.push("the take has no saved screens: a frame a third of the way into its recording");
      return withSubject("video", opts, file, notes, given);
    } else
      throw new Error(
        `film gallery: --with ${opts.with}: a take with neither states nor capture.mp4`,
      );
  }
  if (stateDir) {
    const index = readStateIndex(stateDir);
    if (typeof index === "string") throw new Error(`film gallery: --with ${opts.with}: ${index}`);
    const file = join(tmp, "material.png");
    if (existsSync(join(stateDir, "live.png"))) await copyFile(join(stateDir, "live.png"), file);
    else {
      notes.push("the saved screen has no live.png: drawn from its state.html");
      await filmPicture({ state: stateDir, chromePath: opts.chromePath, scale: 1, out: file });
    }
    const p = pickSubject(index, opts.subject);
    return {
      kind: "state",
      source: opts.with,
      picture: existsSync(join(stateDir, "live.png")) ? join(stateDir, "live.png") : null,
      file,
      width: index.viewport.w,
      height: index.viewport.h,
      subject: { ...p.box, label: p.label, how: p.how },
      other: pickOther(index, p.box),
      text:
        p.text && Array.from(p.text).length >= 3
          ? Array.from(p.text).slice(0, 40).join("")
          : DEFAULT_TEXT,
      notes,
    };
  }
  const ext = extname(given).toLowerCase();
  if (IMAGE.has(ext)) {
    const file = join(tmp, `material${ext}`);
    await copyFile(given, file);
    return withSubject("image", opts, file, notes, given);
  }
  if (VIDEO.has(ext)) {
    const file = join(tmp, "material.png");
    await videoFrame(given, file);
    notes.push("a frame a third of the way into the video");
    return withSubject("video", opts, file, notes, given);
  }
  throw new Error(
    `film gallery: --with ${opts.with}: not a picture, a video, a saved screen or a take`,
  );
}

/** a picture's material: its size is read where it is drawn (filled in later) */
function withSubject(
  kind: "image" | "video",
  opts: Pick<FilmGalleryOptions, "with" | "subject">,
  file: string,
  notes: string[],
  source: string,
): GalleryMaterial & { file: string } {
  return {
    kind,
    source: opts.with ?? null,
    picture: kind === "image" ? source : null,
    file,
    width: 0,
    height: 0,
    // a picture has no elements: a box, or the middle (set once its size is known)
    subject: { x: 0, y: 0, width: 0, height: 0, label: "", how: opts.subject ?? "" },
    other: { x: 0, y: 0, width: 0, height: 0, label: "" },
    text: DEFAULT_TEXT,
    notes,
  };
}

// --- the blocks -----------------------------------------------------------------------

type Row = { label: string; o: Record<string, unknown> };
type Block = {
  name: string;
  group: GalleryEntry["group"];
  signature: string;
  note: string;
  /** exports it needs, as "motion.rise" */
  needs: string[];
  /** the strip and the plots cover [t0, t1] (s); the block starts at `start` (default t0) */
  t0: number;
  t1: number;
  start?: number;
  /** the six instants drawn (default: evenly over [t0, t1]); per setting when a function */
  frames?: number[] | ((row: Row) => number[]);
  /** what each cell shows: a window around the subject, or the whole stage */
  view: "subject" | "full";
  rows: Row[];
  /** the stage at t for one setting: HTML in stage px */
  draw: (t: number, row: Row) => string;
  value: (t: number, row: Row) => number;
  valueLabel: string;
  /** the speed is the change over this many s (default 1 ms): a value that
   *  steps (characters shown) has a rate only over a window */
  speedOver?: number;
  /** what to say under a setting instead of the motion numbers (a cut's) */
  describe?: (row: Row) => string;
  /** times to mark on the plots (a grid's beats) */
  marks?: number[];
};

const CW = 224;
const CH = 126;
const GAP = 10;
const LABEL_W = 196;
const ROW_H = CH + 34;
const HEAD_H = 74;
const PLOT_H = 132;
const PLOT_GAP = 40;
const ROWS = 4;
const PAGE_W = LABEL_W + 6 * (CW + GAP) + GAP;
const PAGE_H = HEAD_H + ROWS * ROW_H + 2 * (PLOT_H + PLOT_GAP) + 16;
const COLOURS = ["#1f2937", "#c2410c", "#2563eb", "#15803d"];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n3 = (v: number) => (Number.isFinite(v) ? +v.toFixed(3) : 0);

/** the blocks the kit has, drawn on `mat` (whose picture is `img` beside the page) */
function blocks(kit: Kit, mat: GalleryMaterial, img: string, beats?: unknown): Block[] {
  const M = kit.motion;
  const C = kit.camera;
  const S = mat.subject;
  const W = mat.width;
  const H = mat.height;
  const full = { x: 0, y: 0, w: W, h: H, r: 0 };
  const sc = { x: S.x + S.width / 2, y: S.y + S.height / 2 };
  const pic = (style = "") => `<img class="m" src="${img}" style="${style}">`;
  const home = (b: GalleryBox = S) =>
    `<div class="home" style="left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px"></div>`;
  /** the subject lifted out of the picture, as a layer of its own */
  const lifted = (style: string, b: GalleryBox = S, origin = "50% 50%") =>
    `<div class="l" style="left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;transform-origin:${origin};${style}">${pic(`left:${-b.x}px;top:${-b.y}px`)}</div>`;
  const dim = pic("opacity:0.32");
  const T = (x = 0, y = 0, s = 1, sx = s, sy = s) =>
    `transform:translate(${n3(x)}px,${n3(y)}px) scale(${n3(sx)},${n3(sy)})`;
  const list: Block[] = [];
  const add = (b: Block) => list.push(b);
  /** an offset measured along the direction a rise travels: it goes past 0 when it swings */
  const along = (
    w: { x: number; y: number },
    o: Record<string, unknown>,
    dx0: number,
    dy0: number,
  ) => {
    const dx = (o.dx as number | undefined) ?? dx0;
    const dy = (o.dy as number | undefined) ?? dy0;
    const len = Math.hypot(dx, dy) || 1;
    return (w.x * dx + w.y * dy) / len;
  };

  // springs and entrances: the lifted subject arrives at its own place
  const slide = Math.max(S.width * 1.5, W * 0.12);
  add({
    name: "spring",
    group: "motion",
    signature: "spring(t, { from, to, start, freq, damping | overshoot | stiffness+friction })",
    note: "1.6 Hz, damping ratio 0.7: within 2 % in ≈ 0.57 s, a ≈ 4.6 % swing (the take camera's push-in scaled down)",
    needs: ["motion.spring"],
    t0: 0,
    t1: 1.1,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "overshoot: 0.25", o: { overshoot: 0.25 } },
      { label: "damping: 1", o: { damping: 1 } },
      { label: "freq: 0.8, damping: 1.4", o: { freq: 0.8, damping: 1.4 } },
    ],
    draw: (t, r) => dim + home() + lifted(T(-slide * (1 - M.spring(t, r.o)))),
    value: (t, r) => M.spring(t, r.o),
    valueLabel: "value (0 → 1)",
  });
  add({
    name: "rise",
    group: "motion",
    signature: "rise(t, start, { dx, dy, lead, …spring }) → { x, y, opacity, p }",
    note: "dy 24 px (about a line of 20 px text); solid once 60 % of the travel is covered; the spring's 1.6 Hz / 0.7",
    needs: ["motion.rise"],
    t0: 0,
    t1: 0.8,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "dy: 120, damping: 0.5", o: { dy: 120, damping: 0.5 } },
      { label: "dx: -240, dy: 0", o: { dx: -240, dy: 0 } },
      { label: "freq: 0.9, damping: 1", o: { freq: 0.9, damping: 1 } },
    ],
    draw: (t, r) => {
      const w = M.rise(t, 0, r.o);
      return dim + home() + lifted(`${T(w.x, w.y)};opacity:${n3(w.opacity)}`);
    },
    value: (t, r) => along(M.rise(t, 0, r.o), r.o, 0, 24),
    valueLabel: "offset along its travel (px)",
  });
  add({
    name: "riseOut",
    group: "motion",
    signature: "riseOut(t, start, { dx, dy, dur, lead }) → { x, y, opacity, p }",
    note: "0.32 s (about half an entrance's settle), accelerating away; dy −24",
    needs: ["motion.riseOut"],
    t0: 0,
    t1: 0.7,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "dy: -90", o: { dy: -90 } },
      { label: "dx: 300, dy: 0", o: { dx: 300, dy: 0 } },
      { label: "dur: 0.6", o: { dur: 0.6 } },
    ],
    draw: (t, r) => {
      const w = M.riseOut(t, 0, r.o);
      return dim + home() + lifted(`${T(w.x, w.y)};opacity:${n3(w.opacity)}`);
    },
    value: (t, r) => along(M.riseOut(t, 0, r.o), r.o, 0, -24),
    valueLabel: "offset along its travel (px)",
  });
  add({
    name: "pop",
    group: "motion",
    signature: "pop(t, start, { scale, …spring }) → { scale, opacity, p }",
    note: "from 0.6, 2.2 Hz, overshoot 0.12 (≈ 5 % past full size)",
    needs: ["motion.pop"],
    t0: 0,
    t1: 0.7,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "scale: 0", o: { scale: 0 } },
      { label: "scale: 0.9, overshoot: 0.35", o: { scale: 0.9, overshoot: 0.35 } },
      { label: "damping: 1", o: { damping: 1 } },
    ],
    draw: (t, r) => {
      const p = M.pop(t, 0, r.o);
      return dim + home() + lifted(`${T(0, 0, p.scale)};opacity:${n3(p.opacity)}`);
    },
    value: (t, r) => M.pop(t, 0, r.o).scale,
    valueLabel: "scale",
  });
  add({
    name: "popOut",
    group: "motion",
    signature: "popOut(t, start, { scale, dur, swell }) → { scale, opacity, p }",
    note: "swells 4 % first, then shrinks to 0.6 in ≈ 0.26 s",
    needs: ["motion.popOut"],
    t0: 0,
    t1: 0.5,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "swell: 0.15", o: { swell: 0.15 } },
      { label: "scale: 0", o: { scale: 0 } },
      { label: "dur: 0.5", o: { dur: 0.5 } },
    ],
    draw: (t, r) => {
      const p = M.popOut(t, 0, r.o);
      return dim + home() + lifted(`${T(0, 0, p.scale)};opacity:${n3(p.opacity)}`);
    },
    value: (t, r) => M.popOut(t, 0, r.o).scale,
    valueLabel: "scale",
  });
  add({
    name: "drop",
    group: "motion",
    signature: "drop(t, start, { height, squash, …spring }) → { y, sx, sy, opacity }",
    note: "falls 120 px, 1.8 Hz, damping 0.45 (one clear bounce); squash 0.18 (text stays legible to ≈ 0.2)",
    needs: ["motion.drop"],
    t0: 0,
    t1: 1,
    frames: [0.04, 0.14, 0.22, 0.3, 0.45, 0.9],
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "squash: 0.4", o: { squash: 0.4 } },
      { label: "damping: 0.8", o: { damping: 0.8 } },
      { label: "height: 400, squash: 0", o: { height: 400, squash: 0 } },
    ],
    draw: (t, r) => {
      const d = M.drop(t, 0, r.o);
      return (
        dim + home() + lifted(`${T(0, d.y, 1, d.sx, d.sy)};opacity:${n3(d.opacity)}`, S, "50% 100%")
      );
    },
    value: (t, r) => M.drop(t, 0, r.o).y,
    valueLabel: "y from its place (px)",
  });
  add({
    name: "dropOut",
    group: "motion",
    signature: "dropOut(t, start, { depth, dur, squash }) → { y, sx, sy, opacity }",
    note: "falls 160 px in 0.4 s under constant acceleration, stretching with its speed",
    needs: ["motion.dropOut"],
    t0: 0,
    t1: 0.8,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "depth: 400", o: { depth: 400 } },
      { label: "squash: 0", o: { squash: 0 } },
      { label: "dur: 0.8", o: { dur: 0.8 } },
    ],
    draw: (t, r) => {
      const d = M.dropOut(t, 0, r.o);
      return (
        dim + home() + lifted(`${T(0, d.y, 1, d.sx, d.sy)};opacity:${n3(d.opacity)}`, S, "50% 0%")
      );
    },
    value: (t, r) => M.dropOut(t, 0, r.o).y,
    valueLabel: "y from its place (px)",
  });
  add({
    name: "maskRise",
    group: "motion",
    signature: "maskRise(t, start, { height, …spring }) → { y, clip, p }",
    note: "rises out of its own box; damping 0.85 (a swing past the line would be cut), 1.5 Hz",
    needs: ["motion.maskRise"],
    t0: 0,
    t1: 0.9,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "damping: 0.5", o: { damping: 0.5 } },
      { label: "freq: 3", o: { freq: 3 } },
      { label: "freq: 0.8", o: { freq: 0.8 } },
    ],
    draw: (t, r) => {
      const m = M.maskRise(t, 0, { height: S.height, ...r.o });
      return dim + home() + lifted(`transform:translateY(${n3(m.y)}px);clip-path:${m.clip}`);
    },
    value: (t, r) => M.maskRise(t, 0, { height: S.height, ...r.o }).y,
    valueLabel: "y below its line (px)",
  });
  add({
    name: "maskOut",
    group: "motion",
    signature: "maskOut(t, start, { height, dur, up }) → { y, clip, p }",
    note: "sinks into its own box in 0.32 s, accelerating",
    needs: ["motion.maskOut"],
    t0: 0,
    t1: 0.7,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "up: true", o: { up: true } },
      { label: "dur: 0.6", o: { dur: 0.6 } },
      { label: "dur: 0.15", o: { dur: 0.15 } },
    ],
    draw: (t, r) => {
      const m = M.maskOut(t, 0, { height: S.height, ...r.o });
      return dim + home() + lifted(`transform:translateY(${n3(m.y)}px);clip-path:${m.clip}`);
    },
    value: (t, r) => Math.abs(M.maskOut(t, 0, { height: S.height, ...r.o }).y),
    valueLabel: "distance moved (px)",
  });

  // typing: the subject's own words, at the subject's own height
  const fs = Math.max(18, Math.min(64, S.height * 0.5));
  const textBox: GalleryBox = {
    x: S.x,
    y: S.y,
    width: Math.max(S.width, fs * 0.62 * Array.from(mat.text).length + fs * 1.4),
    height: Math.max(S.height, fs * 1.6),
  };
  const typed = (s: string) =>
    dim +
    `<div class="txt" style="left:${textBox.x}px;top:${textBox.y}px;width:${textBox.width}px;height:${textBox.height}px;font-size:${fs}px;line-height:${textBox.height}px;padding-left:${fs * 0.5}px">${esc(s)}<span class="caret"></span></div>`;
  // long enough for the slowest setting shown (8 a second) to finish
  const typeT1 = Math.max(0.6, (Array.from(mat.text).length / 8) * 1.1);
  add({
    name: "type",
    group: "motion",
    signature:
      "type(t, start, text, { cps, human, seed }) → { text, count, done, lastAt } · typeTimes(text, start, opts)",
    note: "16 characters a second (about twice a fast typist: a film shows the typing, not the typist)",
    needs: ["motion.type"],
    t0: 0,
    t1: typeT1,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "human: true", o: { human: true } },
      { label: "cps: 8", o: { cps: 8 } },
      { label: "cps: 40", o: { cps: 40 } },
    ],
    draw: (t, r) => typed(M.type(t, 0, mat.text, r.o).text),
    value: (t, r) => M.type(t, 0, mat.text, r.o).count,
    valueLabel: "characters shown",
    speedOver: 0.25,
  });
  add({
    name: "untype",
    group: "motion",
    signature: "untype(t, start, text, { cps }) → { text, count, done }",
    note: "30 characters a second: a held key's auto-repeat",
    needs: ["motion.untype"],
    t0: 0,
    t1: Math.max(0.6, (Array.from(mat.text).length / 12) * 1.1),
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "cps: 12", o: { cps: 12 } },
      { label: "cps: 60", o: { cps: 60 } },
      { label: "cps: 120", o: { cps: 120 } },
    ],
    draw: (t, r) => typed(M.untype(t, 0, mat.text, r.o).text),
    value: (t, r) => M.untype(t, 0, mat.text, r.o).count,
    valueLabel: "characters shown",
    speedOver: 0.25,
  });

  // handoffs: one picture becomes the next
  const subjRect = { x: S.x, y: S.y, w: S.width, h: S.height, r: Math.min(S.height / 2, 12) };
  const morphRows: Row[] = [
    { label: "default (sizes in log, lands on a spring)", o: {} },
    { label: "log: false", o: { log: false } },
    { label: "ease: smooth", o: { ease: M.smooth } },
    {
      label: "ease: settle(p, { overshoot: 0.08 })",
      o: { ease: (p: number) => M.settle?.(p, { overshoot: 0.08 }) ?? p },
    },
  ];
  add({
    name: "morphRect",
    group: "motion",
    signature:
      "morphRect(t, start, end, fromBox, toBox, { ease, log }) → { x, y, w, h, r, p } · rectClip(rect, frame)",
    note: "sizes change in log space (a 10× growth looks steady); a critically damped spring that lands on `end`",
    needs: ["motion.morphRect", "motion.rectClip"],
    t0: 0,
    t1: 0.6,
    view: "full",
    rows: morphRows,
    draw: (t, r) => {
      const m = M.morphRect(t, 0, 0.5, subjRect, full, r.o);
      return `${dim}${home()}${pic(`clip-path:${M.rectClip(m, { width: W, height: H })}`)}<div class="edge" style="left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px;border-radius:${m.r}px"></div>`;
    },
    value: (t, r) => M.morphRect(t, 0, 0.5, subjRect, full, r.o).w,
    valueLabel: "width (px)",
  });
  add({
    name: "iris",
    group: "motion",
    signature: "iris(t, start, end, at, frame, { ease, from, to, close }) → { r, clip, p }",
    note: "the radius reaches the farthest corner at `end`; smootherstep on the radius",
    needs: ["motion.iris"],
    t0: 0,
    t1: 0.7,
    view: "full",
    rows: [
      { label: "default (from the subject)", o: {} },
      { label: "ease: easeOut", o: { ease: M.easeOut } },
      { label: "close: true", o: { close: true } },
      { label: "at the top-left corner", o: { at: { x: 0, y: 0 } } },
    ],
    draw: (t, r) => {
      const { at = sc, ...o } = r.o as { at?: { x: number; y: number } };
      const i = M.iris(t, 0, 0.6, at, { width: W, height: H }, o);
      return `<div class="void"></div>${pic(`clip-path:${i.clip}`)}`;
    },
    value: (t, r) => {
      const { at = sc, ...o } = r.o as { at?: { x: number; y: number } };
      return M.iris(t, 0, 0.6, at, { width: W, height: H }, o).r;
    },
    valueLabel: "radius (px)",
  });
  add({
    name: "zoomThrough",
    group: "motion",
    signature:
      "zoomThrough(t, start, end, rect, view, { ease, fit, through }) → { scale, x, y, transform, p }",
    note: "one scale about a fixed point, in log space: every step of the flight looks the same size",
    needs: ["motion.zoomThrough"],
    t0: 0,
    t1: 0.9,
    view: "full",
    rows: [
      { label: "default (cover)", o: {} },
      { label: 'fit: "contain"', o: { fit: "contain" } },
      { label: "through: 3", o: { through: 3 } },
      { label: "ease: easeIn", o: { ease: M.easeIn } },
    ],
    draw: (t, r) => {
      const z = M.zoomThrough(t, 0, 0.8, subjRect, { width: W, height: H }, r.o);
      return `<div class="layer" style="transform:${z.transform}">${pic()}${home()}</div>`;
    },
    value: (t, r) => M.zoomThrough(t, 0, 0.8, subjRect, { width: W, height: H }, r.o).scale,
    valueLabel: "scale",
  });
  // the picture in thirds, gathering onto the subject
  const tiles: GalleryBox[] = [];
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++)
      tiles.push({ x: (i * W) / 3, y: (j * H) / 3, width: W / 3, height: H / 3 });
  const tileCentres = tiles.map((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
  add({
    name: "gather",
    group: "motion",
    signature:
      "gather(t, start, fromPoints, to, { dur, stagger, ease, scale, order }) → [{ x, y, scale, p }]",
    note: "each leaves 0.04 s after the one before (2–3 frames: a ripple, not a block or a queue), 0.5 s each",
    needs: ["motion.gather"],
    t0: 0,
    t1: 0.95,
    view: "full",
    rows: [
      { label: "scale: 0.25", o: { scale: 0.25 } },
      { label: 'order: "far", scale: 0.25', o: { order: "far", scale: 0.25 } },
      { label: "stagger: 0.12, scale: 0.25", o: { stagger: 0.12, scale: 0.25 } },
      { label: "stagger: 0, scale: 0.6", o: { stagger: 0, scale: 0.6 } },
    ],
    draw: (t, r) =>
      `<div class="void"></div>` +
      M.gather(t, 0, tileCentres, sc, r.o)
        .map((g: { x: number; y: number; scale: number }, i: number) => {
          const c = tileCentres[i]!;
          return lifted(T(g.x - c.x, g.y - c.y, g.scale), tiles[i]);
        })
        .join(""),
    value: (t, r) => {
      const gs: { x: number; y: number }[] = M.gather(t, 0, tileCentres, sc, r.o);
      return gs.reduce((a, g) => a + Math.hypot(g.x - sc.x, g.y - sc.y), 0) / gs.length;
    },
    valueLabel: "pieces' mean distance to the subject (px)",
  });
  const hopFrom = { x: sc.x - Math.max(S.width * 2, W * 0.15), y: sc.y };
  add({
    name: "hop",
    group: "motion",
    signature: "hop(t, start, end, from, to, { height, ease }) → { x, y, p }",
    note: "a parabola 80 px above the straight line at its middle; smootherstep along the path",
    needs: ["motion.hop"],
    t0: 0,
    t1: 0.6,
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "height: 0", o: { height: 0 } },
      { label: "height: 240", o: { height: 240 } },
      { label: "ease: linear", o: { ease: (p: number) => Math.max(0, Math.min(1, p)) } },
    ],
    draw: (t, r) => {
      const h = M.hop(t, 0, 0.6, hopFrom, sc, r.o);
      return dim + home() + lifted(T(h.x - sc.x, h.y - sc.y));
    },
    value: (t, r) => {
      const h = M.hop(t, 0, 0.6, hopFrom, sc, r.o);
      return sc.y - h.y;
    },
    valueLabel: "height above its line (px)",
  });

  // contact
  add({
    name: "press",
    group: "motion",
    signature: "press(t, at, { depth, sink, hold, freq, damping, drop }) → { scale, y, down }",
    note: "6 % smaller (a film reads smaller than an interface's 2–5 %), down in 0.07 s, held 0.05 s, back on a 3 Hz spring",
    needs: ["motion.press"],
    t0: 0,
    t1: 0.6,
    frames: [0, 0.05, 0.1, 0.17, 0.26, 0.5],
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "depth: 0.02", o: { depth: 0.02 } },
      { label: "depth: 0.15, drop: 6", o: { depth: 0.15, drop: 6 } },
      { label: "damping: 1", o: { damping: 1 } },
    ],
    draw: (t, r) => {
      const p = M.press(t, 0, r.o);
      return pic() + lifted(`${T(0, p.y, p.scale)};box-shadow:0 0 0 2px rgba(0,0,0,0.25)`);
    },
    value: (t, r) => M.press(t, 0, r.o).scale,
    valueLabel: "scale",
  });
  add({
    name: "impact",
    group: "motion",
    signature: "impact(t, at, { amount, angle, scale, freq, damping }) → { x, y, scale, k }",
    note: "10 px first swing ≈ 30 ms after the hit (7 Hz, damping 0.35): under 5 % in ≈ 0.23 s — one hit, not a wobble",
    needs: ["motion.impact"],
    t0: 0,
    t1: 0.4,
    frames: [0, 0.03, 0.06, 0.1, 0.16, 0.3],
    view: "subject",
    rows: [
      { label: "default", o: {} },
      { label: "amount: 30", o: { amount: 30 } },
      { label: "angle: 0", o: { angle: 0 } },
      { label: "freq: 3, damping: 0.2", o: { freq: 3, damping: 0.2 } },
    ],
    draw: (t, r) => {
      const k = M.impact(t, 0, r.o);
      return dim + home() + lifted(T(k.x, k.y, k.scale));
    },
    value: (t, r) => {
      const k = M.impact(t, 0, r.o);
      return Math.hypot(k.x, k.y) * Math.sign(k.k || 0);
    },
    valueLabel: "offset along the hit (px)",
  });

  // the camera: the stage is its content, each cell its picture
  const content = { width: W, height: H };
  const subjBox = { x: S.x, y: S.y, width: S.width, height: S.height };
  // biome-ignore lint/suspicious/noExplicitAny: a camera of the film's kit
  const cams = new WeakMap<Row, any>();
  // biome-ignore lint/suspicious/noExplicitAny: a camera of the film's kit
  const camOf = (row: Row, make: (o: Record<string, unknown>) => any) => {
    let c = cams.get(row);
    if (!c) {
      c = make(row.o);
      cams.set(row, c);
    }
    return c;
  };
  const shot = (transform: string, extra = "") =>
    `<div class="void"></div><div class="layer" style="transform:${transform}">${pic()}${home()}${extra}</div>`;
  const camBlock = (
    b: Omit<Block, "group" | "draw" | "value" | "valueLabel" | "view"> & {
      // biome-ignore lint/suspicious/noExplicitAny: a camera of the film's kit
      make: (o: Record<string, unknown>) => any;
      // biome-ignore lint/suspicious/noExplicitAny: a camera of the film's kit
      draw?: (t: number, cam: any, row: Row) => string;
      // biome-ignore lint/suspicious/noExplicitAny: a camera of the film's kit
      value?: (t: number, cam: any, row: Row) => number;
      valueLabel?: string;
    },
  ) =>
    add({
      ...b,
      group: "camera",
      view: "full",
      draw: (t, r) => {
        const cam = camOf(r, b.make);
        return b.draw ? b.draw(t, cam, r) : shot(cam.transform(t));
      },
      value: (t, r) => {
        const cam = camOf(r, b.make);
        return b.value ? b.value(t, cam, r) : cam.at(t).scale;
      },
      valueLabel: b.valueLabel ?? "zoom (picture px per content px)",
    });
  const needCam = ["camera.camera"];
  camBlock({
    name: "camera.frame",
    signature: "cam.frame(box, { arrive | start, dur, ease, fill, fit }) · cam.transform(t)",
    note: "a push-in takes 0.73 s and settles its last 4 % into the hold (the take camera, frame-tracked off a reference); the box fills 60 %",
    needs: needCam,
    t0: 0,
    t1: 1.2,
    rows: [
      { label: "default", o: {} },
      { label: "dur: 0.3", o: { dur: 0.3 } },
      { label: "dur: 1.6", o: { dur: 1.6 } },
      { label: "ease: smooth, fill: 0.85", o: { ease: C.smooth, fill: 0.85 } },
    ],
    make: (o) => {
      const cam = C.camera({ content });
      cam.frame(subjBox, { start: 0, ...o });
      return cam;
    },
  });
  camBlock({
    name: "camera.rest",
    signature: "cam.rest({ arrive | start, dur, ease })",
    note: "a pull-out takes 1.34 s (slower than a push: the eye has more to take in)",
    needs: needCam,
    t0: 0,
    t1: 1.6,
    rows: [
      { label: "default", o: {} },
      { label: "dur: 0.5", o: { dur: 0.5 } },
      { label: 'zoom: "log"', o: { zoom: "log" } },
      { label: "ease: smooth", o: { ease: C.smooth } },
    ],
    make: (o) => {
      const cam = C.camera({ content });
      cam.cut(subjBox, 0, { fill: 0.6 });
      cam.rest({ start: 0, ...o });
      return cam;
    },
  });
  camBlock({
    name: "camera.cut",
    signature: "cam.cut(box, at, { fill, fit })",
    note: "no move: from `at` on the camera shows the box",
    needs: needCam,
    t0: 0,
    t1: 1,
    rows: [
      { label: "default (fill 0.6)", o: {} },
      { label: "fill: 0.3", o: { fill: 0.3 } },
      { label: "fill: 0.95", o: { fill: 0.95 } },
      { label: 'fit: "width", fill: 0.9', o: { fit: "width", fill: 0.9 } },
    ],
    make: (o) => {
      const cam = C.camera({ content });
      cam.cut(subjBox, 0.5, o);
      return cam;
    },
  });
  camBlock({
    name: "camera.lead",
    signature: "camera({ content, lead }) · cam.frame(box, { arrive, lead })",
    note: "off by default (0): the camera arrives when asked; a lead gets it there first. The subject is pressed at 1.0 s",
    needs: needCam,
    t0: 0,
    t1: 1.4,
    rows: [
      { label: "lead: 0 (default)", o: {} },
      { label: "lead: 0.15", o: { lead: 0.15 } },
      { label: "lead: 0.35", o: { lead: 0.35 } },
      { label: "lead: -0.2 (late)", o: { lead: -0.2 } },
    ],
    make: (o) => {
      const cam = C.camera({ content, ...o });
      cam.frame(subjBox, { arrive: 1 });
      return cam;
    },
    draw: (t, cam) => {
      const p = M.press?.(t, 1) ?? { scale: 1, y: 0 };
      return shot(cam.transform(t), lifted(T(0, p.y, p.scale)));
    },
  });
  camBlock({
    name: "camera.zoom",
    signature: 'camera({ content, zoom: "linear" | "log" }) · cam.frame(box, { zoom })',
    note: 'linear by default (the take camera); "log" runs a big scale change at an even pace',
    needs: needCam,
    t0: 0,
    t1: 1.6,
    rows: [
      { label: "linear (default), fill 0.9", o: { fill: 0.9 } },
      { label: 'zoom: "log", fill 0.9', o: { fill: 0.9, zoom: "log" } },
      { label: "linear, dur 1.4, smooth", o: { fill: 0.9, dur: 1.4, ease: C.smooth } },
      { label: '"log", dur 1.4, smooth', o: { fill: 0.9, dur: 1.4, ease: C.smooth, zoom: "log" } },
    ],
    make: (o) => {
      const cam = C.camera({ content });
      cam.frame(subjBox, { start: 0, ...o });
      return cam;
    },
    value: (t, cam) => Math.log2(cam.at(t).scale),
    valueLabel: "zoom in stops (log2 of the scale)",
  });
  const corner = { x: 0, y: 0, width: W * 0.14, height: H * 0.14 };
  camBlock({
    name: "camera.keepInside",
    signature: "camera({ content, keepInside }) · cam.frame(box, { keepInside })",
    note: "on by default: a view stops at the content's edge; false lets it centre a box at the edge and look past it",
    needs: needCam,
    t0: 0,
    t1: 1,
    rows: [
      { label: "keepInside (default)", o: {} },
      { label: "keepInside: false", o: { keepInside: false } },
      { label: "fill: 0.3", o: { fill: 0.3 } },
      { label: "keepInside: false, fill: 0.3", o: { keepInside: false, fill: 0.3 } },
    ],
    make: (o) => {
      const cam = C.camera({ content });
      cam.frame(corner, { start: 0, ...o });
      return cam;
    },
    draw: (t, cam) =>
      shot(
        cam.transform(t),
        `<div class="home" style="left:${corner.x}px;top:${corner.y}px;width:${corner.width}px;height:${corner.height}px"></div>`,
      ),
    value: (t, cam) => cam.at(t).cx,
    valueLabel: "view centre x (content px)",
  });
  const held = { cx: sc.x, cy: sc.y, w: W * 0.6 };
  camBlock({
    name: "camera.handheld",
    signature: "camera({ content, handheld: { amp, rot, period, seed } }) · cam.jitter(t)",
    note: "off by default; given, 3 px of slow, never-repeating wander, a turn about every 2.5 s",
    needs: needCam,
    t0: 0,
    t1: 3,
    rows: [
      { label: "{} (amp 3)", o: {} },
      { label: "amp: 10", o: { amp: 10 } },
      { label: "amp: 3, rot: 0.5", o: { rot: 0.5 } },
      { label: "amp: 6, period: 0.6", o: { amp: 6, period: 0.6 } },
    ],
    make: (o) => {
      const cam = C.camera({ content, handheld: o });
      cam.cut(held, 0);
      return cam;
    },
    value: (t, cam) => cam.jitter(t).x,
    valueLabel: "hand's x offset (picture px)",
  });
  camBlock({
    name: "camera.shake",
    signature: "cam.shake(at, { amp, rot, dur, freq, seed })",
    note: "off until asked; a jolt of 10 px dying away over 0.45 s, about 16 turns a second",
    needs: needCam,
    t0: 0,
    t1: 0.6,
    rows: [
      { label: "default", o: {} },
      { label: "amp: 30", o: { amp: 30 } },
      { label: "amp: 4, rot: 1.5", o: { amp: 4, rot: 1.5 } },
      { label: "dur: 1, freq: 6", o: { dur: 1, freq: 6 } },
    ],
    make: (o) => {
      const cam = C.camera({ content });
      cam.cut(held, 0);
      cam.shake(0, o);
      return cam;
    },
    value: (t, cam) => cam.jitter(t).x,
    valueLabel: "shake's x offset (picture px)",
  });
  camBlock({
    name: "camera.depth",
    signature: "cam.depth(k).transform(t) — a layer that moves k of the way",
    note: "1 moves with the content, 0 holds still, 0.3 is far behind, 1.5 passes in front; each row is the same push seen on a layer at k",
    needs: needCam,
    t0: 0,
    t1: 1,
    rows: [
      { label: "k: 1 (the content)", o: { k: 1 } },
      { label: "k: 0.3", o: { k: 0.3 } },
      { label: "k: 0", o: { k: 0 } },
      { label: "k: 1.5", o: { k: 1.5 } },
    ],
    make: () => {
      const cam = C.camera({ content });
      cam.frame(subjBox, { start: 0 });
      return cam;
    },
    draw: (t, cam, r) => shot(cam.depth(r.o.k).transform(t)),
    value: (t, cam, r) => {
      const d = cam.depth(r.o.k);
      return d.toView(1, 0, t)[0] - d.toView(0, 0, t)[0];
    },
    valueLabel: "layer scale",
  });

  // kit/cut.js: where cuts fall, and what a match cut frames
  const X = kit.cut;
  if (X && typeof X.grid === "function") {
    const O = mat.other;
    const G = X.grid(beats ?? { bpm: 100 });
    const pulse = beats
      ? "on the film's music (--beats)"
      : "on a stand-in pulse of 100 bpm, for drawing only (--beats <file> draws on the film's music)";
    const from = G.bar(0);
    const to = G.bar(4);
    const beatsIn: number[] = G.between(from, to);
    const viewOf = (b: GalleryBox, fill: number) => ({
      cx: b.x + b.width / 2,
      cy: b.y + b.height / 2,
      w: Math.max(b.width, (b.height * W) / H) / fill,
    });
    /** the picture of a view of the stage: as a camera would put it */
    const look = (v: { cx: number; cy: number; w: number }) => {
      const k = W / v.w;
      return `translate(${n3(W / 2 - v.cx * k)}px,${n3(H / 2 - v.cy * k)}px) scale(${n3(k)})`;
    };
    // the shots a cut moves between: the whole, the subject, the other, corners
    const shots = [
      { cx: W / 2, cy: H / 2, w: W },
      viewOf(S, 0.6),
      viewOf(O, 0.6),
      { cx: W * 0.3, cy: H * 0.3, w: W * 0.5 },
      viewOf(S, 0.25),
      { cx: W * 0.7, cy: H * 0.7, w: W * 0.5 },
    ];
    const timesFor = new WeakMap<Row, number[]>();
    const timesOf = (row: Row): number[] => {
      let ts = timesFor.get(row);
      if (!ts) {
        ts = X.density(G, [{ from, to, intent: row.o.intent }]) as number[];
        timesFor.set(row, ts);
      }
      return ts;
    };
    const cutsBy = (row: Row, t: number) => timesOf(row).filter((c) => c <= t + 1e-9).length;
    const span = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
    add({
      name: "cut.density",
      group: "cut",
      signature: "density(grid, [{ from, to, intent, on, start }]) → cut times · cuts(tl, times)",
      note: `beats between cuts: a word (hold, calm 8, steady 4, pulse 2, burst 1, flurry ½), a number or { every: [first, last] }, each cut on the grid — ${pulse}; cuts(tl, times) declares them as cut events. A cell a shot, each shot another framing of the stage`,
      needs: ["cut.grid", "cut.density"],
      t0: from,
      t1: to,
      view: "full",
      rows: [
        { label: '"hold"', o: { intent: "hold" } },
        { label: '"steady" (4 beats)', o: { intent: "steady" } },
        { label: '"burst" (1 beat)', o: { intent: "burst" } },
        { label: "{ every: [4, 0.5] } (a build)", o: { intent: { every: [4, 0.5] } } },
      ],
      frames: (r) => {
        // the middle of each of the first six shots: one cell a shot
        const edges = [...timesOf(r), to];
        const mids = edges.slice(0, -1).map((a, i) => (a + edges[i + 1]!) / 2);
        return mids.length >= 6
          ? mids.slice(0, 6)
          : [
              ...mids,
              ...Array.from(
                { length: 6 - mids.length },
                (_, i) => from + ((to - from) * (i + mids.length + 0.5)) / 6,
              ),
            ].sort((a, b) => a - b);
      },
      draw: (t, r) =>
        `<div class="void"></div><div class="layer" style="transform:${look(shots[(cutsBy(r, t) - 1 + shots.length) % shots.length]!)}">${pic()}</div>`,
      value: (t, r) => cutsBy(r, t),
      valueLabel: "cuts so far",
      speedOver: 2 * G.period,
      marks: beatsIn,
      describe: (r) => {
        const ts = timesOf(r);
        const shotsLong = span([...ts, to]);
        return [
          `${ts.length} cut${ts.length === 1 ? "" : "s"} in ${(to - from).toFixed(2)} s (the section's start is one)`,
          shotsLong.length
            ? `shots ${Math.min(...shotsLong).toFixed(2)}–${Math.max(...shotsLong).toFixed(2)} s`
            : "",
          "computed by density()",
        ]
          .filter(Boolean)
          .join(" · ");
      },
    });
    const marksFor = (row: Row): number[] =>
      G.between(from, G.bar(2), { to: row.o.to }) as number[];
    const lastMark = (row: Row, t: number) => {
      const ms = marksFor(row).filter((m) => m <= t + 1e-9);
      return ms.length ? ms[ms.length - 1]! : Number.NEGATIVE_INFINITY;
    };
    const onsets = G.onsets.length > 0;
    add({
      name: "cut.grid",
      group: "cut",
      signature:
        "grid(beatsJson | { bpm, offset, beatsPerBar }) → { beat(n), bar(n), snap(t, { to, within }), between(a, b, { to }) }",
      note: `the music's grid: beats, halves, quarters, bars, and what the music has (onsets, sections, drops); ${pulse}. The subject is pressed on each mark`,
      needs: ["cut.grid"],
      t0: from,
      t1: G.bar(2),
      view: "subject",
      rows: [
        { label: '{ to: "beat" }', o: { to: "beat" } },
        { label: '{ to: "half" }', o: { to: "half" } },
        { label: '{ to: "bar" }', o: { to: "bar" } },
        onsets
          ? { label: '{ to: "onset" }', o: { to: "onset" } }
          : { label: '{ to: "quarter" }', o: { to: "quarter" } },
      ],
      draw: (t, r) => {
        const p = M.press?.(t, lastMark(r, t)) ?? { scale: 1, y: 0 };
        return dim + lifted(T(0, p.y, p.scale));
      },
      value: (t, r) => marksFor(r).filter((m) => m <= t + 1e-9).length,
      valueLabel: "marks so far",
      speedOver: 0.5,
      marks: beatsIn.filter((b) => b <= G.bar(2)),
      describe: (r) => {
        const n = marksFor(r).length;
        const len = G.bar(2) - from;
        return `${n} marks in ${len.toFixed(2)} s (${(n / len).toFixed(2)} a second) · computed by grid()`;
      },
    });
    if (typeof X.matchCut === "function") {
      const tCut = 0.6;
      const content = { width: W, height: H };
      // biome-ignore lint/suspicious/noExplicitAny: cameras of the film's kit
      const pairs = new WeakMap<Row, { a: any; b: any; left: GalleryBox }>();
      const pairOf = (row: Row) => {
        let p = pairs.get(row);
        if (!p) {
          const a = C.camera({ content });
          a.frame(
            { x: S.x, y: S.y, width: S.width, height: S.height },
            { start: 0, dur: 1.2, fill: 0.35 },
          );
          const [x0, y0] = a.toView(S.x, S.y, tCut);
          const [x1, y1] = a.toView(S.x + S.width, S.y + S.height, tCut);
          const left = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
          const b = C.camera({ content });
          b.cut(X.matchCut(left, O, content, row.o), tCut, { keepInside: false });
          p = { a, b, left };
          pairs.set(row, p);
        }
        return p;
      };
      /** where the box the shot follows is in the picture at t */
      const tracked = (row: Row, t: number) => {
        const { a, b } = pairOf(row);
        const [cam, box] = t < tCut ? [a, S] : [b, O];
        const [x0, y0] = cam.toView(box.x, box.y, t);
        const [x1, y1] = cam.toView(box.x + box.width, box.y + box.height, t);
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      };
      add({
        name: "cut.matchCut",
        group: "cut",
        signature:
          "matchCut(fromPictureBox, toBox, view, { fit }) → { cx, cy, w } — cam.cut(v, t, { keepInside: false })",
        note: `the incoming shot framed so ${O.label} lands where the subject left the last one (centres meet; fit says what "as big" means). Solid outline: where the subject was in the picture at the cut`,
        needs: ["cut.matchCut", "camera.camera"],
        t0: 0,
        t1: 1.2,
        frames: [0, 0.3, 0.55, 0.6, 0.85, 1.2],
        view: "full",
        rows: [
          { label: 'fit: "area" (default)', o: {} },
          { label: 'fit: "width"', o: { fit: "width" } },
          { label: 'fit: "contain"', o: { fit: "contain" } },
          { label: 'fit: "cover"', o: { fit: "cover" } },
        ],
        draw: (t, r) => {
          const { a, b, left } = pairOf(r);
          const before = t < tCut;
          return `<div class="void"></div><div class="layer" style="transform:${(before ? a : b).transform(t)}">${pic()}${home(before ? S : O)}</div><div class="edge" style="left:${left.x}px;top:${left.y}px;width:${left.width}px;height:${left.height}px"></div>`;
        },
        value: (t, r) => tracked(r, t).x + tracked(r, t).width / 2,
        valueLabel: "the followed box's centre x in the picture (px)",
        describe: (r) => {
          const a = tracked(r, tCut - 1e-6);
          const b = tracked(r, tCut);
          const moved = Math.hypot(
            b.x + b.width / 2 - (a.x + a.width / 2),
            b.y + b.height / 2 - (a.y + a.height / 2),
          );
          return `across the cut: centre moves ${moved.toFixed(1)} px · width ×${(b.width / a.width).toFixed(2)}, height ×${(b.height / a.height).toFixed(2)} · computed through the cameras`;
        },
      });
    }
  }

  return list;
}

// --- measuring -------------------------------------------------------------------------

const STEP = 0.001;

/** the numbers of one setting: where it starts and rests, when it settles,
 *  how far it swings past, its top speed — on samples 1 ms apart */
export function measureRow(
  f: (t: number) => number,
  start: number,
  span: number,
  /** the speed is the change over this many s (central) */
  speedOver = 2 * STEP,
): GalleryStats {
  const window = Math.max(4, span * 3);
  const n = Math.round(window / STEP);
  const v = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const x = f(start + i * STEP);
    v[i] = Number.isFinite(x) ? x : Number.NaN;
  }
  const from = v[0]!;
  // the rest: where the window ends
  const to = v[n]!;
  const travel = to - from;
  // a move comes back when it ends where it began, next to how far it went (a
  // kick whose tail is still a hair off 0 at the window's end comes back)
  let reach = 0;
  for (let i = 0; i <= n; i++) reach = Math.max(reach, Math.abs(v[i]! - from));
  const back =
    Math.abs(travel) < Math.max(1e-6 * Math.max(1, Math.abs(from), Math.abs(to)), 1e-3 * reach);
  let peak = 0;
  for (let i = 0; i <= n; i++) peak = Math.max(peak, Math.abs(v[i]! - to));
  const ref = back ? peak : Math.abs(travel);
  let last = -1;
  if (ref > 0) for (let i = 0; i <= n; i++) if (Math.abs(v[i]! - to) > 0.01 * ref) last = i;
  // still moving within half a second of the window's end: never seen settling
  const settle = last < 0 ? 0 : last * STEP > window - 0.5 ? null : (last + 1) * STEP;
  // a swing past the rest and a peak from it need a rest: none for what never settles
  let swing: number | null = null;
  if (!back && settle != null) {
    let past = 0;
    for (let i = 0; i <= n; i++)
      past = Math.max(past, ((v[i]! - to) * Math.sign(travel)) / Math.abs(travel));
    swing = past > 1e-4 ? past : 0;
  }
  // a value that steps (characters shown, cuts so far) has a rate only over a
  // window: up to four of its steps, when they come closer than the window asked for
  const steps = speedOver > 2 * STEP;
  let over = speedOver;
  if (steps) {
    const changes: number[] = [];
    for (let i = 1; i <= n; i++) if (v[i] !== v[i - 1]) changes.push(i * STEP);
    const gaps = changes
      .slice(1)
      .map((c, i) => c - changes[i]!)
      .sort((a, b) => a - b);
    if (gaps.length)
      over = Math.min(
        over,
        Math.max(2 * STEP, Math.min(4, changes.length) * gaps[gaps.length >> 1]!),
      );
  }
  // a continuous value that changes by a quarter of all it spans within 1 ms
  // is a jump (a cut)
  let jump: number | null = null;
  let lo = v[0]!;
  let hi = v[0]!;
  for (let i = 0; i <= n; i++) {
    lo = Math.min(lo, v[i]!);
    hi = Math.max(hi, v[i]!);
  }
  if (!steps && hi > lo) {
    let big = 0;
    for (let i = 1; i <= n; i++) {
      const d = Math.abs(v[i]! - v[i - 1]!);
      if (d > big) {
        big = d;
        if (d >= 0.25 * (hi - lo)) jump = i * STEP;
      }
    }
  }
  let peakSpeed = 0;
  let peakSpeedAt = 0;
  const half = Math.max(1, Math.round(over / 2 / STEP));
  for (let i = half; i <= n - half; i++) {
    const s = Math.abs(v[i + half]! - v[i - half]!) / (2 * half * STEP);
    if (s > peakSpeed) {
      peakSpeed = s;
      peakSpeedAt = i * STEP;
    }
  }
  return {
    from,
    to,
    settle,
    swing,
    peak: back && settle != null ? peak : null,
    peakSpeed,
    peakSpeedAt,
    speedOver: over,
    jump,
    window,
  };
}

/** a setting's numbers as a line: each says it was measured, or not detected */
export function formatStats(s: GalleryStats | null): string {
  if (!s) return "not measured";
  const num = (x: number) =>
    Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3);
  const parts = [
    s.settle == null
      ? `settles: not detected in ${s.window.toFixed(1)} s`
      : `settles (1 %) at ${s.settle.toFixed(3)} s`,
  ];
  if (s.swing != null)
    parts.push(
      s.swing > 0
        ? `swings ${(s.swing * 100).toFixed(1)} % past its rest`
        : "no swing past its rest",
    );
  if (s.peak != null) parts.push(`peak ${num(s.peak)} from rest`);
  parts.push(
    s.jump != null
      ? `jumps at ${s.jump.toFixed(3)} s (a cut: no speed)`
      : `top speed ${num(s.peakSpeed)}/s at ${s.peakSpeedAt.toFixed(3)} s`,
  );
  return parts.join(" · ");
}

// --- drawing ---------------------------------------------------------------------------

/** the window of the stage a cell shows */
function windowOf(view: Block["view"], mat: GalleryMaterial, focus: GalleryBox): GalleryBox {
  const W = mat.width;
  const H = mat.height;
  if (view === "full") {
    // the whole stage, letterboxed to the cell's shape
    const w = Math.max(W, (H * CW) / CH);
    const h = (w * CH) / CW;
    return { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h };
  }
  // a little over twice the subject, never under a fifth of the stage's width
  const w = Math.min(
    Math.max(W / 5, focus.width * 2.2, (focus.height * 2.2 * CW) / CH),
    Math.max(W, (H * CW) / CH),
  );
  const h = (w * CH) / CW;
  return {
    x: focus.x + focus.width / 2 - w / 2,
    y: focus.y + focus.height / 2 - h / 2,
    width: w,
    height: h,
  };
}

function polyline(
  rows: { pts: [number, number][] }[],
  x0: number,
  y0: number,
  w: number,
  h: number,
  t0: number,
  t1: number,
  marks: number[],
  title: string,
): string {
  const all = rows.flatMap((r) => r.pts.map((p) => p[1])).filter(Number.isFinite);
  let lo = all.length ? Math.min(...all) : 0;
  let hi = all.length ? Math.max(...all) : 1;
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const m = (hi - lo) * 0.08;
  const X = (t: number) => x0 + ((t - t0) / (t1 - t0)) * w;
  const Y = (v: number) => y0 + h - ((v - (lo - m)) / (hi - lo + 2 * m)) * h;
  let s = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#fff" stroke="#d4d4d0"/>`;
  s += `<text x="${x0}" y="${y0 - 8}" class="pt">${esc(title)}</text>`;
  // an end within 1 % of the range from 0 is 0 (a spring's tail, not a value worth printing)
  const snap = (v: number) => (Math.abs(v) < (hi - lo) * 0.01 ? 0 : v);
  const ticks = [snap(lo), snap(hi), ...(lo < 0 && hi > 0 ? [0] : [])];
  for (const v of ticks)
    s += `<line x1="${x0}" x2="${x0 + w}" y1="${Y(v)}" y2="${Y(v)}" stroke="#ecece8"/><text x="${x0 - 6}" y="${Y(v) + 4}" class="tk" text-anchor="end">${+v.toPrecision(3)}</text>`;
  for (const t of marks)
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${y0}" y2="${y0 + h}" stroke="#bdbdb8" stroke-dasharray="3 3"/>`;
  rows.forEach((r, k) => {
    const pts = r.pts
      .filter((p) => Number.isFinite(p[1]))
      .map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`)
      .join(" ");
    s += `<polyline fill="none" stroke="${COLOURS[k % COLOURS.length]}" stroke-width="${k ? 1.6 : 2.4}" points="${pts}"/>`;
  });
  s += `<text x="${x0 + w}" y="${y0 + h + 16}" class="tk" text-anchor="end">${(t1 - t0).toFixed(2)} s</text>`;
  return s;
}

/** one block's page: header, a strip per setting, its value and its speed */
function blockPage(
  b: Block,
  mat: GalleryMaterial,
  focus: GalleryBox,
): { html: string; rows: GalleryRow[] } {
  const even = Array.from({ length: 6 }, (_, i) => b.t0 + ((b.t1 - b.t0) * i) / 5);
  const framesOf = (row: Row) =>
    typeof b.frames === "function" ? b.frames(row) : (b.frames ?? even);
  const frames = typeof b.frames === "function" ? even : (b.frames ?? even);
  const win = windowOf(b.view, mat, focus);
  const k = CW / win.width;
  const start = b.start ?? b.t0;
  const rows: GalleryRow[] = [];
  const values: { pts: [number, number][] }[] = [];
  const speeds: { pts: [number, number][] }[] = [];
  let strips = "";
  b.rows.slice(0, ROWS).forEach((row, ri) => {
    const y = HEAD_H + ri * ROW_H;
    let cells = "";
    let error: string | undefined;
    framesOf(row).forEach((t, i) => {
      let inner: string;
      try {
        inner = b.draw(t, row);
      } catch (e) {
        error ??= (e as Error).message.split("\n")[0];
        inner = "";
      }
      const x = LABEL_W + GAP + i * (CW + GAP);
      cells += `<div class="cell" style="left:${x}px;top:${y + 4}px"><div class="stage" style="--px:${n3(1 / k)}px;width:${mat.width}px;height:${mat.height}px;transform:scale(${k}) translate(${-win.x}px,${-win.y}px)">${inner}</div></div>`;
      cells += `<div class="tl" style="left:${x}px;top:${y + CH + 7}px">${(t - start).toFixed(3)} s</div>`;
    });
    let stats: GalleryStats | null = null;
    const pts: [number, number][] = [];
    const sp: [number, number][] = [];
    if (!error)
      try {
        const f = (t: number) => b.value(t, row);
        stats = measureRow(f, start, b.t1 - b.t0, b.speedOver);
        // the curve's speed over the window its numbers were measured over
        const h = stats.speedOver;
        const N = 300;
        for (let i = 0; i <= N; i++) {
          const t = b.t0 + ((b.t1 - b.t0) * i) / N;
          pts.push([t, f(t)]);
          sp.push([t, (f(t + h / 2) - f(t - h / 2)) / h]);
        }
      } catch (e) {
        error = (e as Error).message.split("\n")[0];
      }
    values.push({ pts });
    speeds.push({ pts: sp });
    let text = error ? `could not draw: ${error}` : formatStats(stats);
    if (!error && b.describe)
      try {
        text = b.describe(row);
      } catch (e) {
        error = (e as Error).message.split("\n")[0];
        text = `could not draw: ${error}`;
      }
    rows.push({ label: row.label, stats, text, ...(error ? { error } : {}) });
    const info = text.split(" · ").map(esc).join("<br>");
    strips += `<div class="rl" style="top:${y + 4}px;color:${COLOURS[ri % COLOURS.length]}"><b>${esc(row.label)}</b><small>${info}</small></div>${cells}`;
  });
  const py = HEAD_H + ROWS * ROW_H + PLOT_GAP - 8;
  const pw = PAGE_W - LABEL_W - GAP * 2;
  const svg =
    `<svg class="plots" width="${PAGE_W}" height="${2 * (PLOT_H + PLOT_GAP)}" style="top:${py - PLOT_GAP + 8}px">` +
    polyline(
      values,
      LABEL_W + GAP,
      PLOT_GAP - 8,
      pw,
      PLOT_H,
      b.t0,
      b.t1,
      b.marks ?? frames,
      b.valueLabel,
    ) +
    polyline(
      speeds,
      LABEL_W + GAP,
      PLOT_H + 2 * PLOT_GAP - 8,
      pw,
      PLOT_H,
      b.t0,
      b.t1,
      b.marks ?? frames,
      `its speed (${b.valueLabel.replace(/\s*\(.*\)$/, "")} a second)`,
    ) +
    `</svg>`;
  const legend = b.rows
    .slice(0, ROWS)
    .map((r, i) => `<span style="color:${COLOURS[i % COLOURS.length]}">■ ${esc(r.label)}</span>`)
    .join("");
  const html =
    `<div class="hd"><b>${esc(b.name)}</b> <code>${esc(b.signature)}</code><div>defaults (as shipped): ${esc(b.note)}</div>` +
    `<div class="win">each cell: ${b.view === "full" ? "the whole stage" : `${Math.round(win.width)}×${Math.round(win.height)} px of the stage around the subject`} · numbers measured on the function, 1 ms apart · none is a target</div></div>` +
    strips +
    svg +
    `<div class="lg" style="top:${PAGE_H - 22}px">${legend}</div>`;
  return { html, rows };
}

const CSS = `html,body{margin:0;background:#fff;width:${PAGE_W}px;height:${PAGE_H}px;overflow:hidden;font:12px/1.35 ui-monospace,Menlo,monospace;color:#1f1f1d}
.hd{position:absolute;left:${GAP}px;top:8px;right:${GAP}px;height:${HEAD_H - 8}px}
.hd b{font-size:17px}.hd code{color:#444;margin-left:8px}.hd div{color:#555;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hd .win{color:#888}
.rl{position:absolute;left:${GAP}px;width:${LABEL_W - GAP}px;height:${CH}px;overflow:hidden}
.rl b{display:block;font-size:12px;margin-bottom:4px}.rl small{color:#555;font-size:10.5px;line-height:1.35}
.cell{position:absolute;width:${CW}px;height:${CH}px;overflow:hidden;background:#cfcfcb;outline:1px solid #c4c4c0}
.stage{position:absolute;left:0;top:0;transform-origin:0 0;background:#f2f2ef}
.m{position:absolute;left:0;top:0;width:var(--mw);height:var(--mh);max-width:none}
.l{position:absolute;overflow:hidden}
.layer{position:absolute;left:0;top:0;width:var(--mw);height:var(--mh);transform-origin:0 0}
.void{position:absolute;left:-50000px;top:-50000px;width:100000px;height:100000px;background:#2b2b29}
.home{position:absolute;outline:calc(1.5 * var(--px)) dashed rgba(194,65,12,0.7);outline-offset:var(--px)}
.edge{position:absolute;outline:calc(1.5 * var(--px)) solid rgba(194,65,12,0.9)}
.txt{position:absolute;background:#fff;color:#111;font-family:system-ui,sans-serif;white-space:pre;box-sizing:border-box;border:3px solid #9a9a95;border-radius:10px;overflow:hidden}
.caret{display:inline-block;width:0.08em;height:1em;vertical-align:-0.12em;background:#c2410c;margin-left:0.04em}
.tl{position:absolute;width:${CW}px;color:#666;font-size:11px}
.plots{position:absolute;left:0}.pt{font-size:12px;fill:#333}.tk{font-size:10.5px;fill:#777}
.lg{position:absolute;left:${LABEL_W + GAP}px}.lg span{margin-right:18px}`;

// --- the gallery ------------------------------------------------------------------------

/** every block name the gallery can draw with this kit (for --blocks) */
export async function galleryBlockNames(kit?: string): Promise<string[]> {
  const k = await loadKit(galleryKitDir(kit));
  const mat = {
    kind: "placeholder",
    source: null,
    picture: null,
    width: 1920,
    height: 1080,
    subject: { x: 800, y: 500, width: 300, height: 80, label: "", how: "" },
    other: { x: 200, y: 100, width: 300, height: 300, label: "" },
    text: DEFAULT_TEXT,
    notes: [],
  } satisfies GalleryMaterial;
  return blocks(k, mat, "").map((b) => b.name);
}

/** the blocks a --blocks list names: a name, or a group (motion, camera, cut) */
function chosen(all: Block[], names?: string[]): Block[] {
  if (!names?.length) return all;
  const out = new Set<Block>();
  for (const n of names) {
    let hit = all.filter((b) => b.name === n || b.group === n);
    // a camera option by its own name: shake for camera.shake
    if (!hit.length) hit = all.filter((b) => b.name === `camera.${n}`);
    // "cut" with nothing drawn for it is said in the gallery itself (see filmGallery)
    if (!hit.length && n !== "cut")
      throw new Error(
        `film gallery: no block named ${n} — there are: ${all.map((b) => b.name).join(", ")} (or a group: motion, camera${all.some((b) => b.group === "cut") ? ", cut" : ""})`,
      );
    for (const b of hit) out.add(b);
  }
  return all.filter((b) => out.has(b));
}

const fileName = (name: string) => `${name.replace(/[^\w.-]+/g, "-")}.png`;

export async function filmGallery(opts: FilmGalleryOptions): Promise<FilmGalleryResult> {
  const kitDir = galleryKitDir(opts.kit);
  const kit = await loadKit(kitDir);
  const out = resolve(opts.out);
  await mkdir(out, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), "open-take-gallery-"));
  try {
    const material = await resolveMaterial(opts, tmp);
    const img = basename(material.file);
    await writeFile(
      join(tmp, "gallery.html"),
      `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body></body>`,
    );
    // one Chrome for every page
    const browser = await launchHtmlBrowser({
      chromePath: opts.chromePath,
      url: pathToFileURL(join(tmp, "gallery.html")).href,
      width: PAGE_W,
      height: PAGE_H,
      profilePrefix: "open-take-gallery-",
    });
    const entries: GalleryEntry[] = [];
    try {
      if (!material.width) {
        // a picture's size is the picture's
        const size = await browser.evaluate<{ w: number; h: number }>(
          `new Promise((ok, no) => { const i = new Image(); i.onload = () => ok({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => no(new Error("the picture did not load")); i.src = ${JSON.stringify(img)}; })`,
        );
        material.width = size.w;
        material.height = size.h;
        const p = opts.subject
          ? pickSubject({ viewport: { w: size.w, h: size.h, dpr: 1 }, elements: [] }, opts.subject)
          : {
              box: middle(size.w, size.h),
              label: "the middle of the picture",
              how: "a picture has no elements — the middle third (--subject x,y,w,h picks a region)",
            };
        material.subject = { ...p.box, label: p.label, how: p.how };
        material.other = mirrored(size.w, size.h, p.box);
      }
      await browser.evaluate(
        `document.documentElement.style.setProperty("--mw", "${material.width}px"); document.documentElement.style.setProperty("--mh", "${material.height}px");`,
      );
      const beats = opts.beats
        ? JSON.parse(await readFile(resolve(opts.beats), "utf8"))
        : undefined;
      const all = blocks(kit, material, img, beats);
      const picked = chosen(all, opts.blocks);
      // a kit/cut.js whose helpers the gallery has no drawing for is said, not skipped quietly
      const cutNames = Object.keys(kit.cut ?? {}).filter((k) => typeof kit.cut?.[k] === "function");
      if (
        kit.cut &&
        !all.some((b) => b.group === "cut") &&
        (!opts.blocks?.length || opts.blocks.includes("cut"))
      )
        entries.push({
          name: "cut.js",
          group: "cut",
          signature: cutNames.join(", "),
          note: "the kit's cut helpers",
          value: "",
          png: null,
          rows: [],
          error: `not drawn — the gallery has no drawing for ${cutNames.length ? cutNames.join(", ") : "its exports"} yet; read kit/cut.js`,
        });
      const exports: Record<string, Mod> = {
        motion: kit.motion,
        camera: kit.camera,
        cut: kit.cut ?? {},
      };
      for (const b of picked) {
        const entry: GalleryEntry = {
          name: b.name,
          group: b.group,
          signature: b.signature,
          note: b.note,
          value: b.valueLabel,
          png: null,
          rows: [],
        };
        entries.push(entry);
        const missing = b.needs.filter((n) => {
          const [m, f] = n.split(".") as [string, string];
          return typeof exports[m]?.[f] !== "function";
        });
        if (missing.length) {
          entry.error = `the kit has no ${missing.join(", ")}`;
          continue;
        }
        const focus =
          b.name === "type" || b.name === "untype" ? textFocus(material) : material.subject;
        const page = blockPage(b, material, focus);
        entry.rows = page.rows;
        const failed = page.rows.filter((r) => r.error);
        if (failed.length === page.rows.length) {
          entry.error = failed[0]!.error;
          continue;
        }
        await browser.evaluate(
          `(async () => { document.body.innerHTML = ${JSON.stringify(page.html)};
            await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
            await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); })()`,
        );
        const png = join(out, fileName(b.name));
        await writeFile(png, await browser.screenshot({ format: "png" }));
        entry.png = png;
      }
    } finally {
      await browser.close();
    }
    const { file: _file, ...mat } = material;
    const index = join(out, "index.md");
    const json = join(out, "gallery.json");
    await writeFile(index, galleryIndex(kitDir, mat, entries, out));
    await writeFile(
      json,
      `${JSON.stringify({ version: 1, kit: kitDir, material: mat, entries }, null, 2)}\n`,
    );
    return { out, index, json, kit: kitDir, material: mat, entries };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** where type/untype's text box sits (the same sum as in blocks()) */
function textFocus(mat: GalleryMaterial): GalleryBox {
  const S = mat.subject;
  const fs = Math.max(18, Math.min(64, S.height * 0.5));
  return {
    x: S.x,
    y: S.y,
    width: Math.max(S.width, fs * 0.62 * Array.from(mat.text).length + fs * 1.4),
    height: Math.max(S.height, fs * 1.6),
  };
}

function galleryIndex(
  kitDir: string,
  mat: GalleryMaterial,
  entries: GalleryEntry[],
  out: string,
): string {
  const s = mat.subject;
  const lines = [
    "# Film gallery",
    "",
    `- kit: \`${kitDir}\``,
    `- stage: ${mat.kind === "placeholder" ? "a neutral stand-in interface" : `${mat.kind} \`${mat.source}\``} (${mat.width}×${mat.height})`,
    `- subject: ${s.label} at ${Math.round(s.x)},${Math.round(s.y)} ${Math.round(s.width)}×${Math.round(s.height)} — ${s.how}`,
    ...mat.notes.map((n) => `- ${n}`),
    "",
    "Each picture: the block at six instants (time since it starts under each cell), for its default and three other settings, then the value each setting gives over time and its speed. Dashed outline: where the subject sits in the picture. Every number is measured on the function's output, sampled every millisecond; a settle that never happens in the window is *not detected*. These say what a block does — none of them is a target, and the defaults are one choice among many: change any setting, or write the move yourself.",
    "",
  ];
  for (const group of ["motion", "camera", "cut"] as const) {
    const es = entries.filter((e) => e.group === group);
    if (!es.length) continue;
    lines.push(
      `## ${group === "motion" ? "kit/motion.js" : group === "camera" ? "kit/camera.js" : "kit/cut.js"}`,
      "",
    );
    for (const e of es) {
      lines.push(
        `### ${e.name}`,
        "",
        `\`${e.signature}\``,
        "",
        `Defaults (as shipped): ${e.note}.`,
        "",
      );
      if (e.error) {
        lines.push(`Could not be drawn: ${e.error}.`, "");
        continue;
      }
      if (e.png) lines.push(`![${e.name}](${relative(out, e.png)})`, "");
      lines.push(`| setting | ${e.value}: from → rest | numbers |`, "|---|---|---|");
      for (const r of e.rows)
        lines.push(
          `| ${r.label.replace(/\|/g, "\\|")} | ${r.stats ? `${fmt(r.stats.from)} → ${r.stats.settle == null ? "no rest detected" : fmt(r.stats.to)}` : "—"} | ${r.text} |`,
        );
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : +v.toFixed(3));
