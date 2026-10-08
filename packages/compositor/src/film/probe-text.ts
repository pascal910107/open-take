// Text at film scale, for `film probe`: how much of the frame is text at each
// moment, how big that text is drawn on the film and how big it would be on a
// phone, and whether the film's own text sits over pictures, the product's
// text or the subject a segment names.
//
// Two readers, each labelled for what it is:
//   - the page (measured): the film's page played on the film clock, as
//     `film check` plays it, and every visible piece of text read where its
//     glyphs are drawn and at the size they are drawn — the film's own text
//     (titles, captions) apart from the product's text in a saved screen
//     (an <iframe>);
//   - the picture (estimated): the finished film's frames read for text,
//     which is the only way to see text inside a screenshot or a recording.
//     On macOS the system's own text recognizer (Vision, through a small
//     Swift helper compiled once into the temp dir) reads each line and its
//     height; elsewhere, or when that fails, an edge count says only how much
//     of the frame looks like text, with no size.
//
// Information only: no size is called too small and no amount too much.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../ffmpeg";
import { type HtmlBrowser, launchHtmlBrowser } from "../html/cdp";
import { serveDirectory } from "../html/server";
import { type FilmPageInfo, filmClockSource } from "./clock";
import { resolveFilmPage } from "./render";

/** the width (CSS px) a film is taken to be shown at on a phone: a phone held
 *  upright, the film across the feed */
export const PHONE_W = 390;

export type Box = [number, number, number, number];

/** one moment of the page, as read (frame CSS px) */
export type PageTextSample = {
  t: number;
  /** the film's own text, one entry per block of text */
  own: { text: string; chars: number; px: number; boxes: Box[] }[];
  /** the product's text inside saved screens (iframes), summed */
  product: { chars: number; pieces: number };
  /** char-weighted sizes of all text drawn: [px, chars] */
  sizes: [number, number][];
  /** share of the frame under the lines of: own text, product text (their
   *  line boxes, summed) */
  ownShare: number;
  productShare: number;
  /** the grid of cells the product's text covers, row by row, "1" covered */
  grid: string[];
  /** pictures on the page: img, video, canvas, iframe, a background image;
   *  `src` the file it shows (a URL as the page has it; after
   *  readPageText, a path from the served root when it is served there);
   *  for an <img>, `drawn`: where its whole image is drawn (object-fit
   *  and transforms taken in, the clip not), and its own size in px */
  media: { label: string; box: Box; src?: string; drawn?: Box; natural?: [number, number] }[];
  /** where each named subject (a CSS selector) is drawn; null: an element
   *  matches but is not visible; absent: no element matches */
  subjects: Record<string, Box | null>;
  /** what `extra` gave at this time, when it was asked */
  extra?: unknown;
};

export type PageTextReading = {
  samples: PageTextSample[];
  /** the folder the page was served from: the media's `src` paths are in it */
  root: string;
  width: number;
  height: number;
  /** window.__film.segments() as the page has it now (unchecked) */
  segments: unknown;
  /** times the page threw at, twice, and was not read */
  failed: { t: number; error: string }[];
  /** what the page says it is (window.__ot.prepare()) */
  info: FilmPageInfo;
};

// --- the page --------------------------------------------------------------------------

export function pageTextSource(subjects: readonly string[]): string {
  return `(() => { const __name = (f) => f; return (${probeText.toString()})(${JSON.stringify(subjects)}); })()`;
}

