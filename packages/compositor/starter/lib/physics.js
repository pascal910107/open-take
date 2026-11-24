// physics.js — rigid bodies for a film page: simulated once when the page
// loads, then read back at any film time t. A scene is plain data (statics,
// bodies, each body's release time and kick); bake() steps an engine at a
// fixed step and records every body's pose, and sample() reads a pose at any
// t, between steps too (position lerped, rotation slerped). __render(t) only
// reads the bake, so a frame drawn twice, out of order, by another worker or
// between frames for the shutter comes out the same. Nothing here reads a
// clock or Math.random: everything random comes from rng(seed).
//
// The film brings its own engine, as files in its own folder (vendor/):
//   Rapier: npm @dimforge/rapier3d-deterministic-compat (Apache-2.0), its
//     dist/rapier.mjs — one ES module, the wasm inlined. Copy it as
//     vendor/rapier.mjs (any name with "rapier" in it).
//   ammo.js (Bullet, zlib): builds/ammo.wasm.js and builds/ammo.wasm.wasm of
//     github.com/kripken/ammo.js, both in the same folder (the script fetches
//     the .wasm from beside itself). Not the npm 0.0.10 package, which is a
//     years-old asm.js build.
// This file imports neither (only lib/anim.js, for rng): engine(url) loads the
// one the film names, when it is called. The two take the same scene: boxes
// are rounded the same (r, 0.04 m unless said), damping means the same, and a
// pose is read at the same step; the paths still differ, since the solvers
// do. Rapier first: the shortest scenes, a build that is the same across
// machines. Neither settles a stack cleanly most of the time: of 20 seeds of
// 40 chips falling into a bar chart, 6 came to rest clean with Rapier and 7
// with ammo (settle(): the others still creeping, trembling a few millimetres
// in place, or a chip leaning). ammo's stacks drift less — counting only how
// far each chip got in the last 0.2 s, 17 against 10 — but tremble more.
// Same input, same numbers: each engine gave the same hash in one tab three
// times, in two fresh tabs, and in Node 22.
//
// Physics gets things somewhere believable; whether it got them somewhere
// readable is a matter of the seed. Run lib/physics-seeds.mjs over 20 seeds
// in Node (a few seconds) and write a clean one into the page.
//
//   import { engine, bake, sample, publish, explode, landings, snap } from "./lib/physics.js";
//   const E = await engine("./vendor/rapier.mjs");      // or "./vendor/ammo.wasm.js"
//   const fall = bake(E.make(), myScene(7));            // at load, in __film.ready
//   publish({ fall });                                  // window.__bake.hash: the renderer stops if two workers differ
//   // in __render(t): a body not yet released is at its spawn pose — hide it
//   mesh.visible = t >= scene.bodies[i].t;
//   sample(fall, i, t, mesh.position, mesh.quaternion);
//
//   rng(seed)                        a seeded random 0..1 (mulberry32)
//   quat(x, y, z)                    Euler angles (rad, XYZ) as a quaternion [x, y, z, w]
//   engine(url, kind?)               loads the film's engine → { kind, module, make() → an adapter }
//   adapters.rapier(R), .ammo(A)     an engine's module as the five calls bake() makes
//   bake(adapter, scene, dt?)        → { frames, steps, n, dt, duration, hash }
//   sample(baked, i, s, pos, quat)   body i's pose at sim time s (written into pos / quat)
//   fnv1a(f32, h?)                   a bake's hash (8 hex digits)
//   publish(bakes)                   window.__bake = { hash, parts }: one hash over every bake
//   settle(baked, o?)                how it came to rest: speed and spin in the last 0.2 s, tilt, fallen through
//   explode(parts, o?)               a scene that blows parts out from where they belong (play it backwards;
//                                    in the object's own coordinates: add where it stands after sample())
//   byLayers(cells, o?)              an assembly order: bottom layer first, round the axis within a layer
//   landings(order, start, o?)       each part's landing time: in pairs, 0.06 s apart
//   snap(t, land, S, o?)             the sim time of a part on the snap assembly timeline
//
// Scene: { gravity (m/s², along y; -25 reads as a table-top drop), duration (s),
// statics: [{ half: [hx, hy, hz], pos, quat?, friction? }], bodies: [{ t (when it
// is released; before that it is recorded at its spawn pose, so the page hides
// it), half, r? (corner radius, under the smallest half; 0.04 m, or a quarter
// of the smallest half when that is less; 0: sharp), shape? ("box" | "ball";
// a ball's radius is r), pos, quat, linvel?, angvel?, friction?, restitution?,
// linDamp?, angDamp? (per second: a speed falls as e^(-damp·t)), density? }] }. Metres,
// seconds, quaternions [x, y, z, w]. A bake is 7 floats a body a step: 40
// bodies for 2.9 s at 1/120 s is 391 KB, and costs 40–150 ms in Chrome (the
// first one more, while the engine's wasm warms up) — once per worker.
//
// Assembly: a burst baked from the assembled object and played backwards puts
// every part on the path it would fly out on. The reference's assembly (a
// wooden plane's parts in a launch film, 23.3–31.8 s) is not physics in time:
// parts hang still as an exploded view, then land one or two at a time, each
// crossing in 4 frames at 30 fps, ease in-out, no overshoot. snap() is that:
// physics gives the path and the tumble, the timeline gives the when.

