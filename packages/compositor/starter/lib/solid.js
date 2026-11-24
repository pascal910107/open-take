// solid.js — objects made by code for a film page's 3D shots: a product's
// shell from a distance function, a turned part from a profile, surfaces
// painted by code (brushed, spun, a circuit board), a backdrop, a room's
// light to reflect, and a finish (bloom and a grade) for a lit object on a
// dark ground. No model files and no downloads: what a launch film shows as
// "the thing itself" when the product has no 3D model of its own.
//
// The modelling is abyssal-garden's (MIT, (c) 2026 Maksymilian Dendura,
// github.com/Noniv/abyssal-garden, source/src/math.js and world.js): write a
// signed distance function, sample it on a grid and turn it into a mesh by
// surface nets — smooth unions, cut pockets and repeated grooves come free.
// Measured in Node 22 at product size: a slab with a pocket at 6 mm voxels
// 152 ms (372k triangles); a shroud with a fan well and fins at 8 mm 303 ms
// (284k) — 4 mm took 2.7 s. Make it once, at load.
//
//   import * as THREE from "./kit/three.module.min.js";
//   import { solid, sd } from "./lib/solid.js";
//   const S = solid(THREE);
//   const shell = S.sdf((x, y, z) => sd.smax(sd.roundBox(x, y, z, 300, 20, 120, 12),
//     -sd.cylY(x - 80, y - 20, z, 90, 8), 4), [-310, -30, -130, 310, 30, 130], 3);
//   const disc = S.lathe([[0, 0], [88, 0], [92, 4, 1], [92, 8, 1], [0, 8]], { seg: 256, ribs: 120 });
//   scene.environment = S.room(renderer);         // studio light to reflect, no file
//   scene.environmentIntensity = 0.55;            // start here: at 1 a metal face turned up
//                                                 // mirrors the ceiling's light box as a white disk
//   const spun = S.texture(S.spun(1024));         // a map for bumpMap / roughnessMap
//
//   pure (no three): sd.* — roundBox, box, sphere, cylY, capsule, torus, smin, smax, repeat;
//     sdfMesh(sdf, box, voxel) → { position, normal, index }; latheMesh(profile, o);
//     surfaceNets(D, nx, ny, nz); rng(seed) (anim.js's); vnoise; fbm;
//     brushed / spun / pcb / backdropPaint — pixels drawn on a canvas
//   with three, solid(THREE): sdf(), lathe() → BufferGeometry; texture(canvas, srgb);
//     planarUV(geometry, axes); room(renderer) → a prefiltered environment;
//     backdrop() → a CanvasTexture; finish(renderer, o) → bloom + grade for space.js
//   ready objects, each { group, … } to put in a scene — space.js's scene.add(it) also runs
//   its `tick` at every sample's time and takes its fog:
//     laptop(o) — a keyboard half and a lid on a hinge; `screen` is the group a live slab
//       rides on (st.slab(el, { parent: lap.screen, shadow: false })), `open` the lid's
//       angle, a number or a function of film time
//     desk(o) — a table to stand things on that fades into the scene's ground colour,
//       with a sky light and a sun; `look` (a function of film time) changes them
//     contact(w, d, o) — the soft shadow under a thing standing on the table
//
//   const main = st.scene("main", { clear: (t) => (t < 6 ? 0x2a211b : 0xe9dfcf) });
//   main.add(S.desk({ color: 0x77604c }));
//   const lap = main.add(S.laptop({ screen: [1440, 900], open: (t) => keys(t, [[0, 105], [3, 105], [3.3, 0, "in2"]]) }));
//   const app = st.slab(document.querySelector("#app"), { parent: lap.screen, shadow: false, scale: 2.5 });
//
// The finish: abyssal-garden's chain (Karis-weighted first downsample, a
// six-level bloom, exposure, vignette, the ACES fit, a luminance S-curve,
// highlight desaturation) with its two traps fixed — the bloom's alpha held
// at 1 so additive blending does not multiply it, and no lift of the blacks
// unless asked (`lift`: its warm lift turns a black ground brown). It ends in
// the sRGB curve, where abyssal-garden's grade ends in a plain gamma 2.2:
// a little darker in the deepest shadows. Keep it off an interface: bloom
// lifts white UI into a glare.

import { rng } from "./anim.js";

// --- pure: noise and randomness ---------------------------------------------

/** a seeded random stream, 0..1 (mulberry32), lib/anim.js's: `const r = rng(3); r()` */
export { rng };

/** @param {number} x @param {number} y @param {number} z */
const ihash = (x, y, z) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** @param {number} a @param {number} b @param {number} t */
const mix = (a, b, t) => a + (b - a) * t;
/** @param {number} x @param {number} a @param {number} b */
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** value noise in 3D, 0..1 @param {number} x @param {number} y @param {number} z */
export function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = mix(mix(ihash(ix, iy, iz), ihash(ix + 1, iy, iz), fx), mix(ihash(ix, iy + 1, iz), ihash(ix + 1, iy + 1, iz), fx), fy);
  const b = mix(mix(ihash(ix, iy, iz + 1), ihash(ix + 1, iy, iz + 1), fx), mix(ihash(ix, iy + 1, iz + 1), ihash(ix + 1, iy + 1, iz + 1), fx), fy);
  return mix(a, b, fz);
}

/** fractal value noise, about 0..1 @param {number} x @param {number} y @param {number} z @param {number} [octaves] */
export function fbm(x, y, z, octaves = 4) {
  let a = 0.5, s = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * vnoise(x, y, z);
    x = x * 2.03 + 17.1; y = y * 2.03 + 31.7; z = z * 2.03 + 5.3; a *= 0.5;
  }
  return s / (1 - 2 * a);
}

// --- pure: distance functions -----------------------------------------------

/** Signed distances (negative inside), the usual Inigo Quilez forms, scalar
 *  arguments so a field of millions of samples allocates nothing. Sizes are
 *  half-extents. */