// serialized into the page: nothing outside its own body
function probeText(subjects: string[]): Omit<PageTextSample, "t"> {
  const vw = innerWidth;
  const vh = innerHeight;
  const GXp = 96;
  const GYp = 54;
  // faded text is still text on screen; a cross-fade's two scenes both count
  const MIN_O = 0.15;
  type B = { x: number; y: number; w: number; h: number };
  const inter = (a: B, b: B): B | null => {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  const alphas = new Map<Element, number>();
  const alphaOf = (el: Element | null, view: Window): number => {
    if (!el) return 1;
    const hit = alphas.get(el);
    if (hit !== undefined) return hit;
    const cs = view.getComputedStyle(el);
    const own = cs.display === "none" ? 0 : Number(cs.opacity) || 0;
    const o = own === 0 ? 0 : own * alphaOf(el.parentElement, view);
    alphas.set(el, o);
    return o;
  };
  const opacityOf = (el: Element, view: Window): number => {
    const v = view.getComputedStyle(el).visibility;
    return v === "hidden" || v === "collapse" ? 0 : alphaOf(el, view);
  };
  /** what of the frame the boxes holding an element let show: every
   *  ancestor whose overflow is not visible (the root and body aside) */
  const clips = new Map<Element, B | null>();
  const clipOf = (el: Element | null, view: Window, map: (r: DOMRect) => B, base: B): B | null => {
    if (!el) return base;
    if (clips.has(el)) return clips.get(el)!;
    const doc = el.ownerDocument;
    let c = clipOf(el.parentElement, view, map, base);
    if (c && el !== doc.documentElement && el !== doc.body) {
      const cs = view.getComputedStyle(el);
      if (cs.display !== "contents" && (cs.overflowX !== "visible" || cs.overflowY !== "visible"))
        c = inter(c, map(el.getBoundingClientRect()));
    }
    clips.set(el, c);
    return c;
  };
  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : "";
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.localName}${id}${text ? ` "${text}"` : ""}`;
  };
  const scaleOf = (el: Element): number => {
    const drawn = el.getBoundingClientRect().height;
    const laid = (el as HTMLElement).offsetHeight;
    if (typeof laid === "number") return laid > 0 ? drawn / laid : 1;
    try {
      const own = (el as SVGGraphicsElement).getBBox?.().height;
      return own && own > 0 ? drawn / own : 1;
    } catch {
      return 1;
    }
  };
  const grid = new Uint8Array(GXp * GYp);
  let ownArea = 0;
  let prodArea = 0;
  const mark = (b: B, isOwn: boolean) => {
    if (isOwn) {
      ownArea += b.w * b.h;
      return;
    }
    prodArea += b.w * b.h;
    const x0 = Math.max(0, Math.floor((b.x / vw) * GXp));
    const x1 = Math.min(GXp - 1, Math.floor(((b.x + b.w) / vw) * GXp - 1e-9));
    const y0 = Math.max(0, Math.floor((b.y / vh) * GYp));
    const y1 = Math.min(GYp - 1, Math.floor(((b.y + b.h) / vh) * GYp - 1e-9));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * GXp + x] = 1;
  };
  const own: Omit<PageTextSample, "t">["own"] = [];
  const product = { chars: 0, pieces: 0 };
  const sizes = new Map<number, number>();
  const frame: B = { x: 0, y: 0, w: vw, h: vh };

  const collect = (
    doc: Document,
    view: Window,
    map: (r: DOMRect) => B,
    clip: B,
    baseO: number,
    scale: number,
    isOwn: boolean,
  ) => {
    if (!doc.body) return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    const seen = new Map<Element, { text: string; chars: number; px: number; boxes: Box[] }>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const value = n.nodeValue ?? "";
      const chars = value.replace(/\s+/g, "").length;
      if (!chars) continue;
      const el = n.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      if (baseO * opacityOf(el, view) < MIN_O) continue;
      const visible = clipOf(el, view, map, clip);
      if (!visible) continue;
      range.selectNodeContents(n);
      // characters shown: by the width of each line that shows (a line box's
      // empty leading cut off at an edge costs no characters), a line counting
      // when at least half its height shows
      let full = 0;
      let shown = 0;
      const boxes: B[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 1) continue;
        const m = map(r);
        full += m.w;
        const v = inter(m, visible);
        if (!v || v.w < 1 || v.h < 1) continue;
        if (v.h >= 0.5 * m.h) shown += v.w;
        boxes.push(v);
      }
      if (!boxes.length) continue;
      // the block it belongs to: a caption split into spans is one piece
      let owner: Element = el;
      while (
        owner.parentElement &&
        owner.parentElement !== doc.body &&
        /^(inline|inline-block|inline-flex|contents)$/.test(view.getComputedStyle(owner).display)
      )
        owner = owner.parentElement;
      const px = (Number.parseFloat(view.getComputedStyle(el).fontSize) || 0) * scaleOf(el) * scale;
      const seenChars = shown ? Math.max(1, Math.round((chars * shown) / Math.max(1, full))) : 0;
      const key = Math.round(px * 2) / 2;
      sizes.set(key, (sizes.get(key) ?? 0) + seenChars);
      for (const b of boxes) mark(b, isOwn);
      if (isOwn) {
        const e = seen.get(owner);
        const rb = boxes.map(
          (b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)] as Box,
        );
        if (e) {
          e.chars += seenChars;
          e.px = Math.min(e.px, px);
          e.boxes.push(...rb);
        } else {
          const entry = { text: describe(owner), chars: seenChars, px, boxes: rb };
          seen.set(owner, entry);
          own.push(entry);
        }
      } else {
        product.chars += seenChars;
        if (!seen.has(owner)) {
          seen.set(owner, { text: "", chars: 0, px, boxes: [] });
          product.pieces++;
        }
      }
    }
  };

  const top = (r: DOMRect): B => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  collect(document, window, top, frame, 1, 1, true);
  // same-origin iframes: the product's saved screens
  const frames: { f: HTMLIFrameElement; doc: Document; map: (r: DOMRect) => B; sy: number }[] = [];
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    let doc: Document | null = null;
    try {
      doc = f.contentDocument;
    } catch {
      continue;
    }
    const view = f.contentWindow;
    if (!doc?.body || !view) continue;
    const o = opacityOf(f, window);
    if (o < MIN_O) continue;
    const fb = f.getBoundingClientRect();
    const sx = f.offsetWidth ? fb.width / f.offsetWidth : 1;
    const sy = f.offsetHeight ? fb.height / f.offsetHeight : 1;
    const left = fb.left + f.clientLeft * sx;
    const topY = fb.top + f.clientTop * sy;
    const map = (r: DOMRect): B => ({
      x: left + r.left * sx,
      y: topY + r.top * sy,
      w: r.width * sx,
      h: r.height * sy,
    });
    const shown = clipOf(f, window, top, frame);
    const box = inter({ x: left, y: topY, w: f.clientWidth * sx, h: f.clientHeight * sy }, frame);
    const clip = shown && box && inter(shown, box);
    if (!clip) continue;
    frames.push({ f, doc, map, sy });
    collect(doc, view, map, clip, o, sy, false);
  }

  // pictures on the film's own page, as far as they show
  const media: Omit<PageTextSample, "t">["media"] = [];
  for (const el of Array.from(document.body?.querySelectorAll("*") ?? [])) {
    const tag = el.localName;
    let picture = ["img", "video", "canvas", "iframe", "picture", "image"].includes(tag);
    let src = "";
    if (!picture) {
      const bg = getComputedStyle(el).backgroundImage;
      picture = !!bg && bg !== "none" && /url\(/.test(bg);
      if (picture) src = /url\(["']?([^"')]+)["']?\)/.exec(bg)?.[1] ?? "";
    } else if (tag === "img" || tag === "video") {
      const m = el as HTMLImageElement;
      src = m.currentSrc || m.src || "";
    } else if (tag === "iframe") src = (el as HTMLIFrameElement).src || "";
    else if (tag === "image") {
      const href = (el as SVGImageElement).href?.baseVal ?? "";
      try {
        src = href ? new URL(href, document.baseURI).href : "";
      } catch {}
    }
    if (!picture) continue;
    if (opacityOf(el, window) < MIN_O) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 0.01 * vw * vh) continue;
    const c = clipOf(el.parentElement, window, top, frame);
    const v = c && inter(top(r), c);
    if (!v) continue;
    // an image's own pixels on the frame: its box as laid out, fitted as
    // object-fit says (centred), then as transformed
    let drawn: Box | undefined;
    let natural: [number, number] | undefined;
    if (tag === "img") {
      const im = el as HTMLImageElement;
      const nw = im.naturalWidth;
      const nh = im.naturalHeight;
      const lw = im.offsetWidth;
      const lh = im.offsetHeight;
      if (nw && nh && lw && lh) {
        const fit = getComputedStyle(im).objectFit;
        const contain = Math.min(lw / nw, lh / nh);
        const [fx, fy] =
          fit === "contain"
            ? [contain, contain]
            : fit === "cover"
              ? [Math.max(lw / nw, lh / nh), Math.max(lw / nw, lh / nh)]
              : fit === "none"
                ? [1, 1]
                : fit === "scale-down"
                  ? [Math.min(1, contain), Math.min(1, contain)]
                  : [lw / nw, lh / nh];
        const kx = r.width / lw;
        const ky = r.height / lh;
        const dw = nw * fx * kx;
        const dh = nh * fy * ky;
        drawn = [
          Math.round((r.left + (r.width - dw) / 2) * 10) / 10,
          Math.round((r.top + (r.height - dh) / 2) * 10) / 10,
          Math.round(dw * 10) / 10,
          Math.round(dh * 10) / 10,
        ];
        natural = [nw, nh];
      }
    }
    media.push({
      label: describe(el).slice(0, 60),
      box: [Math.round(v.x), Math.round(v.y), Math.round(v.w), Math.round(v.h)],
      ...(src && !src.startsWith("data:") && !src.startsWith("blob:") ? { src } : {}),
      ...(drawn ? { drawn, natural } : {}),
    });
  }

  // the subjects the segments name, where a selector finds them
  const where: Record<string, Box | null> = {};
  for (const sel of subjects) {
    let box: B | null = null;
    const find = (doc: Document, map: (r: DOMRect) => B, view: Window) => {
      let el: Element | null = null;
      try {
        el = doc.querySelector(sel);
      } catch {
        return false;
      }
      if (!el) return false;
      if (opacityOf(el, view) < MIN_O) return true;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return true;
      box = map(r);
      return true;
    };
    const found =
      find(document, top, window) ||
      frames.some((fr) => !!fr.f.contentWindow && find(fr.doc, fr.map, fr.f.contentWindow));
    if (!found) continue;
    const b = box as B | null;
    where[sel] = b ? [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)] : null;
  }

  const share = (a: number) => Math.round(Math.min(1, a / (vw * vh)) * 1000) / 1000;
  const rows: string[] = [];
  for (let y = 0; y < GYp; y++)
    rows.push(Array.from(grid.subarray(y * GXp, (y + 1) * GXp)).join(""));
  return {
    own: own.map((o) => ({ ...o, px: Math.round(o.px * 10) / 10 })),
    product,
    sizes: [...sizes].sort((a, b) => a[0] - b[0]),
    ownShare: share(ownArea),
    productShare: share(prodArea),
    grid: rows,
    media,
    subjects: where,
  };
}

/** Play the film's page on the film clock, as `film check` does, and read its
 *  text at each of `times` (the film's own seconds; the page is at from + t). */
export async function readPageText(opts: {
  page: string;
  root?: string;
  chromePath: string;
  from: number;
  times: readonly number[];
  width?: number;
  height?: number;
  fallback: { width: number; height: number };
  /** CSS selectors to locate at each time */
  subjects?: readonly string[];
  /** an expression asked of the page at each time too (awaited), kept on the
   *  sample as `extra` — another reading on the same seek */
  extra?: string;
  onConsole?: (level: string, text: string) => void;
}): Promise<PageTextReading> {
  const { root, urlPath } = resolveFilmPage(opts.page, opts.root);
  const server = await serveDirectory(root);
  const open = (width: number, height: number) =>
    launchHtmlBrowser({
      chromePath: opts.chromePath,
      url: `${server.url}${urlPath}`,
      width,
      height,
      initScript: filmClockSource({ seed: 0x5eed, epochMs: Date.now() }),
      stillAnimations: true,
      onConsole: opts.onConsole,
      timeoutMs: 120_000,
      profilePrefix: "open-take-probe-text-",
    });
  const prepare = async (b: HtmlBrowser) => {
    if (!(await b.evaluate<boolean>(`typeof window.__ot === "object"`)))
      throw new Error("film probe: the film clock did not install in the page");
    return b.evaluate<FilmPageInfo>("window.__ot.prepare()", { timeoutMs: 120_000 });
  };
  try {
    let width = opts.width ?? opts.fallback.width;
    let height = opts.height ?? opts.fallback.height;
    let browser = await open(width, height);
    try {
      let info = await prepare(browser);
      if (
        opts.width === undefined &&
        info.width &&
        info.height &&
        (info.width !== width || info.height !== height)
      ) {
        await browser.close();
        width = info.width;
        height = info.height;
        browser = await open(width, height);
        info = await prepare(browser);
      }
      const segments = await browser
        .evaluate<unknown>(
          `(async () => { const f = window.__film?.segments; return typeof f === "function" ? JSON.parse(JSON.stringify((await f()) ?? [])) : null; })()`,
        )
        .catch(() => null);
      // the subjects: the ones asked for, and those the page's segments name
      const subjects = new Set(opts.subjects ?? []);
      if (Array.isArray(segments))
        for (const s of segments as { subject?: unknown }[])
          if (typeof s?.subject === "string" && s.subject) subjects.add(s.subject);
      const source = pageTextSource([...subjects]);
      const samples: PageTextSample[] = [];
      const failed: PageTextReading["failed"] = [];
      for (const t of opts.times) {
        // a page that throws at one time (a still that failed to decode) is
        // asked once more, then left out there
        let error = "";
        for (let tries = 0; tries < 2; tries++) {
          try {
            await browser.evaluate(`window.__ot.seek(${opts.from + t})`);
            const r = await browser.evaluate<Omit<PageTextSample, "t">>(source);
            for (const m of r.media) if (m.src) m.src = servedPath(m.src, server.url);
            const extra = opts.extra ? await browser.evaluate<unknown>(opts.extra) : undefined;
            samples.push({ t, ...r, ...(opts.extra ? { extra } : {}) });
            error = "";
            break;
          } catch (e) {
            error = (e as Error).message.split("\n")[0] ?? "";
          }
        }
        if (error) failed.push({ t, error });
      }
      return { samples, root, width, height, segments, failed, info };
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

/** a URL the page showed, as a path from the served root ("/shots/001-a.png")
 *  when the server serves it, else as it was */
export function servedPath(src: string, base: string): string {
  const b = base.replace(/\/+$/, "");
  if (!src.startsWith(`${b}/`)) return src;
  const path = src.slice(b.length).split(/[?#]/)[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** how much of a box (frame px) the page's text grid covers, 0..1 */
export function gridCover(grid: readonly string[], w: number, h: number, b: Box): number {
  if (!grid.length) return 0;
  const gx = grid[0]!.length;
  const gy = grid.length;
  const x0 = Math.max(0, Math.floor((b[0] / w) * gx));
  const x1 = Math.min(gx - 1, Math.floor(((b[0] + b[2]) / w) * gx - 1e-9));
  const y0 = Math.max(0, Math.floor((b[1] / h) * gy));
  const y1 = Math.min(gy - 1, Math.floor(((b[1] + b[3]) / h) * gy - 1e-9));
  let n = 0;
  let k = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      n++;
      if (grid[y]![x] === "1") k++;
    }
  return n ? k / n : 0;
}

// --- the picture ----------------------------------------------------------------------

/** a line of text the recognizer read: its box in frame px, characters, confidence */
export type OcrLine = { box: Box; chars: number; conf: number; text: string };

export type FrameText = {
  t: number;
  /** "ocr": lines read with their size; "edges": only a share, from an edge count */
  how: "ocr" | "edges";
  lines: OcrLine[];
  /** share of the frame under text (ocr: the lines' boxes, summed; edges: text-like cells) */
  share: number;
};

const OCR_SWIFT = `import Foundation
import Vision
import ImageIO
// reads image paths on stdin, one a line; writes one JSON line per image
while let line = readLine() {
  let path = line.trimmingCharacters(in: .whitespaces)
  if path.isEmpty { continue }
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    print("{\\"error\\":\\"unreadable\\"}"); fflush(stdout); continue
  }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  req.recognitionLanguages = ["zh-Hant", "zh-Hans", "ja-JP", "ko-KR", "en-US"]
  let h = VNImageRequestHandler(cgImage: img, options: [:])
  try? h.perform([req])
  var out: [[String: Any]] = []
  for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    out.append(["x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height, "c": c.confidence, "s": c.string])
  }
  let d = try! JSONSerialization.data(withJSONObject: ["w": img.width, "h": img.height, "lines": out])
  print(String(data: d, encoding: .utf8)!)
  fflush(stdout)
}
`;

let ocrBinary: Promise<string | null> | null = null;

/** the text recognizer's helper, compiled once per source into the temp dir;
 *  null where it cannot be had (not macOS, no swiftc, a failed build) */
export function ocrHelper(): Promise<string | null> {
  if (process.env.OPEN_TAKE_NO_OCR) return Promise.resolve(null);
  ocrBinary ??= (async () => {
    if (platform() !== "darwin") return null;
    const hash = createHash("sha1").update(OCR_SWIFT).digest("hex").slice(0, 12);
    const dir = join(tmpdir(), `open-take-ocr-${hash}`);
    const bin = join(dir, "ocr");
    if (existsSync(bin)) return bin;
    try {
      await mkdir(dir, { recursive: true });
      const src = join(dir, "ocr.swift");
      await writeFile(src, OCR_SWIFT);
      const tmpBin = join(dir, `ocr-${process.pid}`);
      await runTool("swiftc", ["-O", src, "-o", tmpBin]);
      await rm(bin, { force: true });
      await rename(tmpBin, bin);
      return bin;
    } catch {
      return null;
    }
  })();
  return ocrBinary;
}

/** run the helper over images: one parsed result per image, in order */
export function runOcr(
  bin: string,
  files: readonly string[],
): Promise<
  ({
    w: number;
    h: number;
    lines: { x: number; y: number; w: number; h: number; c: number; s: string }[];
  } | null)[]
> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    p.stderr.on("data", () => {});
    p.on("error", fail);
    p.on("close", (code) => {
      const lines = out.split("\n").filter((l) => l.trim());
      if (code !== 0 && lines.length < files.length)
        return fail(new Error(`text recognizer exited ${code}`));
      ok(
        files.map((_, i) => {
          try {
            const r = JSON.parse(lines[i] ?? "null");
            return r && !r.error ? r : null;
          } catch {
            return null;
          }
        }),
      );
    });
    p.stdin.end(`${files.join("\n")}\n`);
  });
}

/** the film's frames at `times` (its own seconds), read for text; null when
 *  neither reader could run */
export async function readFrameText(opts: {
  ffmpeg: string;
  input: string;
  times: readonly number[];
  /** the film's frame size, which boxes are given in */
  width: number;
  height: number;
  /** skip the recognizer and use the edge count */
  edgesOnly?: boolean;
}): Promise<{ how: "ocr" | "edges"; frames: FrameText[] } | null> {
  const bin = opts.edgesOnly ? null : await ocrHelper();
  const tmp = await mkdtemp(join(tmpdir(), "open-take-probe-text-"));
  try {
    if (bin) {
      // the frames as images, at most 1920 wide (the recognizer reads small text there)
      const ow = Math.min(1920, opts.width);
      const files: string[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, opts.times.length) }, async () => {
          while (next < opts.times.length) {
            const i = next++;
            const f = join(tmp, `${String(i).padStart(5, "0")}.png`);
            await runTool(opts.ffmpeg, [
              "-v",
              "error",
              "-ss",
              String(Math.max(0, opts.times[i]!)),
              "-i",
              opts.input,
              "-frames:v",
              "1",
              "-vf",
              `scale=${ow}:-2`,
              "-y",
              f,
            ]).catch(() => {});
            files[i] = f;
          }
        }),
      );
      const present = files.filter((f) => existsSync(f));
      if (present.length) {
        try {
          const read = await runOcr(bin, present);
          const byFile = new Map(present.map((f, i) => [f, read[i]] as const));
          const frames: FrameText[] = opts.times.map((t, i) => {
            const r = byFile.get(files[i]!) ?? null;
            const lines: OcrLine[] = (r?.lines ?? []).map((l) => ({
              box: [
                Math.round(l.x * opts.width),
                Math.round(l.y * opts.height),
                Math.round(l.w * opts.width),
                Math.round(l.h * opts.height),
              ] as Box,
              chars: l.s.replace(/\s+/g, "").length,
              conf: Math.round(l.c * 100) / 100,
              text: l.s.slice(0, 60),
            }));
            const share = Math.min(
              1,
              lines.reduce((a, l) => a + l.box[2] * l.box[3], 0) / (opts.width * opts.height),
            );
            return { t, how: "ocr", lines, share: Math.round(share * 1000) / 1000 };
          });
          return { how: "ocr", frames };
        } catch {
          // fall through to the edge count
        }
      }
    }
    const frames = await edgeText(opts.ffmpeg, opts.input, opts.times);
    return frames ? { how: "edges", frames } : null;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** the share of the frame that looks like text by an edge count: cells of a
 *  960-wide grey copy dense in short, strong horizontal transitions over
 *  enough contrast. Photos and fine textures count too; there is no size. */
async function edgeText(
  ffmpeg: string,
  input: string,
  times: readonly number[],
): Promise<FrameText[] | null> {
  const W = 960;
  const out: FrameText[] = [];
  for (const t of times) {
    const buf = await new Promise<Buffer | null>((ok) => {
      const p = spawn(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          String(Math.max(0, t)),
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          `scale=${W}:-2,format=gray`,
          "-f",
          "rawvideo",
          "-",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const chunks: Buffer[] = [];
      p.stdout.on("data", (d: Buffer) => chunks.push(d));
      p.on("error", () => ok(null));
      p.on("close", (code) => ok(code === 0 ? Buffer.concat(chunks) : null));
    });
    if (!buf || buf.length < W * 8) {
      out.push({ t, how: "edges", lines: [], share: 0 });
      continue;
    }
    out.push({ t, how: "edges", lines: [], share: edgeShare(buf, W, Math.floor(buf.length / W)) });
  }
  return out.length ? out : null;
}

/** text-like cells (8×8) of a grey frame, as a share of all cells */
export function edgeShare(px: Uint8Array, w: number, h: number): number {
  const C = 8;
  const cx = Math.floor(w / C);
  const cy = Math.floor(h / C);
  let text = 0;
  for (let by = 0; by < cy; by++)
    for (let bx = 0; bx < cx; bx++) {
      let edges = 0;
      let s = 0;
      let sq = 0;
      for (let r = 0; r < C; r++) {
        const row = (by * C + r) * w + bx * C;
        for (let c = 0; c < C; c++) {
          const v = px[row + c]!;
          s += v;
          sq += v * v;
          if (c < C - 1 && Math.abs(v - px[row + c + 1]!) > 40) edges++;
        }
      }
      const m = s / (C * C);
      const sd = Math.sqrt(Math.max(0, sq / (C * C) - m * m));
      const density = edges / (C * (C - 1));
      if (sd > 20 && density >= 0.1 && density <= 0.6) text++;
    }
  return cx * cy ? Math.round((text / (cx * cy)) * 1000) / 1000 : 0;
}
