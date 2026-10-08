// The page's material, the whole page (compositor film/materials.ts): read
// in the live page as a shoot keeps its first saved screen of each page,
// its images saved where that is cheap, and the page drawn top to bottom as
// one small sheet from the saved screen. `open-take materials` reads a
// screen saved before this existed from its state.html — one page in one
// Chrome, as the component probe opens them.
//
// What is saved is the product's own: images its top document draws (not an
// iframe's), from no ad or tracking host, each once (content-named in the
// states' shared assets/). A source that cannot be fetched is listed with
// why; nothing fails a shoot.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adHost,
  type ComponentSource,
  imageFileSize,
  type MaterialSheet,
  type MaterialsFile,
  type MaterialsPage,
  type MaterialsProbeResult,
  materialsFromProbe,
  materialsProbeExpression,
  readComponentSource,
  readMaterials,
  readStateIndex,
  resolveFfmpeg,
} from "@open-take/compositor";
import { type CDP, ensureChrome, isCdpStall, launchBrowser } from "./cdp";
import { closeFidelityPage, openFidelityPage, renderState } from "./dom-state";
import { runBuffer } from "./tool";

/** Most image files fetched for one page, how long each may take, and how
 *  large one may be. Past them an image is listed with its URL and why. */
const FETCH_MAX = 120;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 25 * 1024 * 1024;
const FETCH_PARALLEL = 6;
/** all of a page's fetches together */
const FETCH_BUDGET_MS = 60_000;
/** the sheet: px per column, and the most page px it shows */
const SHEET_COLUMN_PX = 360;
const SHEET_MAX_PAGE_PX = 24_000;

/** Read the page open in `cdp` with the materials probe (read-only). */
export async function readPageMaterials(
  cdp: CDP,
): Promise<Exclude<MaterialsProbeResult, { error: string }>> {
  const r = await cdp.send<{ result?: { value?: string }; exceptionDetails?: { text?: string } }>(
    "Runtime.evaluate",
    { expression: materialsProbeExpression(), returnByValue: true },
  );
  const raw = r.result?.value;
  if (typeof raw !== "string")
    throw new Error(`the materials probe returned nothing (${r.exceptionDetails?.text ?? "?"})`);
  const res = JSON.parse(raw) as MaterialsProbeResult;
  if ("error" in res) throw new Error(`the materials probe failed: ${res.error.split("\n")[0]}`);
  return res;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/bmp": "bmp",
};

/** a file's extension from its bytes, else its stated type */
function extOf(buf: Buffer, type: string): string | null {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length >= 3 && buf.toString("latin1", 0, 3) === "GIF") return "gif";
  if (buf.length >= 12 && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 12 && /^ftypavi[fs]$/.test(buf.toString("latin1", 4, 12))) return "avif";
  if (/<svg\b/i.test(buf.toString("utf8", 0, Math.min(buf.length, 2048)))) return "svg";
  return EXT[type.split(";")[0]!.trim().toLowerCase()] ?? null;
}

type Saved = { file: string; fileSize?: [number, number]; bytes: number } | { notSaved: string };

/**
 * Save what `materialsFromProbe` named for each image — fetch a URL, decode
 * a data: URL, write an svg's markup, point at a file:// one already in the
 * assets — into `assetsDir` (content-named, shared), and fill each image's
 * `file`, `fileSize`, `bytes` or `notSaved`; the page's og:image too.
 */
