// The film clock: the page-side half of `open-take film render`, installed in
// the film's page before any of its own scripts run.
//
// A film is any web page. It either draws itself for a time (`window.__render(t)`,
// t in seconds, any order — the page is a pure function of time) or it simply
// animates: CSS animations and transitions, the Web Animations API, a
// requestAnimationFrame loop, GSAP, three.js, a <video>. For the second kind this
// clock replaces every time source the page can read — performance.now, Date,
// timers, requestAnimationFrame — with film time, and pauses every running
// animation and video so each frame shows exactly the instant asked for. Such a
// page keeps its own state, so it renders front to back (time only moves
// forward); Math.random is seeded so every render worker draws the same numbers.
//
// The renderer drives the page through `window.__ot`:
//   prepare()        → the page's ready promise, fonts, images; what it declared
//   seek(t)          → the page shows film time t (seconds)
//   motion(t, half)  → how far (px) anything visible moves across [t-half, t+half],
//                      and which side of that shutter to expose (one that cuts is left out)
// and, before each draw, sets `window.__filmShare`: the share of the frame's
// shutter that draw stands for (1 when the frame is one draw; 1/n of it, or of
// its half, when it is n samples) — what a page that blurs itself across its
// own shutter exposes, so its samples and the renderer's tile the shutter.
//
// The page may declare itself with `window.__film = { duration, width, height,
// fps, audio, ready, motion, marks }` (every field optional); `motion` speaks
// for what the page draws (a canvas), and the larger of it and how far its
// elements move is the frame's motion. `__duration` and
// `__ready` are read too. `marks` — [{ at, until?, what? }] — are the moments
// the author means to look the way they do (a white flash on the beat): `film
// check` lists what it finds there as marked, not as a defect.
//
// The clock and its canvas matcher are serialized into the page
// (Function#toString): they take anything they need as arguments.

type FilmClockOptions = {
  /** Math.random's seed — the same in every worker */
  seed: number;
  /** what Date says at film time 0 (ms since the epoch) */
  epochMs: number;
};

export type FilmPageInfo = {
  /** "render": the page draws any time on request (window.__render);
   *  "clock": it animates on its own and renders front to back */
  mode: "render" | "clock";
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  audio: string | null;
  /** the page has <audio> elements — they are not recorded */
  audioElements: number;
  /** libraries found running on their own tickers in clock mode */
  tickers: ("GSAP" | "anime.js")[];
  /** window.__film.marks as the page has them (see filmMarks) */
  marks: unknown;
};

/** A moment the author means to look the way it does, in seconds of film
 *  time: `film check` lists what it finds there as marked, not as a defect. */
export type FilmMark = { at: number; until: number; what: string | null };

/** window.__film.marks, checked: a list of { at, until?, what? } in seconds;
 *  a mark without `until` is the moment `at`. */
export function filmMarks(raw: unknown): FilmMark[] {
  if (raw == null) return [];
  const usage = "[{ at: <seconds>, until?: <seconds>, what?: <text> }]";
  if (!Array.isArray(raw)) throw new Error(`film: window.__film.marks is a list — ${usage}`);
  return raw.map((m, i) => {
    const { at, until, what } = (m ?? {}) as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0)
      throw new Error(
        `film: window.__film.marks[${i}].at is the mark's time in seconds — ${usage}`,
      );
    if (until != null && (typeof until !== "number" || !Number.isFinite(until) || until < at))
      throw new Error(
        `film: window.__film.marks[${i}].until is a time in seconds from at (${at}) on — ${usage}`,
      );
    return {
      at,
      until: (until as number | null | undefined) ?? at,
      what: what == null ? null : String(what),
    };
  });
}

type CanvasThumb = { pixels: Uint8Array; width: number; height: number; cutPixels: Uint8ClampedArray };
export type TextCause = { key: string; label: string };

// An eighth of the grey range represents coverage. Opaque black can then
// be followed against a transparent surround.
export function canvasGrey(r: number, g: number, b: number, alpha: number): number {
  return (((77 * r + 150 * g + 29 * b) / 256) * 7 / 8 + 32) * alpha / 255;
}

export function canvasAxisSize(
  width: number, height: number, { a, b, c, d }: Pick<DOMMatrixReadOnly, "a" | "b" | "c" | "d">, zoom: number,
): [number, number] {
  return [width * Math.hypot(a, b) * zoom, height * Math.hypot(c, d) * zoom];
}

export function gsapTickerRunning(gsap: {
  ticker?: { add?: unknown; _listeners?: unknown[]; active?: boolean };
  globalTimeline?: { getChildren?: () => { paused?: () => boolean }[] };
} | undefined): boolean {
  const ticker = gsap?.ticker;
  if (typeof ticker?.add !== "function" || ticker.active === false) return false;
  // GSAP 3 has one internal listener. The timeline is also useful on
  // builds that do not expose their ticker listeners.
  return (ticker._listeners?.length ?? 0) > 1 ||
    gsap?.globalTimeline?.getChildren?.().some((child) => !child.paused?.()) === true;
}

/** The largest credible shift between two grey thumbnails, in CSS px.
 *  Follow textured patches where the picture changed, so still background
 *  cannot outvote a small moving object; take the fastest of them, so a part
 *  that turns or grows while it moves is spaced by its fastest edge. 0 when
 *  nothing changed enough to follow (the caller's own test decides then);
 *  `fallback` when something changed and no patch can be followed. */
