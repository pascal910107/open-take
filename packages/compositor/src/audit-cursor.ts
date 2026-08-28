// auditCursor: verify the DRAWN cursor in a finished mp4 against the
// compositor's own INTENT. No vision model and no duplicated geometry — the
// engine already knows where it meant to draw the pointer (math.buildLegs /
// cursorPos / stageCamera give the tip in the finished frame), so the audit
// only has to LOOK there: the cursor polygon is rasterised at that beat's
// on-screen scale and matched by masked normalised cross-correlation in a
// ±SEARCH_WIN_PX window around the expected tip. Field-validated: a 1% skew
// is caught while 22/22 beats of good footage pass clean (median error
// 0.21px, ncc ≈ 0.83).
//
// The pixel-independent parts (template, NCC search, tip prediction, issue
// building) are pure and exported for tests; only auditCursor itself spawns
// ffmpeg (one grayscale frame per beat, piped raw — no image decoder dep).

import { spawn } from "node:child_process";
import { resolveFfmpeg } from "./ffmpeg";
import { buildLegs, cursorPos, stageCamera } from "./math";
import type { Pt, TakeComposition } from "./types";
import type { CompositionIssue } from "./validate";

/** The pointer polygon, tip at (0,0), stage units. Copied from
 *  src/scene/scene.tsx (CURSOR) — the scene is compiled by revideo's vite and
 *  exports nothing, so the vertex list is duplicated here ON PURPOSE: any
 *  drift between the drawn cursor and the audited one shows up in review. */
export const CURSOR_POLYGON: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 17],
  [4.5, 13],
  [7.5, 19.5],
  [10, 18.3],
  [7, 11.7],
  [12, 11.7],
];

/** supersample factor for the template rasteriser */
const SS = 4;
/** template pixels below this mask weight do not score */
const MASK_MIN = 0.15;
/** search radius around the expected tip, output px */
const SEARCH_WIN_PX = 45;
/** Below this the template never locked onto a cursor at all — a different
 *  failure from "matched but offset". Measured with the Python prototype's
 *  LANCZOS template: ncc 0.825 on a clean take, 0.611 at 8% skew, 0.421 at
 *  13% (the shipped-to-a-PR failure). Re-measured with THIS module's box
 *  downsample on a real 10-beat draft render: all 9 pointer beats found at
 *  0.00px error, ncc 0.626–0.944 — the 0.5 floor holds for this template. */
const NCC_MATCH_MIN = 0.5;
/** the scene's cursor body fill, rgb(20,20,24) ≈ 20/255 gray */
const BODY_GRAY = 20 / 255;

const DEFAULT_SAMPLE_AFTER_MS = 500;
const DEFAULT_TOL_PX = 6;

export type AuditCursorOpts = {
  /** ms after a beat's landing to sample (clamped inside the beat's hold) */
  sampleAfterMs?: number;
  /** max tolerated tip error, VIEWPORT px (default 6; good takes median 0.21) */
  tolPx?: number;
};

export type AuditRow = {
  /** event index */
  beat: number;
  /** sample instant in the DELIVERED video (startMs head trim applied), s */
  tSec: number;
  /** expected cursor-tip position in the finished frame, output px */
  expect: Pt;
  /** best-match tip position, output px (absent when unverifiable) */
  found?: Pt;
  /** tip error in viewport px (output-px error / camera scale) */
  errViewportPx?: number;
  /** masked NCC score of the best match */
  ncc?: number;
  /** the expected tip is not in the delivered frame — unverifiable, never an error */
  offscreen?: boolean;
};

export type GrayFrame = { data: Float32Array; width: number; height: number };

export type CursorTemplate = {
  width: number;
  height: number;
  /** grayscale sprite, 0..1 (dark body, white outline) */
  pixels: Float32Array;
  /** score only where the sprite is — the patch around it is page content */
  mask: Float32Array;
  /** local coords of the cursor TIP inside the template */
  tip: Pt;
};

/** Rasterise the cursor sprite at its on-screen scale (cursor.scale × camera
 *  scale): supersampled scanline polygon fill + a distance-field outline
 *  stroke, box-downsampled — matching how the scene draws it (dark body,
 *  2 stage-px white stroke) closely enough for NCC to lock on. */
