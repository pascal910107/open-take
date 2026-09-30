/// <reference lib="dom" />
// The HTML renderer's page: a launch film of motion scenes, built once as DOM
// and set frame by frame from the SAME pure evaluator the 2D renderer uses.
// It exists because the DOM draws what a 2D canvas cannot — real 3D
// perspective (a window tilting in, a wall of tiles), CSS blur, text laid out
// by the browser itself — and renders in parallel.
//
// Contract with the driver (render.ts): `window.__ready` resolves when the
// page can render; `window.__seek(atS, frameS)` shows scene time `atS` (a
// shutter sample) of the output frame at `frameS` and resolves once every
// image it shows is decoded. Bundled for the browser by tsdown
// (dist/html-engine.js); reads ./film.json and ./media.json beside it.

import {
  launchEase,
  launchSceneWindows,
  sceneSampleS,
  transitionOpacity,
} from "../launch-evaluate";
import type { LaunchComposition } from "../launch-types";
import {
  CURSOR_ARROW,
  CURSOR_SHADOW,
  CURSOR_UNIT,
  DEFAULT_PERSPECTIVE,
  evaluateHits,
  evaluateMotionScene,
  evaluateTextUnit,
  motionMediaTimeS,
  motionTextUnits,
  textUnitMaskHeight,
  wipeShape,
} from "../motion-evaluate";
import type { EvaluatedMotionLayer, MotionLayer, MotionScene } from "../motion-types";
import { type HtmlMedia, type HtmlState, mediaKey } from "./media";

type Frame = { localS: number; frameLocalS: number; pending: Promise<unknown>[] };
type Updater = (layer: EvaluatedMotionLayer, frame: Frame, visible: boolean) => void;
type Built = { el: HTMLElement | SVGElement; update: Updater; children?: Built[] };

const SVG = "http://www.w3.org/2000/svg";
const px = (n: number) => `${n}px`;
const html = (tag: string, style: Partial<CSSStyleDeclaration> = {}): HTMLElement => {
  const el = document.createElement(tag);
  Object.assign(el.style, { position: "absolute", left: "0px", top: "0px" }, style);
  return el;
};
const svg = (tag: string): SVGElement => document.createElementNS(SVG, tag);
/** Write a style only when it changes: most properties hold most frames. */
const set = (el: HTMLElement | SVGElement, key: string, value: string) => {
  const style = el.style as unknown as Record<string, string>;
  if (style[key] !== value) style[key] = value;
};

const transform = (l: EvaluatedMotionLayer) =>
  `translate3d(${l.x}px, ${l.y}px, ${l.z}px) rotateX(${l.rotateX}deg) rotateY(${l.rotateY}deg) rotate(${l.rotation}deg) scale(${l.scaleX}, ${l.scaleY})`;

type Theme = { ink: string; surface: string; accent: string; fontFamily: string };