import { rng } from "./anim.js";

/** @typedef {[number, number, number]} V3 */
/** @typedef {[number, number, number, number]} Q4  x, y, z, w */
/**
 * @typedef {object} Static
 * @property {V3} half  half extents (m)
 * @property {V3} pos
 * @property {Q4} [quat]
 * @property {number} [friction]  0.5
 */
/**
 * @typedef {object} Body
 * @property {number} [t]  when it is released (s); 0
 * @property {V3} half  half extents (m); a ball's are its radius each way
 * @property {number} [r]  corner radius, under the smallest half (a ball: its radius); see cornerOf
 * @property {"box" | "ball"} [shape]  "box"
 * @property {V3} pos
 * @property {Q4} [quat]
 * @property {V3} [linvel]
 * @property {V3} [angvel]
 * @property {number} [friction]  0.5
 * @property {number} [restitution]  0
 * @property {number} [linDamp]  per second: the speed falls as e^(-linDamp·t); 0
 * @property {number} [angDamp]  per second, the same for the spin; 0
 * @property {number} [density]  1
 */
/**
 * @typedef {object} Scene
 * @property {number} gravity  along y (m/s²)
 * @property {number} duration  how long to simulate (s)
 * @property {Static[]} statics
 * @property {Body[]} bodies
 */
/**
 * @typedef {object} Adapter  one engine's world, as the calls bake() makes
 * @property {(g: number) => void} setGravity
 * @property {(s: Static) => void} addStatic
 * @property {(b: Body) => unknown} addBody  → a handle read() takes
 * @property {(dt: number) => void} step
 * @property {(h: any, out: Float32Array, o: number) => void} read  px py pz qx qy qz qw into out at o
 * @property {() => void} [dispose]
 */
/**
 * @typedef {object} Baked
 * @property {Float32Array} frames  ((step * n) + i) * 7 → px py pz qx qy qz qw
 * @property {number} steps  steps after the first pose (frames hold steps + 1)
 * @property {number} n  bodies
 * @property {number} dt  the step (s)
 * @property {number} duration  steps * dt
 * @property {string} hash  fnv1a of frames
 */
/** @typedef {{ set: (...v: number[]) => unknown } | number[] | Float32Array} Out  a THREE.Vector3 / Quaternion, or an array */

/** the step: 1/120 s, two steps a 60 fps frame */
export const DT = 1 / 120;

/** a seeded random 0..1 (mulberry32), lib/anim.js's: `const r = rng(7); r()` */
export { rng };

/** Euler angles (rad, three.js's "XYZ": about X, then about the turned Y, then
 *  the turned Z — q = qx·qy·qz) as [x, y, z, w]
 *  @param {number} x @param {number} y @param {number} z @returns {Q4} */
export function quat(x, y, z) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

// ---------------------------------------------------------------- engines

/** which engine a file is, by its name @param {string} url @returns {"rapier" | "ammo"} */
function kindOf(url) {
  if (/rapier/i.test(url)) return "rapier";
  if (/ammo/i.test(url)) return "ammo";
  throw new Error(`physics: can't tell which engine ${url} is — say engine(url, "rapier") or engine(url, "ammo")`);
}

/**
 * Loads the engine the film brings, from a file in its folder (relative to
 * the page), and gives back a maker of fresh worlds. Rapier is an ES module
 * with its wasm inside; ammo is a classic script that fetches ammo.wasm.wasm
 * from beside itself. In a browser only — lib/physics-seeds.mjs loads the same
 * files in Node.
 * `const E = await engine("./vendor/rapier3d-deterministic-compat.mjs"); bake(E.make(), scene)`
 * @param {string} url  the engine's file, relative to the page
 * @param {"rapier" | "ammo"} [kind]  which engine it is (default: from the file's name)
 * @returns {Promise<{ kind: "rapier" | "ammo", module: any, make: () => Adapter }>}
 */
