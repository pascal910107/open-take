// The starter's physics (starter/lib/physics.js, physics-seeds.mjs), on a
// stand-in engine that moves bodies in straight lines, so no engine file is
// needed: a bake records the poses the engine reports, step by step, with
// bodies held at their spawn pose until released; sample() lerps and slerps
// between steps; settle() tells still from moving and level from leaning;
// the snap timeline hangs, crosses in about four frames at 30 fps without
// overshooting, and lands its parts in pairs 0.06 s apart; the seed check
// bakes twice and reports what check() says. The adapters are checked against
// a stand-in of Bullet's own rules (damping clamped to 0..1, a motion state a
// step behind); with OPEN_TAKE_PHYSICS_ENGINES naming a folder that holds
// rapier.mjs and ammo.wasm.js (+ ammo.wasm.wasm), against the engines too.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  adapters,
  bake,
  cornerOf,
  engine,
  byLayers,
  DT,
  explode,
  fnv1a,
  landings,
  publish,
  quat,
  rng,
  sample,
  settle,
  snap,
} from "../starter/lib/physics.js";
import { checkSeeds, loadEngine, parseArgs, parseSeeds } from "../starter/lib/physics-seeds.mjs";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "../starter/lib");

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

/** a stand-in engine: bodies move at their linvel and spin at a fixed rate about z, nothing collides */
function lineEngine(log: string[] = []) {
  type B = { pos: V3; v: V3; angle: number; w: number; q0: Q4 };
  const bodies: B[] = [];
  return {
    setGravity(g: number) {
      log.push(`gravity ${g}`);
    },
    addStatic() {
      log.push("static");
    },
    addBody(b: { pos: V3; linvel?: V3; angvel?: V3; quat?: Q4 }) {
      const body = { pos: [...b.pos] as V3, v: b.linvel ?? [0, 0, 0], angle: 0, w: b.angvel?.[2] ?? 0, q0: b.quat ?? [0, 0, 0, 1] };
      bodies.push(body);
      log.push(`add ${bodies.length - 1}`);
      return body;
    },
    step(dt: number) {
      for (const b of bodies) {
        for (let k = 0; k < 3; k++) b.pos[k]! += b.v[k]! * dt;
        b.angle += b.w * dt;
      }
    },
    read(b: B, out: Float32Array, o: number) {
      out.set(b.pos, o);
      out.set([0, 0, Math.sin(b.angle / 2), Math.cos(b.angle / 2)], o + 3);
    },
    dispose() {
      log.push("dispose");
    },
  };
}

const at = (b: ReturnType<typeof bake>, step: number, i: number) =>
  Array.from(b.frames.subarray((step * b.n + i) * 7, (step * b.n + i) * 7 + 7));

test("rng and quat: seeded numbers, Euler angles as a quaternion", () => {
  const a = rng(7), b = rng(7), c = rng(8);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.notEqual(xs[0], c());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const q = quat(0, Math.PI / 2, 0);
  [0, Math.SQRT1_2, 0, Math.SQRT1_2].forEach((v, k) => {
    assert.ok(Math.abs(q[k]! - v) < 1e-12);
  });
  // three angles at once: about X, then the turned Y, then the turned Z (q = qx·qy·qz), as three.js's "XYZ"
  const mul = (a: Q4, b: Q4): Q4 => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const [x, y, z] = [0.3, -1.1, 2.2];
  const want = mul(mul([Math.sin(x / 2), 0, 0, Math.cos(x / 2)], [0, Math.sin(y / 2), 0, Math.cos(y / 2)]), [0, 0, Math.sin(z / 2), Math.cos(z / 2)]);
  quat(x, y, z).forEach((v, k) => {
    assert.ok(Math.abs(v - want[k]!) < 1e-12, `${quat(x, y, z)} vs ${want}`);
  });
});