export function makeCursorTemplate(scale: number): CursorTemplate {
  const pad = 3;
  const width = Math.ceil(12 * scale) + 6 + pad; // polygon extents 12 × 19.5
  const height = Math.ceil(19.5 * scale) + 6 + pad;
  const sW = width * SS;
  const sH = height * SS;
  const pts = CURSOR_POLYGON.map(
    ([x, y]) => [(x * scale + pad / 2) * SS, (y * scale + pad / 2) * SS] as const,
  );

  // even-odd scanline fill at supersample resolution
  const fill = new Float32Array(sW * sH);
  for (let y = 0; y < sH; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[(i + 1) % pts.length]!;
      if (y1 <= yc !== y2 <= yc) xs.push(x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const x1 = Math.min(sW - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = x0; x <= x1; x++) fill[y * sW + x] = 1;
    }
  }

  // outline stroke: the scene draws lineWidth 2 in stage units, so on screen
  // it is ~2·camScale ≈ `scale` px at the shipped cursor.scale of 2 — the
  // same approximation the field-validated prototype used.
  const half = Math.max(2, Math.round(scale * SS)) / 2;
  const strk = new Float32Array(sW * sH);
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % pts.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
    const x1 = Math.min(sW - 1, Math.ceil(Math.max(ax, bx) + half + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
    const y1 = Math.min(sH - 1, Math.ceil(Math.max(ay, by) + half + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        const u = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - u * dx;
        const ey = py - u * dy;
        if (ex * ex + ey * ey <= half * half) strk[y * sW + x] = 1;
      }
    }
  }

  // box-downsample SS× to the final template
  const down = (src: Float32Array): Float32Array => {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let s = 0;
        for (let sy = 0; sy < SS; sy++)
          for (let sx = 0; sx < SS; sx++) s += src[(y * SS + sy) * sW + x * SS + sx]!;
        out[y * width + x] = s / (SS * SS);
      }
    }
    return out;
  };
  const f = down(fill);
  const s = down(strk);
  const pixels = new Float32Array(width * height);
  const mask = new Float32Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const interior = Math.min(1, Math.max(0, f[i]! - s[i]!));
    pixels[i] = interior * BODY_GRAY + s[i]!; // dark body, white outline
    mask[i] = Math.min(1, interior + s[i]!);
  }
  return { width, height, pixels, mask, tip: { x: pad / 2, y: pad / 2 } };
}

/** Masked-NCC search over a ±win px window around the expected tip. Returns
 *  the best score and the tip position it was found at; `found` is absent
 *  only when no template placement fits inside the frame at all. */
export function findCursor(
  frame: GrayFrame,
  expect: Pt,
  scale: number,
  win = SEARCH_WIN_PX,
): { ncc: number; found?: Pt } {
  const tpl = makeCursorTemplate(scale);
  const { width: fw, height: fh, data } = frame;
  // The template vector is constant across placements: hoist the mask index
  // list (as frame-row offsets) and the zero-meaned template values.
  const offs: number[] = [];
  const b: number[] = [];
  for (let ty = 0; ty < tpl.height; ty++) {
    for (let tx = 0; tx < tpl.width; tx++) {
      const j = ty * tpl.width + tx;
      if (tpl.mask[j]! > MASK_MIN) {
        offs.push(ty * fw + tx);
        b.push(tpl.pixels[j]!);
      }
    }
  }
  const n = offs.length;
  if (n < 12) return { ncc: -1 };
  let bMean = 0;
  for (const v of b) bMean += v;
  bMean /= n;
  let db2 = 0;
  for (let j = 0; j < n; j++) {
    b[j] = b[j]! - bMean;
    db2 += b[j]! * b[j]!;
  }
  const db = Math.sqrt(db2);
  if (db < 1e-6) return { ncc: -1 };

  let best = -2;
  let found: Pt | undefined;
  for (let dy = -win; dy <= win; dy++) {
    for (let dx = -win; dx <= win; dx++) {
      const x0 = Math.round(expect.x + dx - tpl.tip.x);
      const y0 = Math.round(expect.y + dy - tpl.tip.y);
      if (x0 < 0 || y0 < 0 || x0 + tpl.width > fw || y0 + tpl.height > fh) continue;
      const base = y0 * fw + x0;
      // Σb = 0, so cov = Σab and var(a) = Σa² − (Σa)²/n — one pass per patch.
      let sa = 0;
      let saa = 0;
      let sab = 0;
      for (let j = 0; j < n; j++) {
        const a = data[base + offs[j]!]!;
        sa += a;
        saa += a * a;
        sab += a * b[j]!;
      }
      const da = Math.sqrt(Math.max(0, saa - (sa * sa) / n));
      const score = da < 1e-6 ? -1 : sab / (da * db);
      if (score > best) {
        best = score;
        found = { x: expect.x + dx, y: expect.y + dy };
      }
    }
  }
  return { ncc: best, found };
}

export type PredictedTip = {
  /** event index */
  beat: number;
  /** sample instant on the composition (capture) timeline, ms */
  sampleMs: number;
  /** the same instant in the DELIVERED video (startMs head trim applied), s */
  tSec: number;
  /** expected cursor-tip position in the finished frame, output px */
  expect: Pt;
  /** camera scale at the sample instant (output px per video px) */
  camScale: number;
  /** the tip is not in the delivered frame (zoomed out of frame, or the head
   *  trim cut the sample) — unverifiable, never an error */
  offscreen: boolean;
};