export function engine(url, kind = kindOf(url)) {
  const href = new URL(url, document.baseURI).href;
  // once a page: ammo's script, once run, puts its module where its factory
  // was (window.Ammo), so a second load would add the script and start the
  // wasm over
  let got = loaded.get(`${kind} ${href}`);
  if (!got) {
    got = load(href, kind);
    got.catch(() => loaded.delete(`${kind} ${href}`));
    loaded.set(`${kind} ${href}`, got);
  }
  return got;
}

/** @type {Map<string, Promise<{ kind: "rapier" | "ammo", module: any, make: () => Adapter }>>} */
const loaded = new Map();

/** @param {string} href @param {"rapier" | "ammo"} kind */
async function load(href, kind) {
  if (kind === "rapier") {
    const mod = await import(href);
    const R = mod.default ?? mod;
    await R.init?.();
    return { kind, module: R, make: () => adapters.rapier(R) };
  }
  const w = /** @type {any} */ (window);
  if (typeof w.Ammo !== "function") {
    await new Promise((done, fail) => {
      const s = document.createElement("script");
      s.src = href;
      s.onload = done;
      s.onerror = () => fail(new Error(`physics: ammo didn't load from ${href}`));
      document.head.append(s);
    });
  }
  const A = await w.Ammo();
  return { kind, module: A, make: () => adapters.ammo(A) };
}

/**
 * A box's corner radius, the same in both engines: b.r, or 0.04 m (Bullet's
 * own collision margin) but no more than a quarter of the smallest half. A
 * radius that reaches the smallest half is not a box: say shape: "ball".
 * @param {Body} b @returns {number}
 */
export function cornerOf(b) {
  const least = Math.min(...b.half);
  const r = b.r ?? Math.min(0.04, least / 4);
  if (!(r >= 0 && r < least))
    throw new Error(
      `physics: a box of half ${JSON.stringify(b.half)} can't have corner radius r ${b.r} — it must be at least 0 and under the smallest half (${least}); a box rounded that far is a ball (shape: "ball")`,
    );
  return r;
}

/** damping per second (a speed falls as e^(-c·t), Rapier's meaning) as
 *  Bullet's factor: Bullet keeps (1 - d)^dt of a speed each step and clamps d
 *  to 0..1, so a rate over 1 given straight would stop a body dead
 *  @param {number} c */
const bulletDamping = (c) => 1 - Math.exp(-Math.max(0, c));

/** Each engine's module as the five calls bake() makes. The film passes the
 *  module it loaded; nothing here imports one. */