test("bake records every step, holds a body at its spawn pose until released, and disposes the world", () => {
  const log: string[] = [];
  const scene = {
    gravity: -25,
    duration: 0.5,
    statics: [{ half: [1, 0.1, 1] as V3, pos: [0, 0, 0] as V3 }],
    bodies: [
      { t: 0, half: [0.1, 0.1, 0.1] as V3, pos: [0, 1, 0] as V3, linvel: [1, 0, 0] as V3 },
      { t: 0.25, half: [0.1, 0.1, 0.1] as V3, pos: [0, 2, 0] as V3, linvel: [0, -1, 0] as V3, quat: [0, 0, 0, 1] as Q4 },
    ],
  };
  const b = bake(lineEngine(log) as never, scene);
  assert.equal(b.dt, DT);
  assert.equal(b.steps, 60);
  assert.equal(b.n, 2);
  assert.equal(b.frames.length, 61 * 2 * 7);
  assert.deepEqual(log, ["gravity -25", "static", "add 0", "add 1", "dispose"]);
  // body 0 moves from the start: 1 m/s along x
  assert.ok(Math.abs(at(b, 60, 0)[0]! - 0.5) < 1e-5);
  // body 1 is at its spawn pose until 0.25 s (step 30), then falls 1 m/s
  assert.deepEqual(at(b, 29, 1).slice(0, 3), [0, 2, 0]);
  assert.ok(Math.abs(at(b, 60, 1)[1]! - (2 - 0.25)) < 1e-4);
  // the hash is the frames', the same for the same scene and not for another
  assert.equal(b.hash, fnv1a(b.frames));
  assert.equal(bake(lineEngine() as never, scene).hash, b.hash);
  const moved = { ...scene, bodies: [{ ...scene.bodies[0]!, linvel: [1.01, 0, 0] as V3 }, scene.bodies[1]!] };
  assert.notEqual(bake(lineEngine() as never, moved).hash, b.hash);
  // a world that throws is still disposed, wherever it throws
  for (const where of ["step", "setGravity", "addStatic"]) {
    const bad = { ...lineEngine(log), [where]() { throw new Error("boom"); } };
    log.length = 0;
    assert.throws(() => bake(bad as never, scene), /boom/);
    assert.equal(log.at(-1), "dispose", where);
  }
});

test("sample lerps position and slerps rotation between steps, holds at the ends, writes arrays or set()", () => {
  // one body: x 1 m/s, a quarter turn about z a second
  const b = bake(lineEngine() as never, {
    gravity: 0,
    duration: 1,
    statics: [],
    bodies: [{ half: [0.1, 0.1, 0.1], pos: [0, 0, 0], linvel: [1, 0, 0], angvel: [0, 0, Math.PI / 2] }],
  });
  const p = [0, 0, 0], q = [0, 0, 0, 0];
  // half way through a step: still on the line, and the angle in between
  const s = 10.5 * DT;
  sample(b, 0, s, p, q);
  assert.ok(Math.abs(p[0]! - s) < 1e-6);
  const angle = 2 * Math.atan2(q[2]!, q[3]!);
  assert.ok(Math.abs(angle - (Math.PI / 2) * s) < 1e-5, `angle ${angle}`);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6, "a unit quaternion");
  // held inside the bake
  sample(b, 0, -1, p);
  assert.equal(p[0], 0);
  sample(b, 0, 9, p);
  assert.ok(Math.abs(p[0]! - 1) < 1e-5);
  // into anything with set(), as a THREE.Vector3 or Quaternion
  const got: number[][] = [];
  sample(b, 0, 0.5, { set: (...v: number[]) => got.push(v) }, { set: (...v: number[]) => got.push(v) });
  assert.deepEqual(got[0]!.map((v) => +v.toFixed(5)), [0.5, 0, 0]);
  assert.deepEqual(got[1]!.map((v) => +v.toFixed(5)), [0, 0, +Math.sin(Math.PI / 8).toFixed(5), +Math.cos(Math.PI / 8).toFixed(5)]);
  // a body the bake does not have is an error, not another body's pose
  assert.throws(() => sample(b, 1, 0.5), RangeError);
  assert.throws(() => sample(b, -1, 0.5), RangeError);
  // the same s gives the same numbers, whatever was asked before
  const once = sample(b, 0, 0.37).quat.slice();
  sample(b, 0, 0.9);
  assert.deepEqual(sample(b, 0, 0.37).quat.slice(), once);
});

