import type { Vector3 } from "three";

// Critically damped spring, integrated with the exact closed form so any frame
// rate lands on the same trajectory. `w` is the angular frequency: the product's
// punch-in (~730 ms to settle) is w≈8.2, its release ~1.8× slower is w≈4.6.
export class Spring1 {
  x: number;
  v = 0;
  target: number;
  w: number;

  constructor(value: number, w: number) {
    this.x = value;
    this.target = value;
    this.w = w;
  }

  step(dt: number): number {
    const dx = this.x - this.target;
    const e = Math.exp(-this.w * dt);
    const tmp = (this.v + this.w * dx) * dt;
    this.x = this.target + (dx + tmp) * e;
    this.v = (this.v - tmp * this.w) * e;
    return this.x;
  }

  snap(value: number): void {
    this.x = value;
    this.target = value;
    this.v = 0;
  }
}

export class Spring3 {
  readonly sx: Spring1;
  readonly sy: Spring1;
  readonly sz: Spring1;

  constructor(value: Vector3, w: number) {
    this.sx = new Spring1(value.x, w);
    this.sy = new Spring1(value.y, w);
    this.sz = new Spring1(value.z, w);
  }

  setW(w: number): void {
    this.sx.w = w;
    this.sy.w = w;
    this.sz.w = w;
  }

  setTarget(t: Vector3): void {
    this.sx.target = t.x;
    this.sy.target = t.y;
    this.sz.target = t.z;
  }

  step(dt: number, out: Vector3): Vector3 {
    return out.set(this.sx.step(dt), this.sy.step(dt), this.sz.step(dt));
  }

  snap(t: Vector3): void {
    this.sx.snap(t.x);
    this.sy.snap(t.y);
    this.sz.snap(t.z);
  }
}

export type Ease = (p: number) => number;
export const easeOutCubic: Ease = (p) => 1 - (1 - p) ** 3;
export const easeInOutCubic: Ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
export const easeOutBack: Ease = (p) => 1 + 2.3 * (p - 1) ** 3 + 1.3 * (p - 1) ** 2;

export interface Tween {
  t0: number;
  dur: number;
  ease: Ease;
  fn: (p: number) => void;
  done: boolean;
}

// A deliberately tiny tween pool: the timeline resets it wholesale on loop wrap.
export class Tweens {
  private list: Tween[] = [];

  add(now: number, dur: number, ease: Ease, fn: (p: number) => void, delay = 0): void {
    this.list.push({ t0: now + delay, dur, ease, fn, done: false });
  }

  step(now: number): void {
    for (const t of this.list) {
      if (t.done || now < t.t0) continue;
      const p = Math.min(1, (now - t.t0) / t.dur);
      t.fn(t.ease(p));
      if (p >= 1) t.done = true;
    }
    if (this.list.length > 64) this.list = this.list.filter((t) => !t.done);
  }

  clear(): void {
    this.list = [];
  }
}