export const sd = {
  /** @param {number} x @param {number} y @param {number} z @param {number} bx @param {number} by @param {number} bz @param {number} r */
  roundBox: (x, y, z, bx, by, bz, r) => {
    const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r, qz = Math.abs(z) - bz + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
  },
  /** @param {number} x @param {number} y @param {number} z @param {number} bx @param {number} by @param {number} bz */
  box: (x, y, z, bx, by, bz) => sd.roundBox(x, y, z, bx, by, bz, 0),
  /** @param {number} x @param {number} y @param {number} z @param {number} r */
  sphere: (x, y, z, r) => Math.hypot(x, y, z) - r,
  /** a cylinder round y, radius r, half-height h @param {number} x @param {number} y @param {number} z @param {number} r @param {number} h */
  cylY: (x, y, z, r, h) => {
    const dx = Math.hypot(x, z) - r, dy = Math.abs(y) - h;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  },
  /** @param {number} x @param {number} y @param {number} z @param {number} ax @param {number} ay @param {number} az @param {number} bx @param {number} by @param {number} bz @param {number} r */
  capsule: (x, y, z, ax, ay, az, bx, by, bz, r) => {
    const pax = x - ax, pay = y - ay, paz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az;
    const h = clamp((pax * bax + pay * bay + paz * baz) / Math.max(1e-12, bax * bax + bay * bay + baz * baz), 0, 1); // a == b: a sphere
    return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
  },
  /** a ring round y: R to the tube's middle, r the tube @param {number} x @param {number} y @param {number} z @param {number} R @param {number} r */
  torus: (x, y, z, R, r) => Math.hypot(Math.hypot(x, z) - R, y) - r,
  /** a smooth union, k the width of the blend (abyssal's polynomial smooth-min; k 0: the plain min) @param {number} a @param {number} b @param {number} k */
  smin: (a, b, k) => { if (!(k > 0)) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; },
  /** a smooth intersection; smax(d, -cut, k) cuts a pocket with a rounded edge (k 0: the plain max) @param {number} a @param {number} b @param {number} k */
  smax: (a, b, k) => { if (!(k > 0)) return Math.max(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; },
  /** a coordinate folded so one shape repeats every `step` (fins, grooves, keys) @param {number} x @param {number} step */
  repeat: (x, step) => x - step * Math.round(x / step),
};

// --- pure: meshes -----------------------------------------------------------

/**
 * Naive surface nets (abyssal-garden math.js): one vertex in each cell the
 * surface crosses, at the mean of the edge crossings; a quad across each
 * crossed edge. D > 0 inside. Positions in grid units. Two surfaces less than
 * a cell apart share a cell's one vertex: the mesh pinches there, its edges
 * shared by more than two triangles — keep separate parts a voxel or two apart.
 * @param {Float32Array} D @param {number} nx @param {number} ny @param {number} nz
 * @returns {{ pos: Float32Array, idx: Uint32Array, nv: number, ni: number }}
 */
export function surfaceNets(D, nx, ny, nz) {
  let pos = new Float32Array(1 << 16), nv = 0;
  let idx = new Uint32Array(1 << 17), ni = 0;
  const sl = nx * ny;
  let cur = new Int32Array(sl), prev = new Int32Array(sl);
  /** @param {number} i */
  const at = (i) => /** @type {number} */ (D[i]);
  /** @param {Int32Array} a @param {number} i */
  const g = (a, i) => /** @type {number} */ (a[i]);
  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      let i0 = nx * (y + ny * z);
      for (let x = 0; x < nx - 1; x++, i0++) {
        const d0 = at(i0), d1 = at(i0 + 1), d2 = at(i0 + nx), d3 = at(i0 + nx + 1);
        const d4 = at(i0 + sl), d5 = at(i0 + sl + 1), d6 = at(i0 + sl + nx), d7 = at(i0 + sl + nx + 1);
        const m = (+(d0 > 0)) | (+(d1 > 0) << 1) | (+(d2 > 0) << 2) | (+(d3 > 0) << 3) | (+(d4 > 0) << 4) | (+(d5 > 0) << 5) | (+(d6 > 0) << 6) | (+(d7 > 0) << 7);
        if (m === 0 || m === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0, t;
        if ((d0 > 0) !== (d1 > 0)) { t = d0 / (d0 - d1); sx += t; n++; }
        if ((d2 > 0) !== (d3 > 0)) { t = d2 / (d2 - d3); sx += t; sy += 1; n++; }
        if ((d4 > 0) !== (d5 > 0)) { t = d4 / (d4 - d5); sx += t; sz += 1; n++; }
        if ((d6 > 0) !== (d7 > 0)) { t = d6 / (d6 - d7); sx += t; sy += 1; sz += 1; n++; }
        if ((d0 > 0) !== (d2 > 0)) { t = d0 / (d0 - d2); sy += t; n++; }
        if ((d1 > 0) !== (d3 > 0)) { t = d1 / (d1 - d3); sy += t; sx += 1; n++; }
        if ((d4 > 0) !== (d6 > 0)) { t = d4 / (d4 - d6); sy += t; sz += 1; n++; }
        if ((d5 > 0) !== (d7 > 0)) { t = d5 / (d5 - d7); sy += t; sx += 1; sz += 1; n++; }
        if ((d0 > 0) !== (d4 > 0)) { t = d0 / (d0 - d4); sz += t; n++; }
        if ((d1 > 0) !== (d5 > 0)) { t = d1 / (d1 - d5); sz += t; sx += 1; n++; }
        if ((d2 > 0) !== (d6 > 0)) { t = d2 / (d2 - d6); sz += t; sy += 1; n++; }
        if ((d3 > 0) !== (d7 > 0)) { t = d3 / (d3 - d7); sz += t; sx += 1; sy += 1; n++; }
        if (nv * 3 + 3 > pos.length) { const p2 = new Float32Array(pos.length * 2); p2.set(pos); pos = p2; }
        const vi = nv++;
        pos[vi * 3] = x + sx / n; pos[vi * 3 + 1] = y + sy / n; pos[vi * 3 + 2] = z + sz / n;
        const ci = x + nx * y;
        cur[ci] = vi;
        if (ni + 18 > idx.length) { const i2 = new Uint32Array(idx.length * 2); i2.set(idx); idx = i2; }
        const s0 = d0 > 0;
        /** @param {number} a @param {number} b @param {number} c @param {number} d */
        const quad = (a, b, c, d) => {
          if (s0) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
          else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
        };
        if ((d1 > 0) !== s0 && y > 0 && z > 0) quad(vi, g(cur, ci - nx), g(prev, ci - nx), g(prev, ci));
        if ((d2 > 0) !== s0 && x > 0 && z > 0) quad(vi, g(prev, ci), g(prev, ci - 1), g(cur, ci - 1));
        if ((d4 > 0) !== s0 && x > 0 && y > 0) quad(vi, g(cur, ci - 1), g(cur, ci - 1 - nx), g(cur, ci - nx));
      }
    }
    const tmp = cur; cur = prev; prev = tmp;
  }
  return { pos: pos.subarray(0, nv * 3), idx: idx.subarray(0, ni), nv, ni };
}