/** Where the compositor MEANT to draw the pointer tip, per pointer-landing
 *  beat, in finished-frame px — via the engine's own public math, so there is
 *  no second geometry to drift. */
export function predictCursorTips(
  comp: TakeComposition,
  sampleAfterMs = DEFAULT_SAMPLE_AFTER_MS,
): PredictedTip[] {
  const legs = buildLegs(comp);
  const cam = stageCamera(comp);
  const { width: oW, height: oH, fps } = comp.output;
  const startMs = comp.startMs ?? 0;
  const frameMs = 1000 / fps;
  const out: PredictedTip[] = [];
  for (const [beat, e] of comp.events.entries()) {
    if (!e.point) continue; // hand-edited JSON can drop it; nothing to verify then
    if (e.kind === "press" && !e.bbox) continue; // bare press: cursor parked, no target
    // Sample inside the beat's HOLD: after the landing (the ripple has fired,
    // the camera settle is all but done) but before the cursor departs again —
    // the next travel leg, or this beat's own drag stroke. Legs are t0-ordered,
    // so the first departure past tMs is the binding one.
    let sampleMs = e.tMs + sampleAfterMs;
    for (const l of legs) {
      const departMs = l.t0 * 1000;
      // strict >: a rushed succession clamps the next leg's t0 to EXACTLY this
      // landing (math.ts buildLegs), and that departure is still binding — a
      // "+1" grace would sample mid-flight on the skipped leg, converting
      // cursor speed into ~17px of false position error at 60fps.
      if (departMs > e.tMs) {
        sampleMs = Math.min(sampleMs, departMs - frameMs);
        break;
      }
    }
    sampleMs = Math.max(Math.min(sampleMs, comp.durationMs - frameMs), e.tMs);
    const tS = sampleMs / 1000;
    const c = cursorPos(tS, legs, comp); // video px
    const k = cam.at(tS);
    // scene geometry: a video-px point lands at (p − camera center)·scale + out/2
    const expect: Pt = {
      x: (c.x - k.center.x) * k.scale + oW / 2,
      y: (c.y - k.center.y) * k.scale + oH / 2,
    };
    const tSec = (sampleMs - startMs) / 1000;
    const offscreen = tSec < 0 || expect.x < 0 || expect.x >= oW || expect.y < 0 || expect.y >= oH;
    out.push({ beat, sampleMs, tSec, expect, camScale: k.scale, offscreen });
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const signed = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;

/** Turn measured rows into issues (pure — unit-testable without a video). */
export function auditIssues(rows: AuditRow[], tolPx = DEFAULT_TOL_PX): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const offscreen = rows.filter((r) => r.offscreen);
  if (offscreen.length) {
    const names = offscreen
      .map((r) => `events[${r.beat}] (tip at ${r.expect.x.toFixed(0)},${r.expect.y.toFixed(0)})`)
      .join(", ");
    issues.push({
      severity: "warn",
      path: "events",
      message: `${offscreen.length} beat${offscreen.length === 1 ? "" : "s"} cannot be audited — the zoom pushed the expected cursor tip out of the output frame: ${names}`,
      fix: "check those beats by eye; to make them auditable, pull zoom.center toward the pointer or lower zoom.scale so the pointer stays in frame",
    });
  }
  const checked = rows.filter((r) => !r.offscreen && r.ncc != null && r.found);
  const unmatched = checked.filter((r) => (r.ncc ?? -1) < NCC_MATCH_MIN);
  const offsetFails = checked.filter(
    (r) => (r.ncc ?? -1) >= NCC_MATCH_MIN && (r.errViewportPx ?? 0) > tolPx,
  );
  if (!unmatched.length && !offsetFails.length) return issues;
  const parts = [
    ...offsetFails.map(
      (r) =>
        `events[${r.beat}] drawn ${r.errViewportPx!.toFixed(1)}px off (ncc ${r.ncc!.toFixed(2)} — the cursor matched, at the wrong place)`,
    ),
    ...unmatched.map(
      (r) =>
        `events[${r.beat}] never matched (best ncc ${r.ncc!.toFixed(2)} < ${NCC_MATCH_MIN} — no cursor found near the expected tip, so its offset means nothing)`,
    ),
  ];
  // A shared offset across the failing beats is the classic failure (the
  // every-cursor-13%-off release): a renderer↔math transform skew, not
  // per-beat noise — say so, with the measured vector.
  let fix =
    "re-render and re-audit; a repeat means the renderer disagrees with math.cursorPos/stageCamera — the fix is in the renderer, no composition edit moves the drawn cursor";
  if (offsetFails.length >= 2) {
    const vecs = offsetFails.map((r) => {
      const dx = r.found!.x - r.expect.x;
      const dy = r.found!.y - r.expect.y;
      const errOut = Math.hypot(dx, dy);
      const k = errOut > 0 ? (r.errViewportPx ?? 0) / errOut : 0; // output px → viewport px
      return { x: dx * k, y: dy * k };
    });
    const mx = median(vecs.map((v) => v.x));
    const my = median(vecs.map((v) => v.y));
    const spread = Math.max(...vecs.map((v) => Math.hypot(v.x - mx, v.y - my)));
    if (spread <= 2)
      fix = `every failing beat shares one offset ≈ (${signed(mx)}, ${signed(my)}) viewport px — a systematic renderer↔math skew; fix the cursor transform in the renderer and re-render (no composition edit moves the drawn cursor)`;
  }
  issues.push({
    severity: "error",
    path: "events",
    message: `the drawn cursor misses the composition's own intent on ${offsetFails.length + unmatched.length} of ${checked.length} verifiable beats (tolerance ${tolPx}px): ${parts.join("; ")}`,
    fix,
  });
  return issues;
}

/** Decode ONE frame of the delivered mp4 at tSec to raw grayscale pixels,
 *  piped straight from ffmpeg — no image-decoding dependency. */
function extractGrayFrame(
  ffmpeg: string,
  mp4Path: string,
  tSec: number,
  width: number,
  height: number,
): Promise<GrayFrame> {
  return new Promise((res, rej) => {
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-ss",
        tSec.toFixed(4),
        "-i",
        mp4Path,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let errText = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => {
      errText += d;
    });
    child.on("error", rej);
    child.on("close", (code) => {
      const bytes = Buffer.concat(chunks);
      const need = width * height;
      if (code !== 0)
        return rej(
          new Error(
            `ffmpeg exited ${code} extracting the ${tSec.toFixed(2)}s frame from ${mp4Path}${errText.trim() ? `: ${errText.trim()}` : ""}`,
          ),
        );
      // EXACTLY one gray frame: a longer payload means the mp4's true
      // dimensions exceed the composition's — reinterpreting its first
      // oW·oH bytes with the wrong row stride would garble the image and
      // turn every beat into a false "never matched" renderer defect.
      if (bytes.length !== need)
        return rej(
          new Error(
            `ffmpeg returned ${bytes.length} bytes for the ${tSec.toFixed(2)}s frame — expected one ${width}x${height} gray frame (${need} bytes); is ${mp4Path} the delivered render of this composition?`,
          ),
        );
      const data = new Float32Array(need);
      for (let i = 0; i < need; i++) data[i] = bytes[i]! / 255;
      res({ data, width, height });
    });
  });
}