export const adapters = {
  /** @param {any} R  Rapier, after `await R.init()` @returns {Adapter} */
  rapier(R) {
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    /** @param {Q4 | undefined} q */
    const rot = (q) => (q ? { x: q[0], y: q[1], z: q[2], w: q[3] } : { x: 0, y: 0, z: 0, w: 1 });
    return {
      setGravity(g) {
        world.gravity = { x: 0, y: g, z: 0 };
      },
      addStatic(s) {
        const [hx, hy, hz] = s.half;
        world.createCollider(
          R.ColliderDesc.cuboid(hx, hy, hz)
            .setTranslation(...s.pos)
            .setRotation(rot(s.quat))
            .setFriction(s.friction ?? 0.5),
        );
      },
      addBody(b) {
        const lv = b.linvel ?? [0, 0, 0], av = b.angvel ?? [0, 0, 0];
        const rb = world.createRigidBody(
          R.RigidBodyDesc.dynamic()
            .setTranslation(...b.pos)
            .setRotation(rot(b.quat))
            .setLinvel(lv[0], lv[1], lv[2])
            .setAngvel({ x: av[0], y: av[1], z: av[2] })
            .setLinearDamping(b.linDamp ?? 0)
            .setAngularDamping(b.angDamp ?? 0)
            .setCanSleep(false),
        );
        const [hx, hy, hz] = b.half;
        const r = b.shape === "ball" ? 0 : cornerOf(b);
        const desc =
          b.shape === "ball"
            ? R.ColliderDesc.ball(b.r || hx)
            : r > 0
              ? R.ColliderDesc.roundCuboid(hx - r, hy - r, hz - r, r) // Rapier's rounding is outside the core box
              : R.ColliderDesc.cuboid(hx, hy, hz);
        world.createCollider(
          desc
            .setFriction(b.friction ?? 0.5)
            .setRestitution(b.restitution ?? 0)
            .setDensity(b.density ?? 1),
          rb,
        );
        return rb;
      },
      step(dt) {
        world.timestep = dt;
        world.step();
      },
      read(rb, out, o) {
        const p = rb.translation(), q = rb.rotation();
        out[o] = p.x; out[o + 1] = p.y; out[o + 2] = p.z;
        out[o + 3] = q.x; out[o + 4] = q.y; out[o + 5] = q.z; out[o + 6] = q.w;
      },
      dispose() {
        world.free();
      },
    };
  },

  /** @param {any} A  ammo, after `await Ammo()` @returns {Adapter} */
  ammo(A) {
    const cfg = new A.btDefaultCollisionConfiguration();
    const disp = new A.btCollisionDispatcher(cfg);
    const bp = new A.btDbvtBroadphase();
    const solver = new A.btSequentialImpulseConstraintSolver();
    const world = new A.btDiscreteDynamicsWorld(disp, bp, solver, cfg);
    /** @type {any[]} */ const made = [];
    /** @type {any[]} */ const bodies = [];
    /** @template T @param {T} x @returns {T} */
    const keep = (x) => {
      made.push(x);
      return x;
    };
    /** @param {number} x @param {number} y @param {number} z */
    const v = (x, y, z) => keep(new A.btVector3(x, y, z));
    /** @param {number} mass @param {any} shape @param {V3} pos @param {Q4} q */
    const rigid = (mass, shape, pos, q) => {
      const t = keep(new A.btTransform());
      t.setIdentity();
      t.setOrigin(v(...pos));
      t.setRotation(keep(new A.btQuaternion(...q)));
      const inertia = v(0, 0, 0);
      if (mass > 0) shape.calculateLocalInertia(mass, inertia);
      const info = keep(new A.btRigidBodyConstructionInfo(mass, keep(new A.btDefaultMotionState(t)), shape, inertia));
      const body = new A.btRigidBody(info);
      bodies.push(body);
      return body;
    };
    return {
      setGravity(g) {
        world.setGravity(v(0, g, 0));
      },
      addStatic(s) {
        const body = rigid(0, keep(new A.btBoxShape(v(...s.half))), s.pos, s.quat ?? [0, 0, 0, 1]);
        body.setFriction(s.friction ?? 0.5);
        world.addRigidBody(body);
      },
      addBody(b) {
        const [hx, hy, hz] = b.half;
        // a box's collision margin is inside it and rounds its corners
        const shape = keep(b.shape === "ball" ? new A.btSphereShape(b.r || hx) : new A.btBoxShape(v(hx, hy, hz)));
        if (b.shape !== "ball") shape.setMargin(cornerOf(b));
        const vol = b.shape === "ball" ? (4 / 3) * Math.PI * (b.r || hx) ** 3 : 8 * hx * hy * hz;
        const body = rigid(vol * (b.density ?? 1), shape, b.pos, b.quat ?? [0, 0, 0, 1]);
        body.setFriction(b.friction ?? 0.5);
        body.setRestitution(b.restitution ?? 0);
        body.setDamping(bulletDamping(b.linDamp ?? 0), bulletDamping(b.angDamp ?? 0));
        body.setActivationState(4); // DISABLE_DEACTIVATION: nothing falls asleep mid-shot
        body.setLinearVelocity(v(...(b.linvel ?? [0, 0, 0])));
        body.setAngularVelocity(v(...(b.angvel ?? [0, 0, 0])));
        world.addRigidBody(body);
        return body;
      },
      step(dt) {
        world.stepSimulation(dt, 1, dt); // one fixed step, nothing carried over
      },
      read(body, out, o) {
        // the body's own transform: its motion state's is a step behind
        const t = body.getWorldTransform();
        const p = t.getOrigin(), q = t.getRotation();
        out[o] = p.x(); out[o + 1] = p.y(); out[o + 2] = p.z();
        out[o + 3] = q.x(); out[o + 4] = q.y(); out[o + 5] = q.z(); out[o + 6] = q.w();
      },
      dispose() {
        // ammo's objects live on its heap until destroyed: the bodies out of the world first
        for (const b of bodies) {
          world.removeRigidBody(b);
          A.destroy(b);
        }
        for (const x of [world, solver, bp, disp, cfg, ...made]) A.destroy(x);
      },
    };
  },
};

// ---------------------------------------------------------------- bake and read

/**
 * Steps a fresh world at a fixed dt and records every body's pose. The
 * adapter is used up (disposed) by it: one make() per bake.
 * @param {Adapter} adapter @param {Scene} scene @param {number} [dt] @returns {Baked}
 */