export async function saveMaterialFiles(args: {
  file: MaterialsFile;
  save: ReturnType<typeof materialsFromProbe>["save"];
  stateDir: string;
  assetsDir: string;
}): Promise<void> {
  const t0 = Date.now();
  const { file, stateDir, assetsDir } = args;
  mkdirSync(assetsDir, { recursive: true });
  const rel = (p: string) => relative(stateDir, p).split(sep).join("/");
  const keep = (buf: Buffer, ext: string): Saved => {
    const name = `${createHash("sha1").update(buf).digest("hex")}.${ext}`;
    const path = join(assetsDir, name);
    if (!existsSync(path)) writeFileSync(path, buf);
    const size = imageFileSize(buf);
    return { file: rel(path), ...(size ? { fileSize: size } : {}), bytes: buf.length };
  };
  const deadline = t0 + FETCH_BUDGET_MS;
  let fetches = 0;
  const fetched = new Map<string, Promise<Saved>>();
  const fetchOne = (url: string): Promise<Saved> => {
    let p = fetched.get(url);
    if (!p) {
      p = (async (): Promise<Saved> => {
        if (url.startsWith("file:")) {
          const path = fileURLToPath(url);
          if (!existsSync(path)) return { notSaved: "its saved file is not there" };
          const buf = readFileSync(path);
          const size = imageFileSize(buf);
          return { file: rel(path), ...(size ? { fileSize: size } : {}), bytes: buf.length };
        }
        if (!/^https?:/i.test(url)) return { notSaved: "not a URL that can be fetched" };
        if (adHost(url)) return { notSaved: "an ad or tracking host" };
        if (++fetches > FETCH_MAX)
          return { notSaved: `past the ${FETCH_MAX} files fetched per page` };
        const left = deadline - Date.now();
        if (left <= 0)
          return {
            notSaved: `past the ${FETCH_BUDGET_MS / 1000} s spent fetching this page's images`,
          };
        try {
          const res = await fetch(url, {
            headers: {
              "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
              accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
              referer: file.url,
            },
            signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, left)),
          });
          if (!res.ok) return { notSaved: `HTTP ${res.status}` };
          const type = res.headers.get("content-type") ?? "";
          const len = Number(res.headers.get("content-length") ?? 0);
          if (len > FETCH_MAX_BYTES) return { notSaved: `${Math.round(len / 1048576)} MB` };
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > FETCH_MAX_BYTES)
            return { notSaved: `${Math.round(buf.length / 1048576)} MB` };
          const ext = extOf(buf, type);
          if (!ext) return { notSaved: `not an image (${type.split(";")[0] || "no type"})` };
          return keep(buf, ext);
        } catch (e) {
          const why =
            (e as Error).name === "TimeoutError" ? "the fetch timed out" : (e as Error).message;
          return { notSaved: `not fetched (${why})` };
        }
      })();
      fetched.set(url, p);
    }
    return p;
  };
  const jobs: (() => Promise<void>)[] = [];
  file.images.forEach((im, i) => {
    const s = args.save[i];
    if (!s) {
      im.notSaved =
        im.kind === "canvas"
          ? "drawn by the page's script (a canvas)"
          : im.kind === "video"
            ? "a video (not fetched), no poster"
            : file.read === "saved screen"
              ? "not in the saved screen (the page had not loaded it)"
              : "no source that can be fetched";
      return;
    }
    jobs.push(async () => {
      let r: Saved;
      if ("markup" in s) r = keep(Buffer.from(s.markup, "utf8"), "svg");
      else if ("data" in s) {
        const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(s.data);
        if (!m) r = { notSaved: "an unreadable data: URL" };
        else {
          const buf = m[2]
            ? Buffer.from(m[3]!, "base64")
            : Buffer.from(decodeURIComponent(m[3]!), "utf8");
          const ext = extOf(buf, m[1] ?? "");
          r = ext ? keep(buf, ext) : { notSaved: `not an image (${m[1] || "no type"})` };
        }
      } else r = await fetchOne(s.url);
      Object.assign(im, r);
    });
  });
  if (file.meta.ogImage)
    jobs.push(async () => {
      const r = await fetchOne(file.meta.ogImage!);
      if ("file" in r) file.meta.ogImageFile = r.file;
    });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_PARALLEL, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }),
  );
  file.ms.files = Date.now() - t0;
}