export function canvasDisplacement(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  cssWidth: number,
  cssHeight: number,
  fallback = 12,
): number {
  if (!a.some((v, i) => v !== b[i])) return 0;

  // A patch is 7×7 pixels read every other pixel: 16 values. On the
  // 192-pixel thumbnail one pixel is 5 CSS px of a 960-pixel canvas, so a
  // patch spans 35 CSS px — a button's worth, small enough to stay rigid
  // on a part that turns.
  const radius = 3;
  // The plain search reaches 32 pixels (160 CSS px at 960) at every pixel;
  // the wide one 64 at every other pixel, for what it cannot find there.
  const reach = 32;
  const wide = 64;
  const offsets: [number, number][] = [];
  for (let y = -radius; y <= radius; y += 2)
    for (let x = -radius; x <= radius; x += 2) offsets.push([x, y]);
  const n = offsets.length;

  // Where the picture changed and holds texture to follow. 48 over 16 values
  // is 3 grey levels a value: one pixel a level off, or a 4×4 square
  // flickering by 4 levels, stays under it and is no motion (the canvas
  // motion tests). A range of 16 levels is the faintest edge on those tests'
  // disc and pan that the matcher still places to the pixel.
  // At a stride of 5 the 7 px patches overlap by 2, so the test's 6 px
  // disc can still leave an edge in a patch.
  const tiles: { x: number; y: number; score: number; reverse: boolean }[] = [];
  for (let y = radius; y < height - radius; y += 5)
    for (let x = radius; x < width - radius; x += 5) {
      let alo = 255, ahi = 0, blo = 255, bhi = 0, diff = 0;
      for (const [i, j] of offsets) {
        const p = (y + j) * width + x + i;
        const av = a[p]!;
        const bv = b[p]!;
        alo = Math.min(alo, av);
        ahi = Math.max(ahi, av);
        blo = Math.min(blo, bv);
        bhi = Math.max(bhi, bv);
        diff += Math.abs(av - bv);
      }
      const ar = ahi - alo;
      const br = bhi - blo;
      if (!(diff >= 48 && Math.max(ar, br) >= 16)) continue;
      // What moves changes a run of pixels alike — an edge, a texture
      // shifted; grain changes each pixel on its own. The change at each
      // pixel of the patch against its right and lower neighbours: grain's
      // stays under a third of its own size, and it is no motion.
      let dd = 0, dh = 0, dv = 0;
      for (let j = -radius; j <= radius; j++)
        for (let i = -radius; i <= radius; i++) {
          const p = (y + j) * width + x + i;
          const d = a[p]! - b[p]!;
          dd += d * d;
          if (i < radius) dh += d * (a[p + 1]! - b[p + 1]!);
          if (j < radius) dv += d * (a[p + width]! - b[p + width]!);
        }
      if (Math.max(dh, dv) < dd / 2) continue;
      tiles.push({ x, y, score: diff * Math.max(ar, br), reverse: br > ar });
    }
  if (!tiles.length) return 0;
  tiles.sort((l, r) => r.score - l.score);

  const sample = (img: Uint8Array, x: number, y: number): number => {
    const cx = Math.min(width - 1.001, Math.max(0, x));
    const cy = Math.min(height - 1.001, Math.max(0, y));
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const fx = cx - x0, fy = cy - y0;
    const p = y0 * width + x0;
    return (img[p]! * (1 - fx) + img[p + 1]! * fx) * (1 - fy) +
      (img[p + width]! * (1 - fx) + img[p + width + 1]! * fx) * fy;
  };
  const css = (f: { dx: number; dy: number }) =>
    Math.hypot(f.dx * cssWidth / width, f.dy * cssHeight / height);
  // Check a single move over a whole part before using its farthest edge:
  // short patches can match the wrong repeat of a texture when it turns.
  const bounds = (includes: (i: number) => boolean) => {
    let left = width, right = -1, top = height, bottom = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (!includes(y * width + x)) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    return { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2,
      w: right + 1 - left, h: bottom + 1 - top };
  };
  const enclosed = (p: ReturnType<typeof bounds>) => p.left > 0 && p.right < width - 1 &&
    p.top > 0 && p.bottom < height - 1 && p.w >= 2 * radius && p.h >= 2 * radius;
  const bg = a[0]!;
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  const flat = corners.every((i) => a[i] === bg && b[i] === bg);
  const changed = bounds((i) => Math.abs(a[i]! - b[i]!) >= 16);
  const before = flat ? bounds((i) => Math.abs(a[i]! - bg) >= 16) : changed;
  const after = flat ? bounds((i) => Math.abs(b[i]! - bg) >= 16) : changed;
  // A flat surround exposes the two outlines. Against a textured
  // surround we can still check for a turn centred on the changed part.
  const p = enclosed(before) && enclosed(after) ? before : changed;
  const q = p === before ? after : changed;
  if (enclosed(p) && enclosed(q)) {
    const scale = Math.sqrt(q.w * q.h / (p.w * p.h));
    let best = Infinity, bestPx = 0, bestTurn = 0, still = 0, n = 0;
    for (let y = p.top; y <= p.bottom; y += 2)
      for (let x = p.left; x <= p.right; x += 2) {
        still += Math.abs(a[y * width + x]! - b[y * width + x]!);
        n++;
      }
    const fit = (turn: number, scale: number) => {
      const c = scale * Math.cos(turn), s = scale * Math.sin(turn);
      let error = 0, px = 0;
      for (let y = p.top; y <= p.bottom && error < best; y += 2)
        for (let x = p.left; x <= p.right; x += 2) {
          const dx = x - p.x, dy = y - p.y;
          const u = q.x + c * dx - s * dy, v = q.y + s * dx + c * dy;
          const value = a[y * width + x]!;
          error += Math.abs(value - sample(b, u, v));
          if ((p !== changed && Math.abs(value - bg) >= 16) ||
            (p === changed && Math.abs(value - b[y * width + x]!) >= 16))
            px = Math.max(px, css({ dx: u - x, dy: v - y }));
        }
      if (error < best) { best = error; bestPx = px; bestTurn = turn; }
    };
    fit(0, scale);
    let lo = 255, hi = 0;
    for (let y = Math.ceil(p.y - p.h / 4); y <= p.y + p.h / 4; y++)
      for (let x = Math.ceil(p.x - p.w / 4); x <= p.x + p.w / 4; x++) {
        const v = a[y * width + x]!;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    // A plain disc can look better after an arbitrary turn because its
    // edge lands differently on the grid. Require the same 16-level
    // texture range inside it before following a turn. Five degrees
    // moves the 25 px test disc's rim about 2 px.
    if (hi - lo >= 16)
      for (let angle = 5; angle < 360; angle += 5) fit(angle * Math.PI / 180, scale);
    const turn = bestTurn;
    // Quantised edges put the span of the test disc off by up to 2 px.
    const unit = 1 / Math.min(q.w, q.h);
    for (const ds of [-2, -1, 1, 2]) fit(turn, scale * (1 + ds * unit));
    if (bestPx > 0 && best <= Math.min(0.3 * still, n * 9)) return bestPx;
  }
  // A part that turns or grows between the two pictures turns or grows its
  // patches too. Turns of 20° and 40° each way and a growth of 18 % each
  // way: with the interpolation's slack they match turns to about 50°,
  // where a 3D part tumbling at 30 rad/s turns 14° over the half shutter
  // the probe compares at 60 fps.
  const shapes: [number, number][] = [[1, 0]];
  for (const turn of [20, -20, 40, -40]) {
    const r = (turn * Math.PI) / 180;
    shapes.push([Math.cos(r), Math.sin(r)]);
  }
  shapes.push([1.18, 0], [1 / 1.18, 0]);

  const grid = 2 * wide + 1;
  const errors = new Float32Array(grid * grid);
  const at = (dx: number, dy: number) => (dy + wide) * grid + dx + wide;
  // Where the patch of `from` around (x, y) went in `to`, or null.
  // With `home`, only within three pixels of it: the way back.
  const follow = (from: Uint8Array, to: Uint8Array, x: number, y: number,
    home?: { dx: number; dy: number }) => {
    const hx = home ? Math.round(home.dx) : 0, hy = home ? Math.round(home.dy) : 0;
    const patch = offsets.map(([i, j]) => from[(y + j) * width + x + i]!);
    const x0 = Math.max(-wide, radius - x), x1 = Math.min(wide, width - radius - 1 - x);
    const y0 = Math.max(-wide, radius - y), y1 = Math.min(wide, height - radius - 1 - y);
    // shape: [cos·scale, sin·scale] applied to the patch's offsets
    const cost = (dx: number, dy: number, [c, s]: [number, number]): number => {
      let sum = 0;
      if (c === 1 && s === 0) {
        const p = (y + dy) * width + x + dx;
        for (let i = 0; i < n; i++)
          sum += Math.abs(patch[i]! - to[p + offsets[i]![1] * width + offsets[i]![0]]!);
      } else
        for (let i = 0; i < n; i++) {
          const [ox, oy] = offsets[i]!;
          sum += Math.abs(patch[i]! - sample(to, x + dx + c * ox - s * oy, y + dy + s * ox + c * oy));
        }
      return sum;
    };
    // The best place within `span` at every `step` pixels, kept in errors.
    // A stripe or a checker repeats: of the places that match about as well
    // as the best (an eighth and a level a value allow for rounding on
    // the shifted discs), take the nearest
    // one that is a low point of its own, the slower reading of the two.
    const search = (span: number, step: number, shape: [number, number]) => {
      const ylo = Math.max(y0, hy - span), yhi = Math.min(y1, hy + span);
      const xlo = Math.max(x0, hx - span), xhi = Math.min(x1, hx + span);
      const on = (d: number) => step === 1 || d % step === 0;
      let best = Infinity;
      for (let dy = ylo; dy <= yhi; dy++)
        for (let dx = xlo; dx <= xhi; dx++) {
          if (!on(dx) || !on(dy)) continue;
          const e = cost(dx, dy, shape);
          errors[at(dx, dy)] = e;
          best = Math.min(best, e);
        }
      const near = best * 1.125 + n;
      let bx = 0, by = 0, pick = Infinity, pickError = Infinity;
      for (let dy = ylo; dy <= yhi; dy++)
        for (let dx = xlo; dx <= xhi; dx++) {
          if (!on(dx) || !on(dy)) continue;
          const e = errors[at(dx, dy)]!;
          if (e > near) continue;
          let low = true;
          for (let j = -step; j <= step && low; j += step)
            for (let i = -step; i <= step; i += step) {
              const u = dx + i, v = dy + j;
              if ((i || j) && u >= xlo && u <= xhi && v >= ylo && v <= yhi &&
                errors[at(u, v)]! < e) {
                low = false;
                break;
              }
            }
          const d = Math.hypot(dx - hx, dy - hy);
          if (low && (d < pick || (d === pick && e < pickError))) {
            pick = d;
            pickError = e;
            bx = dx;
            by = dy;
          }
        }
      return { best: pickError, bx, by };
    };
    // Credible: it explains most of what changed — a mean error of 9 levels
    // a value where a patch that moved off its place differs by tens on the
    // test pages, and under 0.3 of the error at no shift.
    const credible = (best: number, bx: number, by: number, slack: number) =>
      best <= n * 9 * slack && (!(bx || by) || best <= 0.3 * slack * cost(0, 0, [1, 0]));
    const refine = (lo: number, hi: number, mid: number): number => {
      const bend = lo + hi - 2 * mid;
      return bend > 0 ? Math.max(-0.5, Math.min(0.5, (lo - hi) / (2 * bend))) : 0;
    };
    const plain = search(home ? 3 : reach, 1, [1, 0]);
    if (credible(plain.best, plain.bx, plain.by, 1)) {
      const { best, bx, by } = plain;
      const sx = bx > x0 && bx < x1 ? refine(errors[at(bx - 1, by)]!, errors[at(bx + 1, by)]!, best) : 0;
      const sy = by > y0 && by < y1 ? refine(errors[at(bx, by - 1)]!, errors[at(bx, by + 1)]!, best) : 0;
      return { dx: bx + sx, dy: by + sy };
    }
    // Farther, or turned or grown: every other pixel over the wide reach,
    // then to the pixel around the best of them. These matches blur
    // through interpolation, so they get a third more slack.
    let pick: { best: number; bx: number; by: number; shape: [number, number] } | null = null;
    for (const shape of shapes) {
      // turned or grown within the plain reach, unchanged out to the wide one
      const s = home ? search(3, 1, shape) : search(shape === shapes[0] ? wide : reach, 2, shape);
      if (!credible(s.best, s.bx, s.by, 1.35)) continue;
      const d = Math.hypot(s.bx - hx, s.by - hy);
      const pd = pick ? Math.hypot(pick.bx - hx, pick.by - hy) : Infinity;
      if (d < pd || (d === pd && s.best < pick!.best))
        pick = { ...s, shape };
    }
    if (!pick) return null;
    let { best, bx, by } = pick;
    for (let dy = pick.by - 1; dy <= pick.by + 1; dy++)
      for (let dx = pick.bx - 1; dx <= pick.bx + 1; dx++) {
        if (dx < x0 || dx > x1 || dy < y0 || dy > y1) continue;
        const e = cost(dx, dy, pick.shape);
        if (e < best) {
          best = e;
          bx = dx;
          by = dy;
        }
      }
    return { dx: bx, dy: by };
  };

  const found: { x: number; y: number; dx: number; dy: number; sure: boolean }[] = [];
  // a patch's neighbours that share at most one column or row of its values
  const APART: [number, number][] = [[2 * radius, 0], [-2 * radius, 0], [0, 2 * radius], [0, -2 * radius]];
  const inside = (u: number, v: number) =>
    u >= radius && v >= radius && u < width - radius && v < height - radius;
  // The 12 patches that changed most: more never changed the answer on the
  // test pages and each costs two searches.
  for (const { x, y, reverse } of tiles.slice(0, 12)) {
    const from = reverse ? b : a;
    const to = reverse ? a : b;
    const there = follow(from, to, x, y);
    if (!there) continue;
    // Followed back from where it landed, it must come home within two
    // pixels: a new picture rarely matches both ways.
    const u = Math.round(x + there.dx), v = Math.round(y + there.dy);
    if (!inside(u, v)) continue;
    const back = follow(to, from, u, v, { dx: -there.dx, dy: -there.dy });
    if (!back || Math.hypot(u + back.dx - x, v + back.dy - y) > 2) continue;
    // Grain that changes every frame matches somewhere by chance, and both
    // ways: the same pixels matched back are the same chance. What moved
    // carries its neighbourhood with it — a patch beside it, sharing a
    // column of it at most, lands with it.
    const sure = APART.some(([i, j]) => {
      if (!inside(x + i, y + j)) return false;
      const t = follow(from, to, x + i, y + j);
      return !!t && Math.hypot(t.dx - there.dx, t.dy - there.dy) <= 2;
    });
    const sign = reverse ? -1 : 1;
    found.push({ x, y, dx: sign * there.dx, dy: sign * there.dy, sure });
  }
  // For a shift under half a thumbnail pixel, fitting the frame's grey
  // gradients is steadier than snapping the edges to the patch grid.
  // Downweight residuals over 20 levels: the 0.4 px test disc's hard
  // silhouette can cross a pixel even where its texture moved only a
  // fraction. The small shift explains over 60% of the weighted error.
  if (found.every(({ dx, dy }) => Math.hypot(dx, dy) < radius)) {
    let xx = 0, yy = 0, xy = 0, ex = 0, ey = 0, ee = 0;
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++) {
        const p = y * width + x;
        const e = a[p]! - b[p]!;
        const dx = (b[p + 1]! - b[p - 1]! + a[p + 1]! - a[p - 1]!) / 4;
        const dy = (b[p + width]! - b[p - width]! + a[p + width]! - a[p - width]!) / 4;
        const weight = 1 / Math.max(1, (e / 20) ** 2);
        xx += weight * dx * dx; yy += weight * dy * dy; xy += weight * dx * dy;
        ex += weight * e * dx; ey += weight * e * dy; ee += weight * e * e;
      }
    const det = xx * yy - xy * xy;
    if (det > 0) {
      const dx = (yy * ex - xy * ey) / det;
      const dy = (xx * ey - xy * ex) / det;
      if (Math.hypot(dx, dy) <= 0.5 && dx * ex + dy * ey >= 0.6 * ee)
        return css({ dx, dy });
    }
  }
  // Nothing followed for certain.
  const unfollowed = (): number => {
    // Grain alone — each pixel off on its own, no two neighbours alike — is
    // no motion: 0, and the caller's own test decides.
    let dd = 0, dh = 0, dv = 0;
    for (let y = 0; y < height - 1; y++)
      for (let x = 0; x < width - 1; x++) {
        const p = y * width + x;
        const d = a[p]! - b[p]!;
        dd += d * d;
        dh += d * (a[p + 1]! - b[p + 1]!);
        dv += d * (a[p + width]! - b[p + width]!);
      }
    if (dd > 0 && Math.max(dh, dv) < 0.25 * dd) return 0;
    // A local change in both directions can be a turn that lost its
    // texture between samples. Use the radius of the changed box. A
    // flash or a replacement across the whole canvas keeps the cut signal.
    if (enclosed(changed) && a.some((v, i) => v - b[i]! >= 16) &&
      b.some((v, i) => v - a[i]! >= 16))
      return Math.max(fallback, css({ dx: changed.w / 2, dy: changed.h / 2 }));
    return fallback;
  };
  if (!found.length) return unfollowed();
  // A repeated texture can be followed both ways to the wrong repeat. The
  // fastest patch counts when another moved alike: within two pixels, and
  // half the distance between them up to 12 pixels (two patches apart),
  // which a part turning by up to 29° between the two pictures keeps
  // (2·sin 14.5° = 0.5) — a 3D part tumbling at 30 rad/s turns about 14°
  // over the half-shutter the probe compares at 60 fps.
  // Two patches that overlap share their chance matches too: another
  // counts once it is a patch apart (its values at most a column of these).
  let px = -1;
  for (const f of found)
    if (found.some((g) => g !== f && Math.hypot(f.x - g.x, f.y - g.y) >= 2 * radius &&
      Math.hypot(f.dx - g.dx, f.dy - g.dy) <= 2 + 0.5 * Math.min(12, Math.hypot(f.x - g.x, f.y - g.y))))
      px = Math.max(px, css(f));
  if (px >= 0) return px;
  // Patches that each moved their own way: at least the fixed distance —
  // those found at both ends or beside a neighbour; chance matches in grain
  // are none.
  const sure = found.filter((f) => f.sure);
  if (!sure.length) return unfollowed();
  const alone = sure.map(css).sort((l, r) => l - r);
  // found where they were: they did not move
  if (sure.every((f) => Math.hypot(f.dx, f.dy) < 1)) return alone[alone.length >> 1]!;
  return Math.max(fallback, alone[alone.length >> 1]!);
}

export function filmClockSource(opts: FilmClockOptions): string {
  // a transpiler that keeps function names (tsx/esbuild) calls a module-level
  // `__name` helper inside the body; the page has none, so it gets a no-op
  const helpers = [canvasDisplacement, canvasGrey, canvasAxisSize, gsapTickerRunning]
    .map((fn) => `(${fn.toString()})`).join(", ");
  return `(() => { const __name = (f) => f; (${installFilmClock.toString()})(${JSON.stringify(opts)}, ${helpers}); })();`;
}