/** Audit the drawn cursor of a delivered mp4 against the composition that
 *  rendered it. One row per pointer-landing beat; issues in the
 *  validateComposition shape ("error" = the render is wrong, "warn" = a beat
 *  the audit cannot see). */
export async function auditCursor(
  comp: TakeComposition,
  mp4Path: string,
  opts: AuditCursorOpts = {},
): Promise<{ rows: AuditRow[]; issues: CompositionIssue[] }> {
  const tolPx = opts.tolPx ?? DEFAULT_TOL_PX;
  const preds = predictCursorTips(comp, opts.sampleAfterMs ?? DEFAULT_SAMPLE_AFTER_MS);
  if (!preds.length)
    // an empty verdict must not read as "audit clean" — nothing was opened,
    // nothing was verified
    return {
      rows: [],
      issues: [
        {
          severity: "warn",
          path: "events",
          message:
            "no pointer-landing beats to audit — the drawn cursor was never verified on this take",
        },
      ],
    };
  const ffmpeg = await resolveFfmpeg();
  const { width: oW, height: oH } = comp.output;
  const rows: AuditRow[] = [];
  for (const p of preds) {
    if (p.offscreen) {
      rows.push({ beat: p.beat, tSec: p.tSec, expect: p.expect, offscreen: true });
      continue;
    }
    const frame = await extractGrayFrame(ffmpeg, mp4Path, p.tSec, oW, oH);
    const { ncc, found } = findCursor(frame, p.expect, comp.cursor.scale * p.camScale);
    if (!found) {
      // every placement in the search window fell off the frame edge — as
      // unverifiable as an offscreen tip, and reported with them
      rows.push({ beat: p.beat, tSec: p.tSec, expect: p.expect, offscreen: true });
      continue;
    }
    const errOutPx = Math.hypot(found.x - p.expect.x, found.y - p.expect.y);
    rows.push({
      beat: p.beat,
      tSec: p.tSec,
      expect: p.expect,
      found,
      errViewportPx: errOutPx / p.camScale,
      ncc,
    });
  }
  return { rows, issues: auditIssues(rows, tolPx) };
}