/**
 * The page open in `cdp` (a restored state.html, laid out) drawn top to
 * bottom, small, cut into columns side by side: `<stateDir>/sheet.jpg`.
 * The picture is taken beyond the viewport (nothing scrolls); a page taller
 * than SHEET_MAX_PAGE_PX shows its first that many px. Without ffmpeg the
 * sheet is one column, as a PNG.
 */
export async function takeSheet(
  cdp: CDP,
  opts: { stateDir: string; vw: number; ffmpeg?: string },
): Promise<MaterialSheet> {
  const r = await cdp.send<{ result?: { value?: number } }>("Runtime.evaluate", {
    expression:
      "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight)",
    returnByValue: true,
  });
  const pageH = Math.max(1, Math.round(r.result?.value ?? 0));
  const covered = Math.min(pageH, SHEET_MAX_PAGE_PX);
  const scale = SHEET_COLUMN_PX / opts.vw;
  const shot = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: opts.vw, height: covered, scale },
    },
    { timeoutMs: 120_000 },
  );
  const png = Buffer.from(shot.data, "base64");
  const [w, h] = imageFileSize(png) ?? [SHEET_COLUMN_PX, Math.round(covered * scale)];
  // about as wide as 16:10 overall: n columns of h/n each
  const columns = opts.ffmpeg ? Math.max(1, Math.min(8, Math.round(Math.sqrt((1.6 * h) / w)))) : 1;
  if (columns === 1) {
    const name = opts.ffmpeg ? "sheet.jpg" : "sheet.png";
    if (opts.ffmpeg) await toJpeg(opts.ffmpeg, png, join(opts.stateDir, name), "null");
    else await writeFile(join(opts.stateDir, name), png);
    return sheetInfo(name, 1, covered, scale, covered);
  }
  const ch = Math.ceil(h / columns);
  const gap = 12;
  const parts: string[] = [
    `[0]split=${columns}${Array.from({ length: columns }, (_, k) => `[s${k}]`).join("")}`,
  ];
  for (let k = 0; k < columns; k++) {
    const y = k * ch;
    const hk = Math.max(1, Math.min(ch, h - y));
    parts.push(
      `[s${k}]crop=${w}:${hk}:0:${y},pad=${w + (k < columns - 1 ? gap : 0)}:${ch}:0:0:color=0x9a9a9a[c${k}]`,
    );
  }
  parts.push(
    `${Array.from({ length: columns }, (_, k) => `[c${k}]`).join("")}hstack=inputs=${columns}`,
  );
  await toJpeg(opts.ffmpeg!, png, join(opts.stateDir, "sheet.jpg"), parts.join(";"));
  return sheetInfo("sheet.jpg", columns, Math.ceil(covered / columns), scale, covered);
}

const sheetInfo = (
  file: string,
  columns: number,
  columnPx: number,
  scale: number,
  coveredPx: number,
): MaterialSheet => ({
  file,
  columns,
  columnPx,
  scale: Math.round(scale * 10000) / 10000,
  coveredPx,
  from: "saved screen",
});