test("sample slerps along the shorter arc when the stored quaternions flip sign", () => {
  const frames = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -Math.sin(0.1), -Math.cos(0.1)]);
  const b = { frames, steps: 1, n: 1, dt: 1, duration: 1, hash: "" };
  const { quat: q } = sample(b, 0, 0.5);
  // the same rotation as +(0, 0, sin .1, cos .1), half way: 0.1 rad about z
  assert.ok(Math.abs(2 * Math.atan2(q[2]!, q[3]!) - 0.1) < 1e-5, `${q}`);
  // a slerp turns evenly, where a normalised lerp would not: a quarter of a 2.4 rad turn is 0.6 rad
  const wide = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, Math.sin(1.2), Math.cos(1.2)]);
  const w = sample({ ...b, frames: wide }, 0, 0.25).quat;
  assert.ok(Math.abs(2 * Math.atan2(w[2]!, w[3]!) - 0.6) < 1e-5, `${w}`);
});

test("settle tells still from moving and level from leaning", () => {
  const still = bake(lineEngine() as never, {
    gravity: 0,
    duration: 1,
    statics: [],
    bodies: [
      { half: [0.1, 0.1, 0.1], pos: [0, 0, 0] },
      { half: [0.1, 0.1, 0.1], pos: [1, 0, 0], quat: quat(0, 0, 0.5) },
      { half: [0.1, 0.1, 0.1], pos: [2, 0, 0], linvel: [0, 0.2, 0] },
      { half: [0.1, 0.1, 0.1], pos: [3, 0, 0], quat: quat(Math.PI / 2, 0, 0) },
    ],
  });
  // the stand-in engine reports its own rotation, not the spawn's: lean them by hand, all along
  for (let k = 0; k <= still.steps; k++) {
    still.frames.set(quat(0, 0, 0.5), (k * still.n + 1) * 7 + 3);
    still.frames.set(quat(Math.PI / 2, 0, 0), (k * still.n + 3) * 7 + 3);
  }
  const s = settle(still);
  assert.equal(s.clean, false);
  assert.deepEqual(s.moving, [2]);
  assert.deepEqual(s.tilted, [1, 3]);
  assert.ok(Math.abs(s.bodies[2]!.speed - 0.2) < 1e-3);
  assert.ok(Math.abs(s.bodies[1]!.tilt - (0.5 * 180) / Math.PI) < 0.01);
  // lying on another face is level when any face will do
  assert.deepEqual(settle(still, { up: "any" }).tilted, [1]);
  assert.deepEqual(settle(still, { still: 0.5, level: 45 }).moving, []);
  assert.deepEqual(settle(still, { floor: 1 }).fell, [0, 1, 2, 3]);
});

test("settle catches a body trembling in place or turning on the spot, and reads which way up", () => {
  const b = bake(lineEngine() as never, {
    gravity: 0,
    duration: 1,
    statics: [],
    bodies: [
      { half: [0.1, 0.1, 0.1], pos: [0, 0, 0] },
      { half: [0.1, 0.1, 0.1], pos: [1, 0, 0] },
      { half: [0.1, 0.1, 0.1], pos: [2, 0, 0], quat: quat(Math.PI, 0, 0) },
    ],
  });
  // body 0 shakes 5 mm either way at 15 Hz and is back where it started at the end;
  // body 1 turns a full turn a second about y and ends where it began
  for (let k = 0; k <= b.steps; k++) {
    b.frames[(k * b.n) * 7] = 0.005 * Math.sin(2 * Math.PI * 15 * k * b.dt);
    b.frames.set(quat(0, 2 * Math.PI * k * b.dt, 0), (k * b.n + 1) * 7 + 3);
    b.frames.set(quat(Math.PI, 0, 0), (k * b.n + 2) * 7 + 3);
  }
  const s = settle(b);
  assert.deepEqual(s.moving, [0, 1]);
  assert.ok(s.bodies[0]!.speed > 0.2, `${s.bodies[0]!.speed}`);
  assert.ok(Math.abs(s.bodies[1]!.spin - 2 * Math.PI) < 0.01, `${s.bodies[1]!.spin}`);
  // upside down: upright for a chip ("y"), not for a logo ("+y")
  assert.deepEqual(s.tilted, []);
  assert.deepEqual(settle(b, { up: "+y" }).tilted, [2]);
  // a bake of no steps says nothing about rest
  const none = bake(lineEngine() as never, { gravity: 0, duration: 0, statics: [], bodies: [{ half: [1, 1, 1], pos: [0, 0, 0] }] });
  assert.throws(() => settle(none), /at least one step/);
});