function installFilmClock(
  opts: FilmClockOptions,
  displacement: typeof canvasDisplacement,
  grey: typeof canvasGrey,
  axisSize: typeof canvasAxisSize,
  gsapRunning: typeof gsapTickerRunning,
): void {
  // biome-ignore lint/suspicious/noExplicitAny: the page's globals are untyped
  const w = window as any;
  if (w.__ot) return;
  const realSetTimeout = w.setTimeout.bind(w) as typeof setTimeout;
  const RealDate = w.Date as DateConstructor;
  const realPause = HTMLMediaElement.prototype.pause;
  // motion (px) credited to a playing video or a canvas the probe cannot
  // read, and the old canvas-change signal used to choose a shutter side
  const OPAQUE_PX = 12;
  const STEP_MS = 1000 / 60;
  const MAX_JUMP_MS = 10_000;
  // how long the ready wait holds the clock for loading that does not end
  const LOADING_PATIENCE_MS = 10_000;
  // how many times one instant is drawn while new frames keep showing up in it
  const MAX_DRAWS = 32;
  const warn = console.warn.bind(console);

  let now = 0; // the page's clock, ms
  // the timers' own clock: equal to the page's, except while a __render holds
  // its instant — then timers still run in due order and schedule from their
  // own due time (a timer set inside a timer lands after the earlier ones)
  let holding = false;
  let timerNow = 0;
  const schedNow = () => (holding ? timerNow : clock());
  // film time 0 is where the page became ready: a ready promise that waits on
  // a timer advances the page's clock before the film starts
  let base = 0;
  let mode: "render" | "clock" = "clock";
  // A frame inside the film (an <iframe> of a saved screen, say) shows its
  // page as it loaded, on the film's clock. Its timers and animation frames
  // run where the page put it — its first frame, as a browser runs before
  // painting — and not again: what a frame's own script would do later
  // depends on how the film is sought, and what moves inside a frame, the
  // page moves (it is same-origin). Its CSS animations and videos play on
  // film time. While it loads it reads the time it was put on the page;
  // once it shows, the time of the page that holds it (ms on the top page's
  // clock).
  // biome-ignore lint/suspicious/noExplicitAny: the holding page's film clock
  let holder: any = null;
  try {
    const up = w.parent;
    if (up && up !== w && up.__ot) {
      holder = up.__ot;
      now = holder.bornOf(w.frameElement);
      base = holder.origin();
    }
  } catch {
    /* a cross-origin parent: this frame keeps its own clock */
  }
  // whether the page has had its first animation frame (see firstFrame)
  let started = false;
  /** the time this page reads, and plays its animations and videos at */
  const clock = (): number => (holder && started ? holder.clock() : now);
  /** this page, or the page that holds it, draws any moment on request */
  const drawn = (): boolean => mode === "render" || !!holder?.drawn();
  // requestAnimationFrame runs on one grid of film time (see advance): the
  // grid's instants, and the next one to run
  const gridTime = (k: number) => base + (k + 0.5) * STEP_MS;
  const gridAfter = (t: number) => Math.floor((t - base) / STEP_MS - 0.5 + 1e-9) + 1;
  let grid = gridAfter(now);

  // --- inline styles the page sets that do not take ----------------------------
  // `el.style.transform = \`scale(${x})\`` with x NaN, undefined or an object
  // is not CSS: the browser ignores the assignment and the element keeps what
  // it had, silently. Every inline-style setter is wrapped to notice an
  // assignment after which the property does not hold what was set — the
  // value is passed on unchanged, so the page draws exactly as it would — and
  // the first such value for each element and property is kept, with the film
  // time it was set at, for the renderer to name (styleRejects). Reading the
  // property back costs two string reads a set; a value is only parsed again
  // (on a detached declaration, cached) when the property reads the same
  // before and after — set again unchanged, or ignored. cssText, the style
  // attribute and the styles of CSS rules (but their setProperty) are not
  // watched.
  type StyleReject = {
    el: string;
    prop: string;
    value: string;
    kept: string;
    /** "ignored": the property did not take it; "suspect": a custom property
     *  took it as written, but it reads NaN, undefined or [object …] */
    how: "ignored" | "suspect";
    t: number | null;
  };
  let begun = false;
  const rejected: StyleReject[] = [];
  const rejectedSeen = new WeakMap<CSSStyleDeclaration, Set<string>>();
  const SUSPECT = /\bNaN\b|\bundefined\b|\[object [A-Za-z]+\]/;
  const filmT = (): number | null => {
    if (holder) {
      try {
        return (holder.clock() - holder.origin()) / 1000;
      } catch {
        return null;
      }
    }
    return begun ? (now - base) / 1000 : null;
  };
  const noteStyle = (r: StyleReject) => {
    if (rejected.length < 200) rejected.push(r);
  };
  (() => {
    const proto = w.CSSStyleDeclaration?.prototype as CSSStyleDeclaration | undefined;
    if (!proto) return;
    const realGet = proto.getPropertyValue;
    const realSetProperty = proto.setProperty;
    const realRemove = proto.removeProperty;
    // a declaration of its own, taken before `style` hands out proxies
    const scratch = document.createElement("div").style;
    const takesCache = new Map<string, boolean>();
    /** whether a fresh declaration holds `value` for `prop` once it is set */
    const takes = (prop: string, value: string): boolean => {
      const key = `${prop}\n${value}`;
      const known = takesCache.get(key);
      if (known !== undefined) return known;
      realSetProperty.call(scratch, prop, value);
      const ok = realGet.call(scratch, prop) !== "";
      realRemove.call(scratch, prop);
      if (takesCache.size > 4000) takesCache.clear();
      takesCache.set(key, ok);
      return ok;
    };
    // the element each inline declaration belongs to (see the style getter)
    const owners = new WeakMap<CSSStyleDeclaration, Element>();
    /** a short name for the element (or rule) a declaration belongs to */
    const nameOf = (decl: CSSStyleDeclaration): string => {
      const rule = decl.parentRule as CSSStyleRule | null;
      if (rule) return `the rule ${rule.selectorText ?? rule.cssText.slice(0, 60)}`;
      const el = owners.get(decl);
      if (!el) return "an element";
      const one = (e: Element) => {
        let s = e.tagName.toLowerCase();
        if (e.id) return `${s}#${e.id}`;
        const cls = Array.from(e.classList).slice(0, 2);
        if (cls.length) s += `.${cls.join(".")}`;
        const p = e.parentElement;
        if (p) {
          const same = Array.from(p.children).filter((c) => c.tagName === e.tagName);
          if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
        }
        return s;
      };
      const path: string[] = [];
      for (let e: Element | null = el; e && path.length < 3; e = e.parentElement) {
        if (e === document.body || e === document.documentElement) break;
        path.unshift(one(e));
        if (e.id) break;
      }
      return (
        (path.join(" > ") || el.tagName.toLowerCase()) +
        (el.isConnected ? "" : " (not on the page)")
      );
    };
    const check = (
      decl: CSSStyleDeclaration,
      prop: string,
      value: unknown,
      before: string,
      after: string,
    ) => {
      const custom = prop.startsWith("--");
      if (!custom && after !== before) return;
      let seen = rejectedSeen.get(decl);
      if (seen?.has(prop)) return;
      const str = String(value);
      let how: StyleReject["how"];
      if (custom) {
        if (!SUSPECT.test(str)) return;
        how = "suspect";
      } else {
        if (takes(prop, str)) return;
        how = "ignored";
      }
      if (!seen) {
        seen = new Set();
        rejectedSeen.set(decl, seen);
      }
      seen.add(prop);
      const r: StyleReject = { el: nameOf(decl), prop, value: str, kept: before, how, t: filmT() };
      if (holder?.noteStyle) holder.noteStyle(r);
      else noteStyle(r);
    };
    const kebab = (name: string) =>
      name === "cssFloat"
        ? "float"
        : name.includes("-")
          ? name
          : name
              .replace(/^webkit(?=[A-Z])/, "-webkit")
              .replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    const kebabs = new Map<string, string>();
    // the declaration behind a proxy (see the style getter below): a native
    // method called on the proxy itself, `CSSStyleDeclaration.prototype
    // .getPropertyValue.call(el.style, …)`, reaches the declaration
    const targets = new WeakMap<object, CSSStyleDeclaration>();
    const self = (o: CSSStyleDeclaration) => targets.get(o) ?? o;
    for (const name of [
      "getPropertyValue",
      "getPropertyPriority",
      "removeProperty",
      "item",
    ] as const) {
      const real = proto[name] as (...a: unknown[]) => unknown;
      if (typeof real !== "function") continue;
      // biome-ignore lint/suspicious/noExplicitAny: the prototype's own methods
      (proto as any)[name] = function (this: CSSStyleDeclaration, ...a: unknown[]) {
        return real.apply(self(this), a);
      };
    }
    // setProperty, on every declaration
    proto.setProperty = function (
      this: CSSStyleDeclaration,
      ...args: [string, string | null, string?]
    ) {
      const d = self(this);
      const [p, v] = args;
      if (v == null || v === "" || typeof p !== "string") return realSetProperty.apply(d, args);
      const prop = p.startsWith("--") ? p : p.toLowerCase();
      const before = realGet.call(d, prop);
      realSetProperty.apply(d, args);
      const after = realGet.call(d, prop);
      if (after === before || prop.startsWith("--")) check(d, prop, v, before, after);
    };
    // `el.style.transform = …`: Chrome keeps each property on the declaration
    // itself, where no setter can be wrapped. An element's `style` is handed
    // out as a proxy of its declaration — one per declaration, so it is the
    // same object every time — whose set notices a property that did not take;
    // everything else (reads, methods, `in`, keys) reaches the declaration as
    // it is.
    const proxies = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
    const proxyOf = (decl: CSSStyleDeclaration, el: Element): CSSStyleDeclaration => {
      const had = proxies.get(decl);
      if (had) return had;
      owners.set(decl, el);
      const methods = new Map<PropertyKey, unknown>();
      const p = new Proxy(decl, {
        get(t, k) {
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function") return v;
          let m = methods.get(k);
          if (!m || (m as { real?: unknown }).real !== v) {
            const bound = (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(t, a);
            (bound as unknown as { real: unknown }).real = v;
            m = bound;
            methods.set(k, bound);
          }
          return m;
        },
        set(t, k, v) {
          if (
            typeof k !== "string" ||
            k === "cssText" ||
            v == null ||
            v === "" ||
            typeof Reflect.get(t, k, t) !== "string"
          )
            return Reflect.set(t, k, v, t);
          let prop = kebabs.get(k);
          if (prop === undefined) {
            prop = kebab(k);
            kebabs.set(k, prop);
          }
          const before = realGet.call(t, prop);
          const ok = Reflect.set(t, k, v, t);
          const after = realGet.call(t, prop);
          if (after === before) check(t, prop, v, before, after);
          return ok;
        },
      });
      proxies.set(decl, p);
      targets.set(p, decl);
      return p;
    };
    for (const C of [w.HTMLElement, w.SVGElement, w.MathMLElement]) {
      const d = C && Object.getOwnPropertyDescriptor(C.prototype, "style");
      if (!d?.get || !d.configurable) continue;
      const get = d.get;
      Object.defineProperty(C.prototype, "style", {
        ...d,
        get(this: Element) {
          const decl = get.call(this) as CSSStyleDeclaration;
          return decl ? proxyOf(decl, this) : decl;
        },
      });
    }
  })();

  // when each <iframe> and <video> was put on the page: it loads in real
  // time, after the clock has moved on, and must start where it was inserted.
  // Lazy loading waits for a viewport a film never scrolls into, so what is
  // lazy loads at once. Records are drained synchronously after every
  // callback that could insert.
  const inserted = new WeakMap<Element, number>();
  // frames put on the page that have not shown yet (see after), and how many
  // have
  const unshown = new Set<HTMLIFrameElement>();
  let shown = 0;
  const noteInserted = (records: MutationRecord[]) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof Element)) continue;
        const els = Array.from(n.querySelectorAll("iframe,video,img"));
        if (n.matches("iframe,video,img")) els.push(n);
        for (const el of els) {
          if (!(el instanceof HTMLImageElement) && !inserted.has(el)) inserted.set(el, clock());
          if (el instanceof HTMLIFrameElement) unshown.add(el);
          const lazy = el as HTMLImageElement | HTMLIFrameElement;
          if (lazy.loading === "lazy") lazy.loading = "eager";
        }
      }
    }
  };
  const watcher = new MutationObserver(noteInserted);
  watcher.observe(document, { childList: true, subtree: true });
  const drain = () => noteInserted(watcher.takeRecords());

  // an error in the page's own callback fails the render, named, instead of
  // leaving a frame half drawn: rethrown on a clean stack the renderer watches
  const report = (e: unknown) => {
    realSetTimeout(() => {
      throw e;
    }, 0);
  };

  // In a browser every timer and animation-frame callback is a task of its
  // own: the promises it settles run before anything else does, so an `await`
  // resumes at the time its timer was due. A message on the clock's own
  // channel is such a task boundary.
  const channel = new MessageChannel();
  const flushed: (() => void)[] = [];
  channel.port1.onmessage = () => flushed.shift()?.();
  const flush = () =>
    new Promise<void>((ok) => {
      flushed.push(ok);
      channel.port2.postMessage(null);
    });
  /** after each of the page's callbacks: what it settled runs on, at its
   *  time; an animation it started, here or in a frame, runs from then; and a
   *  frame it put on the page loads and shows before the clock moves on */
  async function after(): Promise<void> {
    await flush();
    stamp();
    await showFrames();
  }
  /** animations not seen before start now */
  function stamp(): void {
    drain();
    if (!drawn()) for (const a of document.getAnimations()) if (!born.has(a)) born.set(a, clock());
    for (const f of Array.from(document.querySelectorAll("iframe"))) clockOf(f)?.stamp();
  }

  // --- random: seeded (mulberry32) -----------------------------------------
  let seed = opts.seed >>> 0;
  /** a page that draws any moment on request draws each moment with the same
   *  numbers, whichever worker draws it and in whatever order */
  const reseed = (tSec: number) => {
    let h = (opts.seed ^ Math.round(tSec * 1e6)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    seed = (h ^ (h >>> 16)) >>> 0;
  };
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // --- time sources ---------------------------------------------------------
  performance.now = () => clock();
  class FilmDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(opts.epochMs + clock());
      // biome-ignore lint/suspicious/noExplicitAny: Date's overloads
      else super(...(args as [any]));
    }
    static override now() {
      return opts.epochMs + clock();
    }
  }
  w.Date = FilmDate;

  type Timer = { due: number; fn: unknown; args: unknown[]; every: number };
  const timers = new Map<number, Timer>();
  let nextTimer = 1;
  w.setTimeout = (fn: unknown, delay?: number, ...args: unknown[]) => {
    const id = nextTimer++;
    timers.set(id, { due: schedNow() + Math.max(0, Number(delay) || 0), fn, args, every: 0 });
    return id;
  };
  w.setInterval = (fn: unknown, delay?: number, ...args: unknown[]) => {
    const id = nextTimer++;
    const every = Math.max(1, Number(delay) || 0);
    timers.set(id, { due: schedNow() + every, fn, args, every });
    return id;
  };
  w.clearTimeout = w.clearInterval = (id: number) => {
    timers.delete(id);
  };
  w.requestIdleCallback = (fn: (d: unknown) => void) =>
    w.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0);
  w.cancelIdleCallback = (id: number) => timers.delete(id);

  let frames = new Map<number, (t: number) => void>();
  let nextFrame = 1;
  w.requestAnimationFrame = (fn: (t: number) => void) => {
    const id = nextFrame++;
    frames.set(id, fn);
    return id;
  };
  w.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };

  // --- loading: what the page asked for that is still on its way. Before the
  // film starts the clock moves on only while nothing is (see pump) ----------
  let loading = 0;
  const track = <T>(p: Promise<T>): Promise<T> => {
    loading++;
    const done = () => {
      loading--;
    };
    p.then(done, done);
    return p;
  };
  if (typeof w.fetch === "function") {
    const realFetch = w.fetch.bind(w);
    w.fetch = (...a: unknown[]) => track(realFetch(...a));
  }
  // biome-ignore lint/suspicious/noExplicitAny: the body readers, by name
  const body = Response.prototype as any;
  for (const k of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
    const real = body[k];
    if (typeof real === "function")
      body[k] = function (this: Response, ...a: unknown[]) {
        return track(real.apply(this, a));
      };
  }
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...a: unknown[]) {
    loading++;
    let counted = true;
    const done = () => {
      if (counted) loading--;
      counted = false;
    };
    // added first: a synchronous request ends inside send
    this.addEventListener("loadend", done, { once: true });
    try {
      // biome-ignore lint/suspicious/noExplicitAny: send's one optional body
      return realSend.apply(this, a as any);
    } catch (e) {
      this.removeEventListener("loadend", done);
      done();
      throw e;
    }
  };
  // a body read as a stream counts while each read waits
  // biome-ignore lint/suspicious/noExplicitAny: the stream readers, by name
  const streams: any[] = [
    w.ReadableStreamDefaultReader?.prototype,
    w.ReadableStreamBYOBReader?.prototype,
  ];
  for (const proto of streams) {
    const real = proto?.read;
    if (typeof real === "function")
      proto.read = function (this: unknown, ...a: unknown[]) {
        return track(real.apply(this, a));
      };
  }
  const stream = ReadableStream.prototype;
  const realPipe = stream.pipeTo;
  stream.pipeTo = function (this: ReadableStream, ...a: Parameters<typeof realPipe>) {
    return track(realPipe.apply(this, a));
  };
  for (const k of ["values", Symbol.asyncIterator]) {
    // biome-ignore lint/suspicious/noExplicitAny: the stream's iterator, by name
    const proto = stream as any;
    const real = proto[k];
    if (typeof real !== "function") continue;
    proto[k] = function (this: ReadableStream, ...a: unknown[]) {
      const it = real.apply(this, a);
      const next = it.next.bind(it);
      it.next = () => track(next());
      return it;
    };
  }
  // an image made in script (a texture, say) counts while it loads; the
  // document's own images are looked at directly (see busy)
  for (const k of ["src", "srcset"]) {
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, k);
    const set = d?.set;
    if (!set) continue;
    Object.defineProperty(HTMLImageElement.prototype, k, {
      ...d,
      set(this: HTMLImageElement, v: unknown) {
        set.call(this, v);
        if (this.isConnected || this.complete) return;
        loading++;
        let counted = true;
        const done = () => {
          if (counted) loading--;
          counted = false;
        };
        this.addEventListener("load", done, { once: true });
        this.addEventListener("error", done, { once: true });
      },
    });
  }
  const realDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
    return track(realDecode.call(this));
  };
  if (typeof w.createImageBitmap === "function") {
    const realBitmap = w.createImageBitmap.bind(w);
    w.createImageBitmap = (...a: unknown[]) => track(realBitmap(...a));
  }

  /** run every timer due by `until`, in due order. The clock moves to each
   *  timer's time — unless `hold`: a __render draws one instant, so the timers
   *  it waits on run at that instant (a page reading the clock reads t). */
  async function runTimers(until: number, hold = false): Promise<void> {
    for (let guard = 0; guard < 100_000; guard++) {
      let pickId = 0;
      let pick: Timer | undefined;
      for (const [id, t] of timers)
        if (t.due <= until && (!pick || t.due < pick.due)) {
          pick = t;
          pickId = id;
        }
      if (!pick) return;
      if (hold) timerNow = Math.max(timerNow, pick.due);
      else {
        now = Math.max(now, pick.due);
        // what the callback reads of an animation is where it is at its time
        if (clock() !== syncedAt) syncAnimations();
      }
      if (pick.every) pick.due += pick.every;
      else timers.delete(pickId);
      try {
        if (typeof pick.fn === "function") pick.fn(...pick.args);
        // setTimeout("code") is part of the timer API this clock stands in for
        // biome-ignore lint/complexity/noCommaOperator: an indirect (global) eval, as the browser's own
        // biome-ignore lint/security/noGlobalEval: the page's own string handler, run as the browser would
        else (0, eval)(String(pick.fn));
      } catch (e) {
        report(e);
      }
      await after();
    }
  }

  /** the page's animation frame: its callbacks, then the ones it asked the
   *  frames inside it for (see asked) */
  async function runFrames(only?: (fn: unknown) => boolean, at = clock()): Promise<void> {
    let batch = frames;
    if (only) {
      batch = new Map([...frames].filter(([, fn]) => only(fn)));
      for (const id of batch.keys()) frames.delete(id);
    } else frames = new Map();
    for (const fn of batch.values()) {
      try {
        fn(at);
      } catch (e) {
        report(e);
      }
      await after();
    }
    await eachFrame(async (f) => clockOf(f)?.runAsked(at));
    // what those put on this page shows before the clock moves on, too
    await showFrames();
  }
  // A frame runs its own animation frames only where it was put on the page,
  // but a page may ask one for its next animation frame — to wait until it
  // has drawn, say. Such a callback belongs to the page (it comes from the
  // page's own script, not the frame's) and runs on the page's animation
  // frames, at the page's time.
  const asked = (fn: unknown) => !(fn instanceof w.Function);
  const askedHere = (): boolean =>
    [...frames.values()].some(asked) ||
    Array.from(document.querySelectorAll("iframe")).some((f) => clockOf(f)?.asked());
  /** an animation frame is waited for: the page's own, or one it asked a frame for */
  const framesDue = () => frames.size > 0 || askedHere();

  // --- animations: every one paused and set from film time -------------------
  const born = new WeakMap<Animation, number>();
  let syncedAt = Number.NaN;
  function syncAnimations(): void {
    const t = clock();
    syncedAt = t;
    // a page that draws any moment on request jumps around in time: its
    // animations (and its frames') all run from film time 0. In one that
    // animates on its own an animation runs from the callback that started
    // it, or from where it was first seen; one that started before the film
    // did starts with it
    const fromZero = drawn();
    for (const a of document.getAnimations()) {
      let b = base;
      if (!fromZero) {
        if (!born.has(a)) born.set(a, t);
        b = Math.max(base, born.get(a)!);
      }
      if (a.playState !== "paused") a.pause();
      a.currentTime = Math.max(0, (t - b) * (a.playbackRate || 1));
    }
    for (const svg of Array.from(document.querySelectorAll("svg"))) {
      if (svg.ownerSVGElement) continue;
      if (!svg.querySelector("animate,animateTransform,animateMotion,set")) continue;
      svg.pauseAnimations();
      svg.setCurrentTime((t - base) / 1000);
    }
    // a page that reads a frame's animation reads it at its time too
    for (const f of Array.from(document.querySelectorAll("iframe"))) clockOf(f)?.sync();
  }

  // --- media: a video plays on film time, seeked frame by frame ---------------
  // A video the page plays — or that plays by itself (autoplay), from where it
  // was put on the page — plays on film time: where it is follows from when
  // it started. One the page pauses stays where it was; one the page sets to
  // a time goes there. That place is what the page reads of the video, at
  // once; the element is sought there before a frame is taken (see syncMedia).
  type Media = {
    /** taken over: muted, its own playback stopped (see syncMedia) */
    seen: boolean;
    /** the page has played, paused or set it */
    touched: boolean;
    playing: boolean;
    /** playing: the time it was at 0 */
    born: number;
    /** paused: where it stays */
    at: number;
  };
  const media = new WeakMap<HTMLMediaElement, Media>();
  const mediaOf = (el: HTMLMediaElement): Media => {
    let m = media.get(el);
    if (!m) {
      m = { seen: false, touched: false, playing: false, born: 0, at: Number.NaN };
      media.set(el, m);
    }
    return m;
  };
  // what plays by itself: its autoplay is switched off when it is taken over
  const autoplay = new WeakSet<HTMLMediaElement>();
  /** a video that will play by itself, untouched by the page */
  const autoplays = (el: HTMLMediaElement, m: Media) =>
    !m.seen && !m.touched && (el.autoplay || autoplay.has(el));
  /** how many times a video was loaded: what was asked of it before it was
   *  loaded again (a seek, a frame to show) is not done to what it loads */
  const loads = new WeakMap<HTMLMediaElement, number>();
  /** a video loaded again (load(), a new source) starts over where it is
   *  loaded: at 0, playing by itself from there if it does. One that had
   *  nothing to play keeps playing if the page had played it, as the element
   *  does; one that had something stops. The frame it showed goes with what
   *  it had: it shows what it loads */
  function startOver(el: HTMLMediaElement, hadNothing: boolean): void {
    const playing = hadNothing && !!media.get(el)?.playing;
    media.delete(el);
    loads.set(el, (loads.get(el) ?? 0) + 1);
    seeking.delete(el);
    lastAsked.delete(el);
    unframe(el);
    inserted.set(el, clock());
    // from where it got it — in a film that draws itself, from film time 0,
    // as what plays by itself does there
    if (playing)
      Object.assign(mediaOf(el), { touched: true, playing: true, born: drawn() ? base : clock() });
  }
  const realLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function (this: HTMLMediaElement) {
    startOver(this, this.networkState === HTMLMediaElement.NETWORK_EMPTY);
    return realLoad.call(this);
  };
  // a new source loads it again too — at once, so what the page sets on the
  // video right after applies to the new one; one the element refuses
  // changes nothing (the element's own checks come first)
  const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    ...source,
    set(this: HTMLMediaElement, v: string) {
      const hadNothing = this.networkState === HTMLMediaElement.NETWORK_EMPTY;
      source.set!.call(this, v);
      startOver(this, hadNothing);
    },
  });
  // so does a stream, a MediaSource or a blob given as its source object
  const sourceObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
  if (sourceObject?.set)
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      ...sourceObject,
      set(this: HTMLMediaElement, v: unknown) {
        const hadNothing = this.networkState === HTMLMediaElement.NETWORK_EMPTY;
        sourceObject.set!.call(this, v);
        startOver(this, hadNothing);
      },
    });
  const realSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    const n = `${name}`; // as the element converts it: once, and an error as its own
    const isSource = this instanceof HTMLMediaElement && n.toLowerCase() === "src";
    const hadNothing =
      isSource && (this as HTMLMediaElement).networkState === HTMLMediaElement.NETWORK_EMPTY;
    realSetAttribute.call(this, n, value);
    if (isSource) startOver(this as HTMLMediaElement, hadNothing);
  };
  const realRemoveAttribute = Element.prototype.removeAttribute;
  Element.prototype.removeAttribute = function (this: Element, name: string) {
    const n = `${name}`;
    const isSource =
      this instanceof HTMLMediaElement && n.toLowerCase() === "src" && this.hasAttribute("src");
    const hadNothing =
      isSource && (this as HTMLMediaElement).networkState === HTMLMediaElement.NETWORK_EMPTY;
    realRemoveAttribute.call(this, n);
    if (isSource) startOver(this as HTMLMediaElement, hadNothing);
  };
  /** when a video that plays by itself started: where it was put on the page */
  const autoBorn = (el: HTMLMediaElement) =>
    drawn() ? base : Math.max(base, inserted.get(el) ?? clock());
  /** where a video is on film time; null for one the page has left to itself */
  function position(el: HTMLMediaElement): number | null {
    const m = mediaOf(el);
    const d = el.duration;
    const known = Number.isFinite(d) && d > 0;
    if (!m.playing && !autoplays(el, m)) {
      if (!m.touched || !Number.isFinite(m.at)) return null;
      return Math.max(0, known ? Math.min(m.at, d) : m.at);
    }
    let at = (clock() - (m.playing ? m.born : autoBorn(el))) / 1000;
    if (known) at = el.loop ? at % d : Math.min(at, d - 0.001);
    return Math.max(0, at);
  }
  // a video sought to its frame (below) reads as seeking until that frame is
  // there, as one sought itself does until it has decoded it. Seeks are
  // numbered — the last one asked of each video, and the one to a frame that
  // is under way: a later seek, to a frame or the element's own, ends that
  // one, as the element's own does
  const lastSeek = new WeakMap<HTMLMediaElement, number>();
  const seeking = new WeakMap<HTMLMediaElement, number>();
  let seekCount = 0;
  const realSeeking = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "seeking")!;
  Object.defineProperty(HTMLMediaElement.prototype, "seeking", {
    ...realSeeking,
    get(this: HTMLMediaElement) {
      return seeking.has(this) || realSeeking.get!.call(this);
    },
  });
  const seekTo = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    ...seekTo,
    get(this: HTMLMediaElement) {
      return position(this) ?? seekTo.get!.call(this);
    },
    set(this: HTMLMediaElement, v: number) {
      // a video shown as its frames is not sought: its frame at the new time
      // is shown, and the page told, as a real seek would (see showFrame)
      const virtual =
        this instanceof HTMLVideoElement &&
        asFrame.has(this) &&
        !readers.has(this) &&
        Number.isFinite(Number(v));
      // the element's own checks first: a time it refuses changes nothing
      if (!virtual) seekTo.set!.call(this, v);
      let n = Number(v);
      if (!Number.isFinite(n)) return;
      // as the element does: a time before 0 is 0, one past its end its end
      n = Math.max(0, n);
      if (Number.isFinite(this.duration) && this.duration > 0) n = Math.min(n, this.duration);
      const m = mediaOf(this);
      // a playing video (or one about to play by itself) plays on from there
      if (m.playing || autoplays(this, m)) {
        m.born = clock() - n * 1000;
        m.playing = true;
      } else m.at = n;
      m.touched = true;
      const seek = ++seekCount;
      lastSeek.set(this, seek);
      if (!virtual) seeking.delete(this);
      else {
        // as a real seek does: seeking at once, then seeked once the frame is
        // there — the events in a later task, so a listener added right after
        // the set still hears them. One loaded or sought again in the
        // meantime says no more: loading or a later seek ends it
        const el = this as HTMLVideoElement;
        const load = loads.get(el);
        seeking.set(el, seek);
        realSetTimeout(() => {
          if (loads.get(el) !== load) return;
          el.dispatchEvent(new Event("seeking"));
          void showFrame(el, position(el) ?? n).then((shown) => {
            if (loads.get(el) !== load || lastSeek.get(el) !== seek) return;
            seeking.delete(el);
            // read in the meantime, or its frame did not come: a real seek,
            // which tells the page itself — of the video itself, not the
            // frame it showed
            if (!shown) {
              unframe(el);
              return void seekTo.set!.call(el, n);
            }
            el.dispatchEvent(new Event("timeupdate"));
            el.dispatchEvent(new Event("seeked"));
          });
        }, 0);
      }
    },
  });
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    const m = mediaOf(this);
    if (!m.playing) {
      m.born = clock() - (position(this) ?? seekTo.get!.call(this)) * 1000;
      m.playing = true;
    }
    m.touched = true;
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    const m = mediaOf(this);
    const at = position(this);
    if (at !== null) m.at = at;
    m.playing = false;
    m.touched = true;
    return realPause.call(this);
  };
  // --- a video shown as its frames --------------------------------------------
  // A film-timed <video> is shown as its decoded frame at the film's time —
  // the frame's image as the element's CSS `content`, so the page's own size,
  // fit, corners and transforms all hold — and is not sought: a video element
  // composited under a slow push shimmers, and seeking it for every frame and
  // every motion probe is most of a recorded film's render. The frames come
  // from the renderer (the __otFrames binding, answered by framesReady); a
  // canvas, WebGL or a VideoFrame the page makes of the video gets the frame
  // too. With no renderer to ask (a layout reading), for a source it does not
  // decode (or not in time), or for a video the page reads frame by frame
  // itself (a frame callback, a stream), the element is sought as before.
  type Frames = { base: string; times: number[]; ext: string; bright?: boolean } | null;
  const framesFor = new Map<string, Promise<Frames>>();
  const framesWaiting = new Map<string, (f: Frames) => void>();
  const readers = new WeakSet<HTMLMediaElement>();
  const asFrame = new WeakMap<HTMLMediaElement, string>();
  /** What a video shown as its frames shows: the frame's image, when that
   *  frame starts, and whether the image is brighter than the video decodes
   *  (frames.ts). Kept on the element under a key every page and frame
   *  shares, so the page around a frame reads the frame's videos too. */
  type Shown = { im: HTMLImageElement; at: number; bright: boolean; plain?: HTMLCanvasElement };
  const SHOWN = Symbol.for("open-take frame shown");
  const shownOf = (x: unknown): Shown | null =>
    x !== null && typeof x === "object"
      ? ((x as Record<symbol, Shown | undefined>)[SHOWN] ?? null)
      : null;
  /** show the video itself again */
  function unframe(v: HTMLMediaElement): void {
    if (asFrame.has(v)) {
      v.style.removeProperty("content");
      asFrame.delete(v);
    }
    delete (v as unknown as Record<symbol, unknown>)[SHOWN];
  }
  /** the page reads this video's pixels: it is sought from now on */
  const reads = (v: unknown) => {
    if (!(v instanceof HTMLMediaElement) || readers.has(v)) return;
    readers.add(v);
    unframe(v);
  };
  // Chrome on macOS shows video through Apple's gamma, but hands a canvas
  // the pixels as they decode: a frame written as shown (frames.ts) goes to
  // a canvas with that undone
  let undo: Uint8Array | null = null;
  function pixelsOf(f: Shown): HTMLImageElement | HTMLCanvasElement {
    if (!f.bright || !f.im.naturalWidth) return f.im;
    if (f.plain) return f.plain;
    if (!undo) {
      undo = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        const c = v / 255;
        const light = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        undo[v] = Math.round(255 * light ** (1 / 1.961));
      }
    }
    const c = document.createElement("canvas");
    c.width = f.im.naturalWidth;
    c.height = f.im.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(f.im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      p[i] = undo[p[i]!]!;
      p[i + 1] = undo[p[i + 1]!]!;
      p[i + 2] = undo[p[i + 2]!]!;
    }
    g.putImageData(d, 0, 0);
    f.plain = c;
    return c;
  }
  // where the page reads a video's pixels: a video shown as its frames — here
  // or in a frame inside the page — is handed over as its frame (the same
  // pixels, the same size); one not shown so yet is read as it is, sought as
  // before
  const passFrames = (owner: Record<string, unknown> | undefined, name: string) => {
    const real = owner?.[name];
    if (!owner || typeof real !== "function") return;
    owner[name] = function (this: unknown, ...a: unknown[]) {
      for (let i = 0; i < a.length; i++) {
        const f = shownOf(a[i]);
        if (f) a[i] = pixelsOf(f);
      }
      return (real as (...a: unknown[]) => unknown).apply(this, a);
    };
  };
  // what needs the element's own decoding: a frame callback, a stream
  const needsDecoding = (owner: Record<string, unknown> | undefined, name: string) => {
    const real = owner?.[name];
    if (!owner || typeof real !== "function") return;
    owner[name] = function (this: unknown, ...a: unknown[]) {
      reads(this);
      return (real as (...a: unknown[]) => unknown).apply(this, a);
    };
  };
  for (const ctx of [w.CanvasRenderingContext2D, w.OffscreenCanvasRenderingContext2D])
    passFrames(ctx?.prototype, "drawImage");
  for (const gl of [w.WebGLRenderingContext, w.WebGL2RenderingContext])
    for (const f of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D"])
      passFrames(gl?.prototype, f);
  passFrames(w, "createImageBitmap");
  needsDecoding(w.HTMLVideoElement?.prototype, "requestVideoFrameCallback");
  needsDecoding(w.HTMLMediaElement?.prototype, "captureStream");
  // a VideoFrame of a video shown as its frames holds the frame it shows, at
  // that frame's time unless the page gives one
  if (typeof w.VideoFrame === "function")
    w.VideoFrame = new Proxy(w.VideoFrame, {
      construct(target, args, nt) {
        const f = shownOf(args[0]);
        if (f) {
          const init = (args[1] ?? {}) as { timestamp?: number };
          args = [pixelsOf(f), { ...init, timestamp: init.timestamp ?? Math.round(f.at * 1e6) }];
        }
        return Reflect.construct(target, args, nt);
      },
    });
  // A call from the renderer gives up at 120 s, and a page waits for frames
  // inside one: in all, one call waits for frames at most FRAMES_WAIT_MS (a
  // frame inside the page counts with the page), and a video whose frames
  // have not come by then is sought, that once. One whose answer never comes
  // is sought from then on.
  const FRAMES_WAIT_MS = 75_000;
  let framesUntil = 0;
  /** the real time by which the frames of this call must be there */
  const framesBy = (): number =>
    holder?.framesBy?.() ?? (framesUntil || RealDate.now() + FRAMES_WAIT_MS);
  /** the renderer's answers that have come */
  const answered = new Map<string, Frames>();
  /** the frames of the video at `src`, asked of the renderer once */
  const framesOf = (src: string): Promise<Frames> => {
    let p = framesFor.get(src);
    if (!p) {
      p = new Promise<Frames>((ok) => {
        framesWaiting.set(src, ok);
        realSetTimeout(() => framesReady(src, null), FRAMES_WAIT_MS);
      });
      void p.then((f) => answered.set(src, f));
      framesFor.set(src, p);
      try {
        w.__otFrames(JSON.stringify({ src }));
      } catch {
        framesReady(src, null);
      }
    }
    return p;
  };
  /** the frames of the video at `src`; null when they do not come in time */
  const framesNow = (src: string): Frames | Promise<Frames> =>
    answered.has(src)
      ? (answered.get(src) ?? null)
      : Promise.race([
          framesOf(src),
          new Promise<Frames>((ok) => realSetTimeout(() => ok(null), framesBy() - RealDate.now())),
        ]);
  /** the renderer's answer, passed on to the frames inside the film */
  function framesReady(src: string, f: Frames): void {
    const ok = framesWaiting.get(src);
    framesWaiting.delete(src);
    ok?.(f);
    for (const el of Array.from(document.querySelectorAll("iframe"))) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: another document's globals
        (el.contentWindow as any)?.__ot?.framesReady?.(src, f);
      } catch {
        // another origin: it has no frames of ours to wait for
      }
    }
  }
  /** the frame showing at `t` seconds: the last that starts by then — give
   *  or take the film's own rounding, and no more: a 29.97 fps video's second
   *  frame starts 33 µs after a 30 fps film's */
  const frameAt = (times: number[], t: number): number => {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid]! <= t + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // decoded frames, a few held: the ones shown and the next ones fetched
  // ahead. One that fails, or has not come in 10 s (a service worker of the
  // page's can hold its request), is null — its video is sought — and not
  // kept
  const DECODE_MS = 10_000;
  const decoded = new Map<string, Promise<HTMLImageElement | null>>();
  const decodeFrame = (url: string): Promise<HTMLImageElement | null> => {
    let p = decoded.get(url);
    if (p) decoded.delete(url);
    else {
      const im = new Image();
      im.src = url;
      // one the page's policy refuses, or that does not decode, is null too
      const coming = new Promise<HTMLImageElement | null>((ok) => {
        let done = false;
        realSetTimeout(() => {
          if (done) return;
          done = true;
          im.removeAttribute("src"); // asked no longer
          ok(null);
        }, DECODE_MS);
        im.decode().then(
          () => {
            if (!done) ok(im);
            done = true;
          },
          () => {
            if (!done) ok(null);
            done = true;
          },
        );
      });
      void coming.then((x) => {
        if (!x && decoded.get(url) === coming) decoded.delete(url);
      });
      p = coming;
    }
    decoded.set(url, p);
    while (decoded.size > 8) decoded.delete(decoded.keys().next().value!);
    return p;
  };
  const frameUrl = (f: NonNullable<Frames>, i: number) =>
    `${f.base}${String(i).padStart(6, "0")}.${f.ext}`;
  /** the last frame asked of each video: only it is shown. One asked
   *  earlier that comes later is not — not over a later frame, nor over the
   *  video itself once a later one was not there and it was sought — and
   *  answers as the last one does */
  const lastAsked = new WeakMap<HTMLMediaElement, { n: number; shown: Promise<boolean> }>();
  let askCount = 0;
  /** show the video at `at` seconds as its frame; false when it cannot be,
   *  or when it is read or loaded again while its frame comes — said at once
   *  when there is no frame to show */
  function showFrame(el: HTMLVideoElement, at: number): Promise<boolean> {
    const n = ++askCount;
    const load = loads.get(el);
    const shown = frameOf(el, at).then((frame): boolean | Promise<boolean> => {
      const last = lastAsked.get(el);
      if (last && last.n !== n) return last.shown;
      if (!frame || readers.has(el) || loads.get(el) !== load) return false;
      if (asFrame.get(el) !== frame.url) {
        el.style.setProperty("content", `url("${frame.url}")`, "important");
        asFrame.set(el, frame.url);
      }
      if (shownOf(el)?.im !== frame.shown.im)
        Object.defineProperty(el, SHOWN, {
          value: frame.shown,
          configurable: true,
          writable: true,
        });
      return true;
    });
    lastAsked.set(el, { n, shown });
    return shown;
  }
  /** the video's frame at `at` seconds, decoded; null when it has none: no
   *  renderer to ask, a source that is not a file the page serves (a stream
   *  or a blob as its source object), a video read or loaded again */
  async function frameOf(
    el: HTMLVideoElement,
    at: number,
  ): Promise<{ url: string; shown: Shown } | null> {
    if (typeof w.__otFrames !== "function" || readers.has(el) || el.srcObject) return null;
    const src = el.currentSrc || el.src;
    if (!src?.startsWith(`${location.origin}/`)) return null;
    const load = loads.get(el);
    const f = await framesNow(src);
    if (!f?.times.length || readers.has(el) || loads.get(el) !== load) return null;
    const i = frameAt(f.times, at);
    const url = frameUrl(f, i);
    const im = await decodeFrame(url);
    for (let k = 1; k <= 2 && i + k < f.times.length; k++) void decodeFrame(frameUrl(f, i + k));
    if (!im) return null;
    return { url, shown: { im, at: f.times[i]!, bright: !!f.bright } };
  }
  function seekVideo(el: HTMLVideoElement, at: number): Promise<void> {
    return new Promise((ok) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        el.removeEventListener("seeked", done);
        ok();
      };
      const go = () => {
        el.addEventListener("seeked", done);
        seekTo.set!.call(el, at);
      };
      if (el.readyState >= 1) go();
      else el.addEventListener("loadedmetadata", go, { once: true });
      realSetTimeout(done, 10_000);
    });
  }
  async function syncMedia(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const el of Array.from(document.querySelectorAll("video"))) {
      const m = mediaOf(el);
      if (!m.seen) {
        if (autoplays(el, m)) {
          m.born = autoBorn(el);
          m.playing = true;
          autoplay.add(el);
        }
        m.seen = true;
        el.muted = true;
        el.autoplay = false;
        realPause.call(el);
      }
      // a stream (a MediaStream as its source object) has no film time to
      // seek: it shows what it is sent — waiting on a seek it cannot make
      // cost 10 s an instant. A MediaSource (a worker's handle) is sought
      const object = el.srcObject as { getTracks?: unknown } | null;
      if (object && typeof object.getTracks === "function") continue;
      const at = position(el);
      if (at === null) continue;
      const load = loads.get(el);
      waits.push(
        showFrame(el, at).then((shown) => {
          // loaded again meanwhile: `at` was where the old one was
          if (shown || loads.get(el) !== load) return;
          unframe(el);
          if (Math.abs(seekTo.get!.call(el) - at) > 0.0005 || el.readyState < 2)
            return seekVideo(el, at);
        }),
      );
    }
    await Promise.all(waits);
  }

  async function settle(): Promise<void> {
    await syncMedia();
    const pending = Array.from(document.images).filter((i) => !i.complete);
    if (pending.length)
      await Promise.race([
        Promise.all(pending.map((i) => i.decode().catch(() => {}))),
        new Promise((ok) => realSetTimeout(ok, 15_000)),
      ]);
    if (document.fonts.status !== "loaded")
      await Promise.race([document.fonts.ready, new Promise((ok) => realSetTimeout(ok, 15_000))]);
    await followFrames();
  }

  // same-origin frames on the page: loaded before the frame is taken, and
  // their animations and videos at the film's time
  async function followFrames(): Promise<void> {
    unshown.clear();
    await eachFrame(async (f) => {
      if (await loaded(f)) await clockOf(f)?.follow(base);
    });
  }

  /** frames the page put on it since the last look load and show — their
   *  first frame — before its clock moves on: however the film is sought, a
   *  frame starts at the same moment of the film */
  async function showFrames(): Promise<void> {
    drain(); // what was put here since this page last looked
    while (unshown.size) {
      const fresh = [...unshown];
      unshown.clear();
      await Promise.all(
        fresh.map(async (f) => {
          if (!f.isConnected || !(await loaded(f))) return;
          await clockOf(f)?.follow(base);
          shown++;
        }),
      );
    }
    // one the page put into a frame of its own shows too
    await eachFrame(async (f) => clockOf(f)?.showFrames());
  }
  /** how many frames have shown, here and inside the frames */
  const shownHere = (): number =>
    Array.from(document.querySelectorAll("iframe")).reduce(
      (n, f) => n + (clockOf(f)?.shown() ?? 0),
      shown,
    );

  function eachFrame(fn: (f: HTMLIFrameElement) => Promise<unknown>): Promise<unknown> {
    return Promise.all(Array.from(document.querySelectorAll("iframe")).map(fn));
  }

  /** a frame's own film clock; null when it is cross-origin or has none */
  // biome-ignore lint/suspicious/noExplicitAny: the frame's own film clock
  function clockOf(f: HTMLIFrameElement): any {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: the frame's own film clock
      return (f.contentWindow as any)?.__ot ?? null;
    } catch {
      return null; // cross-origin: not ours to drive
    }
  }

  /** a frame's document is still to come (a frame with a source shows an
   *  empty one until that loads) */
  const awaiting = (f: HTMLIFrameElement, doc: Document) => {
    const src = f.getAttribute("src");
    return (
      doc.readyState !== "complete" ||
      (doc.URL === "about:blank" && (f.hasAttribute("srcdoc") || (!!src && src !== "about:blank")))
    );
  };

  /** wait for a frame's document; false when it is not ours to drive */
  async function loaded(f: HTMLIFrameElement): Promise<boolean> {
    const doc = f.contentDocument; // null when cross-origin
    if (!doc) return false;
    if (awaiting(f, doc))
      await new Promise<void>((ok) => {
        const done = () => ok();
        f.addEventListener("load", done, { once: true });
        realSetTimeout(done, 15_000);
      });
    return !!f.contentDocument;
  }

  /** a frame inside the film, as the page that holds it moves (`origin` is
   *  where film time 0 is): its first frame where it was put on the page,
   *  then its animations and videos at the film's time */
  async function follow(origin: number): Promise<void> {
    base = origin;
    if (!started) await firstFrame();
    syncAnimations();
    await settle();
  }

  /** the page's first animation frame, which a browser runs before it first
   *  paints: where the page becomes ready, or where a frame inside it starts */
  async function firstFrame(): Promise<void> {
    await runTimers(now);
    syncAnimations();
    await runFrames();
    syncAnimations();
    started = true;
  }

  /** when the page's clock has something to run next: a timer, or an
   *  animation frame someone asked for */
  function nextEvent(): number {
    let t = Number.POSITIVE_INFINITY;
    for (const x of timers.values()) t = Math.min(t, x.due);
    if (framesDue()) t = Math.min(t, gridTime(grid));
    return t;
  }

  /** something the page asked for is still on its way: a fetch, an image, a
   *  font, a video's first frame, a frame's document, or the like in a frame */
  function busy(): boolean {
    if (loading > 0 || document.fonts.status === "loading") return true;
    if (Array.from(document.images).some((i) => !i.complete)) return true;
    for (const v of Array.from(document.querySelectorAll("video")))
      if (v.readyState < 2 && v.networkState === v.NETWORK_LOADING) return true;
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      const doc = f.contentDocument;
      if (doc && (awaiting(f, doc) || clockOf(f)?.busy())) return true;
    }
    return false;
  }

  // --- moving time -----------------------------------------------------------
  /** requestAnimationFrame runs 60 times a second of film time, on one grid
   *  from film time 0 — as on a 60 Hz screen — however the film is sought: in
   *  order, between a shutter's samples, or straight from a fresh page, a page
   *  that moves a step a frame is where a browser would have it. The grid
   *  lies halfway between 60 fps frames, so no frame's shutter spans two of
   *  its instants: what a page draws itself in requestAnimationFrame is sharp;
   *  what CSS, the Web Animations API or __render move is blurred. */
  async function advance(to: number): Promise<void> {
    if (to < now - 1e-6)
      throw new Error(
        `film clock: cannot go back from ${((now - base) / 1000).toFixed(3)}s to ${((to - base) / 1000).toFixed(3)}s — ` +
          "this film has no window.__render(t), so it keeps its own state and renders front to back",
      );
    syncAnimations(); // what is on the page now starts now
    for (let g = gridTime(grid); g <= to + 1e-6; g = gridTime(++grid)) {
      await runTimers(g);
      now = g;
      if (framesDue()) {
        syncAnimations();
        await runFrames();
      }
    }
    await runTimers(to);
    now = to;
    syncAnimations();
  }

  /** await a promise the page returned while its timers and frames still run.
   *  Real waiting comes first (a fetch, an image, a font). A promise that waits
   *  on the page's own clock (a timer, an animation frame) would never settle
   *  on a clock that only moves when asked: when real waiting does not settle
   *  it, the clock runs the next thing due — at most MAX_JUMP_MS past where
   *  the wait began.
   *  Before the film starts (`hold` false: the ready wait) the clock moves
   *  with it, but only while nothing the page asked for is still on its way:
   *  however long loading took, the page reaches film time 0 — where it
   *  became ready — in the same state. Inside a __render (`hold` true) the
   *  clock stays at the instant being drawn; timers run in due order on their
   *  own clock. */
  async function pump<T>(p: PromiseLike<T>, hold = false): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    let failed = false;
    Promise.resolve(p).then(
      (v) => {
        settled = true;
        value = v;
      },
      (e) => {
        settled = true;
        failed = true;
        error = e;
      },
    );
    const start = now;
    const began = RealDate.now();
    let impatient = false;
    if (hold) {
      holding = true;
      timerNow = now;
    }
    try {
      for (let i = 0, stepped = false; !settled; i++) {
        if (RealDate.now() - began > 45_000)
          throw new Error(
            "film clock: the page's promise did not settle within 45 s" +
              (document.querySelector("iframe")
                ? " (a frame inside the film runs its own timers and animation frames only where it was put on the page)"
                : ""),
          );
        if (hold) {
          await runTimers(now, true);
          await runFrames();
        } else await advance(now);
        if (settled) break;
        await new Promise((ok) => realSetTimeout(ok, stepped || i < 20 ? 0 : 15));
        stepped = false;
        if (settled || i < 3) continue;
        if (hold) {
          let due = Number.POSITIVE_INFINITY;
          for (const t of timers.values()) due = Math.min(due, t.due);
          if (due - start <= MAX_JUMP_MS) await runTimers(due, true);
        } else {
          const stillLoading = busy();
          if (stillLoading && RealDate.now() - began < LOADING_PATIENCE_MS) continue;
          const next = nextEvent();
          if (next - start <= MAX_JUMP_MS) {
            if (stillLoading && !impatient)
              warn(
                `film clock: the page was still loading after ${LOADING_PATIENCE_MS / 1000} s while it waited on its own clock; its clock went on, so renders of it may start differently`,
              );
            impatient ||= stillLoading;
            await advance(Math.max(now, next));
            await followFrames();
            stepped = true;
          }
        }
      }
    } finally {
      holding = false;
    }
    if (failed) throw error;
    return value as T;
  }

  async function seek(tSec: number): Promise<void> {
    const t = base + tSec * 1000;
    if (mode === "render") {
      now = t;
      // the frames the page draws into have shown before it does (their first
      // frame would otherwise come after what it writes), and are at t — the
      // videos in them too, for a page that draws one; a frame it puts on the
      // page while drawing loads, and the instant is drawn again — into that
      // one too — until no new one shows up
      await showFrames();
      await followFrames();
      syncAnimations();
      for (let pass = 0; ; pass++) {
        if (pass === MAX_DRAWS)
          throw new Error(
            `film clock: drawing ${tSec}s put a new frame on the page ${MAX_DRAWS} times over — draw the same frames for the same t`,
          );
        const before = shownHere();
        reseed(tSec);
        const r = w.__render(tSec);
        if (r && typeof r.then === "function") await pump(r, true);
        drain();
        await showFrames();
        if (shownHere() === before) break;
        syncAnimations();
      }
      syncAnimations();
    } else await advance(t);
    await settle();
  }

  // --- motion: how far anything visible moves over the shutter ---------------
  const thumbCanvas = document.createElement("canvas");
  const CUT_WIDTH = 48;
  const CUT_HEIGHT = 27;
  let thumbCtx: CanvasRenderingContext2D | null = null;
  function readThumb(c: HTMLCanvasElement): CanvasThumb | null {
    if (!c.width || !c.height) return null;
    const scale = Math.min(1, 192 / Math.max(c.width, c.height));
    const width = Math.max(1, Math.round(c.width * scale));
    const height = Math.max(1, Math.round(c.height * scale));
    const stride = Math.max(width, CUT_WIDTH);
    const rows = height + CUT_HEIGHT;
    if (thumbCanvas.width !== stride) thumbCanvas.width = stride;
    if (thumbCanvas.height !== rows) thumbCanvas.height = rows;
    try {
      thumbCtx ??= thumbCanvas.getContext("2d", { willReadFrequently: true });
      if (!thumbCtx) return null;
      thumbCtx.clearRect(0, 0, stride, rows);
      thumbCtx.drawImage(c, 0, 0, width, height);
      // Keep the original 48×27 RGBA comparison for choosing the shutter
      // side. Both drawings share one read back from the thumbnail canvas.
      thumbCtx.drawImage(c, 0, height, CUT_WIDTH, CUT_HEIGHT);
      const data = thumbCtx.getImageData(0, 0, stride, rows).data;
      const pixels = new Uint8Array(width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0, j = 4 * y * stride; x < width; x++, j += 4)
          pixels[y * width + x] = grey(data[j]!, data[j + 1]!, data[j + 2]!, data[j + 3]!);
      const cutPixels = new Uint8ClampedArray(CUT_WIDTH * CUT_HEIGHT * 4);
      for (let y = 0; y < CUT_HEIGHT; y++) {
        const from = 4 * (y + height) * stride;
        cutPixels.set(data.subarray(from, from + CUT_WIDTH * 4), y * CUT_WIDTH * 4);
      }
      return { pixels, width, height, cutPixels };
    } catch {
      thumbCanvas.width = stride; // clears the taint for the next canvas
      return null; // a tainted or lost canvas: counted as moving
    }
  }

  let probing = false;
  const gpuCanvases = new WeakSet<HTMLCanvasElement>();
  const gpuPictures = new WeakMap<HTMLCanvasElement, CanvasThumb | null>();
  type PendingTexture = { texture: object; clearing: boolean };
  let pendingTextures = new WeakMap<object, Map<HTMLCanvasElement, PendingTexture>>();
  // A WebGPU canvas's drawing buffer can be gone by the time an async
  // __render returns. Read it in the task that submitted the draw, before
  // the browser presents it. Keep the first picture for canvases drawn once
  // at load, then read only while probing. The screenshots use the page's
  // own presentation.
  type GPUContext = { canvas: HTMLCanvasElement | OffscreenCanvas };
  type GPUConfig = { device: { queue: object } };
  const contexts = w.GPUCanvasContext?.prototype;
  const queues = w.GPUQueue?.prototype;
  if (contexts && queues) {
    const configure = contexts.configure;
    const unconfigure = contexts.unconfigure;
    const getCurrentTexture = contexts.getCurrentTexture;
    const submit = queues.submit;
    const configured = new WeakMap<GPUContext, object>();
    const forget = (context: GPUContext) => {
      if (!(context.canvas instanceof HTMLCanvasElement)) return;
      const queue = configured.get(context);
      if (queue) pendingTextures.get(queue)?.delete(context.canvas);
      gpuPictures.delete(context.canvas);
    };
    contexts.configure = function (this: GPUContext, config: GPUConfig) {
      configure.call(this, config);
      forget(this);
      configured.set(this, config.device.queue);
      if (this.canvas instanceof HTMLCanvasElement) {
        gpuCanvases.add(this.canvas);
      }
    };
    contexts.unconfigure = function (this: GPUContext) {
      unconfigure.call(this);
      forget(this);
      configured.delete(this);
    };
    contexts.getCurrentTexture = function (this: GPUContext) {
      const texture = getCurrentTexture.call(this);
      const queue = configured.get(this);
      if (queue && this.canvas instanceof HTMLCanvasElement &&
        (probing || !gpuPictures.has(this.canvas))) {
        let wanted = pendingTextures.get(queue);
        if (!wanted) {
          wanted = new Map();
          pendingTextures.set(queue, wanted);
        }
        if (wanted.get(this.canvas)?.texture !== texture)
          wanted.set(this.canvas, { texture, clearing: false });
      }
      return texture;
    };
    queues.submit = function (this: object, commands: Iterable<unknown>) {
      submit.call(this, commands);
      const wanted = pendingTextures.get(this);
      if (!wanted) return;
      // A frame can be drawn in several submits (a clear pass, then the
      // scene loaded over it, then an overlay): read after each one, so the
      // last submit before the browser presents the texture is the picture.
      // Expire only this texture. The next draw can acquire its texture
      // before the timer for the previous one runs.
      for (const [canvas, frame] of wanted) {
        gpuPictures.set(canvas, readThumb(canvas));
        if (frame.clearing) continue;
        frame.clearing = true;
        realSetTimeout(() => {
          if (wanted.get(canvas) === frame) wanted.delete(canvas);
        }, 0);
      }
    };
  }

  function thumb(c: HTMLCanvasElement): CanvasThumb | null {
    return gpuCanvases.has(c) ? (gpuPictures.get(c) ?? null) : readThumb(c);
  }
  type Snapshot = {
    rects: Map<Element, DOMRect>;
    /** what a still element shows — an image's source, a leaf's text: when it
     *  changes, the picture cut there, however small the element */
    shows: Map<Element, string>;
    thumbs: Map<HTMLCanvasElement, CanvasThumb | null>;
    video: boolean;
  };
  function showing(el: Element): string | null {
    // by tag, not instanceof: a saved screen's elements belong to its frame's realm
    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      return img.currentSrc || img.src;
    }
    return el.childElementCount === 0 ? (el.textContent ?? "") : null;
  }
  function snapshot(): Snapshot {
    const vw = innerWidth;
    const vh = innerHeight;
    const rects = new Map<Element, DOMRect>();
    const shows = new Map<Element, string>();
    const thumbs = new Map<HTMLCanvasElement, CanvasThumb | null>();
    let video = false;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (
        r.width < 1 ||
        r.height < 1 ||
        r.right <= 0 ||
        r.bottom <= 0 ||
        r.left >= vw ||
        r.top >= vh
      )
        continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      rects.set(el, r);
      const s = showing(el);
      if (s !== null) shows.set(el, s);
      if (el instanceof HTMLCanvasElement) thumbs.set(el, thumb(el));
      else if (el instanceof HTMLVideoElement && media.get(el)?.playing) video = true;
      else if (el instanceof HTMLIFrameElement) framed(el, r, rects, shows, vw, vh);
    }
    return { rects, shows, thumbs, video };
  }

  /** the elements inside a same-origin frame (a saved screen lifted into the
   *  film), in the film's coordinates — what moves inside it moves on screen */
  function framed(
    f: HTMLIFrameElement,
    box: DOMRect,
    rects: Map<Element, DOMRect>,
    shows: Map<Element, string>,
    vw: number,
    vh: number,
  ): void {
    let doc: Document | null = null;
    try {
      doc = f.contentDocument;
    } catch {
      return; // cross-origin
    }
    if (!doc?.body) return;
    // the frame's own viewport, scaled by whatever transform the film put on it
    const sx = box.width / (f.clientWidth || box.width);
    const sy = box.height / (f.clientHeight || box.height);
    for (const el of Array.from(doc.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const m = new DOMRect(
        box.left + r.left * sx,
        box.top + r.top * sy,
        r.width * sx,
        r.height * sy,
      );
      if (m.right <= Math.max(0, box.left) || m.bottom <= Math.max(0, box.top)) continue;
      if (m.left >= Math.min(vw, box.right) || m.top >= Math.min(vh, box.bottom)) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      rects.set(el, m);
      const s = showing(el);
      if (s !== null) shows.set(el, s);
    }
  }
  type Change = {
    /** the farthest any element that is in both snapshots travelled */
    px: number;
    /** visible area (px²) of elements that are in only one of them */
    churn: number;
    /** elements inside the picture that appeared, vanished or changed what
     *  they show: cuts, however small (one sliding in from an edge is motion) */
    cuts: number;
    /** how far the text that moved at all moved, the median (px): Chrome
     *  draws glyphs on whole device pixels, so text moving under one a frame
     *  steps */
    text: number;
    /** the element at the middle of the moving text speeds */
    textElement: Element | null;
    /** the picture as a whole, fitted to the elements in both: b = s·a + t
     *  (a camera's zoom and pan), from n elements; null with too few */
    view: {
      s: number;
      tx: number;
      ty: number;
      n: number;
      share: number;
      rigid: number;
      who: string;
    } | null;
  };
  /** the zoom and pan that carry most elements from a to b: least squares on
   *  their centres, again without those it fits worst (a cursor, a caption
   *  moving on its own) */
  // the element the fit followed, by where it sits in the page (and the frame
  // it is in): the same in every browser that probes, frame after frame
  const idOf = (el: Element | null): string => {
    if (!el) return "";
    const path: number[] = [];
    let n: Element | null = el;
    while (n) {
      const parent: Element | null = n.parentElement;
      if (parent) path.unshift(Array.prototype.indexOf.call(parent.children, n));
      else {
        const host: Element | null = n.ownerDocument.defaultView?.frameElement ?? null;
        path.unshift(-1);
        n = host;
        continue;
      }
      n = parent;
    }
    return path.join(".");
  };
  function fitView(
    pairs: [number, number, number, number][],
    share: number,
    el: Element | null,
  ): Change["view"] {
    const fit = (ps: [number, number, number, number][]) => {
      const n = ps.length;
      let mx = 0,
        my = 0,
        nx = 0,
        ny = 0;
      for (const [ax, ay, bx, by] of ps) {
        mx += ax;
        my += ay;
        nx += bx;
        ny += by;
      }
      mx /= n;
      my /= n;
      nx /= n;
      ny /= n;
      let num = 0,
        den = 0;
      for (const [ax, ay, bx, by] of ps) {
        num += (ax - mx) * (bx - nx) + (ay - my) * (by - ny);
        den += (ax - mx) ** 2 + (ay - my) ** 2;
      }
      const sc = den > 1e-6 ? num / den : 1;
      return { s: sc, tx: nx - sc * mx, ty: ny - sc * my };
    };
    if (pairs.length < 2) return null;
    let f = fit(pairs);
    const err = (q: [number, number, number, number]) =>
      Math.hypot(f.s * q[0] + f.tx - q[2], f.s * q[1] + f.ty - q[3]);
    const errs = pairs.map(err).sort((x, y) => x - y);
    const cut = Math.max(0.5, errs[Math.floor(errs.length * 0.75)]! * 2);
    const kept = pairs.filter((q) => err(q) <= cut);
    if (kept.length >= 2) f = fit(kept);
    const used = kept.length >= 2 ? kept : pairs;
    // how much of the elements' movement the zoom and pan leave unexplained:
    // 0 for a camera, near 1 for shapes changing on their own
    let res = 0,
      mov = 0;
    for (const q of used) {
      res += (f.s * q[0] + f.tx - q[2]) ** 2 + (f.s * q[1] + f.ty - q[3]) ** 2;
      mov += (q[2] - q[0]) ** 2 + (q[3] - q[1]) ** 2;
    }
    return {
      ...f,
      n: used.length,
      share,
      rigid: mov > 0 ? Math.sqrt(res / mov) : 0,
      who: idOf(el),
    };
  }
  function moved(a: Snapshot, b: Snapshot): Change {
    let px = 0;
    let churn = 0;
    let cuts = 0;
    const text: { px: number; el: Element }[] = [];
    // the largest element that moves: under a camera, the picture itself
    let big: [number, number, number, number][] = [];
    let bigEl: Element | null = null;
    let movingArea = 0;
    const vw = innerWidth;
    const vh = innerHeight;
    const area = (r: DOMRect) =>
      Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left)) *
      Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    const inside = (r: DOMRect) => r.left > 0 && r.top > 0 && r.right < vw && r.bottom < vh;
    for (const [el, ra] of a.rects) {
      const rb = b.rects.get(el);
      if (!rb) {
        churn += area(ra); // vanished: a cut or a fade, not motion
        if (inside(ra)) cuts++;
        continue;
      }
      const shown = a.shows.get(el);
      if (shown !== b.shows.get(el)) cuts++;
      const d = Math.max(
        Math.abs(ra.left - rb.left),
        Math.abs(ra.top - rb.top),
        Math.abs(ra.right - rb.right),
        Math.abs(ra.bottom - rb.bottom),
      );
      if (d > px) px = d;
      // text, not a picture: Chrome resamples an image wherever it lands, and
      // puts glyphs on whole device pixels
      if (shown?.trim() && el.tagName !== "IMG" && d > 1e-4)
        text.push({ px: Math.hypot(ra.left - rb.left, ra.top - rb.top), el });
      // what moves: what holds still (a caption over a moving picture) is not the picture's move
      // its two corners, so that one picture alone (a screenshot past the
      // frame's edges under a zoom) gives the zoom as well as the pan
      if (d > 1e-3) {
        if (area(rb) > movingArea) {
          movingArea = area(rb);
          bigEl = el;
          big = [
            [ra.left, ra.top, rb.left, rb.top],
            [ra.right, ra.bottom, rb.right, rb.bottom],
          ];
        }
      }
    }
    for (const [el, rb] of b.rects)
      if (!a.rects.has(el)) {
        churn += area(rb);
        if (inside(rb)) cuts++;
      }
    if (a.video || b.video) px = Math.max(px, OPAQUE_PX);
    text.sort((l, r) => l.px - r.px);
    const middle = text.length >> 1;
    const upper = text[middle];
    const lower = text[middle - 1];
    const even = text.length % 2 === 0;
    return {
      px,
      churn,
      cuts,
      text: !upper ? 0 : even ? (lower!.px + upper.px) / 2 : upper.px,
      textElement: (even && lower?.px ? lower : upper)?.el ?? null,
      view: fitView(big, Math.min(1, movingArea / (vw * vh)), bigEl),
    };
  }

  // A change on just one side still uses the old fixed-distance signal.
  // The measured displacement is for spacing samples on the chosen span.
  const canvasChanged = (a: CanvasThumb, b: CanvasThumb): boolean => {
    let diff = 0;
    for (let i = 0; i < a.cutPixels.length; i++)
      diff += Math.abs(a.cutPixels[i]! - b.cutPixels[i]!);
    return diff / a.cutPixels.length > 0.5;
  };
  // The canvas's own width and height on screen, along its own axes: its
  // layout box scaled by the transforms on it and its ancestors. The
  // bounding box swaps the two for a canvas turned 90°.
  function drawnSize(el: HTMLCanvasElement, box: DOMRect): [number, number] {
    if (!el.offsetWidth || !el.offsetHeight) return [box.width, box.height];
    let m = new DOMMatrix();
    for (let node: Element | null = el; node; node = node.parentElement) {
      const t = getComputedStyle(node).transform;
      if (t && t !== "none") m = new DOMMatrix(t).multiply(m);
    }
    return axisSize(el.offsetWidth, el.offsetHeight, m, el.currentCSSZoom ?? 1);
  }
  function canvasMotion(a: Snapshot, b: Snapshot, measure: boolean): number {
    let px = 0;
    for (const [el, ta] of a.thumbs) {
      if (!b.thumbs.has(el)) continue;
      const tb = b.thumbs.get(el);
      if (!ta || !tb) {
        px = Math.max(px, OPAQUE_PX);
      } else if (measure) {
        const [cssWidth, cssHeight] = drawnSize(el, b.rects.get(el)!);
        const d = ta.width === tb.width && ta.height === tb.height
          ? displacement(ta.pixels, tb.pixels, ta.width, ta.height, cssWidth, cssHeight)
          : OPAQUE_PX;
        // A change of colour alone can leave the grey thumbnails equal.
        px = Math.max(px, d || (canvasChanged(ta, tb) ? OPAQUE_PX : 0));
      } else if (canvasChanged(ta, tb)) return OPAQUE_PX;
    }
    return px;
  }

  function textLabel(el: Element | null, picture: Snapshot): TextCause | null {
    if (!el) return null;
    const text = (picture.shows.get(el) ?? "").trim().replace(/\s+/g, " ");
    const key = idOf(el);
    const name = el.id ? `#${el.id.replace(/\s+/g, " ").slice(0, 40)}` : ` [${key}]`;
    const label = `${el.tagName.toLowerCase()}${name} "${text.length > 32 ? `${text.slice(0, 31)}…` : text}"`;
    return { key, label };
  }
  /** how far anything moves while the shutter is open, and which part of the
   *  shutter to expose: side 0 all of it, -1 its first half, 1 its second;
   *  and how fast the text that moves there moves, px a second */
  async function motion(
    tSec: number,
    halfSec: number,
  ): Promise<{
    px: number;
    side: number;
    text: number;
    textCause: TextCause | null;
    /** the picture's zoom and pan across the exposed span, as rates: s − 1
     *  and t (px) a second, about the page's top left; null when not fitted */
    view: { ds: number; tx: number; ty: number; share: number; rigid: number; who: string } | null;
  }> {
    // The page's own motion(t, half) says how far its picture moves across
    // [t-half, t+half] (what a canvas draws, which no element shows) in place
    // of the canvas matcher; its elements are still measured, and where the
    // picture cuts is still found here, so a hook never opens the shutter across one.
    const hook = w.__film?.motion;
    const told =
      typeof hook === "function"
        ? async (t: number, half: number) => {
            const px = Number(await hook(t, half));
            return Number.isFinite(px) && px > 0 ? px : 0;
          }
        : null;
    probing = true;
    let a: Snapshot;
    let mid: Snapshot;
    let b: Snapshot;
    try {
      await seek(Math.max(0, tSec - halfSec));
      a = snapshot();
      await seek(tSec);
      mid = snapshot();
      await seek(tSec + halfSec);
      b = snapshot();
    } finally {
      probing = false;
      pendingTextures = new WeakMap();
    }
    // A shutter never straddles a cut: when something changes in one half of
    // the shutter only — it jumps, a large part of the picture appears or
    // vanishes at once, or anything inside the picture appears, vanishes or
    // shows something else — the frame is exposed over the other half alone:
    // no double exposure, and what moves through that half keeps its blur.
    // Motion spreads over both halves.
    const first = moved(a, mid);
    const second = moved(mid, b);
    const screen = innerWidth * innerHeight;
    const firstPx = Math.max(first.px, canvasMotion(a, mid, false));
    const secondPx = Math.max(second.px, canvasMotion(mid, b, false));
    const onlyIn = (x: Change, y: Change, xPx: number, yPx: number) =>
      (xPx > 1 && yPx < 0.1 * xPx) ||
      (x.churn > 0.25 * screen && y.churn < 0.05 * screen) ||
      (x.cuts > 0 && y.cuts === 0);
    // with a hook, it is asked for the half that is exposed
    const quarter = halfSec / 2;
    const rate = (v: Change["view"], sec: number) =>
      v
        ? {
            ds: (v.s - 1) / sec,
            tx: v.tx / sec,
            ty: v.ty / sec,
            share: v.share,
            rigid: v.rigid,
            who: v.who,
          }
        : null;
    const side = onlyIn(first, second, firstPx, secondPx)
      ? 1
      : onlyIn(second, first, secondPx, firstPx) ? -1 : 0;
    const change = side === 1 ? second : side === -1 ? first : moved(a, b);
    const start = side === 1 ? mid : a;
    const end = side === -1 ? mid : b;
    const half = side === 0 ? halfSec : quarter;
    const textCause = change.text > 0 ? textLabel(change.textElement, end) : null;
    return {
      // a hook speaks for what the page draws; its elements outside a canvas
      // are still measured here, and the larger of the two is the motion
      px: Math.max(
        change.px,
        told ? await told(tSec + side * quarter, half) : canvasMotion(start, end, true),
      ),
      side,
      text: change.text / (2 * half),
      textCause,
      view: rate(change.view, 2 * half),
    };
  }

  // --- ready -----------------------------------------------------------------
  async function prepare(): Promise<unknown> {
    // a module page still in a top-level await (a fetch, a font) has declared
    // nothing yet: its length and soundtrack would be read as missing. Wait
    // for it, up to 5 s; a page that declares nothing goes on as before.
    const declared = () =>
      w.__film != null || typeof w.__render === "function" || w.__duration != null;
    if (!declared() && document.querySelector('script[type="module"]')) {
      const began = RealDate.now();
      await pump(
        new Promise<void>((done) => {
          const look = () =>
            declared() || RealDate.now() - began > 5_000 ? done() : w.setTimeout(look, 16);
          look();
        }),
      );
    }
    const film = w.__film ?? {};
    const ready = film.ready ?? w.__ready;
    if (ready) await pump(typeof ready === "function" ? ready() : ready);
    base = now;
    begun = true;
    grid = 0;
    mode = typeof w.__render === "function" ? "render" : "clock";
    if (mode === "clock") await firstFrame();
    await settle();
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    const tickers: FilmPageInfo["tickers"] = [];
    if (mode === "clock") {
      if (gsapRunning(w.gsap)) tickers.push("GSAP");
      // Anime v4's ESM and UMD builds register their engine in AnimeJS.
      // A build that does not expose its engine cannot be identified here.
      if (Array.isArray(w.AnimeJS) && w.AnimeJS.some(
        (entry: { engine?: { reqId?: number } } | null) => !!entry?.engine?.reqId,
      )) tickers.push("anime.js");
    }
    return {
      mode,
      tickers,
      duration: num(film.duration ?? w.__duration),
      width: num(film.width),
      height: num(film.height),
      fps: num(film.fps),
      audio: typeof film.audio === "string" ? film.audio : null,
      audioElements: document.querySelectorAll("audio").length,
      // plain values only, to cross into the renderer; checked there (filmMarks)
      marks: Array.isArray(film.marks)
        ? // biome-ignore lint/suspicious/noExplicitAny: the page's own marks, untyped
          film.marks.map((m: any) => ({ at: m?.at, until: m?.until, what: m?.what }))
        : film.marks == null
          ? null
          : String(film.marks),
    };
  }

  /** a call from the renderer: the frames it waits for count from now */
  const called =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      framesUntil = RealDate.now() + FRAMES_WAIT_MS;
      return fn(...a);
    };
  w.__ot = {
    prepare: called(prepare),
    seek: called(seek),
    motion: called(motion),
    framesReady,
    // --- for the frames inside the film (times in ms on the top page's clock) ---
    framesBy,
    follow,
    stamp,
    showFrames,
    shown: shownHere,
    sync: syncAnimations,
    busy,
    asked: askedHere,
    runAsked: (at: number) => runFrames(asked, at),
    drawn,
    clock,
    origin: () => base,
    // inline styles the page set that did not take (see StyleReject): kept
    // here for the renderer, which drains them; a frame's go to its holder
    noteStyle,
    styleRejects: () => rejected.splice(0),
    // in a page that draws any moment on request, which moment put a frame on
    // the page first depends on the order they were drawn in: its frames
    // start at film time 0
    bornOf: (el: Element | null) => {
      if (drawn()) return base;
      drain();
      return (el && inserted.get(el)) ?? clock();
    },
  };
}