async function toJpeg(ffmpeg: string, png: Buffer, out: string, graph: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "open-take-sheet-"));
  try {
    const src = join(dir, "page.png");
    await writeFile(src, png);
    await runBuffer(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-i",
      src,
      ...(graph === "null" ? [] : ["-filter_complex", graph]),
      "-frames:v",
      "1",
      "-q:v",
      "3",
      out,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function writeMaterials(file: MaterialsFile, stateDir: string): string {
  const path = join(stateDir, "materials.json");
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

/** One page read live (a shoot): pick, save and write — never throws past a
 *  line in `note`; null when it could not be written. */
export async function finishPageMaterials(args: {
  res: Exclude<MaterialsProbeResult, { error: string }>;
  id: string;
  stateDir: string;
  assetsDir: string;
  sheet?: MaterialSheet & { ms?: number };
  note: (line: string) => void;
}): Promise<MaterialsPage | null> {
  try {
    const { file, save } = materialsFromProbe(args.res, { state: args.id, read: "live" });
    await saveMaterialFiles({ file, save, stateDir: args.stateDir, assetsDir: args.assetsDir });
    if (args.sheet) {
      const { ms, ...sheet } = args.sheet;
      file.sheet = sheet;
      if (ms != null) file.ms.sheet = ms;
    }
    const path = writeMaterials(file, args.stateDir);
    return { id: args.id, dir: args.stateDir, file, path };
  } catch (e) {
    args.note(`shoot: no materials.json for ${args.id} (${(e as Error).message})`);
    return null;
  }
}

export type MaterialsInventory = {
  pages: MaterialsPage[];
  source: ComponentSource;
  /** pages read now from a saved screen */
  read: string[];
  failed: { state: string; why: string }[];
};

/** `open-take materials`: the materials.json of each page a source's saved
 *  screens show — read from a state.html where a page has none. */
export async function inventoryMaterials(opts: {
  path: string;
  state?: string;
  chromePath?: string;
  /** false: never open Chrome */
  measure?: boolean;
}): Promise<MaterialsInventory> {
  let source: ComponentSource;
  try {
    source = readComponentSource(opts.path);
  } catch (e) {
    // the same sources as `components`, named for this verb
    throw new Error((e as Error).message.replace(/^components:/, "materials:"));
  }
  if (opts.state && !source.states.some((s) => s.id === opts.state))
    throw new Error(
      `materials: no saved screen ${opts.state} here (it has ${source.states.map((s) => s.id).join(", ") || "none"})`,
    );
  const scoped: ComponentSource = opts.state
    ? { ...source, states: source.states.filter((s) => s.id === opts.state) }
    : source;
  const { pages, missing } = readMaterials(scoped);
  const read: string[] = [];
  const failed: { state: string; why: string }[] = [];
  if (missing.length && opts.measure !== false) {
    const first = readStateIndex(missing[0]!.dir);
    const vp = typeof first === "string" ? { w: 1920, h: 1080 } : first.viewport;
    const browser = await launchBrowser({
      width: vp.w,
      height: vp.h,
      chromePath: await ensureChrome(opts.chromePath),
    });
    let ffmpeg: string | undefined;
    try {
      ffmpeg = await resolveFfmpeg();
    } catch {
      /* the sheet is one PNG column then */
    }
    let page: { cdp: CDP; targetId: string } | null = null;
    try {
      for (const m of missing) {
        const index = readStateIndex(m.dir);
        if (typeof index === "string") {
          failed.push({ state: m.id, why: index });
          continue;
        }
        const { w, h } = index.viewport;
        try {
          page = page ?? (await openFidelityPage(browser, w, h));
          await page.cdp.send("Emulation.setDeviceMetricsOverride", {
            width: w,
            height: h,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await renderState(page.cdp, join(m.dir, "state.html"), w, h);
          const res = await readPageMaterials(page.cdp);
          // the page it shows, not the saved file's address
          res.url = index.url;
          res.title = index.title || res.title;
          const { file, save } = materialsFromProbe(res, { state: m.id, read: "saved screen" });
          await saveMaterialFiles({
            file,
            save,
            stateDir: m.dir,
            assetsDir: join(m.dir, "..", "assets"),
          });
          const t0 = Date.now();
          file.sheet = await takeSheet(page.cdp, { stateDir: m.dir, vw: w, ffmpeg });
          file.ms.sheet = Date.now() - t0;
          pages.push({ id: m.id, dir: m.dir, file, path: writeMaterials(file, m.dir) });
          read.push(m.id);
        } catch (e) {
          failed.push({ state: m.id, why: (e as Error).message });
          if (page && isCdpStall(e)) {
            await closeFidelityPage(browser, page);
            page = null;
          }
        }
      }
    } finally {
      if (page) await closeFidelityPage(browser, page);
      await browser.close();
    }
  } else
    for (const m of missing)
      failed.push({ state: m.id, why: "no materials.json (not read: Chrome off)" });
  // shooting order
  const order = new Map(source.states.map((s, i) => [s.id, i]));
  pages.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { pages, source, read, failed };
}