/**
 * Any distance function → a mesh: sampled every `voxel` over `box`
 * ([x0, y0, z0, x1, y1, z1], scene units), surface nets, normals from the
 * field's gradient (smooth across the grid's facets). Detail below about two
 * voxels is lost: a fin 0.8 mm thick wants voxels under 8 mm; type and screws
 * belong in a texture.
 * @param {(x: number, y: number, z: number) => number} f negative inside
 * @param {number[]} box @param {number} voxel
 * @returns {{ position: Float32Array, normal: Float32Array, index: Uint32Array, voxels: number, triangles: number }}
 */
export function sdfMesh(f, box, voxel) {
  const [x0 = 0, y0 = 0, z0 = 0, x1 = 1, y1 = 1, z1 = 1] = box;
  const vs = voxel;
  const nx = Math.ceil((x1 - x0) / vs) + 3, ny = Math.ceil((y1 - y0) / vs) + 3, nz = Math.ceil((z1 - z0) / vs) + 3;
  const ox = x0 - vs, oy = y0 - vs, oz = z0 - vs;
  const D = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) D[x + nx * (y + ny * z)] = -f(ox + x * vs, oy + y * vs, oz + z * vs);
  const sn = surfaceNets(D, nx, ny, nz);
  /** trilinear sample of the grid @param {number} x @param {number} y @param {number} z */
  const smp = (x, y, z) => {
    x = clamp(x, 0, nx - 1.001); y = clamp(y, 0, ny - 1.001); z = clamp(z, 0, nz - 1.001);
    const ix = x | 0, iy = y | 0, iz = z | 0, fx = x - ix, fy = y - iy, fz = z - iz;
    const i = ix + nx * (iy + ny * iz), sl = nx * ny;
    const d = (/** @type {number} */ k) => /** @type {number} */ (D[k]);
    const a = mix(mix(d(i), d(i + 1), fx), mix(d(i + nx), d(i + nx + 1), fx), fy);
    const b = mix(mix(d(i + sl), d(i + sl + 1), fx), mix(d(i + sl + nx), d(i + sl + nx + 1), fx), fy);
    return mix(a, b, fz);
  };
  const P = new Float32Array(sn.nv * 3), N = new Float32Array(sn.nv * 3), e = 0.7;
  for (let k = 0; k < sn.nv; k++) {
    const x = /** @type {number} */ (sn.pos[k * 3]), y = /** @type {number} */ (sn.pos[k * 3 + 1]), z = /** @type {number} */ (sn.pos[k * 3 + 2]);
    const ax = smp(x - e, y, z) - smp(x + e, y, z), ay = smp(x, y - e, z) - smp(x, y + e, z), az = smp(x, y, z - e) - smp(x, y, z + e);
    const l = Math.hypot(ax, ay, az) || 1;
    P[k * 3] = ox + x * vs; P[k * 3 + 1] = oy + y * vs; P[k * 3 + 2] = oz + z * vs;
    N[k * 3] = ax / l; N[k * 3 + 1] = ay / l; N[k * 3 + 2] = az / l;
  }
  return { position: P, normal: N, index: new Uint32Array(sn.idx), voxels: nx * ny * nz, triangles: sn.ni / 3 };
}

/**
 * A turned part: a profile [[r, y, ribs?], …] (bottom to top) swept round y.
 * `ribs` grooves round it, `ribAmp` their depth as a share of r; the third
 * value of a ring says how much of the ribs it takes (0 none … 1 all), so a
 * coin's reeding sits on its edge only. `lump` roughens the radius by noise.
 * @param {number[][]} profile
 * @param {{ seg?: number, ribs?: number, ribAmp?: number, lump?: number }} [o]
 * @returns {{ position: Float32Array, uv: Float32Array, index: Uint32Array }}
 */
export function latheMesh(profile, { seg = 128, ribs = 0, ribAmp = 0.02, lump = 0 } = {}) {
  const rings = profile.length, cols = seg + 1;
  const P = new Float32Array(rings * cols * 3), UV = new Float32Array(rings * cols * 2);
  profile.forEach(([r = 0, y = 0, rw = ribs ? 1 : 0], k) => {
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const rl = r * (1 + lump * (fbm(Math.cos(a) * 1.5 + y * 2, y * 3, Math.sin(a) * 1.5, 2) - 0.5) + (ribs ? ribAmp * rw * Math.cos(ribs * a) : 0));
      const o = (k * cols + s) * 3;
      P[o] = Math.cos(a) * rl; P[o + 1] = y; P[o + 2] = Math.sin(a) * rl;
      UV[(k * cols + s) * 2] = s / seg; UV[(k * cols + s) * 2 + 1] = rings > 1 ? k / (rings - 1) : 0;
    }
  });
  const I = new Uint32Array((rings - 1) * seg * 6);
  let n = 0;
  for (let k = 0; k < rings - 1; k++) for (let s = 0; s < seg; s++) {
    const a = k * cols + s, b = (k + 1) * cols + s;
    I[n++] = a; I[n++] = b; I[n++] = a + 1; I[n++] = a + 1; I[n++] = b; I[n++] = b + 1;
  }
  return { position: P, uv: UV, index: I };
}