test("settle catches a tremble whose period divides a frame, and lets jitter and creep be", () => {
  const one = (x: (k: number, dt: number) => number) => {
    const b = bake(lineEngine() as never, {
      gravity: 0, duration: 1, statics: [], bodies: [{ half: [0.1, 0.1, 0.1], pos: [0, 0, 0] }],
    });
    for (let k = 0; k <= b.steps; k++) b.frames[k * 7] = x(k, b.dt);
    return settle(b);
  };
  for (const hz of [30, 60])
    assert.deepEqual(one((k, dt) => 0.005 * Math.sin(2 * Math.PI * hz * k * dt + 0.7)).moving, [0], `${hz} Hz`);
  assert.deepEqual(one((k) => (k % 2 ? 0.003 : -0.003)).moving, [0], "±3 mm every step");
  assert.deepEqual(one((k) => (k % 2 ? 0.0003 : -0.0003)).moving, [], "the engine's ±0.3 mm");
  assert.deepEqual(one((k, dt) => 0.03 * k * dt).moving, [], "a creep under `still`");
});

test("publish hashes every bake into one, in order", () => {
  const mk = (v: number) =>
    bake(lineEngine() as never, { gravity: 0, duration: 0.1, statics: [], bodies: [{ half: [1, 1, 1], pos: [0, 0, 0], linvel: [v, 0, 0] }] });
  const a = mk(1), b = mk(2);
  const p = publish({ a, b });
  assert.deepEqual(p.parts, { a: a.hash, b: b.hash });
  assert.equal(p.hash, fnv1a(b.frames, parseInt(fnv1a(a.frames), 16)));
  assert.notEqual(publish({ b, a }).hash, p.hash);
  assert.match(p.hash, /^[0-9a-f]{8}$/);
});

test("explode blows parts outward from the centre with no gravity, the same for the same seed", () => {
  const parts = [
    { pos: [1, 0, 0] as V3, half: [0.25, 0.25, 0.25] as V3 },
    { pos: [0, -1, 0] as V3, half: [0.25, 0.25, 0.25] as V3 },
  ];
  const s = explode(parts);
  assert.equal(s.gravity, 0);
  assert.equal(s.bodies.length, 2);
  assert.ok(s.bodies[0]!.linvel![0] > 2, "the part at +x leaves along +x");
  assert.ok(s.bodies[1]!.linvel![1] < -2, "the part at -y leaves along -y");
  assert.deepEqual(explode(parts), s);
  assert.notDeepEqual(explode(parts, { seed: 12 }), s);
  // on the ground: no part flies further down than the floor, and a slab there catches any knocked down
  const onGround = explode(parts, { floor: -1.25 });
  const reach = (1 - Math.exp(-1.6 * 1.8)) / 1.6;
  const clear = -1.25 + Math.hypot(0.25, 0.25, 0.25);
  for (const b of onGround.bodies) assert.ok(b.pos[1] + b.linvel![1] * reach >= Math.min(b.pos[1], clear) - 1e-9, `${b.pos} ${b.linvel}`);
  assert.equal(onGround.bodies[1]!.linvel![1], 0, "a part already near the floor goes no lower");
  assert.equal(onGround.bodies[0]!.linvel![0], s.bodies[0]!.linvel![0], "sideways it flies the same");
  assert.deepEqual(onGround.statics, [{ half: [50, 0.5, 50], pos: [0, -1.75, 0] }]);
});

test("a box's corners: 0.04 m, a quarter of a small box's half, and never as round as the box", () => {
  assert.equal(cornerOf({ half: [0.5, 0.2, 0.5], pos: [0, 0, 0] }), 0.04);
  assert.equal(cornerOf({ half: [0.5, 0.08, 0.5], pos: [0, 0, 0] }), 0.02);
  assert.equal(cornerOf({ half: [0.5, 0.2, 0.5], r: 0, pos: [0, 0, 0] }), 0);
  assert.throws(() => cornerOf({ half: [0.2, 0.2, 0.2], r: 0.2, pos: [0, 0, 0] }), /under the smallest half/);
  assert.throws(() => cornerOf({ half: [0.2, 0.2, 0.2], r: 0.3, pos: [0, 0, 0] }), /shape: "ball"/);
});