export function bake(adapter, scene, dt = DT) {
  const steps = Math.round(scene.duration / dt);
  const n = scene.bodies.length;
  const out = new Float32Array((steps + 1) * n * 7);
  /** @type {unknown[]} */ const handles = new Array(n).fill(null);
  /** @param {number} step */
  const write = (step) => {
    for (let i = 0; i < n; i++) {
      const o = (step * n + i) * 7;
      const h = handles[i];
      if (h == null) {
        const b = /** @type {Body} */ (scene.bodies[i]);
        out.set(b.pos, o);
        out.set(b.quat ?? [0, 0, 0, 1], o + 3);
      } else adapter.read(h, out, o);
    }
  };
  /** @param {number} time */
  const release = (time) => {
    for (let i = 0; i < n; i++) {
      const b = /** @type {Body} */ (scene.bodies[i]);
      if (handles[i] == null && (b.t ?? 0) <= time + 1e-9) handles[i] = adapter.addBody(b);
    }
  };
  try {
    adapter.setGravity(scene.gravity);
    for (const s of scene.statics) adapter.addStatic(s);
    release(0);
    write(0);
    for (let step = 1; step <= steps; step++) {
      adapter.step(dt);
      release(step * dt);
      write(step);
    }
  } finally {
    adapter.dispose?.();
  }
  return { frames: out, steps, n, dt, duration: steps * dt, hash: fnv1a(out) };
}

/** FNV-1a over a bake's bytes, as 8 hex digits; pass h to go on from another
 *  bake's (as a number: parseInt(hash, 16))
 *  @param {Float32Array} f32 @param {number} [h] @returns {string} */