// --- surfaces painted by code (a canvas; three not needed) -----------------

/** @param {number} w @param {number} h */
function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return { c, g: /** @type {CanvasRenderingContext2D} */ (c.getContext("2d")) };
}
/** a grey picture from f(x, y) → 0..1 @param {number} w @param {number} h @param {(x: number, y: number) => number} f */
export function paint(w, h, f) {
  const { c, g } = canvasOf(w, h);
  const im = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = clamp(f(x, y), 0, 1) * 255, o = (x + w * y) * 4;
    im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}
/** brushed metal: long streaks along x — a bumpMap or roughnessMap @param {number} [w] @param {number} [h] */
export const brushed = (w = 1024, h = 512) =>
  paint(w, h, (x, y) => 0.5 + 0.32 * (vnoise(x * 0.004, y * 0.9, 1) - 0.5) + 0.18 * (vnoise(x * 0.02, y * 3.1, 7) - 0.5));
/** spun metal: fine rings round the middle (a fan hub, a lid, a knob) @param {number} [size] */
export const spun = (size = 1024) =>
  paint(size, size, (x, y) => { const r = Math.hypot(x - size / 2, y - size / 2); return 0.5 + 0.35 * (vnoise(r * 0.9, 0, 3) - 0.5) + 0.25 * (vnoise(r * 0.15, 5, 1) - 0.5); });

/**
 * A circuit board's face: traces leaving a package's edge, bending 45°,
 * ending on vias; gold edge fingers; silkscreen boxes. A colour map.
 * @param {{ width?: number, height?: number, seed?: number, traces?: number, board?: string, copper?: string }} [o]
 */