/** a stand-in of ammo.js that keeps Bullet's own rules where they differ from Rapier's:
 *  setDamping clamps to 0..1 and keeps (1 - d)^dt of the speed a step; the motion
 *  state's transform is the one from before the last step */
function bulletLike() {
  const log: string[] = [];
  const vec = (x = 0, y = 0, z = 0) => ({ v: [x, y, z], x: () => vec.self.v[0], setValue() {} }) as never;
  vec.self = { v: [0, 0, 0] };
  class Transform {
    o = [0, 0, 0];
    q = [0, 0, 0, 1];
    setIdentity() {}
    setOrigin(v: { v: number[] }) { this.o = [...v.v]; }
    setRotation(q: { q: number[] }) { this.q = [...q.q]; }
    getOrigin() { return { x: () => this.o[0], y: () => this.o[1], z: () => this.o[2] }; }
    getRotation() { return { x: () => this.q[0], y: () => this.q[1], z: () => this.q[2], w: () => this.q[3] }; }
  }
  const tf = () => new Transform();
  const clamp = (d: number) => Math.min(1, Math.max(0, d));
  class Body {
    now = tf(); before = tf(); v = [0, 0, 0]; lin = 0;
    constructor(info: { t: ReturnType<typeof tf> }) { this.now.o = [...info.t.o]; this.before.o = [...info.t.o]; }
    setFriction() {} setRestitution() {} setActivationState() {}
    setDamping(l: number) { this.lin = clamp(l); log.push(`damping ${l.toFixed(4)}`); }
    setLinearVelocity(v: { v: number[] }) { this.v = [...v.v]; }
    setAngularVelocity() {}
    getWorldTransform() { return this.now; }
    getMotionState() { return { getWorldTransform: (out: ReturnType<typeof tf>) => Object.assign(out, { o: [...this.before.o], q: [...this.before.q] }) }; }
  }
  const bodies: Body[] = [];
  const A = {
    btDefaultCollisionConfiguration: class {}, btCollisionDispatcher: class {}, btDbvtBroadphase: class {},
    btSequentialImpulseConstraintSolver: class {},
    btDiscreteDynamicsWorld: class {
      setGravity() {}
      addRigidBody(b: Body) { bodies.push(b); }
      removeRigidBody() {}
      stepSimulation(dt: number) {
        for (const b of bodies) {
          b.v = b.v.map((x) => x * (1 - b.lin) ** dt);
          b.before.o = [...b.now.o];
          b.now.o = b.now.o.map((x, k) => x + b.v[k]! * dt);
        }
      }
    },
    btTransform: Transform,
    btVector3: class { v: number[]; constructor(x: number, y: number, z: number) { this.v = [x, y, z]; } },
    btQuaternion: class { q: number[]; constructor(x: number, y: number, z: number, w: number) { this.q = [x, y, z, w]; } },
    btDefaultMotionState: class { t: unknown; constructor(t: unknown) { this.t = t; } },
    btRigidBodyConstructionInfo: class { t: unknown; constructor(_m: number, ms: { t: unknown }) { this.t = ms.t; } },
    btRigidBody: Body,
    btBoxShape: class { setMargin(m: number) { log.push(`margin ${m}`); } calculateLocalInertia() {} },
    btSphereShape: class { calculateLocalInertia() {} },
    destroy() {},
  };
  return { A, log };
}

