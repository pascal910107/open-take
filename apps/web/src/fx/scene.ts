import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  HemisphereLight,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector2,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { Cursor } from "./cursor";
import { buildMockApp } from "./mock-app";
import { Rig } from "./rig";
import { LOOP, Timeline } from "./timeline";

export interface StageHooks {
  shot(label: string): void;
  timecode(tc: string): void;
}

export interface StageApi {
  setTheme(theme: "light" | "dark"): void;
}

const FOV = 30;
const TAN_HALF = Math.tan((FOV * Math.PI) / 360);

// Neutral white radial, tinted via material.color — the iris glow behind the
// window in the dark theme, and (in black) the soft ground shadow in light.
function radialTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,0.34)");
  g.addColorStop(0.5, "rgba(255,255,255,0.10)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

function dust(): Points {
  const count = 150;
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    positions.push(
      (Math.random() - 0.5) * 7,
      (Math.random() - 0.5) * 4.4,
      -1.7 + Math.random() * 2.6,
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return new Points(
    geometry,
    new PointsMaterial({
      color: 0x8d86ff,
      size: 0.02,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.35,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function formatTC(tau: number): string {
  const s = Math.floor(tau);
  const f = Math.floor((tau - s) * 60);
  return `00:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

// Boot the hero stage. Returns null when WebGL is unavailable — the page
// stands on its own without it.
export function initStage(canvas: HTMLCanvasElement, hooks: StageHooks): StageApi | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new Scene();
  scene.background = new Color(0x08080b);
  scene.fog = new Fog(0x08080b, 9, 19);

  const camera = new PerspectiveCamera(FOV, 1, 0.1, 30);
  camera.position.set(0, 0.05, 6.4);

  const hemi = new HemisphereLight(0x32324a, 0x050507, 0.85);
  scene.add(hemi);
  const key = new DirectionalLight(0xffffff, 1.9);
  key.position.set(2.6, 3.4, 4.6);
  scene.add(key);
  const iris = new PointLight(0x7a74ff, 9, 9, 2);
  iris.position.set(-2.6, 1.5, 1.6);
  scene.add(iris);
  const fill = new PointLight(0x3a3a55, 5, 9, 2);
  fill.position.set(2.4, -1.5, 2.4);
  scene.add(fill);

  const radial = radialTexture();
  const glow = new Sprite(
    new SpriteMaterial({
      map: radial,
      color: 0x6e6ef7,
      blending: AdditiveBlending,
      depthWrite: false,
      opacity: 0.7,
    }),
  );
  glow.scale.set(6.6, 4.6, 1);
  glow.position.set(0.2, -0.15, -1.2);
  scene.add(glow);
  // hugs the window's base — a taller/softer blob reads as mist on paper
  const shadow = new Sprite(
    new SpriteMaterial({ map: radial, color: 0x141209, depthWrite: false, opacity: 0.28 }),
  );
  shadow.scale.set(4.9, 1.15, 1);
  shadow.position.set(0.1, -1.45, -0.7);
  shadow.visible = false;
  scene.add(shadow);
  const motes = dust();
  scene.add(motes);

  const app = buildMockApp();
  scene.add(app.group);
  const cursor = new Cursor(app.group);
  cursor.snap(0.95, -0.4);
  const rig = new Rig(camera);
  const timeline = new Timeline(app, cursor, rig, hooks);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.34, 0.85, 0.8);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = (): void => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    const aspect = w / h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    rig.frameX = aspect >= 1.45 ? -0.95 : aspect >= 1.05 ? -0.45 : 0;
    rig.wideZ = Math.max(6.4, 3.95 / (2 * TAN_HALF * aspect));
  };
  resize();
  rig.reset();
  window.addEventListener("resize", resize);

  let mx = 0;
  let my = 0;
  window.addEventListener("pointermove", (e) => {
    mx = (e.clientX / window.innerWidth) * 2 - 1;
    my = (e.clientY / window.innerHeight) * 2 - 1;
  });

  // Deterministic scrubbing for tooling (og-image capture, visual review):
  // advances the sim to a loop-local τ and renders one frame.
  (window as Window & { __takeSeek?: (tau: number) => void }).__takeSeek = (tau: number) => {
    const step = 1 / 60;
    let remaining = (tau - timeline.tau + LOOP) % LOOP;
    while (remaining > 0) {
      timeline.update(step);
      cursor.update(step);
      rig.update(step, 0, 0);
      remaining -= step;
    }
    const t = timeline.t;
    app.update(t);
    app.group.position.y = Math.sin(t * 0.55) * 0.035;
    app.group.rotation.y = Math.sin(t * 0.21) * 0.028;
    app.group.rotation.x = Math.cos(t * 0.27) * 0.016;
    hooks.timecode(formatTC(timeline.tau));
    composer.render();
  };

  // The light theme is the product's `paper` look: daylight studio, soft
  // ground shadow, no additive atmosphere (bloom/glow/dust die on white).
  const api: StageApi = {
    setTheme(theme) {
      const light = theme === "light";
      (scene.background as Color).setHex(light ? 0xf2f0e9 : 0x08080b);
      (scene.fog as Fog).color.setHex(light ? 0xf2f0e9 : 0x08080b);
      hemi.color.setHex(light ? 0xffffff : 0x32324a);
      hemi.groundColor.setHex(light ? 0xd9d9e2 : 0x050507);
      hemi.intensity = light ? 1.15 : 0.85;
      key.intensity = light ? 1.45 : 1.9;
      iris.intensity = light ? 3 : 9;
      fill.intensity = light ? 1.6 : 5;
      glow.visible = !light;
      motes.visible = !light;
      shadow.visible = light;
      bloom.enabled = !light;
      app.setTheme(light);
      cursor.setTheme(light);
      composer.render();
    },
  };

  const clock = new Clock();
  const frame = (): void => {
    const dt = Math.min(clock.getDelta(), 0.05);
    timeline.update(dt);
    const t = timeline.t;
    app.update(t);
    cursor.update(dt);
    rig.update(dt, mx, my);
    app.group.position.y = Math.sin(t * 0.55) * 0.035;
    app.group.rotation.y = Math.sin(t * 0.21) * 0.028 + mx * 0.045;
    app.group.rotation.x = Math.cos(t * 0.27) * 0.016 - my * 0.03;
    motes.rotation.y = t * 0.012;
    hooks.timecode(formatTC(timeline.tau));
    composer.render();
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Land on a composed mid-punch frame and hold it.
    for (let i = 0; i < Math.floor(3.6 * 60); i++) {
      timeline.update(1 / 60);
      cursor.update(1 / 60);
      rig.update(1 / 60, 0, 0);
    }
    app.update(timeline.t);
    app.group.position.y = 0;
    hooks.timecode(formatTC(timeline.tau));
    composer.render();
    return api;
  }

  let raf = 0;
  let visible = true;
  let onscreen = true;
  const running = (): boolean => visible && onscreen;
  const tick = (): void => {
    if (!running()) return;
    frame();
    raf = requestAnimationFrame(tick);
  };
  const start = (): void => {
    cancelAnimationFrame(raf);
    if (running()) {
      clock.getDelta();
      raf = requestAnimationFrame(tick);
    }
  };
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    start();
  });
  new IntersectionObserver(
    (entries) => {
      onscreen = entries[0]?.isIntersecting ?? true;
      start();
    },
    { threshold: 0.02 },
  ).observe(canvas);
  start();
  return api;
}

export { LOOP };