export function pcb({ width = 2048, height = 1024, seed = 31, traces = 420, board = "#15191d", copper = "196,150,62" } = {}) {
  const { c, g } = canvasOf(width, height), r = rng(seed), rr = (/** @type {number} */ a, /** @type {number} */ b) => a + (b - a) * r();
  g.fillStyle = board; g.fillRect(0, 0, width, height);
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(40,70,60,${rr(0.05, 0.2)})`; g.fillRect(rr(0, width), rr(0, height), rr(2, 30), rr(2, 30)); }
  const cx = width * 0.5, cy = height * 0.47, hw = width * 0.146, hh = height * 0.234;
  g.lineCap = "round"; g.lineJoin = "round";
  for (let i = 0; i < traces; i++) {
    const side = i % 4, s = rr(-1, 1), out = rr(40, 600);
    let x = side < 2 ? cx + (side ? 1 : -1) * hw : cx + s * hw, y = side < 2 ? cy + s * hh : cy + (side === 2 ? 1 : -1) * hh;
    const dx = side === 0 ? -1 : side === 1 ? 1 : 0, dy = side === 2 ? 1 : side === 3 ? -1 : 0, bend = r() < 0.5 ? -1 : 1;
    g.strokeStyle = r() < 0.8 ? `rgba(${copper},${rr(0.55, 0.95)})` : "rgba(150,160,170,.6)"; g.lineWidth = rr(1.5, 4.5);
    g.beginPath(); g.moveTo(x, y); x += dx * out; y += dy * out; g.lineTo(x, y);
    const l2 = rr(20, 300); x += (dx || bend) * l2 * 0.7; y += (dy || bend) * l2 * 0.7; g.lineTo(x, y);
    x += dx * rr(20, 400); y += dy * rr(20, 400); g.lineTo(x, y); g.stroke();
    g.fillStyle = "#d8b060"; g.beginPath(); g.arc(x, y, rr(3, 7), 0, 6.283); g.fill();
  }
  g.fillStyle = "#d4a94e"; for (let i = 0; i < 60; i++) g.fillRect(140 + i * 29, height - 70, 18, 62);
  g.strokeStyle = "rgba(230,230,230,.5)"; g.lineWidth = 2;
  for (let i = 0; i < 70; i++) g.strokeRect(rr(60, width - 120), rr(60, height - 160), rr(20, 70), rr(14, 40));
  return c;
}

/**
 * A backdrop painted once at load: domain-warped fractal noise with ridged
 * veins, three colours from deep to bright, a little grain — soft enough to
 * sit behind windows out of focus. `colors` [deep, mid, vein] as [r, g, b].
 * @param {{ width?: number, height?: number, seed?: number, colors?: number[][], scale?: number }} [o]
 */
export function backdropPaint({ width = 1280, height = 720, seed = 7, colors = [[18, 30, 52], [44, 84, 112], [120, 178, 205]], scale = 1 } = {}) {
  const { c, g } = canvasOf(width, height), r = rng(seed);
  const im = g.createImageData(width, height), d = im.data;
  const [c0 = [0, 0, 0], c1 = [0, 0, 0], c2 = [0, 0, 0]] = colors;
  const ox = seed * 13.7;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x / width) * 7 * scale + ox, v = (y / height) * 4 * scale;
    const wx = u + 1.6 * fbm(u * 0.6 + 3, v * 0.6, 0.5, 3), wy = v + 1.6 * fbm(u * 0.6, v * 0.6 + 9, 0.5, 3);
    const f = fbm(wx, wy, 1.5, 5);
    const ridge = 1 - Math.abs(2 * fbm(wx * 1.3 + 4, wy * 1.3 + 2, 2.5, 4) - 1);
    const vein = ridge ** 10 * 0.85;
    const grain = (r() - 0.5) * 10;
    const k = (y * width + x) * 4;
    for (let ch = 0; ch < 3; ch++) {
      const a = /** @type {number} */ (c0[ch]), b = /** @type {number} */ (c1[ch]), e = /** @type {number} */ (c2[ch]);
      d[k + ch] = clamp(a + (b - a) * f * 1.4 + (e - a) * vein + grain, 0, 255);
    }
    d[k + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

// --- with three -------------------------------------------------------------

/**
 * The parts that need three: geometry, textures, light, the finish.
 * @param {any} T the three module the page imported
 */
export function solid(T) {
  if (!T) throw new Error("solid: needs three — solid(THREE)");

  /** @param {{ position: Float32Array, normal?: Float32Array, uv?: Float32Array, index: Uint32Array }} m */
  function geometry(m) {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(m.position, 3));
    if (m.normal) g.setAttribute("normal", new T.BufferAttribute(m.normal, 3));
    if (m.uv) g.setAttribute("uv", new T.BufferAttribute(m.uv, 2));
    g.setIndex(new T.BufferAttribute(m.index, 1));
    if (!m.normal) g.computeVertexNormals();
    return g;
  }

  /** uv from two axes' extents, for a map on a face made by sdf()
   *  @param {any} g @param {[number, number, number, number]} ext [a0, b0, a1, b1] @param {"xz" | "xy" | "zy"} [axes] */
  function planarUV(g, ext, axes = "xz") {
    const p = g.attributes.position, uv = new Float32Array(p.count * 2);
    const [a0, b0, a1, b1] = ext;
    for (let i = 0; i < p.count; i++) {
      const a = axes === "zy" ? p.getZ(i) : p.getX(i), b = axes === "xy" || axes === "zy" ? p.getY(i) : p.getZ(i);
      uv[i * 2] = (a - a0) / (a1 - a0); uv[i * 2 + 1] = (b - b0) / (b1 - b0);
    }
    g.setAttribute("uv", new T.BufferAttribute(uv, 2));
    return g;
  }

  // --- ready objects ---

  /** a rounded rectangle lying flat as a plate: x and z about its middle, y from 0 up to h
   *  @param {number} w @param {number} d @param {number} h @param {number} r */
  function plate(w, d, h, r) {
    const sh = new T.Shape(), x = -w / 2, y = -d / 2, rr = Math.min(r, w / 2, d / 2);
    sh.moveTo(x + rr, y); sh.lineTo(x + w - rr, y); sh.quadraticCurveTo(x + w, y, x + w, y + rr);
    sh.lineTo(x + w, y + d - rr); sh.quadraticCurveTo(x + w, y + d, x + w - rr, y + d);
    sh.lineTo(x + rr, y + d); sh.quadraticCurveTo(x, y + d, x, y + d - rr);
    sh.lineTo(x, y + rr); sh.quadraticCurveTo(x, y, x + rr, y);
    // a small bevel, so the edge catches the light as one line
    const b = Math.min(1.2, h / 4);
    const g = new T.ExtrudeGeometry(sh, { depth: h - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 2, curveSegments: 10 });
    g.translate(0, 0, b);
    g.rotateX(-Math.PI / 2);
    return { geometry: g, shape: sh };
  }

  /**
   * The soft shadow under a thing standing on a table: a blurred dark card
   * lying flat at y 0, a little bigger than the w × d footprint it is for.
   * Not cast by any light — it is there whatever the lights do, as the
   * darkest part of a contact shadow is.
   * @param {number} w @param {number} d
   * @param {{ blur?: number, opacity?: number, radius?: number, color?: string }} [o] blur: px of the footprint (60)
   */
  function contact(w, d, { blur = 60, opacity = 0.6, radius = 60, color = "0,0,0" } = {}) {
    // drawn at a quarter size: it is a blur, and four times the pixels show nothing more
    const k = 0.25, pad = blur * 3;
    const { c, g } = canvasOf(Math.ceil((w + pad * 2) * k), Math.ceil((d + pad * 2) * k));
    g.filter = `blur(${blur * k}px)`;
    g.fillStyle = `rgba(${color},${opacity})`;
    g.beginPath(); g.roundRect(pad * k, pad * k, w * k, d * k, radius * k); g.fill();
    const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
    const m = new T.Mesh(new T.PlaneGeometry(w + pad * 2, d + pad * 2), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  /** keys and a touchpad for a keyboard half w × d, drawn once: a colour map with a clear ground
   *  @param {number} w @param {number} d */
  function keysPaint(w, d) {
    const { c, g } = canvasOf(Math.round(w), Math.round(d));
    const u = w * 0.06, x0 = (w - 14 * u) / 2, y0 = d * 0.07;
    const rows = [Array(14).fill(1), [1.5, ...Array(11).fill(1), 1.5], [1.8, ...Array(10).fill(1), 2.2], [2.3, ...Array(9).fill(1), 2.7], [1, 1, 1, 1.3, 5.4, 1.3, 1, 1, 1]];
    g.fillStyle = "rgba(20,20,24,0.9)";
    rows.forEach((row, j) => {
      let x = x0;
      const hh = j === 0 ? u * 0.62 : u, y = y0 + (j === 0 ? 0 : u * 0.62 + (j - 1) * u);
      for (const k of row) { g.beginPath(); g.roundRect(x + u * 0.055, y + u * 0.055, k * u - u * 0.11, hh - u * 0.11, u * 0.11); g.fill(); x += k * u; }
    });
    const top = y0 + 4.62 * u + d * 0.03, ph = Math.max(10, d - top - d * 0.05), pw = Math.min(w * 0.37, ph * 1.6);
    g.fillStyle = "rgba(0,0,0,0.06)"; g.strokeStyle = "rgba(0,0,0,0.16)"; g.lineWidth = 2;
    g.beginPath(); g.roundRect((w - pw) / 2, top, pw, ph, u * 0.24); g.fill(); g.stroke();
    return c;
  }

  /**
   * A laptop standing on y 0, its footprint's middle at the origin, its
   * hinge along the back (−z): a keyboard half with keys drawn on it, a lid
   * that turns on the hinge, a dark bezel inside the lid. `screen` is a group
   * on the lid's inner face, the size of the screen: a live slab given it as
   * parent lies on the lid and turns with it, and its own point(x, y, t)
   * says where a part of the interface is in the space, lid and all. The lid
   * shut hides the screen; a light in the lid throws the screen's glow on
   * the keys, more the wider it is open. No logo and no maker's shape.
   * Sizes are the scene's units (CSS px of the screen): for a 1440 × 900
   * screen the laptop is 1530 wide and 990 deep.
   * @param {{ screen?: [number, number], bezel?: number, base?: number, lid?: number, radius?: number,
   *   color?: number | string, roughness?: number, metalness?: number, keys?: boolean, shadow?: boolean,
   *   glow?: number, glowColor?: number | string, open?: number | ((t: number) => number) }} [o]
   *   screen: its size (1440 × 900); bezel: the lid's margin round it (45); base, lid: thicknesses
   *   (26, 13); open: degrees between lid and keyboard (0 shut … 105), or that from film time;
   *   glow: the screen's light on the keys with the lid upright (0.5; 0: none) — one point of
   *   light in front of the screen: at 1.6 it showed on the palm rest as a white spot
   */
  function laptop(o = {}) {
    const [sw, sh] = o.screen ?? [1440, 900];
    const bezel = o.bezel ?? 45, TB = o.base ?? 26, TL = o.lid ?? 13, radius = o.radius ?? 44, GAP = 3, FOOT = 1;
    const LW = sw + 2 * bezel, LD = sh + 2 * bezel;
    const metal = new T.MeshStandardMaterial({ color: o.color ?? 0xc4c6cc, roughness: o.roughness ?? 0.42, metalness: o.metalness ?? 0.25 });
    const group = new T.Group();
    const base = new T.Mesh(plate(LW, LD, TB, radius).geometry, metal);
    base.position.y = FOOT;
    group.add(base);
    if (o.keys !== false) {
      const kt = new T.CanvasTexture(keysPaint(LW, LD)); kt.colorSpace = T.SRGBColorSpace; kt.anisotropy = 8;
      const keysMesh = new T.Mesh(new T.PlaneGeometry(LW, LD), new T.MeshStandardMaterial({ map: kt, transparent: true, roughness: 0.6 }));
      keysMesh.rotation.x = -Math.PI / 2; keysMesh.position.y = FOOT + TB + 0.6;
      group.add(keysMesh);
    }
    // the lid, hinged along the back edge; shut it lies over the keys, its inner face down
    const lid = new T.Group();
    lid.position.set(0, FOOT + TB + GAP, -LD / 2);
    group.add(lid);
    const shell = plate(LW, LD, TL, radius);
    shell.geometry.translate(0, 0, LD / 2);
    lid.add(new T.Mesh(shell.geometry, metal));
    const inner = new T.Mesh(new T.ShapeGeometry(shell.shape, 10), new T.MeshBasicMaterial({ color: 0x0c0c0f }));
    inner.scale.set((LW - 8) / LW, (LD - 8) / LD, 1);
    inner.rotation.x = Math.PI / 2; inner.position.set(0, -0.6, LD / 2);
    lid.add(inner);
    const screen = new T.Group();
    screen.position.set(0, -1.6, LD / 2);
    screen.rotation.x = Math.PI / 2;
    lid.add(screen);
    const glowK = o.glow ?? 0.5;
    const glow = new T.PointLight(o.glowColor ?? 0xfff1e0, 0, 0, 0);
    glow.position.set(0, -LD / 2, LD / 2);
    lid.add(glow);
    if (o.shadow !== false) {
      const sm = contact(LW, LD);
      sm.position.set(20, 0.5, 30);
      group.add(sm);
    }
    let angle = 105, lit = 1;
    /** the lid at `deg` between it and the keyboard (0 shut), the screen `screenLit` 0…1 bright
     *  @param {number} deg @param {number} [screenLit] */
    function set(deg, screenLit = lit) {
      angle = Math.max(0, Math.min(180, deg)); lit = screenLit;
      lid.rotation.x = (-angle * Math.PI) / 180;
      glow.intensity = glowK * lit * Math.max(0, Math.sin((angle * Math.PI) / 180));
      // shut, the screen lies in the keys' plane: not drawn
      screen.visible = angle > 0.5;
    }
    const open = o.open ?? 105;
    set(typeof open === "function" ? open(0) : open);
    return {
      group, base, lid, screen, glow, material: metal, width: LW, depth: LD, set,
      /** the lid's angle now */
      get open() { return angle; },
      /** space.js runs this at every sample's time: the lid where `open` puts it then @param {number} t */
      tick: (t) => { if (typeof open === "function") set(open(t)); },
    };
  }

  /**
   * A table to stand things on, with its light: a matte ground at y 0 that
   * reaches past the fog, a sky light (a hemisphere: white above, the
   * table's own colour from below) and a sun from the upper left behind the
   * lens — one key and a fill, the least that shows a lid's edge and a
   * body's top apart. `fog` fades the table into the scene's ground colour,
   * so it has no far edge: space.js's scene.add(desk) sets it on the scene
   * and keeps its colour the ground's at every sample (alone: `scene.fog =
   * desk.fog`). `look` changes it over the film — an evening into a morning:
   *   look: (t) => (t < 15 ? { color: 0x77604c, sky: 0.75, sun: 1.5, sunColor: 0xffc591 }
   *                        : { color: 0xd9ccb6, sky: 1.5, sun: 2.3, sunColor: 0xfff3e0 })
   * The intensities are chosen by eye against a mid-grey body.
   * @param {{ color?: number | string, size?: number, roughness?: number, sky?: number, sun?: number,
   *   sunColor?: number | string, sunAt?: [number, number, number], fog?: [number, number] | false,
   *   look?: (t: number) => { color?: number | string, sky?: number, sun?: number, sunColor?: number | string } }} [o]
   *   fog: where it starts and where it has taken everything, from the lens ([4200, 11000])
   */
  function desk(o = {}) {
    const group = new T.Group();
    const mat = new T.MeshStandardMaterial({ color: o.color ?? 0x6a5848, roughness: o.roughness ?? 0.95 });
    const ground = new T.Mesh(new T.PlaneGeometry(o.size ?? 40000, o.size ?? 40000), mat);
    ground.rotation.x = -Math.PI / 2;
    const sky = new T.HemisphereLight(0xffffff, o.color ?? 0x6a5848, o.sky ?? 1);
    const sun = new T.DirectionalLight(o.sunColor ?? 0xffffff, o.sun ?? 1.5);
    sun.position.set(...(o.sunAt ?? [-900, 1800, 1400]));
    group.add(ground, sky, sun);
    const fog = o.fog === false ? null : new T.Fog(0x000000, o.fog?.[0] ?? 4200, o.fog?.[1] ?? 11000);
    /** @param {{ color?: number | string, sky?: number, sun?: number, sunColor?: number | string }} v */
    function set(v) {
      if (v.color !== undefined) { mat.color.set(v.color); sky.groundColor.set(v.color); }
      if (v.sky !== undefined) sky.intensity = v.sky;
      if (v.sun !== undefined) sun.intensity = v.sun;
      if (v.sunColor !== undefined) sun.color.set(v.sunColor);
    }
    return {
      group, ground, sky, sun, fog, set,
      /** space.js runs this at every sample's time @param {number} t @param {{ clear?: any }} [at] the scene's ground colour then */
      tick: (t, at) => {
        if (o.look) set(o.look(t));
        if (fog && at?.clear) fog.color.copy(at.clear);
      },
    };
  }

  return {
    geometry, planarUV, laptop, desk, contact,
    /** a distance function as a lit mesh (see sdfMesh); userData: voxels, triangles
     *  @param {(x: number, y: number, z: number) => number} f @param {number[]} box @param {number} voxel */
    sdf(f, box, voxel) {
      const m = sdfMesh(f, box, voxel);
      const g = geometry(m);
      g.userData = { voxels: m.voxels, triangles: m.triangles };
      return g;
    },
    /** a turned part (see latheMesh) @param {number[][]} profile @param {Parameters<typeof latheMesh>[1]} [o] */
    lathe: (profile, o) => geometry(latheMesh(profile, o)),
    /** a canvas as a texture: srgb for colour maps, linear for bump and roughness
     *  @param {HTMLCanvasElement} c @param {boolean} [srgb] @param {number} [repeat] */
    texture(c, srgb = false, repeat = 1) {
      const t = new T.CanvasTexture(c);
      t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
      t.anisotropy = 8;
      if (repeat !== 1) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat, repeat); }
      return t;
    },
    /** backdropPaint as a colour texture @param {Parameters<typeof backdropPaint>[0]} [o] */
    backdrop(o) {
      const t = new T.CanvasTexture(backdropPaint(o));
      t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8;
      return t;
    },
    /**
     * A studio to reflect, prefiltered for PBR materials: a grey room with
     * a few soft boxes in it, after three's RoomEnvironment, built here so a
     * film needs no addon file. `warm` tints the key box, `cool` the rim.
     * Its boxes are bright (up to 50× white): set the scene's
     * environmentIntensity near 0.55 to start, lower for polished metal
     * facing up at the ceiling's box.
     * @param {any} renderer @param {{ key?: number, warm?: number, cool?: number }} [o]
     */
    room(renderer, { key = 1, warm = 0xfff0dd, cool = 0xcfe0ff } = {}) {
      const sc = new T.Scene();
      const box = new T.BoxGeometry();
      const wall = new T.MeshStandardMaterial({ side: T.BackSide, color: 0x7f7f7f, roughness: 1 });
      const room = new T.Mesh(box, wall); room.position.set(-0.757, 13.219, 0.717); room.scale.set(31.713, 28.305, 28.591); sc.add(room);
      sc.add(new T.PointLight(0xffffff, 900, 28, 2).translateY(5));
      const clutter = new T.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.9 });
      for (const [x, y, z, sx, sy, sz] of [[-10.9, 2.1, -2, 2.7, 4.3, 1.6], [-0.3, 1.6, -9, 7.3, 3.2, 1.9], [6.3, 2.3, -3.3, 2.1, 4.6, 3.6], [-6, 1.1, 3.4, 2.9, 2.2, 1.4], [5.2, 1, 7.2, 3.4, 2, 3.2]]) {
        const m = new T.Mesh(box, clutter); m.position.set(x, y, z); m.scale.set(sx, sy, sz); sc.add(m);
      }
      /** @param {number} color @param {number} k @param {number[]} p @param {number[]} s */
      const light = (color, k, p, s) => {
        const m = new T.Mesh(box, new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(k) }));
        m.position.set(p[0], p[1], p[2]); m.scale.set(s[0], s[1], s[2]); sc.add(m);
      };
      light(warm, 50 * key, [-16.1, 2.5, 6.8], [0.1, 2.5, 2.5]);   // key, left
      light(cool, 43, [14.6, 11.4, -6.6], [0.1, 2.5, 3.4]);        // rim, right and behind
      light(0xffffff, 17, [-0.2, 15.6, 2.3], [5.9, 0.1, 6.9]);     // the ceiling
      light(0xffffff, 43, [-1.6, 17.8, 9.2], [1.6, 0.1, 1.5]);
      const pm = new T.PMREMGenerator(renderer);
      const env = pm.fromScene(sc, 0.04).texture;
      pm.dispose();
      return env;
    },
    /**
     * Bloom and a grade from a linear HDR texture to the screen — space.js's
     * scene `finish`, or alone: finish.render(scene, camera) draws a scene
     * into its own target first. P: expo, bloomMix, bloomAdd, vig, lift,
     * grain (8-bit steps of dither). Bloom uses 6 levels of half size each.
     * @param {any} renderer
     * @param {{ width?: number, height?: number, expo?: number, bloomMix?: number, bloomAdd?: number, vig?: number, lift?: number, grain?: number }} [o]
     */
    finish(renderer, o = {}) {
      const P = { expo: 1, bloomMix: 0.04, bloomAdd: 0.025, vig: 0.7, lift: 0, grain: 1, ...o };
      const VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }";
      const qScene = new T.Scene(), qCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const q = new T.Mesh(new T.PlaneGeometry(2, 2)); q.frustumCulled = false; qScene.add(q);
      // each pass clears only when asked: the bloom's way up adds onto the level below,
      // which a renderer left to clear itself (autoClear, three's default) would wipe
      /** @param {any} mat @param {any} target @param {boolean} [clear] */
      const pass = (mat, target, clear = true) => {
        q.material = mat; renderer.setRenderTarget(target);
        const auto = renderer.autoClear;
        renderer.autoClear = false;
        if (clear) renderer.clear();
        renderer.render(qScene, qCam);
        renderer.autoClear = auto;
      };
      /** @param {string} fs @param {boolean} [add] */
      const blit = (fs, add = false) => new T.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false,
        uniforms: { t: { value: null }, texel: { value: new T.Vector2() } }, blending: add ? T.AdditiveBlending : T.NoBlending, transparent: add });
      const mD0 = blit(`uniform sampler2D t; uniform vec2 texel; varying vec2 vUv;
        vec4 kar(vec3 c){ float w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4(c * w, w); }
        void main(){ vec4 m = kar(min(texture2D(t, vUv + texel * vec2(-1., -1.)).rgb, vec3(24.))) + kar(min(texture2D(t, vUv + texel * vec2(1., -1.)).rgb, vec3(24.)))
          + kar(min(texture2D(t, vUv + texel * vec2(-1., 1.)).rgb, vec3(24.))) + kar(min(texture2D(t, vUv + texel * vec2(1., 1.)).rgb, vec3(24.)));
          gl_FragColor = vec4(m.rgb / m.a, 1.); }`);
      const mD = blit(`uniform sampler2D t; uniform vec2 texel; varying vec2 vUv;
        void main(){ gl_FragColor = (texture2D(t, vUv + texel * vec2(-1., -1.)) + texture2D(t, vUv + texel * vec2(1., -1.))
          + texture2D(t, vUv + texel * vec2(-1., 1.)) + texture2D(t, vUv + texel * vec2(1., 1.))) * .25; }`);
      // alpha 1: three's additive blend multiplies the colour by it
      const mU = blit(`uniform sampler2D t; uniform vec2 texel; varying vec2 vUv;
        void main(){ vec2 e = .75 * texel; gl_FragColor = vec4((texture2D(t, vUv + e * vec2(-1., -1.)).rgb + texture2D(t, vUv + e * vec2(1., -1.)).rgb
          + texture2D(t, vUv + e * vec2(-1., 1.)).rgb + texture2D(t, vUv + e * vec2(1., 1.)).rgb) * .25, 1.); }`, true);
      const mC = new T.ShaderMaterial({ vertexShader: VS, depthTest: false, depthWrite: false,
        uniforms: { tS: { value: null }, tB: { value: null }, expo: { value: 1 }, bloomMix: { value: 0 }, bloomAdd: { value: 0 }, vig: { value: 0 }, lift: { value: 0 }, grain: { value: 1 }, seed: { value: 0 } },
        fragmentShader: `uniform sampler2D tS; uniform sampler2D tB; uniform float expo, bloomMix, bloomAdd, vig, lift, grain, seed; varying vec2 vUv;
        float ss(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
        float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }
        vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
        vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308, c)); }
        void main(){
          vec3 c = texture2D(tS, vUv).rgb, bl = texture2D(tB, vUv).rgb;
          c = mix(c, bl, bloomMix) + bl * bloomAdd;
          c *= expo;
          vec2 q = vUv - .5; c *= 1. - dot(q, q) * vig;
          c = aces(c);
          float l0 = dot(c, vec3(.2126, .7152, .0722));
          float l = mix(l0, l0 * l0 * (3. - 2. * l0), .55);
          c *= l / max(l0, 1e-4);
          c = mix(c, vec3(l), ss(.55, 1., l) * .1);
          c = mix(vec3(l), c, .93) + vec3(.008, .002, 0.) * lift;
          c = srgb(max(c, vec3(0.)));
          float n = ign(gl_FragCoord.xy + seed) + ign(gl_FragCoord.xy + 37. + seed) - 1.;
          gl_FragColor = vec4(c + grain * n / 255., 1.); }` });
      /** @type {any[]} */ let bl = [];
      /** @type {any} */ let own = null;
      let W = 0, H = 0;
      /** @param {number} w @param {number} h */
      function size(w, h) {
        if (w === W && h === H) return;
        W = w; H = h;
        for (const b of bl) b.dispose();
        bl = [];
        for (let i = 0; i < 6; i++) bl.push(new T.WebGLRenderTarget(Math.max(1, W >> (i + 1)), Math.max(1, H >> (i + 1)), { type: T.HalfFloatType, depthBuffer: false }));
        own?.dispose(); own = null;
      }
      if (o.width && o.height) size(o.width, o.height);
      /** @param {any} tex a linear HDR texture @param {number} [t] film time, to move the dither */
      function apply(tex, t = 0) {
        // not sized yet: the texture's own size, else the canvas's
        if (!bl.length) {
          const im = tex?.image, s = renderer.getDrawingBufferSize(new T.Vector2());
          size(im?.width || s.x, im?.height || s.y);
        }
        for (let i = 0; i < bl.length; i++) {
          const src = i ? bl[i - 1] : null, m = i ? mD : mD0;
          m.uniforms.t.value = src ? src.texture : tex;
          m.uniforms.texel.value.set(1 / (src ? src.width : W), 1 / (src ? src.height : H));
          pass(m, bl[i]);
        }
        for (let i = bl.length - 1; i > 0; i--) {
          mU.uniforms.t.value = bl[i].texture; mU.uniforms.texel.value.set(1 / bl[i].width, 1 / bl[i].height);
          pass(mU, bl[i - 1], false);
        }
        const u = mC.uniforms;
        u.tS.value = tex; u.tB.value = bl[0]?.texture ?? tex;
        for (const k of /** @type {const} */ (["expo", "bloomMix", "bloomAdd", "vig", "lift", "grain"])) u[k].value = P[k];
        u.seed.value = Math.round(t * 60) % 97;
        pass(mC, null);
      }
      return {
        P, size, apply,
        /** draw a scene through it, without space.js @param {any} scene @param {any} camera @param {number} [t] */
        render(scene, camera, t = 0) {
          const s = renderer.getDrawingBufferSize(new T.Vector2());
          size(s.x, s.y);
          if (!own) own = new T.WebGLRenderTarget(W, H, { type: T.HalfFloatType, samples: 4 });
          renderer.setRenderTarget(own); renderer.clear(); renderer.render(scene, camera);
          apply(own.texture, t);
        },
      };
    },
  };
}