test("the ammo adapter: damping means what it means in Rapier, and a pose is read at its own step", () => {
  const { A, log } = bulletLike();
  // explode()'s damping, 1.6 a second, would be clamped to 1 and stop the part dead
  const b = bake(adapters.ammo(A), {
    gravity: 0,
    duration: 1,
    statics: [],
    bodies: [{ half: [0.25, 0.25, 0.25], pos: [0, 0, 0], linvel: [1, 0, 0], linDamp: 1.6 }],
  });
  assert.ok(log.includes(`damping ${(1 - Math.exp(-1.6)).toFixed(4)}`), log.join(", "));
  assert.ok(log.includes("margin 0.04"), "rounded as Rapier rounds it");
  // the first step has moved it, not the second: x = v·dt·(1 - d)^dt
  assert.ok(Math.abs(at(b, 1, 0)[0]! - DT * Math.exp(-1.6 * DT)) < 1e-6, `${at(b, 1, 0)[0]}`);
  // and it travels as a speed falling as e^(-1.6 t) carries it, step by step: dt·q(1 - q^N)/(1 - q), q = e^(-1.6 dt)
  const q = Math.exp(-1.6 * DT);
  assert.ok(Math.abs(at(b, b.steps, 0)[0]! - (DT * q * (1 - q ** b.steps)) / (1 - q)) < 1e-5, `${at(b, b.steps, 0)[0]}`);
});

test("engine() loads ammo once a page, though its script puts the module where the factory was", async () => {
  const g = globalThis as Record<string, unknown>;
  let scripts = 0, inits = 0;
  const module = { tag: "ammo" };
  g.window = g;
  g.document = {
    baseURI: "http://film.test/",
    head: {
      append(s: { onload: () => void }) {
        scripts++;
        g.Ammo = () => {
          inits++;
          g.Ammo = module; // what the build does: this.Ammo = its module
          return Promise.resolve(module);
        };
        queueMicrotask(s.onload);
      },
    },
    createElement: () => ({}),
  };
  try {
    const a = await engine("./vendor/ammo.wasm.js");
    const b = await engine("./vendor/ammo.wasm.js");
    assert.equal(a.module, module);
    assert.equal(b, a);
    assert.deepEqual([scripts, inits], [1, 1]);
  } finally {
    delete g.window;
    delete g.document;
    delete g.Ammo;
  }
});

test("byLayers puts the bottom layer first, round the axis within a layer; landings pair them 0.06 s apart", () => {
  const cells: V3[] = [
    [0, 1, 0],
    [1, -1, 0],
    [-1, -1, 0],
    [0, -1, 1],
    [0, 0, 1],
  ];
  const order = byLayers(cells);
  assert.deepEqual(order.slice(0, 3).sort(), [1, 2, 3]);
  assert.deepEqual(order.slice(3), [4, 0]);
  // within the bottom layer by angle from +x towards +z: (1,0) at 0, (0,1) at 90°, (-1,0) at 180°
  assert.deepEqual(order.slice(0, 3), [1, 3, 2]);
  const land = landings(order, 3.4);
  assert.deepEqual(
    order.map((i) => +land[i]!.toFixed(3)),
    [3.4, 3.4, 3.46, 3.46, 3.52],
  );
  assert.deepEqual(
    order.map((i) => +landings(order, 1, { pair: 1, gap: 0.1 })[i]!.toFixed(3)),
    [1, 1.1, 1.2, 1.3, 1.4],
  );
});

test("snap hangs, then crosses in about four frames at 30 fps, fastest in the middle, without overshoot", () => {
  const S = 1.8, land = 4, hold = 0.36;
  // hanging: still at hold of the way out, or drifting in from `from`
  assert.equal(snap(3, land, S), hold * S);
  assert.equal(snap(3.5, land, S), hold * S);
  assert.ok(snap(3.5, land, S, { from: 3 }) < snap(3.2, land, S, { from: 3 }));
  assert.equal(snap(30, 40, S, { from: 0 }), 0.25 * S, "never nearer than `near`");
  assert.equal(snap(land, land, S), 0);
  assert.equal(snap(land + 1, land, S), 0);
  // at 30 fps, whatever the phase of the landing against the frames
  for (const phase of [0, 0.25, 0.5, 0.75]) {
    const L = land + phase / 30;
    const xs = Array.from({ length: 16 }, (_, k) => snap((110 + k) / 30, L, S));
    const steps = xs.slice(1).map((x, k) => (xs[k]! - x) / (hold * S));
    assert.ok(steps.every((d) => d >= 0), "never goes back out: no overshoot");
    assert.ok(Math.abs(steps.reduce((a, b) => a + b, 0) - 1) < 1e-9, "the whole way");
    const moving = steps.filter((d) => d > 0.05).length;
    assert.ok(moving >= 3 && moving <= 4, `phase ${phase}: ${moving} frames move`);
    const big = steps.indexOf(Math.max(...steps));
    const first = steps.findIndex((d) => d > 0.05), lastMoving = steps.length - 1 - [...steps].reverse().findIndex((d) => d > 0.05);
    assert.ok(big > first && big <= lastMoving, "slow in, fastest after the first frame");
  }
});

