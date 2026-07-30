import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type Object3D,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import { Spring1 } from "./springs";

const Z = 0.24; // above the modal layer, below the lens

// Neutral white glow — every accent tint is applied via material.color so the
// look switcher can restyle the cursor without regenerating textures.
function glowTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.3)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

interface Ripple {
  mesh: Mesh<RingGeometry, MeshBasicMaterial>;
  born: number;
}

// The synthetic cursor: a spring-driven dot with an additive trail and click
// ripples. Lives inside the window group so it rides the idle float.
export class Cursor {
  readonly group = new Group();
  private readonly sx = new Spring1(0, 9.5);
  private readonly sy = new Spring1(0, 9.5);
  private readonly core: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly halo: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly glow: Sprite;
  private readonly trail: Sprite[] = [];
  private readonly history: Vector3[] = [];
  private readonly ripples: Ripple[] = [];
  private light = false;
  private now = 0;
  private clickAt = -1;

  constructor(parent: Object3D) {
    const tex = glowTexture();
    this.core = new Mesh(
      new CircleGeometry(0.021, 32),
      new MeshBasicMaterial({ color: 0xf4f3ff, transparent: true, opacity: 0.95 }),
    );
    this.core.renderOrder = 30;
    this.core.material.depthTest = false;

    this.halo = new Mesh(
      new RingGeometry(0.026, 0.033, 32),
      new MeshBasicMaterial({ color: 0x8d86ff, transparent: true, opacity: 0.5 }),
    );
    this.halo.renderOrder = 29;
    this.halo.material.depthTest = false;

    this.glow = new Sprite(
      new SpriteMaterial({
        map: tex,
        color: 0x8d86ff,
        blending: AdditiveBlending,
        depthWrite: false,
        opacity: 0.42,
      }),
    );
    this.glow.scale.setScalar(0.095);
    this.glow.renderOrder = 28;

    this.group.add(this.glow, this.halo, this.core);
    this.group.position.z = Z;

    for (let i = 0; i < 10; i++) {
      const s = new Sprite(
        new SpriteMaterial({
          map: tex,
          color: 0x8d86ff,
          blending: AdditiveBlending,
          depthWrite: false,
          opacity: 0,
        }),
      );
      s.scale.setScalar(0.14);
      s.renderOrder = 27;
      parent.add(s);
      this.trail.push(s);
    }
    parent.add(this.group);
  }

  // On the light app the cursor is a dark dot — additive glow dies on white.
  setTheme(light: boolean): void {
    this.light = light;
    this.core.material.color.setHex(light ? 0x24242c : 0xf4f3ff);
    this.halo.material.color.setHex(light ? 0x5f5edd : 0x8d86ff);
    this.glow.visible = !light;
  }

  moveTo(x: number, y: number, w = 9.5): void {
    this.sx.target = x;
    this.sy.target = y;
    this.sx.w = w;
    this.sy.w = w;
  }

  snap(x: number, y: number): void {
    this.sx.snap(x);
    this.sy.snap(y);
    this.history.length = 0;
  }

  click(parent: Object3D): void {
    this.clickAt = this.now;
    const ring = new Mesh(
      new RingGeometry(0.85, 1, 40),
      new MeshBasicMaterial({
        color: this.light ? 0x5f5edd : 0x8d86ff,
        transparent: true,
        opacity: this.light ? 0.55 : 0.8,
        blending: this.light ? NormalBlending : AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.position.set(this.group.position.x, this.group.position.y, Z - 0.02);
    ring.scale.setScalar(0.05);
    ring.renderOrder = 26;
    parent.add(ring);
    this.ripples.push({ mesh: ring, born: this.now });
  }

  get position(): Vector3 {
    return this.group.position;
  }

  update(dt: number): void {
    this.now += dt;
    const x = this.sx.step(dt);
    const y = this.sy.step(dt);
    this.group.position.set(x, y, Z);

    const dip = this.now - this.clickAt;
    const scale = dip >= 0 && dip < 0.14 ? 0.82 : 1;
    this.core.scale.setScalar(scale);

    this.history.unshift(new Vector3(x, y, Z - 0.01));
    if (this.history.length > 30) this.history.pop();
    const speed = Math.hypot(this.sx.v, this.sy.v);
    const heat = Math.min(1, speed * 1.4);
    for (let i = 0; i < this.trail.length; i++) {
      const s = this.trail[i]!;
      const h = this.history[Math.min(this.history.length - 1, (i + 1) * 2)];
      if (h) s.position.copy(h);
      const fall = (1 - i / this.trail.length) ** 2;
      s.material.opacity = this.light ? 0 : 0.4 * fall * heat;
      s.scale.setScalar(0.085 * (1 - (i / this.trail.length) * 0.6));
    }

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i]!;
      const p = (this.now - r.born) / 0.55;
      if (p >= 1) {
        r.mesh.removeFromParent();
        r.mesh.geometry.dispose();
        r.mesh.material.dispose();
        this.ripples.splice(i, 1);
        continue;
      }
      const e = 1 - (1 - p) ** 3;
      r.mesh.scale.setScalar(0.05 + e * 0.4);
      r.mesh.material.opacity = 0.8 * (1 - e);
    }
  }
}
