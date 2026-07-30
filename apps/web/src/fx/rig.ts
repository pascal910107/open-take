import { type Object3D, type PerspectiveCamera, Vector3 } from "three";
import { Spring3 } from "./springs";

const PUNCH_W = 8.2; // ≈730 ms settle — the measured punch-in
const RELEASE_W = 4.6; // ≈1.8× slower on the way out
export const FOV = 30;
const TAN_HALF = Math.tan((FOV * Math.PI) / 360);

// The camera rig: one spring pair (position + look) chasing the current pose.
// `frameX` frames the miniature right-of-center under the hero copy; punches
// mostly recentre on their target so the zoomed subject owns the frame.
export class Rig {
  frameX = 0;
  wideZ = 6.4;
  private readonly pos: Spring3;
  private readonly look: Spring3;
  private readonly posOut = new Vector3();
  private readonly lookOut = new Vector3();
  private readonly par = new Vector3();
  private target: { obj: Object3D; mag: number } | null = null;
  private readonly world = new Vector3();

  constructor(private readonly cam: PerspectiveCamera) {
    this.pos = new Spring3(new Vector3(0, 0.05, this.wideZ), RELEASE_W);
    this.look = new Spring3(new Vector3(0, 0, 0), RELEASE_W);
  }

  wide(): void {
    this.target = null;
    this.pos.setW(RELEASE_W);
    this.look.setW(RELEASE_W);
  }

  punch(obj: Object3D, mag: number): void {
    this.target = { obj, mag };
    this.pos.setW(PUNCH_W);
    this.look.setW(PUNCH_W);
  }

  reset(): void {
    this.target = null;
    const p = new Vector3(this.frameX, 0.05, this.wideZ);
    this.pos.snap(p);
    this.look.snap(new Vector3(this.frameX, 0, 0));
  }

  update(dt: number, mouseX: number, mouseY: number): void {
    if (this.target) {
      const { obj, mag } = this.target;
      obj.getWorldPosition(this.world);
      const z = this.wideZ / mag;
      // Bias the subject into the right 60% of frame so the hero copy keeps
      // its dark column even while punched in.
      const shift = this.frameX === 0 ? 0 : -2 * z * TAN_HALF * this.cam.aspect * 0.12;
      this.pos.setTarget(new Vector3(this.world.x * 0.88 + shift, this.world.y * 0.85 + 0.03, z));
      this.look.setTarget(new Vector3(this.world.x * 0.94 + shift, this.world.y * 0.9, 0));
    } else {
      this.pos.setTarget(new Vector3(this.frameX, 0.05, this.wideZ));
      this.look.setTarget(new Vector3(this.frameX, 0, 0));
    }

    this.pos.step(dt, this.posOut);
    this.look.step(dt, this.lookOut);

    // Parallax rides on top of the spring and fades as the lens gets closer.
    const depth = this.posOut.z / this.wideZ;
    const k = 1 - Math.exp(-4 * dt);
    this.par.x += (mouseX * 0.16 * depth - this.par.x) * k;
    this.par.y += (-mouseY * 0.1 * depth - this.par.y) * k;

    this.cam.position.set(this.posOut.x + this.par.x, this.posOut.y + this.par.y, this.posOut.z);
    this.cam.lookAt(this.lookOut.x + this.par.x * 0.35, this.lookOut.y + this.par.y * 0.35, 0);
  }
}