function buildLayer(
  authored: MotionLayer,
  theme: Theme,
  design: { width: number; height: number },
  perspective: number,
  media: HtmlMedia,
  sceneId: string,
): Built {
  // boxes (rect, ellipse, text, image, video) are centred on their origin
  const box = (el: HTMLElement, l: EvaluatedMotionLayer & { width: number; height: number }) => {
    set(el, "left", px(-l.width / 2));
    set(el, "top", px(-l.height / 2));
    set(el, "width", px(l.width));
    set(el, "height", px(l.height));
    set(el, "transform", transform(l));
    set(el, "opacity", String(l.opacity));
  };
  const shadow = (s?: { color: string; blur: number; offsetX?: number; offsetY?: number }) =>
    s ? `${s.offsetX ?? 0}px ${s.offsetY ?? 0}px ${s.blur}px ${s.color}` : "none";

  switch (authored.type) {
    case "group": {
      const el = html("div", { width: "0px", height: "0px", transformOrigin: "0 0" });
      let parent: HTMLElement = el;
      let clip: HTMLElement | undefined;
      // Layers stack in paint order, like the 2D renderer: a tilted window is
      // a plane drawn over what came before it, never depth-sorted into the
      // background behind it (preserve-3d would sink half of it behind a flat
      // backdrop). Each group lends its children the scene's perspective.
      if (authored.clip) {
        clip = html("div", { overflow: "hidden", perspective: px(perspective) });
        const origin = html("div", { width: "0px", height: "0px" });
        clip.append(origin);
        el.append(clip);
        parent = origin;
      } else el.style.perspective = px(perspective);
      const children = authored.children.map((c) =>
        buildLayer(c, theme, design, perspective, media, sceneId),
      );
      for (const c of children) parent.append(c.el);
      return {
        el,
        children,
        update(l, _frame, visible) {
          if (l.type !== "group") return;
          set(el, "transform", transform(l));
          set(el, "opacity", String(l.opacity));
          set(el, "display", visible ? "" : "none");
          if (clip) {
            const w = l.width ?? 0,
              h = l.height ?? 0;
            set(clip, "left", px(-w / 2));
            set(clip, "top", px(-h / 2));
            set(clip, "width", px(w));
            set(clip, "height", px(h));
            set(clip, "borderRadius", px(l.radius));
            set(parent, "left", px(w / 2));
            set(parent, "top", px(h / 2));
          }
        },
      };
    }
    case "rect":
    case "ellipse": {
      const el = html("div", { boxSizing: "border-box", transformOrigin: "50% 50%" });
      return {
        el,
        update(l) {
          if (l.type !== "rect" && l.type !== "ellipse") return;
          box(el, l);
          set(el, "background", l.fill ?? theme.surface);
          set(
            el,
            "border",
            l.strokeWidth > 0 ? `${l.strokeWidth}px solid ${l.stroke ?? theme.accent}` : "none",
          );
          set(el, "borderRadius", l.type === "ellipse" ? "50%" : px(l.radius));
          if (l.type === "rect") set(el, "boxShadow", shadow(l.shadow));
        },
      };
    }
    case "text": {
      const el = html("div", {
        transformOrigin: "50% 50%",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      });
      const units = authored.units;
      if (!units) {
        el.style.overflow = "hidden";
        let shown = "";
        return {
          el,
          update(l) {
            if (l.type !== "text") return;
            box(el, l);
            font(el, l, theme);
            if (l.text !== shown) el.textContent = shown = l.text;
          },
        };
      }
      // copy that moves unit by unit: the browser lays the words out (wrap,
      // alignment, spacing); each word is an inline box whose ink moves
      const cells: { cell: HTMLElement; ink: HTMLElement }[] = [];
      motionTextUnits(authored.text, units.by).forEach((line, li) => {
        if (li > 0) el.append("\n");
        for (const unit of line) {
          const ink = document.createElement("span");
          Object.assign(ink.style, { display: "inline-block", transformOrigin: "50% 50%" });
          ink.textContent = unit.trimEnd();
          const cell = document.createElement("span");
          Object.assign(cell.style, { display: "inline-block", verticalAlign: "top" });
          cell.append(ink);
          el.append(cell);
          const gap = unit.slice(unit.trimEnd().length);
          if (gap) el.append(gap);
          cells.push({ cell, ink });
        }
      });
      return {
        el,
        update(l, frame) {
          if (l.type !== "text") return;
          box(el, l);
          font(el, l, theme);
          const mask = textUnitMaskHeight(l);
          const spill = Math.max(0, (mask - l.lineHeight) / 2);
          cells.forEach(({ cell, ink }, i) => {
            const u = evaluateTextUnit(units, i, frame.localS, l);
            set(
              ink,
              "transform",
              `translate(${u.dx}px, ${u.dy}px) rotate(${u.rotation}deg) scale(${u.scale})`,
            );
            set(ink, "opacity", String(u.opacity));
            set(ink, "filter", u.blur > 0.05 ? `blur(${u.blur}px)` : "none");
            // the mask: the unit's line box, grown to the glyphs' full height
            set(
              cell,
              "clipPath",
              u.masked
                ? `inset(${-spill}px ${-l.fontSize}px ${-spill}px ${-l.fontSize}px)`
                : "none",
            );
          });
        },
      };
    }
    case "image":
    case "video": {
      const el = html("div", { overflow: "hidden", transformOrigin: "50% 50%" });
      const img = document.createElement("img");
      Object.assign(img.style, {
        display: "block",
        width: "100%",
        height: "100%",
        objectPosition: "50% 50%",
      });
      img.decoding = "sync";
      el.append(img);
      let src = "";
      const show = (next: string, frame: Frame) => {
        if (next === src) return;
        src = next;
        img.src = next;
        frame.pending.push(img.decode().catch(() => undefined));
      };
      const frames =
        authored.type === "video" ? media.videos[mediaKey(sceneId, authored.id)] : undefined;
      return {
        el,
        update(l, frame, visible) {
          if (l.type !== "image" && l.type !== "video") return;
          box(el, l);
          set(el, "borderRadius", px(l.radius));
          set(el, "boxShadow", shadow(l.shadow));
          set(img, "objectFit", l.fit);
          if (!visible || l.opacity <= 0) return;
          if (l.type === "image") return show(l.asset, frame);
          if (!frames) return;
          // footage samples the OUTPUT frame, never the shutter sample
          const media = motionMediaTimeS(l, frame.frameLocalS) - l.trimStartS;
          const i = Math.min(frames.count - 1, Math.max(0, Math.round(media * frames.fps)));
          show(`${frames.base}${String(i + 1).padStart(6, "0")}.jpg`, frame);
        },
      };
    }
    case "state": {
      // the product's own interface, laid out again at its captured viewport
      // and scaled as a whole: text and vectors stay sharp at any zoom
      const page = media.states?.[mediaKey(sceneId, authored.id)];
      const el = html("div", { overflow: "hidden", transformOrigin: "50% 50%" });
      const clip = html("div", { overflow: "hidden" });
      const frame = document.createElement("iframe");
      Object.assign(frame.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        border: "0",
        transformOrigin: "0 0",
        pointerEvents: "none",
      });
      frame.tabIndex = -1;
      clip.append(frame);
      el.append(clip);
      let loading: Promise<unknown> | undefined;
      return {
        el,
        update(l, frameTime, visible) {
          if (l.type !== "state") return;
          box(el, l);
          set(el, "borderRadius", px(l.radius));
          set(el, "boxShadow", shadow(l.shadow));
          set(el, "visibility", visible ? "visible" : "hidden");
          if (!page) return;
          // loaded the first time it shows: a worker renders a slice of the
          // film, so it only ever opens the screens its slice shows
          if (visible && !loading) {
            loading = openState(frame, page, l.only, l.hide, authored.state);
            frameTime.pending.push(loading);
          }
          const region = l.crop ?? { x: 0, y: 0, width: page.width, height: page.height };
          const s =
            l.fit === "cover"
              ? Math.max(l.width / region.width, l.height / region.height)
              : Math.min(l.width / region.width, l.height / region.height);
          // the region fills (cover) or letterboxes (contain) the box; nothing
          // of the page outside the region shows
          set(clip, "left", px((l.width - region.width * s) / 2));
          set(clip, "top", px((l.height - region.height * s) / 2));
          set(clip, "width", px(region.width * s));
          set(clip, "height", px(region.height * s));
          set(frame, "width", px(page.width));
          set(frame, "height", px(page.height));
          set(frame, "transform", `translate(${-region.x * s}px, ${-region.y * s}px) scale(${s})`);
        },
      };
    }
    case "cursor": {
      // open-take's arrow, tip at the layer's origin (the take renderer's cursor)
      const el = svg("svg");
      Object.assign(el.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        overflow: "visible",
        transformOrigin: "0 0",
      });
      el.setAttribute("width", "1");
      el.setAttribute("height", "1");
      const arrow = (d: number) =>
        CURSOR_ARROW.map(([x, y]) => `${x * CURSOR_UNIT + d},${y * CURSOR_UNIT + d}`).join(" ");
      const shade = svg("polygon");
      shade.setAttribute("points", arrow(CURSOR_SHADOW));
      shade.setAttribute("fill", "rgba(0,0,0,0.35)");
      const body = svg("polygon");
      body.setAttribute("points", arrow(0));
      body.setAttribute("fill", "rgb(20,20,24)");
      body.setAttribute("stroke", "#ffffff");
      body.setAttribute("stroke-width", "2");
      body.setAttribute("stroke-linejoin", "round");
      el.append(shade, body);
      return {
        el,
        update(l) {
          if (l.type !== "cursor") return;
          set(el, "transform", transform(l));
          set(el, "opacity", String(l.opacity));
        },
      };
    }
    case "line": {
      const el = svg("svg");
      Object.assign(el.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        overflow: "visible",
        transformOrigin: "0 0",
      });
      el.setAttribute("width", "1");
      el.setAttribute("height", "1");
      const line = svg("polyline");
      line.setAttribute("points", authored.points.map((p) => p.join(",")).join(" "));
      line.setAttribute("fill", "none");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-linejoin", "round");
      const length = authored.points
        .slice(1)
        .reduce(
          (sum, p, i) =>
            sum + Math.hypot(p[0] - authored.points[i]![0], p[1] - authored.points[i]![1]),
          0,
        );
      line.setAttribute("stroke-dasharray", `${length} ${length}`);
      el.append(line);
      return {
        el,
        update(l) {
          if (l.type !== "line") return;
          set(el, "transform", transform(l));
          set(el, "opacity", String(l.end > 0 ? l.opacity : 0));
          line.setAttribute("stroke", l.stroke ?? theme.accent);
          line.setAttribute("stroke-width", String(l.strokeWidth));
          line.setAttribute("stroke-dashoffset", String(length * (1 - l.end)));
        },
      };
    }
    case "wipe": {
      const el = svg("svg");
      Object.assign(el.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        overflow: "visible",
        transformOrigin: "0 0",
      });
      el.setAttribute("width", "1");
      el.setAttribute("height", "1");
      const cover = svg("polygon");
      el.append(cover);
      const points = (ps: [number, number][]) => ps.map((p) => p.join(",")).join(" ");
      return {
        el,
        update(l) {
          if (l.type !== "wipe") return;
          const on = l.cover > 0;
          set(el, "display", on ? "" : "none");
          if (!on) return;
          set(el, "transform", transform(l));
          set(el, "opacity", String(l.opacity * l.cover));
          const shape = wipeShape(l, l.sweep, design.width, design.height);
          cover.setAttribute("points", points(shape.cover));
          cover.setAttribute("fill", l.color ?? theme.ink);
        },
      };
    }
  }
}