test("the seed check: parses seed lists, bakes each twice and reports what check() says", () => {
  assert.deepEqual(parseSeeds("1-4"), [1, 2, 3, 4]);
  assert.deepEqual(parseSeeds("3,7,10-11"), [3, 7, 10, 11]);
  assert.deepEqual(parseSeeds("1, 2"), [1, 2]);
  for (const bad of ["3-1", "abc", "", "1,,2", "2.5"]) assert.throws(() => parseSeeds(bad), /not a seed/, bad);
  const scene = (seed: number) => ({
    gravity: 0,
    duration: 0.5,
    statics: [],
    bodies: [{ half: [0.1, 0.1, 0.1] as V3, pos: [0, 0, 0] as V3, linvel: [seed % 2 ? 1 : 0, 0, 0] as V3 }],
  });
  // without check(): settle() decides — odd seeds keep moving
  const rows = checkSeeds({ scene }, () => lineEngine() as never, [1, 2]);
  assert.deepEqual(
    rows.map((r) => [r.seed, r.ok]),
    [
      [1, false],
      [2, true],
    ],
  );
  assert.ok(rows.every((r) => "same" in r && r.same));
  // with check(): the film's own judgement, with its notes
  const judged = checkSeeds({ scene, check: (b) => ({ ok: b.n === 1, note: "one body" }) }, () => lineEngine() as never, [1]);
  assert.equal(judged[0]!.ok, true);
  assert.deepEqual("verdict" in judged[0]! && judged[0].verdict, { ok: true, note: "one body" });
  // a scene that is not the same twice is never clean
  let n = 0;
  const drifting = (seed: number) => ({ ...scene(seed), duration: 0.5 + 0.1 * n++ });
  const d = checkSeeds({ scene: drifting }, () => lineEngine() as never, [2]);
  assert.equal(d[0]!.ok, false);
  assert.equal("same" in d[0]! && d[0].same, false);
  // an engine that throws is a row, not a crash
  const boom = checkSeeds({ scene }, () => ({ ...lineEngine(), step() { throw new Error("boom"); } }) as never, [1]);
  assert.match("error" in boom[0]! ? boom[0].error : "", /boom/);
  // so is a scene that throws for one seed: the seeds after it are still checked
  const picky = (seed: number) => {
    if (seed === 1) throw new Error("no seed 1");
    return scene(seed);
  };
  const rows2 = checkSeeds({ scene: picky }, () => lineEngine() as never, [1, 2]);
  assert.match("error" in rows2[0]! ? rows2[0].error : "", /no seed 1/);
  assert.equal(rows2[1]!.ok, true);
});