export function fnv1a(f32, h = 0x811c9dc5) {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  for (let i = 0; i < u8.length; i++) {
    h ^= /** @type {number} */ (u8[i]);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** @param {Out} o @param {number[]} v */
function put(o, v) {
  if (Array.isArray(o) || ArrayBuffer.isView(o)) for (let k = 0; k < v.length; k++) /** @type {number[]} */ (o)[k] = /** @type {number} */ (v[k]);
  else o.set(...v);
}

const P3 = [0, 0, 0], Q = [0, 0, 0, 1];

/**
 * Body i's pose at sim time s, written into pos and quat (THREE.Vector3 and
 * Quaternion, or arrays). Between two steps the position is lerped and the
 * rotation slerped along the shorter arc; s is held inside the bake.
 * `sample(fall, i, t, mesh.position, mesh.quaternion)`
 * @param {Baked} b @param {number} i @param {number} s @param {Out} [pos] @param {Out} [quat]
 * @returns {{ pos: number[], quat: number[] }}  the same numbers (reused between calls: copy to keep)
 */
export function sample(b, i, s, pos, quat) {
  if (!(Number.isInteger(i) && i >= 0 && i < b.n)) throw new RangeError(`physics: sample() of body ${i}, in a bake of ${b.n} (0..${b.n - 1})`);
  const k = Math.min(Math.max(s / b.dt, 0), b.steps);
  const k0 = Math.min(Math.floor(k), Math.max(0, b.steps - 1)), f = b.steps ? k - k0 : 0;
  const F = /** @type {any} */ (b.frames);
  const o0 = (k0 * b.n + i) * 7, o1 = b.steps ? o0 + b.n * 7 : o0;
  for (let c = 0; c < 3; c++) P3[c] = F[o0 + c] + (F[o1 + c] - F[o0 + c]) * f;
  const ax = F[o0 + 3], ay = F[o0 + 4], az = F[o0 + 5], aw = F[o0 + 6];
  let bx = F[o1 + 3], by = F[o1 + 4], bz = F[o1 + 5], bw = F[o1 + 6];
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    d = -d;
  }
  let wa = 1 - f, wb = f;
  if (d < 0.9995) {
    const th = Math.acos(d), sn = Math.sin(th);
    wa = Math.sin((1 - f) * th) / sn;
    wb = Math.sin(f * th) / sn;
  }
  const x = ax * wa + bx * wb, y = ay * wa + by * wb, z = az * wa + bz * wb, w = aw * wa + bw * wb;
  const len = Math.hypot(x, y, z, w) || 1;
  Q[0] = x / len; Q[1] = y / len; Q[2] = z / len; Q[3] = w / len;
  if (pos) put(pos, P3);
  if (quat) put(quat, Q);
  return { pos: P3, quat: Q };
}

/**
 * Puts the bakes' hash on the page as window.__bake = { hash, parts }: one hash
 * over every bake, in the order given, and each one's own. Every worker bakes
 * for itself, so the renderer reads window.__bake.hash from each page it opens
 * and stops when two differ (those workers would draw different films); a
 * range rendered into an earlier master must come from the same hash too.
 * Returns what it published; in Node it only returns it.
 * `publish({ fall, burst })` → { hash: "1c0e…", parts: { fall: "fddeaa2b", burst: "1ec63dd0" } }
 * @param {Record<string, Baked>} bakes @returns {{ hash: string, parts: Record<string, string> }}
 */
export function publish(bakes) {
  let h = 0x811c9dc5;
  /** @type {Record<string, string>} */ const parts = {};
  for (const [name, b] of Object.entries(bakes)) {
    parts[name] = b.hash;
    h = parseInt(fnv1a(b.frames, h), 16);
  }
  const info = { hash: (h >>> 0).toString(16).padStart(8, "0"), parts };
  if (typeof window !== "undefined") /** @type {any} */ (window).__bake = info;
  return info;
}

/** The farthest body `i` strays, in m, from the straight line fitted to its
 *  positions from step `from` to the last
 *  @param {any} F @param {Baked} b @param {number} i @param {number} from */
function stray(F, b, i, from) {
  const n = b.steps - from + 1;
  if (n < 3) return 0;
  const mid = (n - 1) / 2;
  let tt = 0;
  for (let k = 0; k < n; k++) tt += (k - mid) ** 2;
  /** @type {{ mean: number, slope: number }[]} */
  const fit = [0, 1, 2].map((ax) => {
    let mean = 0, slope = 0;
    for (let k = 0; k < n; k++) mean += F[((from + k) * b.n + i) * 7 + ax];
    mean /= n;
    for (let k = 0; k < n; k++) slope += (k - mid) * (F[((from + k) * b.n + i) * 7 + ax] - mean);
    return { mean, slope: slope / tt };
  });
  let far = 0;
  for (let k = 0; k < n; k++) {
    const p = ((from + k) * b.n + i) * 7;
    far = Math.max(far, Math.hypot(...fit.map(({ mean, slope }, ax) => F[p + ax] - mean - slope * (k - mid))));
  }
  return far;
}

/**
 * How a bake came to rest, from its last frames: each body's fastest speed and
 * spin over any `over` s (a frame at 30 fps) of the last `window` s, and
 * how far it strays from a steady line across that window over `over` (a
 * tremble at 30 or 60 Hz is back in place at every frame's comparison) — so
 * a body trembling in place, or turning on the spot, is not at rest, while
 * the engine's own sub-millimetre jitter from one step to the next, which no
 * film frame shows, does not count — its tilt (degrees between its own `up`
 * axis and the world's: "y" — upright either way up, as a chip that looks the
 * same both ways; "+y" — the right way up, as a logo; "any" — from the
 * nearest face, so a box lying on any side is level), and whether it fell
 * below `floor`. clean: everything still and level.
 * `settle(fall).clean` — in 20 seeds of the bar chart, the unclean ones were a
 * chip leaning on its neighbour (tilt), still creeping, or trembling a few
 * millimetres about one place (speed).
 * @param {Baked} b
 * @param {{ window?: number, over?: number, still?: number, spin?: number, level?: number,
 *   up?: "x" | "y" | "z" | "+x" | "+y" | "+z" | "any", floor?: number }} [o]
 *   still: m/s under which a body is at rest (0.05); spin: rad/s, the same for
 *   its turning (0.2); level: degrees under which it is level (10)
 */
export function settle(b, o = {}) {
  const { window: win = 0.2, over = 1 / 30, still = 0.05, spin: calm = 0.2, level = 10, up = "y", floor = -Infinity } = o;
  if (b.steps < 1) throw new Error("physics: settle() needs a bake of at least one step (its duration under dt)");
  const F = /** @type {any} */ (b.frames);
  const back = Math.min(b.steps, Math.max(1, Math.round(win / b.dt)));
  const m = Math.min(back, Math.max(1, Math.round(over / b.dt)));
  const last = b.steps * b.n * 7;
  const bodies = [];
  let maxSpeed = 0, maxSpin = 0, maxTilt = 0;
  for (let i = 0; i < b.n; i++) {
    const o1 = last + i * 7;
    const pos = [F[o1], F[o1 + 1], F[o1 + 2]];
    let speed = 0, spin = 0;
    for (let k = b.steps - back; k + m <= b.steps; k++) {
      const a = (k * b.n + i) * 7, c = a + m * b.n * 7;
      speed = Math.max(speed, Math.hypot(F[c] - F[a], F[c + 1] - F[a + 1], F[c + 2] - F[a + 2]) / (m * b.dt));
      const d = Math.abs(F[a + 3] * F[c + 3] + F[a + 4] * F[c + 4] + F[a + 5] * F[c + 5] + F[a + 6] * F[c + 6]);
      spin = Math.max(spin, (2 * Math.acos(Math.min(1, d))) / (m * b.dt));
    }
    // A tremble whose period divides `over` is back where it was at each
    // comparison. How far the body strays from a steady line through the
    // window, as a speed over `over`, catches it: a creep is on the line,
    // and the engine's sub-millimetre jitter strays too little to count.
    speed = Math.max(speed, stray(F, b, i, b.steps - back) / over);
    const [x, y, z, w] = [F[o1 + 3], F[o1 + 4], F[o1 + 5], F[o1 + 6]];
    // the world-y component of the body's own x, y and z axes
    const ups = { x: 2 * (x * y + w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z - w * x) };
    const c =
      up === "any"
        ? Math.max(...Object.values(ups).map(Math.abs))
        : up.startsWith("+")
          ? ups[/** @type {"x" | "y" | "z"} */ (up[1])]
          : Math.abs(ups[/** @type {"x" | "y" | "z"} */ (up)]);
    const tilt = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
    maxSpeed = Math.max(maxSpeed, speed);
    maxSpin = Math.max(maxSpin, spin);
    maxTilt = Math.max(maxTilt, tilt);
    bodies.push({ i, pos, speed: +speed.toFixed(4), spin: +spin.toFixed(4), tilt: +tilt.toFixed(2), fell: pos[1] < floor });
  }
  const moving = bodies.filter((x) => x.speed >= still || x.spin >= calm).map((x) => x.i);
  const tilted = bodies.filter((x) => x.tilt >= level).map((x) => x.i);
  const fell = bodies.filter((x) => x.fell).map((x) => x.i);
  return {
    clean: !moving.length && !tilted.length && !fell.length,
    moving,
    tilted,
    fell,
    maxSpeed: +maxSpeed.toFixed(4),
    maxSpin: +maxSpin.toFixed(4),
    maxTilt: +maxTilt.toFixed(2),
    bodies,
  };
}

// ---------------------------------------------------------------- assembly

/**
 * A scene that blows parts out from where they belong, with no gravity: baked
 * and played backwards (sim time running down to 0) it is the object
 * assembling, each part arriving tumbling along its own path. Parts fly out
 * from `center`, faster the further out they sit, and slow to a stop.
 *
 * Everything is in the object's own coordinates (parts' pos, center, floor):
 * the page adds where the object stands after sample(). Nothing stops a part
 * flying down, so an object on the ground would scatter through it: give
 * `floor` (the ground's y, in the object's coordinates) and no part's flight
 * ends below it (the downward ones are turned shallower, and a slab there
 * catches any knocked down).
 *
 * How far out: the centres of a 3×3×3 cube of 0.5 m parts (1.54 m across)
 * span about 3.4 times its size at snap()'s hold (0.36 of the burst), 3.7 at
 * 0.45, 4.6 at the end — frame the camera for that, or give snap() a smaller
 * hold.
 * @param {{ pos: V3, half: V3, r?: number, quat?: Q4 }[]} parts  each part at home
 * @param {{ seed?: number, center?: V3, speed?: number, spin?: number, scatter?: number,
 *   linDamp?: number, angDamp?: number, duration?: number, floor?: number }} [o]
 *   speed m/s (5), spin rad/s (6), scatter m/s of sideways noise (1.2), damping 1.6 / 1.2 a second,
 *   duration 1.8 s
 * @returns {Scene}
 */
export function explode(parts, o = {}) {
  const { seed = 11, center = [0, 0, 0], speed = 5, spin = 6, scatter = 1.2, linDamp = 1.6, angDamp = 1.2, duration = 1.8, floor } = o;
  const r = rng(seed);
  // how far a speed of 1 m/s carries a part, damped, in the burst
  const reach = linDamp > 0 ? (1 - Math.exp(-linDamp * duration)) / linDamp : duration;
  const bodies = parts.map((p) => {
    const d = [p.pos[0] - center[0], p.pos[1] - center[1], p.pos[2] - center[2]];
    const len = Math.hypot(...d) || 1;
    const v = speed * (0.7 + 0.6 * r());
    const linvel = /** @type {V3} */ (d.map((x) => (x / len) * v + (r() - 0.5) * scatter));
    if (floor != null) {
      const lowest = floor + Math.hypot(...p.half); // however it has turned
      linvel[1] = Math.max(linvel[1], Math.min(0, (lowest - p.pos[1]) / reach));
    }
    return {
      t: 0,
      half: p.half,
      r: p.r,
      pos: p.pos,
      quat: p.quat ?? /** @type {Q4} */ ([0, 0, 0, 1]),
      linvel,
      angvel: /** @type {V3} */ ([(r() - 0.5) * spin, (r() - 0.5) * spin, (r() - 0.5) * spin]),
      friction: 0.3,
      restitution: 0.3,
      linDamp,
      angDamp,
    };
  });
  /** @type {Static[]} */
  const statics = floor == null ? [] : [{ half: [50, 0.5, 50], pos: [center[0], floor - 0.5, center[2]] }];
  return { gravity: 0, duration, statics, bodies };
}

/**
 * An assembly order: the bottom layer first, then up, and within a layer
 * round the vertical axis — a thing built from the ground. Returns indices.
 * @param {V3[]} cells  each part's home position (or grid cell)
 * @param {{ axis?: 0 | 1 | 2, from?: number }} [o]  axis: up (1, y); from: the angle (rad) the round starts at
 * @returns {number[]}
 */
export function byLayers(cells, o = {}) {
  const { axis = 1, from = 0 } = o;
  const [a, b] = /** @type {[number, number]} */ ([0, 1, 2].filter((k) => k !== axis));
  /** @param {V3} c */
  const ang = (c) => {
    const x = Math.atan2(c[b] ?? 0, c[a] ?? 0) - from;
    return ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  };
  const q = 1e-6;
  return cells
    .map((_, i) => i)
    .sort((i, j) => {
      const ci = /** @type {V3} */ (cells[i]), cj = /** @type {V3} */ (cells[j]);
      const dy = Math.round(((ci[axis] ?? 0) - (cj[axis] ?? 0)) / q);
      return dy || ang(ci) - ang(cj) || i - j;
    });
}

/**
 * Each part's landing time, in the order given: `pair` parts land together,
 * the next pair `gap` s later. The reference's parts landed one or two at a
 * time; 0.06 s apart keeps 26 parts under a second (13 pairs: 0.72 s).
 * `const land = landings(byLayers(cells), 3.4)` → land[i] is part i's
 * @param {number[]} order  part indices, first to land first
 * @param {number} start  when the first pair lands (s)
 * @param {{ pair?: number, gap?: number }} [o]
 * @returns {number[]}  indexed by part
 */
export function landings(order, start, o = {}) {
  const { pair = 2, gap = 0.06 } = o;
  /** @type {number[]} */ const land = [];
  order.forEach((i, rank) => {
    land[i] = start + Math.floor(rank / Math.max(1, pair)) * gap;
  });
  return land;
}

/** @param {number} u */
const inOut3 = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);

