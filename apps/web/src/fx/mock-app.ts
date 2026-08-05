import {
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { C } from "./palette";

// The miniature being filmed: a fictional dashboard built from rounded slabs.
// No textures, no text — bars stand in for words, so it reads as "an app"
// at every zoom level without claiming to be any app in particular.

// The miniature's light mode: the same fictional app with its lights on.
// Anything not in the map (traffic lights, blacks) keeps its color.
const LIGHT: Record<number, number> = {
  1052693: 0xfcfcfe, // window shell
  789520: 0xf0f0f4, // screen
  1513243: 0xe6e6ec, // panel / pills
  1842211: 0xffffff, // cards
  2368555: 0xebebf1, // card-hi (active pill)
  2960695: 0xffffff, // modal card
  3026488: 0xc2c2cc, // text bars
  2302761: 0xdedee6, // dim text bars
  921107: 0xebebf0, // inset field
  5000279: 0x8b8b96, // stat number
  10329514: 0x74747e, // modal title
  7237367: 0x5f5edd, // acc
  9275135: 0x6e6ef7, // acc-hi
  14342399: 0xffffff, // button label bars
  8309135: 0x37985c, // ok green
};

const geoCache = new Map<string, RoundedBoxGeometry>();
function geo(w: number, h: number, d: number, r: number): RoundedBoxGeometry {
  const key = `${w}|${h}|${d}|${r}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 2, r);
    geoCache.set(key, g);
  }
  return g;
}

interface SlabOpts {
  r?: number;
  emissive?: number;
  glow?: number;
  opacity?: number;
  rough?: number;
}

// Materials are never shared: groups fade as a whole, so every mesh owns its
// opacity. baseOpacity is what setOpacity() multiplies back in.
function slab(w: number, h: number, d: number, color: number, opts: SlabOpts = {}): Mesh {
  const m = new MeshStandardMaterial({
    color,
    roughness: opts.rough ?? 0.62,
    metalness: 0.18,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.glow ?? 0,
    transparent: true,
    opacity: opts.opacity ?? 1,
  });
  m.userData.baseOpacity = opts.opacity ?? 1;
  m.userData.baseColor = color;
  m.userData.baseEmissive = opts.emissive ?? 0x000000;
  m.userData.baseGlow = opts.glow ?? 0;
  const mesh = new Mesh(geo(w, h, d, Math.min(opts.r ?? Math.min(w, h) * 0.28, w / 2, h / 2)), m);
  return mesh;
}

export function setOpacity(root: Object3D, o: number): void {
  root.traverse((node) => {
    if (node instanceof Mesh) {
      const mat = node.material as MeshStandardMaterial | MeshBasicMaterial;
      const base = (mat.userData.baseOpacity as number | undefined) ?? 1;
      mat.opacity = base * o;
    }
  });
}

function growable(mesh: Mesh, baseY: number, height: number): Mesh {
  mesh.userData.baseY = baseY;
  mesh.userData.h = height;
  return mesh;
}

export function growY(mesh: Mesh, p: number): void {
  const h = mesh.userData.h as number;
  const baseY = mesh.userData.baseY as number;
  mesh.scale.y = Math.max(p, 0.0001);
  mesh.position.y = baseY + (h * mesh.scale.y) / 2;
}

export interface MockApp {
  group: Group;
  targets: {
    stat: Object3D;
    newBtn: Object3D;
    modal: Object3D;
    confirm: Object3D;
    side: Object3D;
    content: Object3D;
  };
  statBars: Mesh[];
  statNumber: Mesh;
  chartBars: Mesh[];
  createdBar: Mesh;
  statCard: Group;
  modal: Group;
  chips: Mesh[];
  caret: Mesh;
  toast: Group;
  pageA: Group;
  pageB: Group;
  setSideActive(index: number): void;
  setTheme(light: boolean): void;
  update(now: number): void;
  reset(): void;
}

const SPARK_H = [0.09, 0.13, 0.11, 0.16, 0.14, 0.18];
const CHART_H = [0.16, 0.22, 0.19, 0.3, 0.24, 0.2, 0.27, 0.33, 0.38, 0.3, 0.34, 0.4];

export function buildMockApp(): MockApp {
  const group = new Group();

  // shell
  const body = slab(3.4, 2.12, 0.09, C.window, { r: 0.06, rough: 0.5 });
  const screenMat = new MeshStandardMaterial({ color: C.screen, roughness: 0.85, metalness: 0 });
  screenMat.userData.baseColor = C.screen;
  screenMat.userData.baseEmissive = 0x000000;
  screenMat.userData.baseGlow = 0;
  const screen = new Mesh(new PlaneGeometry(3.3, 2.02), screenMat);
  screen.position.z = 0.047;
  group.add(body, screen);

  const ui = new Group();
  ui.position.z = 0.06;
  group.add(ui);

  // titlebar
  const lights = [C.tlRed, C.tlYellow, C.tlGreen];
  for (let i = 0; i < lights.length; i++) {
    const dot = slab(0.045, 0.045, 0.015, lights[i]!, { r: 0.022, emissive: lights[i], glow: 0.5 });
    dot.position.set(-1.5 + i * 0.075, 0.9, 0);
    ui.add(dot);
  }
  const urlPill = slab(0.94, 0.075, 0.015, C.panel, { r: 0.037 });
  urlPill.position.set(0, 0.9, 0);
  const urlDot = slab(0.028, 0.028, 0.012, C.ok, { r: 0.014, emissive: C.ok, glow: 0.45 });
  urlDot.position.set(-0.4, 0.9, 0.012);
  ui.add(urlPill, urlDot);
  const topLine = slab(3.3, 0.006, 0.004, C.chipDim, { r: 0.002 });
  topLine.position.set(0, 0.815, 0);
  ui.add(topLine);

  // sidebar
  const sideItems: Mesh[] = [];
  const logo = slab(0.09, 0.09, 0.02, C.acc, { r: 0.028, emissive: C.acc, glow: 0.7 });
  logo.position.set(-1.47, 0.68, 0);
  const logoBar = slab(0.3, 0.05, 0.012, C.chip, { r: 0.02 });
  logoBar.position.set(-1.22, 0.68, 0);
  ui.add(logo, logoBar);
  for (let i = 0; i < 4; i++) {
    const pill = slab(0.56, 0.105, 0.018, C.panel, { r: 0.036 });
    pill.position.set(-1.28, 0.47 - i * 0.175, 0);
    const bar = slab(0.3, 0.038, 0.012, C.chip, { r: 0.016 });
    bar.position.set(-1.24, 0.47 - i * 0.175, 0.016);
    const dot = slab(0.036, 0.036, 0.012, C.chip, { r: 0.017 });
    dot.position.set(-1.5, 0.47 - i * 0.175, 0.016);
    ui.add(pill, bar, dot);
    sideItems.push(pill);
  }
  const sideLine = slab(0.006, 1.74, 0.004, C.chipDim, { r: 0.002 });
  sideLine.position.set(-0.94, -0.1, 0);
  ui.add(sideLine);

  // content chrome (persists across the page travel)
  const title = slab(0.66, 0.085, 0.016, C.chip, { r: 0.03 });
  title.position.set(-0.47, 0.63, 0);
  const subtitle = slab(0.4, 0.045, 0.012, C.chipDim, { r: 0.02 });
  subtitle.position.set(-0.6, 0.53, 0);
  const newBtn = slab(0.5, 0.14, 0.03, C.acc, { r: 0.05, emissive: C.acc, glow: 0.62 });
  newBtn.position.set(1.28, 0.6, 0);
  const newBtnBar = slab(0.26, 0.042, 0.012, 0xdad8ff, { r: 0.018, emissive: 0xdad8ff, glow: 0.4 });
  newBtnBar.position.set(1.28, 0.6, 0.022);
  ui.add(title, subtitle, newBtn, newBtnBar);

  // page A — stat cards + chart
  const pageA = new Group();
  ui.add(pageA);

  const statCard = new Group();
  statCard.position.set(-0.42, 0.2, 0);
  const statBase = slab(0.72, 0.5, 0.03, C.card, { r: 0.045 });
  const statLabel = slab(0.26, 0.04, 0.012, C.chipDim, { r: 0.018 });
  statLabel.position.set(-0.17, 0.16, 0.02);
  const statNumber = slab(0.3, 0.075, 0.014, 0x4c4c57, { r: 0.028 });
  statNumber.position.set(-0.15, 0.03, 0.02);
  statNumber.userData.baseX = -0.15 - 0.15;
  statCard.add(statBase, statLabel, statNumber);
  const statBars: Mesh[] = [];
  for (let i = 0; i < SPARK_H.length; i++) {
    const h = SPARK_H[i]!;
    const accent = i === SPARK_H.length - 1;
    const bar = slab(0.055, h, 0.016, accent ? C.acc : C.chip, {
      r: 0.02,
      emissive: accent ? C.acc : 0x000000,
      glow: accent ? 0.55 : 0,
    });
    growable(bar, -0.2, h);
    bar.position.x = -0.24 + i * 0.093;
    growY(bar, 0.32);
    bar.position.z = 0.02;
    statCard.add(bar);
    statBars.push(bar);
  }
  pageA.add(statCard);

  for (let i = 1; i < 3; i++) {
    const card = new Group();
    card.position.set(-0.42 + i * 0.81, 0.2, 0);
    const base = slab(0.72, 0.5, 0.03, C.card, { r: 0.045 });
    const label = slab(0.26, 0.04, 0.012, C.chipDim, { r: 0.018 });
    label.position.set(-0.17, 0.16, 0.02);
    const num = slab(0.3, 0.09, 0.014, C.chip, { r: 0.03 });
    num.position.set(-0.15, 0.03, 0.02);
    const spark = slab(0.5, 0.1, 0.014, C.chipDim, { r: 0.03 });
    spark.position.set(0, -0.14, 0.02);
    card.add(base, label, num, spark);
    pageA.add(card);
  }

  const chartCard = new Group();
  chartCard.position.set(0.39, -0.53, 0);
  const chartBase = slab(2.38, 0.62, 0.03, C.card, { r: 0.05 });
  const chartLabel = slab(0.32, 0.04, 0.012, C.chipDim, { r: 0.018 });
  chartLabel.position.set(-0.97, 0.22, 0.02);
  const baseline = slab(2.14, 0.005, 0.008, C.chipDim, { r: 0.002 });
  baseline.position.set(0, -0.23, 0.02);
  chartCard.add(chartBase, chartLabel, baseline);
  const chartBars: Mesh[] = [];
  for (let i = 0; i < CHART_H.length; i++) {
    const h = CHART_H[i]!;
    const accent = i === 3 || i === 8;
    const bar = slab(0.1, h, 0.02, accent ? C.acc : C.chip, {
      r: 0.028,
      emissive: accent ? C.acc : 0x000000,
      glow: accent ? 0.5 : 0,
    });
    growable(bar, -0.228, h);
    growY(bar, 1);
    bar.position.x = -1.02 + i * 0.17;
    bar.position.z = 0.02;
    chartCard.add(bar);
    chartBars.push(bar);
  }
  const createdBar = slab(0.1, 0.5, 0.02, C.accHi, { r: 0.028, emissive: C.accHi, glow: 0.9 });
  growable(createdBar, -0.228, 0.5);
  createdBar.position.x = -1.02 + 12 * 0.17;
  createdBar.position.z = 0.02;
  growY(createdBar, 0.0001);
  createdBar.visible = false;
  chartCard.add(createdBar);
  pageA.add(chartCard);

  // page B — a table the sidebar travels to
  const pageB = new Group();
  pageB.visible = false;
  ui.add(pageB);
  for (let i = 0; i < 6; i++) {
    const y = 0.36 - i * 0.19;
    const rowBase = slab(2.38, 0.15, 0.02, i % 2 ? C.card : C.cardHi, { r: 0.04 });
    rowBase.position.set(0.39, y, 0);
    const accent = i === 1 || i === 4;
    const dot = slab(0.05, 0.05, 0.014, accent ? C.acc : C.chip, {
      r: 0.024,
      emissive: accent ? C.acc : 0x000000,
      glow: accent ? 0.6 : 0,
    });
    dot.position.set(-0.62, y, 0.02);
    const barA = slab(0.62, 0.045, 0.012, C.chip, { r: 0.02 });
    barA.position.set(-0.18, y, 0.02);
    const barB = slab(0.42, 0.045, 0.012, C.chipDim, { r: 0.02 });
    barB.position.set(0.5, y, 0.02);
    const chip = slab(0.26, 0.08, 0.016, C.panel, { r: 0.033 });
    chip.position.set(1.32, y, 0.02);
    pageB.add(rowBase, dot, barA, barB, chip);
  }

  // modal
  const modal = new Group();
  modal.position.set(0.2, 0.02, 0.16);
  modal.visible = false;
  const veil = new Mesh(
    new PlaneGeometry(3.3, 2.02),
    new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 }),
  );
  veil.material.userData.baseOpacity = 0.45;
  veil.position.set(-0.2, -0.02, -0.06);
  const modalCard = slab(1.5, 0.94, 0.04, 0x2d2d37, { r: 0.055, rough: 0.5 });
  const modalTitle = slab(0.5, 0.06, 0.014, 0x9d9daa, { r: 0.024 });
  modalTitle.position.set(-0.42, 0.3, 0.028);
  const field = slab(1.24, 0.18, 0.02, C.inset, { r: 0.04 });
  field.position.set(0, 0.06, 0.028);
  const chips: Mesh[] = [];
  const CHIP_W = [0.1, 0.07, 0.12, 0.08, 0.11, 0.06, 0.1, 0.09];
  let cx = -0.54;
  for (const w of CHIP_W) {
    const chip = slab(w, 0.07, 0.014, C.chip, { r: 0.022 });
    chip.userData.baseX = cx;
    chip.userData.w = w;
    chip.position.set(cx + w / 2, 0.06, 0.05);
    chip.scale.x = 0.0001;
    chip.visible = false;
    modal.add(chip);
    chips.push(chip);
    cx += w + 0.035;
  }
  const caret = slab(0.014, 0.09, 0.012, C.accHi, { r: 0.005, emissive: C.accHi, glow: 0.9 });
  caret.position.set(-0.54, 0.06, 0.05);
  caret.visible = false;
  const ghostBtn = slab(0.32, 0.13, 0.02, C.panel, { r: 0.045 });
  ghostBtn.position.set(0.24, -0.3, 0.028);
  const confirmBtn = slab(0.44, 0.14, 0.03, C.acc, { r: 0.05, emissive: C.acc, glow: 0.65 });
  confirmBtn.position.set(0.66 - 0.22, -0.3, 0.028);
  confirmBtn.position.x = 0.62;
  const confirmBar = slab(0.22, 0.04, 0.012, 0xdad8ff, { r: 0.018, emissive: 0xdad8ff, glow: 0.4 });
  confirmBar.position.set(0.62, -0.3, 0.05);
  modal.add(veil, modalCard, modalTitle, field, caret, ghostBtn, confirmBtn, confirmBar);
  ui.add(modal);

  // toast — lands in the header's empty middle, not on the New button. It sits
  // 0.2 in front of the UI plane, so an off-axis lens throws it further right
  // still; anywhere past x ≈ 0.6 and it covers the very button the take just
  // pressed.
  const toast = new Group();
  toast.position.set(0.52, 0.6, 0.2);
  toast.visible = false;
  const toastBase = slab(0.66, 0.13, 0.024, C.panel, { r: 0.045 });
  const toastDot = slab(0.05, 0.05, 0.014, C.ok, { r: 0.024, emissive: C.ok, glow: 0.9 });
  toastDot.position.set(-0.24, 0, 0.018);
  const toastBar = slab(0.34, 0.04, 0.012, C.chip, { r: 0.018 });
  toastBar.position.set(0.06, 0, 0.018);
  toast.add(toastBase, toastDot, toastBar);
  ui.add(toast);

  // beat targets
  const mk = (x: number, y: number): Object3D => {
    const o = new Object3D();
    o.position.set(x, y, 0.08);
    group.add(o);
    return o;
  };
  const targets = {
    stat: mk(-0.42, 0.2),
    newBtn: mk(1.28, 0.6),
    modal: mk(0.2, 0.04),
    confirm: mk(0.62, -0.28),
    side: mk(-1.28, 0.295),
    content: mk(0.39, -0.05),
  };

  let lightMode = false;
  const col = (hex: number): number => (lightMode ? (LIGHT[hex] ?? hex) : hex);
  let activeSide = 0;
  const applySide = () => {
    for (const [i, pill] of sideItems.entries()) {
      const m = pill.material as MeshStandardMaterial;
      if (i === activeSide) {
        m.color.setHex(col(C.cardHi));
        m.emissive.setHex(col(C.acc));
        m.emissiveIntensity = lightMode ? 0.1 : 0.18;
      } else {
        m.color.setHex(col(C.panel));
        m.emissive.setHex(0x000000);
        m.emissiveIntensity = 0;
      }
    }
  };
  applySide();

  const app: MockApp = {
    group,
    targets,
    statBars,
    statNumber,
    chartBars,
    createdBar,
    statCard,
    modal,
    chips,
    caret,
    toast,
    pageA,
    pageB,
    setSideActive(index: number): void {
      activeSide = index;
      applySide();
    },
    setTheme(light: boolean): void {
      lightMode = light;
      group.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        const mat = node.material as MeshStandardMaterial | MeshBasicMaterial;
        const base = mat.userData.baseColor as number | undefined;
        if (base === undefined) return;
        mat.color.setHex(col(base));
        if (mat instanceof MeshStandardMaterial) {
          mat.emissive.setHex(col(mat.userData.baseEmissive as number));
          mat.emissiveIntensity = light
            ? (mat.userData.baseGlow as number) * 0.4
            : (mat.userData.baseGlow as number);
        }
      });
      applySide();
    },
    update(now: number): void {
      if (caret.visible) {
        (caret.material as MeshStandardMaterial).opacity = now % 0.8 < 0.45 ? 1 : 0.15;
      }
    },
    reset(): void {
      for (const bar of statBars) growY(bar, 0.32);
      statNumber.scale.x = 1;
      modal.visible = false;
      modal.scale.setScalar(1);
      for (const chip of chips) {
        chip.visible = false;
        chip.scale.x = 0.0001;
      }
      caret.visible = false;
      toast.visible = false;
      createdBar.visible = false;
      growY(createdBar, 0.0001);
      pageA.visible = true;
      pageA.position.x = 0;
      setOpacity(pageA, 1);
      pageB.visible = false;
      pageB.position.x = 0;
      statCard.position.z = 0;
      statCard.scale.setScalar(1);
      activeSide = 0;
      applySide();
    },
  };
  return app;
}