test("the seed command: reads its flags strictly, runs from any path, says by its exit whether a seed was clean", () => {
  assert.deepEqual(parseArgs(["s.mjs", "e/rapier.mjs", "--seeds", "2-3", "--json"]), {
    sceneFile: "s.mjs", engineFile: "e/rapier.mjs", seeds: [2, 3], sceneName: "scene", checkName: "check", checkGiven: false, json: true,
  });
  assert.equal(parseArgs(["s.mjs", "e.mjs", "--check", "mine"]).checkGiven, true);
  assert.throws(() => parseArgs(["s.mjs", "e.mjs", "--seed", "5"]), /no option --seed/);
  assert.throws(() => parseArgs(["s.mjs", "e.mjs", "--seeds"]), /needs a value/);
  assert.throws(() => parseArgs(["s.mjs"]), /usage/);

  const dir = mkdtempSync(join(tmpdir(), "physics seeds "));
  try {
    // a copy in a folder with a space in its name, and a link to the real one
    cpSync(LIB, join(dir, "my film", "lib"), { recursive: true });
    symlinkSync(LIB, join(dir, "linked"));
    writeFileSync(join(dir, "scene.mjs"), `export const scene = (seed) => ({ gravity: 0, duration: 0.1, statics: [], bodies: [{ half: [0.1, 0.1, 0.1], pos: [0, 0, 0], linvel: [seed % 2, 0, 0] }] });\nexport const check = (b, s) => ({ ok: s.bodies[0].linvel[0] === 0 });\n`);
    writeFileSync(join(dir, "rapier-standin.mjs"), `export default { init: async () => {}, World: class {} };\n`);
    for (const script of [join(dir, "my film", "lib", "physics-seeds.mjs"), join(dir, "linked", "physics-seeds.mjs")]) {
      const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
      assert.equal(r.status, 2, `${script}: ${r.stderr}`);
      assert.match(r.stderr, /usage/);
    }
    const run = (seeds: string, check = "check") =>
      spawnSync(process.execPath, [join(LIB, "physics-seeds.mjs"), join(dir, "scene.mjs"), join(dir, "rapier-standin.mjs"), "--seeds", seeds, "--check", check], { encoding: "utf8" });
    // the stand-in world can't be stepped: every seed throws, and the command says so
    assert.equal(run("1-2").status, 1);
    const nope = run("2", "nope");
    assert.notEqual(nope.status, 0);
    assert.match(nope.stderr, /exports no nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEngine puts console.warn back, however many load at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "physics-engines-"));
  const warn = console.warn;
  try {
    // the first to start ends first: it must not hand the second's silence back
    writeFileSync(join(dir, "rapier-a.mjs"), `export default { init: async () => { await new Promise((r) => setTimeout(r, 5)); } };\n`);
    writeFileSync(join(dir, "rapier-b.mjs"), `export default { init: async () => { await new Promise((r) => setTimeout(r, 30)); } };\n`);
    await Promise.all([loadEngine(join(dir, "rapier-a.mjs")), loadEngine(join(dir, "rapier-b.mjs"))]);
    assert.equal(console.warn, warn);
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the engines themselves, when a folder of them is named ----------------------------

const ENGINES = process.env.OPEN_TAKE_PHYSICS_ENGINES;
const files = ENGINES ? ["rapier.mjs", "ammo.wasm.js"].map((f) => join(ENGINES, f)) : [];

test("Rapier and ammo take a scene the same way: the same step, damping, corners", {
  skip: !(files.length && files.every(existsSync)) && "OPEN_TAKE_PHYSICS_ENGINES names no folder with rapier.mjs and ammo.wasm.js",
}, async () => {
  const floor = { half: [5, 0.5, 5] as V3, pos: [0, -0.5, 0] as V3 };
  const parts = [
    { pos: [1, 0, 0] as V3, half: [0.25, 0.25, 0.25] as V3 },
    { pos: [0, 1, 0] as V3, half: [0.25, 0.25, 0.25] as V3 },
  ];
  const got: Record<string, number[]> = {};
  for (const f of files) {
    const { kind, make } = await loadEngine(f);
    const line = bake(make(), { gravity: 0, duration: 2 * DT, statics: [], bodies: [{ half: [0.1, 0.1, 0.1], pos: [0, 0, 0], linvel: [1, 0, 0] }] });
    const burst = bake(make(), explode(parts));
    const drop = bake(make(), { gravity: -25, duration: 1.5, statics: [floor], bodies: [{ half: [0.2, 0.2, 0.2], pos: [0, 1, 0] }] });
    got[kind] = [at(line, 1, 0)[0]!, at(burst, burst.steps, 0)[0]!, at(burst, burst.steps, 1)[1]!, at(drop, drop.steps, 0)[1]!];
    assert.throws(() => bake(make(), { gravity: 0, duration: 0.1, statics: [], bodies: [{ half: [0.2, 0.2, 0.2], r: 0.2, pos: [0, 0, 0] }] }), /smallest half/);
  }
  for (const [kind, [step1, x, y, rest]] of Object.entries(got)) {
    assert.ok(Math.abs(step1! - DT) < 1e-6, `${kind}: moved ${step1} in the first step`);
    assert.ok(x! > 3 && y! > 3, `${kind}: the burst's parts went out to ${x}, ${y}`);
    assert.ok(Math.abs(rest! - 0.2) < 0.005, `${kind}: came to rest at ${rest}`);
  }
});