/**
 * The snap assembly: where along its reversed burst a part is at film time t,
 * as a sim time to sample() the burst at (S: the burst's duration, its parts
 * furthest out; 0: home). Before its landing the part hangs as an exploded
 * view at `hold` of the burst (0.36: about 3.4 times the object's size, see
 * explode()) — from film time `from` on, drifting inward
 * `drift` (a share of S a second; 0.065 is 0.12 s of a 1.8 s burst) but never
 * nearer than `near`; without `from` it hangs still — then it crosses the rest
 * in `dur` s on an in-out cubic and is home, still, at land.
 *
 * Measured: the reference's wheel (a launch film's plane assembly, 23.4 s)
 * crossed in 4 frames at 30 fps — about 30, 120, 65, 20 px a frame, slow in,
 * fastest in the middle, slow out, no overshoot. dur 0.17 s on this cubic
 * measures the same: 4 frames of visible motion at 30 fps (0.133 s),
 * power1–2 in-out, 0 % overshoot (curve fit on a single part rendered alone).
 * Pair it with landings(): the parts snapping in, two by two.
 * `sample(burst, i, snap(t, land[i], burst.duration), m.position, m.quaternion)`
 * @param {number} t  film time (s)
 * @param {number} land  when this part is home (s)
 * @param {number} S  the burst's duration (s)
 * @param {{ dur?: number, hold?: number, near?: number, drift?: number, from?: number, ease?: (u: number) => number }} [o]
 * @returns {number}
 */
export function snap(t, land, S, o = {}) {
  const { dur = 0.17, hold = 0.36, near = 0.25, drift = 0.065, from, ease = inOut3 } = o;
  /** @param {number} x */
  const hover = (x) => S * Math.max(near, hold - (from == null ? 0 : drift * Math.max(0, x - from)));
  const t1 = land - dur;
  if (t < t1) return hover(t);
  if (t >= land) return 0;
  return hover(t1) * (1 - ease((t - t1) / dur));
}