/** Open a saved screen in `frame` and resolve once it stands as captured
 *  (its restore script sets `data-ot-ready` after scroll, inputs, fonts and
 *  images), with `only` / `hide` applied. */
function openState(
  frame: HTMLIFrameElement,
  page: HtmlState,
  only: string[] | undefined,
  hide: string[] | undefined,
  name: string,
): Promise<void> {
  frame.src = page.url;
  const started = performance.now();
  return new Promise<void>((ok, fail) => {
    const poll = () => {
      const doc = frame.contentDocument;
      if (doc?.documentElement?.dataset.otReady === "1") {
        const sel = (ids: string[]) => ids.map((id) => `[data-ot-id="${id}"]`);
        const rules: string[] = [];
        if (only?.length) {
          const keep = sel(only);
          // everything else stops painting, the page's background included;
          // what the kept elements contain keeps its own visibility
          rules.push(
            "html,body{background:transparent!important}",
            `:not(${[...keep, ...keep.map((k) => `${k} *`)].join(",")}){visibility:hidden!important}`,
            `${keep.join(",")}{visibility:visible!important}`,
          );
        }
        if (hide?.length) rules.push(`${sel(hide).join(",")}{visibility:hidden!important}`);
        const style = doc.createElement("style");
        style.textContent = rules.join("\n");
        (doc.head ?? doc.documentElement).append(style);
        // a page in another colour scheme than ours would get an opaque
        // backdrop; matching it keeps a transparent page transparent
        frame.style.colorScheme = getComputedStyle(doc.documentElement).colorScheme || "normal";
        return ok();
      }
      if (performance.now() - started > 30_000)
        return fail(new Error(`saved state ${name} did not finish loading in 30 s (${page.url})`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function font(el: HTMLElement, l: EvaluatedMotionLayer & { type: "text" }, theme: Theme): void {
  set(el, "fontFamily", l.fontFamily ?? theme.fontFamily);
  set(el, "fontSize", px(l.fontSize));
  set(el, "fontWeight", String(l.fontWeight));
  set(el, "lineHeight", px(l.lineHeight));
  set(el, "textAlign", l.align);
  set(el, "color", l.fill ?? theme.ink);
}

/** Walk evaluated layers alongside the built nodes (same shape, same order). */
function updateAll(built: Built[], layers: EvaluatedMotionLayer[], frame: Frame, visible: boolean) {
  built.forEach((b, i) => {
    const l = layers[i]!;
    const shown = visible && l.opacity > 0;
    b.update(l, frame, shown);
    if (b.children && l.type === "group") updateAll(b.children, l.children, frame, shown);
  });
}

async function main() {
  const [comp, media] = (await Promise.all([
    fetch("./film.json").then((r) => r.json()),
    fetch("./media.json").then((r) => r.json()),
  ])) as [LaunchComposition, HtmlMedia];
  const W = comp.output.width,
    H = comp.output.height;
  document.documentElement.style.background = "#000";
  Object.assign(document.body.style, { margin: "0", overflow: "hidden" });
  const stage = html("div", { width: px(W), height: px(H), overflow: "hidden" });
  const flash = html("div", { width: px(W), height: px(H), background: "#fff", opacity: "0" });
  document.body.append(stage);

  const windows = launchSceneWindows(comp);
  const scenes = windows.map((win) => {
    const scene = win.scene as MotionScene;
    const colors = { ...comp.theme, ...(scene.colors ?? {}) };
    const theme: Theme = {
      ink: colors.ink,
      surface: colors.surface,
      accent: colors.accent,
      fontFamily: colors.fontFamily,
    };
    const design = scene.designSize ?? { width: 1920, height: 1080 };
    const fit = Math.min(W / design.width, H / design.height);
    const perspective = scene.perspective ?? DEFAULT_PERSPECTIVE;
    const root = html("div", {
      left: px(W / 2),
      top: px(H / 2),
      width: "0px",
      height: "0px",
      perspective: px(perspective),
      visibility: "hidden",
    });
    const built = scene.layers.map((l) =>
      buildLayer(l, theme, design, perspective, media, scene.id),
    );
    for (const b of built) root.append(b.el);
    stage.append(root);
    const background = scene.background === "dark" ? colors.dark : colors.canvas;
    return { win, scene, root, built, fit, background };
  });
  stage.append(flash);

  let current: (typeof scenes)[number] | undefined;
  const seek = async (atS: number, frameS: number) => {
    const t = sceneSampleS(windows, atS, frameS);
    const active = scenes.find((s) => t >= s.win.startS && t < s.win.endS) ?? scenes.at(-1)!;
    if (active !== current) {
      for (const s of scenes) s.root.style.visibility = s === active ? "visible" : "hidden";
      current = active;
    }
    const { scene, win, root, built, fit, background } = active;
    const localS = t - win.startS;
    const frame: Frame = { localS, frameLocalS: frameS - win.startS, pending: [] };
    set(stage, "background", background);
    // scene entrance/exit (fade, slide) and the beats' shake and flash
    const opacity = scene.motion === "off" ? 1 : transitionOpacity(scene, localS);
    const slide =
      scene.motion !== "off" && scene.transition?.type === "slide"
        ? (1 - launchEase(Math.min(1, localS / (scene.transition.durationS ?? 0.5)))) * 42
        : 0;
    const hit = evaluateHits(scene.motion === "off" ? undefined : scene.hits, localS);
    set(root, "opacity", String(opacity));
    set(
      root,
      "transform",
      `scale(${fit}) translate(${hit.dx}px, ${hit.dy + slide}px) rotate(${hit.rotation}deg)`,
    );
    set(flash, "opacity", String(hit.flash));
    updateAll(built, evaluateMotionScene(scene, localS).layers, frame, true);
    await Promise.all(frame.pending);
  };

  const w = window as unknown as {
    __seek: (atS: number, frameS: number) => Promise<void>;
    __ready: Promise<void>;
  };
  w.__seek = seek;
  await document.fonts.ready;
  await seek(0, 0);
}

(window as unknown as { __ready: Promise<void> }).__ready = main();
