// @ts-check
// A 3D world for a film page — open-take's film kit. The same slabs, poses
// and moves as kit/stage.js, drawn into one WebGL canvas with three.js: a
// screen tilted into space, a laptop, a phone or a browser window round a
// picture of the product, the lens turning about it or travelling past it.
// A slab here is a picture — a saved screen's picture (`film picture`), a
// part's picture, a frame of the recording, a <canvas>, a <video> — mapped
// onto a flat slab in a lit scene.
//
// Which one to pick. stage.js keeps a slab live DOM: its text is text, the
// film's text checks read it, what is on it keeps working. world.js has
// pixels only — nothing on a slab is an element any more — and gives back:
//   - a cleaner tilt: mipmaps and 16× anisotropic filtering, where Chrome's
//     compositor samples a tilted layer bilinearly (measured on a 40° turn
//     of the same picture: CSS's text stair-stepped, WebGL's held; square on,
//     the two were the same sharpness);
//   - light on the things round a picture, and devices: `device()` builds a
//     laptop, a phone or a browser window round a slab — a plain shape with
//     no logo and no brand;
//   - one lens for everything in it.
// It costs about a quarter more time a frame (40 ms against 32 ms for the
// same 4 s turn on an Apple M4). One scene, one of the two: a CSS layer and a
// canvas do not share a depth, so a slab of one cannot pass behind the other.
//
// A device is one block among the others. A laptop with the product on its
// screen is the most common picture in launch films — fine when the product
// lives on that device (a desktop app, a phone app), a habit otherwise.
//
// Honest by construction: every slab says where its picture came from
// (`source`: a saved screen and the part, or a file — required), and at(t)
// says where each lands in the picture (its quad, in the same shape as
// stage.at(t)), so what reads the film can tell which pixels are the
// product's and from where; sources() lists them all.
//
// Deterministic: no clock, no randomness, drawn in apply(t) and nowhere else,
// the drawing buffer kept for the frame grab. A video on a slab is copied
// each frame from the <video> the renderer steps on film time, so the slab
// shows the frame the film is at.
//
// The page imports three itself — `film init` puts it beside the kit — and
// hands it over, so a film without three never loads it:
//
//   import * as THREE from "./kit/three.module.min.js";
//   import { world } from "./kit/world.js";
//   const w = world({ el: document.querySelector("#world"), camera: cam, three: THREE });
//   const scr = w.slab("states/home/picture@2x.png", { box: { x: 0, y: 0, w: 1920, h: 1080 },
//     source: { state: "home" }, rest: { scale: 0.55 } });
//   w.device("laptop", scr);
//   scr.set({ ry: 40 }, -Infinity);                     // turned from the start
//   scr.to({ ry: 0 }, { start: 0.5, dur: 2.5 });        // and round to face the lens
//   window.__film = { duration: 3, ready: w.ready };
//   window.__render = (t) => w.apply(t);               // returned: a video's frame is waited for

import { matrices as M, stage } from "./stage.js";

export { drop, explode, flip, stack, together } from "./stage.js";

/** @typedef {import("./stage.js").When} When */
/** @typedef {import("./stage.js").Pose} Pose */
/** @typedef {import("./stage.js").BoxLike} BoxLike */
/** @typedef {import("./stage.js").Box} Box */
/** @typedef {import("./stage.js").CameraLike} CameraLike */
/** @typedef {number[]} Mat */
/**
 * @typedef {{ state: string, selector?: string } | { file: string, selector?: string }} Source
 *   where a picture came from: a saved screen (states/<state>/) and the part of it, or a file
 */
/** @typedef {string | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement} Src */
/**
 * @typedef {object} WorldSlabOpts
 * @property {Source} source where its picture came from — required
 * @property {BoxLike} [box] where the slab sits on the stage (px); default its crop's box, else the whole stage
 * @property {BoxLike} [crop] show this region of the picture, laid over the whole stage as stage.js lays it (px); default all of it
 * @property {string} [name] what at(t) and warnings() call it
 * @property {number} [radius] its corners' radius (px, default 0)
 * @property {[number, number]} [origin] the point it turns about, as shares of its box (default its centre)
 * @property {"hidden" | "visible"} [backface] its back when turned away (default hidden)
 * @property {Partial<Pose>} [rest] its pose before any move
 */
/**
 * @typedef {object} WorldSlab  a slab in the world
 * @property {string} name
 * @property {Box} box
 * @property {[number, number]} origin
 * @property {Source} source
 * @property {(to: Partial<Pose>, when: When) => WorldSlab} to move to a pose — only the fields given
 * @property {(to: Partial<Pose>, at: number) => WorldSlab} set a cut: from `at` on these fields are this
 * @property {(t: number) => Pose} pose its own pose at t
 */
/**
 * @typedef {object} WorldSlabState  a slab at t
 * @property {string} name
 * @property {Pose} pose its own pose
 * @property {{ x: number, y: number }[]} quad its corners in the picture (px), top-left first, clockwise
 * @property {number} area px² it covers in the picture
 * @property {boolean} flat square on to the lens
 * @property {boolean} facing its front toward the lens
 * @property {boolean} visible drawn at all (faded out, behind the lens or its back turned are not)
 * @property {number} opacity
 * @property {number} depth its centre's z after the turn and the lens (px, + nearer)
 * @property {Source} source where its picture came from
 * @property {string | null} device the device round it, if any
 */
/**
 * @typedef {object} Frame  what one frame draws, as plain numbers (frame(t)): computed
 *   anywhere, drawn by draw() — apply(t) is draw(frame(t))
 * @property {number} t
 * @property {number[]} projection the lens, as three's projection matrix
 * @property {[number, number, number]} eye where the lens is (three's space: y up)
 * @property {{ matrix: number[], opacity: number, visible: boolean, shown: boolean }[]} slabs
 *   each slab's matrix (three's space); `visible`: its picture; `shown`: its device
 */
/**
 * @typedef {object} DeviceOpts
 * @property {string} [color] its body (default a dark grey, "#2b2d31"; a browser: "#e7e7e4")
 * @property {number} [open] a laptop: degrees between the lid and the keyboard (default 100: the lid tipped back 10° when the keyboard is flat)
 * @property {"light" | "dark"} [tone] a browser window's bar (default light)
 */

const RAD = Math.PI / 180;
/** @param {BoxLike} b @returns {Box} */
const boxOf = (b) => ({ x: b.x, y: b.y, w: b.w ?? b.width ?? 0, h: b.h ?? b.height ?? 0 });
// CSS has y down; three has y up. Its space here is the stage's, y turned over
const FLIP = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** a stage matrix (CSS, y down) as three's (y up), for geometry made y up
 * @param {Mat} m */
const up = (m) => M.mul(FLIP, M.mul(m, FLIP));
const VIDEO = /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i;

/** the source a slab names, checked */
/** @param {unknown} s @param {string} name @returns {Source} */
export function checkSource(s, name) {
  const o = /** @type {Record<string, unknown> | null} */ (s && typeof s === "object" ? s : null);
  const ok =
    o &&
    ((typeof o.state === "string" && o.state.length > 0) ||
      (typeof o.file === "string" && o.file.length > 0)) &&
    (o.selector == null || typeof o.selector === "string");
  if (!ok)
    throw new Error(
      `world: ${name} needs a source — where its picture came from: { state, selector } (a saved screen and the part of it) or { file } (a picture, a recording). Every texture points back to what it shows`,
    );
  return /** @type {Source} */ (o);
}

// --- devices -------------------------------------------------------------------

/**
 * @typedef {object} DeviceShape  a device's parts, in the slab's own px (y down, z toward the lens; the screen at z 0)
 * @property {"laptop" | "phone" | "browser"} kind
 * @property {{ x: number, y: number, w: number, h: number, r: number, depth: number }} body the lid, the phone, the window
 * @property {number} screenRadius the screen's corners (px)
 * @property {{ w: number, depth: number, thick: number, hinge: { y: number, z: number }, open: number } | null} deck a laptop's keyboard half
 * @property {number} bar a browser window's bar (px tall, above the slab)
 * @property {{ x: number, y: number, z: number, w: number, h: number, d: number }} bounds everything, as a box
 */

/**
 * The shape of a device round a screen of w×h px — the numbers only. The
 * proportions are read off the common shapes, not any one maker's: a laptop's
 * bezel 3 % of the screen's width at the sides, 4.5 % above and 6 % below, its
 * lid 1.2 % thick and its keyboard half 70 % as deep as it is wide; a phone's
 * border 4.5 %, outer corners 16 % and its thickness 10 % of the screen's
 * width (a 7.8 mm phone 71.5 mm wide is 11 %); a browser's bar 4.2 % of the
 * window's width (a desktop browser's tabs and address bar are ≈ 80 px at
 * 1920).
 * @param {"laptop" | "phone" | "browser"} kind
 * @param {number} w @param {number} h
 * @param {DeviceOpts} [o]
 * @returns {DeviceShape}
 */
export function deviceShape(kind, w, h, o = {}) {
  if (!(w > 0 && h > 0)) throw new Error(`world: a ${kind} needs a screen with a size`);
  if (kind === "laptop") {
    const side = 0.03 * w;
    const top = 0.045 * w;
    const chin = 0.06 * w;
    const depth = 0.012 * w;
    const body = { x: -side, y: -top, w: w + 2 * side, h: h + top + chin, r: 0.03 * w, depth };
    const open = o.open ?? 100;
    if (!(open > 0 && open <= 180))
      throw new Error("world: a laptop's open is degrees between 0 and 180");
    const deck = {
      w: body.w,
      depth: 0.7 * body.w,
      thick: 0.014 * w,
      hinge: { y: body.y + body.h, z: -depth / 2 },
      open,
    };
    // the keyboard half's far edge, out from the hinge at `open` from the lid
    const fy = deck.hinge.y - deck.depth * Math.cos(open * RAD);
    const fz = deck.hinge.z + deck.depth * Math.sin(open * RAD);
    const y0 = body.y;
    const y1 = Math.max(deck.hinge.y, fy) + deck.thick;
    const z0 = Math.min(-depth - 2, fz - deck.thick);
    const z1 = Math.max(0, fz);
    return {
      kind,
      body,
      screenRadius: 0,
      deck,
      bar: 0,
      bounds: { x: body.x, y: y0, z: z0, w: body.w, h: y1 - y0, d: z1 - z0 },
    };
  }
  if (kind === "phone") {
    const b = 0.045 * w;
    const depth = 0.1 * w;
    const body = { x: -b, y: -b, w: w + 2 * b, h: h + 2 * b, r: 0.16 * w, depth };
    return {
      kind,
      body,
      screenRadius: 0.12 * w,
      deck: null,
      bar: 0,
      bounds: { x: body.x, y: body.y, z: -depth - 2, w: body.w, h: body.h, d: depth + 2 },
    };
  }
  if (kind === "browser") {
    const bar = 0.042 * w;
    const depth = 0.006 * w;
    const body = { x: 0, y: -bar, w, h: h + bar, r: 0.008 * w, depth };
    return {
      kind,
      body,
      screenRadius: 0,
      deck: null,
      bar,
      bounds: { x: 0, y: -bar, z: -depth - 2, w, h: h + bar, d: depth + 2 },
    };
  }
  throw new Error(`world: no device "${kind}" (laptop, phone, browser)`);
}

// --- the world -----------------------------------------------------------------

/**
 * A world of slabs drawn in WebGL — stage()'s shape: the picture's size, a
 * lens, optionally the film's camera framing it. Without `three` it is
 * numbers only (at(t), frame(t)), as a stage without `el` is.
 * @param {object} [opts]
 * @param {any} [opts.three] the three module the page imported (`import * as THREE from "./kit/three.module.min.js"`)
 * @param {HTMLElement} [opts.el] where its canvas goes (at the element's top-left), or a <canvas> to draw in; default a canvas of its own (w.canvas), not on the page
 * @param {number} [opts.width] the picture (px, default the camera's view, else 1920)
 * @param {number} [opts.height] (default the camera's view, else 1080)
 * @param {number} [opts.perspective] how far the lens is from the stage (px, default 2000 — as stage.js)
 * @param {CameraLike} [opts.camera] a kit camera: its view at t frames the world
 * @param {[number, number]} [opts.pivot] what turn() turns about (px, default the middle of the content)
 * @param {string | null} [opts.background] a colour behind everything (default none: the page shows through)
 * @param {number} [opts.pixelRatio] drawing-buffer px per CSS px (default the page's devicePixelRatio)
 */
export function world(opts = {}) {
  const T = opts.three ?? null;
  const st = stage({
    ...(opts.camera ? { camera: opts.camera } : {}),
    ...(opts.width ? { width: opts.width } : {}),
    ...(opts.height ? { height: opts.height } : {}),
    ...(opts.perspective ? { perspective: opts.perspective } : {}),
    ...(opts.pivot ? { pivot: opts.pivot } : {}),
  });
  const W = st.width;
  const H = st.height;
  const d = st.perspective;
  const cam = opts.camera ?? null;
  const content = cam?.content ?? { width: W, height: H };
  const pivot = opts.pivot ?? [content.width / 2, content.height / 2];

  /**
   * @typedef {object} Rec  a slab's own record
   * @property {WorldSlab} handle
   * @property {ReturnType<typeof st.slab>} inner the stage's slab: its poses
   * @property {Box} box
   * @property {Box | null} crop
   * @property {Src} src
   * @property {Source} source
   * @property {number} radius
   * @property {any} mesh
   * @property {Tex | null} tex
   * @property {{ kind: string, group: any, shape: DeviceShape, mats: any[] } | null} device
   */
  /** @typedef {{ texture: any, live: (() => void) | null, sync?: () => Promise<unknown> | null, size: () => { w: number, h: number } | null, ready: Promise<unknown>, el: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement }} Tex */
  /** @type {Rec[]} */
  const recs = [];

  // --- three's side: one renderer, one scene, a lens set every frame ----------
  /** @type {any} */
  let renderer = null;
  /** @type {any} */
  let scene = null;
  /** @type {any} */
  let lens = null;
  /** @type {HTMLCanvasElement | null} */
  let canvas = null;
  let aniso = 1;
  if (T) {
    const host = opts.el ?? null;
    canvas =
      host && host.tagName === "CANVAS"
        ? /** @type {HTMLCanvasElement} */ (host)
        : document.createElement("canvas");
    if (host && host !== canvas) {
      Object.assign(canvas.style, { position: "absolute", left: "0px", top: "0px" });
      host.appendChild(canvas);
    }
    renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(opts.pixelRatio ?? globalThis.devicePixelRatio ?? 1);
    renderer.setSize(W, H, false);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    // UI colours come out as they went in: sRGB in, sRGB out, no tone curve
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.NoToneMapping;
    if (opts.background) renderer.setClearColor(new T.Color(opts.background), 1);
    else renderer.setClearColor(0x000000, 0);
    aniso = renderer.capabilities.getMaxAnisotropy();
    scene = new T.Scene();
    lens = new T.Camera();
    // light only for what is round the pictures (screens are unlit): a sky
    // over a darker floor, and a key light from up and to the left of the lens
    scene.add(new T.HemisphereLight(0xffffff, 0x404040, 1.6));
    const key = new T.DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.5, 1, 0.9);
    scene.add(key);
  }

  /** @type {Map<unknown, Tex>} */
  const texCache = new Map();
  /** @param {Src} src @param {string} name @returns {Tex} */
  const textureOf = (src, name) => {
    const hit = texCache.get(src);
    if (hit) return hit;
    /** @type {Tex} */
    let tx;
    /** @param {any} tex */
    const crisp = (tex) => {
      tex.colorSpace = T.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = T.LinearMipmapLinearFilter;
      tex.magFilter = T.LinearFilter;
      tex.anisotropy = aniso;
      return tex;
    };
    let el = src;
    if (typeof src === "string") {
      if (VIDEO.test(src)) {
        // a video of its own, on the page so the renderer steps it on film
        // time — playing from film time 0 (give your own <video> to start it
        // elsewhere)
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        v.autoplay = true;
        v.src = src;
        Object.assign(v.style, {
          position: "absolute",
          left: "0px",
          top: "0px",
          width: "2px",
          height: "2px",
          opacity: "0",
          pointerEvents: "none",
        });
        (opts.el && opts.el.tagName !== "CANVAS" ? opts.el : document.body).appendChild(v);
        el = v;
      } else {
        const im = new Image();
        im.decoding = "sync";
        im.src = src;
        el = im;
      }
    }
    const node = /** @type {HTMLImageElement | HTMLCanvasElement | HTMLVideoElement} */ (el);
    if (node.tagName === "VIDEO") {
      const v = /** @type {HTMLVideoElement} */ (node);
      // the frame the film is at, copied each frame: drawImage of a stepped
      // video hands over the frame the renderer shows for it
      const copy = document.createElement("canvas");
      const g = /** @type {CanvasRenderingContext2D} */ (copy.getContext("2d"));
      const texture = crisp(new T.Texture(copy));
      tx = {
        texture,
        el: v,
        size: () => (v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null),
        live: () => {
          if (!v.videoWidth || v.readyState < 2) return;
          if (copy.width !== v.videoWidth || copy.height !== v.videoHeight) {
            copy.width = v.videoWidth;
            copy.height = v.videoHeight;
            texture.dispose();
          }
          g.drawImage(v, 0, 0);
          texture.needsUpdate = true;
        },
        // The renderer shows a video's frame for t only after __render(t) has
        // run, so a copy made in __render would be a frame late (measured on
        // 2 s of a 60 fps recording against the same video shown directly:
        // 34.6 dB). Asked to go where the film has it now, it says so
        // (seeked) once that frame is there — then every frame matched the
        // video shown directly, pixel for pixel.
        sync: () => {
          if (v.readyState < 1) return null;
          const at = v.currentTime;
          return new Promise((ok) => {
            v.addEventListener("seeked", ok, { once: true });
            v.currentTime = at;
          });
        },
        ready:
          v.readyState >= 2
            ? Promise.resolve()
            : new Promise((ok, no) => {
                v.addEventListener("loadeddata", ok, { once: true });
                v.addEventListener(
                  "error",
                  () =>
                    no(
                      new Error(`world: ${name}: the video ${v.currentSrc || v.src} did not load`),
                    ),
                  { once: true },
                );
              }),
      };
    } else if (node.tagName === "CANVAS") {
      const c = /** @type {HTMLCanvasElement} */ (node);
      const texture = crisp(new T.Texture(c));
      tx = {
        texture,
        el: c,
        size: () => ({ w: c.width, h: c.height }),
        // the page draws on it: taken again each frame
        live: () => {
          texture.needsUpdate = true;
        },
        ready: Promise.resolve(),
      };
    } else {
      const im = /** @type {HTMLImageElement} */ (node);
      const texture = crisp(new T.Texture(im));
      const ready = (im.complete && im.naturalWidth ? Promise.resolve() : im.decode()).then(
        () => {
          texture.needsUpdate = true;
        },
        () => {
          throw new Error(`world: ${name}: the picture ${im.currentSrc || im.src} did not load`);
        },
      );
      tx = {
        texture,
        el: im,
        size: () => (im.naturalWidth ? { w: im.naturalWidth, h: im.naturalHeight } : null),
        live: null,
        ready,
      };
    }
    texCache.set(src, tx);
    return tx;
  };

  /** a rounded rectangle as a three Shape, y up: x from x0, y from y0 down by h
   * @param {number} x0 @param {number} y0 @param {number} w @param {number} h @param {number} r */
  const roundRect = (x0, y0, w, h, r) => {
    const s = new T.Shape();
    const k = Math.max(0, Math.min(r, w / 2, h / 2));
    const top = -y0;
    const bot = -(y0 + h);
    s.moveTo(x0 + k, top);
    s.lineTo(x0 + w - k, top);
    if (k) s.quadraticCurveTo(x0 + w, top, x0 + w, top - k);
    s.lineTo(x0 + w, bot + k);
    if (k) s.quadraticCurveTo(x0 + w, bot, x0 + w - k, bot);
    s.lineTo(x0 + k, bot);
    if (k) s.quadraticCurveTo(x0, bot, x0, bot + k);
    s.lineTo(x0, top - k);
    if (k) s.quadraticCurveTo(x0, top, x0 + k, top);
    return s;
  };
  /** a flat face of a rounded rectangle (y down, as the stage has it), its uv
   *  running over [u0, u1] × [v0, v1] across it
   * @param {Box} b @param {number} r @param {[number, number, number, number]} [uv] u0, v0 (its top), u1, v1 (its bottom) */
  const face = (b, r, uv = [0, 1, 1, 0]) => {
    const g = new T.ShapeGeometry(roundRect(b.x, b.y, b.w, b.h, r), 16);
    const pos = g.attributes.position;
    const tex = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const px = (pos.getX(i) - b.x) / b.w;
      const py = (-pos.getY(i) - b.y) / b.h;
      tex.setXY(i, uv[0] + (uv[2] - uv[0]) * px, uv[1] + (uv[3] - uv[1]) * py);
    }
    tex.needsUpdate = true;
    return g;
  };
  /** a rounded slab of material `depth` thick behind z = back (y down as the stage)
   * @param {Box & { r: number }} b @param {number} depth @param {number} back */
  const block = (b, depth, back) => {
    const g = new T.ExtrudeGeometry(roundRect(b.x, b.y, b.w, b.h, b.r), {
      depth,
      bevelEnabled: false,
      curveSegments: 16,
    });
    g.translate(0, 0, back - depth);
    return g;
  };

  /** the slab's picture: its geometry with the crop as its uv */
  /** @param {Rec} r */
  const screenGeometry = (r) => {
    const c = r.crop;
    const uv = /** @type {[number, number, number, number]} */ (
      c
        ? [
            c.x / content.width,
            1 - c.y / content.height,
            (c.x + c.w) / content.width,
            1 - (c.y + c.h) / content.height,
          ]
        : [0, 1, 1, 0]
    );
    return face({ x: 0, y: 0, w: r.box.w, h: r.box.h }, r.radius, uv);
  };

  /** a material that fades with its slab */
  /** @param {any} m */
  const fades = (m) => {
    m.userData.fades = true;
    return m;
  };
  /** a material at an opacity: blended only while it is faded */
  /** @param {any} m @param {number} op */
  const opacityOf = (m, op) => {
    m.opacity = op;
    const faded = op < 1;
    if (m.transparent !== faded) {
      m.transparent = faded;
      m.depthWrite = !faded;
      m.needsUpdate = true;
    }
  };

  /** the canvas a laptop's keyboard half wears: keys and a trackpad, drawn
   *  the same every time */
  /** @param {number} w @param {number} h @param {string} body */
  const deckPicture = (w, h, body) => {
    const k = Math.min(1, 1024 / w);
    const c = document.createElement("canvas");
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    const cw = c.width;
    const ch = c.height;
    g.fillStyle = body;
    g.fillRect(0, 0, cw, ch);
    // the keyboard: 6 rows, 14 keys a row in its well, from 6 % to 50 % of the depth
    const kx = 0.08 * cw;
    const kw = 0.84 * cw;
    const ky = 0.06 * ch;
    const kh = 0.44 * ch;
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(kx - 0.006 * cw, ky - 0.006 * cw, kw + 0.012 * cw, kh + 0.012 * cw);
    const gap = 0.0045 * cw;
    const rows = 6;
    const rh = (kh - gap * (rows - 1)) / rows;
    g.fillStyle = "#121214";
    for (let j = 0; j < rows; j++) {
      const y = ky + j * (rh + gap);
      if (j === rows - 1) {
        // the bottom row: a long space bar in the middle
        const unit = (kw - gap * 8) / 13;
        let x = kx;
        for (const n of [1, 1, 1, 1.5, 5, 1.5, 1, 1]) {
          g.fillRect(x, y, unit * n, rh);
          x += unit * n + gap;
        }
        continue;
      }
      const kwid = (kw - gap * 13) / 14;
      for (let i = 0; i < 14; i++) g.fillRect(kx + i * (kwid + gap), y, kwid, rh);
    }
    // the trackpad, centred below
    g.fillStyle = "rgba(255,255,255,0.07)";
    g.fillRect(0.3 * cw, 0.56 * ch, 0.4 * cw, 0.34 * ch);
    g.strokeStyle = "rgba(0,0,0,0.25)";
    g.lineWidth = Math.max(1, 0.002 * cw);
    g.strokeRect(0.3 * cw, 0.56 * ch, 0.4 * cw, 0.34 * ch);
    return c;
  };

  /** the canvas a browser window's front wears: its bar, three dots, an address field */
  /** @param {number} w @param {number} h @param {number} bar @param {"light" | "dark"} tone @param {string} body */
  const barPicture = (w, h, bar, tone, body) => {
    const k = Math.min(1, 2048 / w);
    const c = document.createElement("canvas");
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    const b = bar * k;
    g.fillStyle = body;
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = tone === "dark" ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.06)";
    g.fillRect(0, b - Math.max(1, b * 0.02), c.width, Math.max(1, b * 0.02));
    const dot = b * 0.13;
    g.fillStyle = tone === "dark" ? "#5a5a5e" : "#c4c4c0";
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(b * 0.45 + i * dot * 3.1, b / 2, dot, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = tone === "dark" ? "#3a3a3e" : "#ffffff";
    const fx = c.width * 0.25;
    const fw = c.width * 0.5;
    const fh = b * 0.52;
    const fy = (b - fh) / 2;
    g.beginPath();
    g.roundRect(fx, fy, fw, fh, fh / 2);
    g.fill();
    return c;
  };

  /** @param {"laptop" | "phone" | "browser"} kind @param {DeviceShape} sh @param {DeviceOpts} o */
  const buildDevice = (kind, sh, o) => {
    const group = new T.Group();
    group.matrixAutoUpdate = false;
    /** @type {any[]} */
    const mats = [];
    /** @param {any} m */
    const mat = (m) => {
      mats.push(fades(m));
      return m;
    };
    const color =
      o.color ?? (kind === "browser" ? (o.tone === "dark" ? "#2a2a2d" : "#e7e7e4") : "#2b2d31");
    const metal = () =>
      mat(
        new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.42, metalness: 0.25 }),
      );
    const glass = () =>
      mat(new T.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.18, metalness: 0 }));
    const b = sh.body;
    if (kind === "browser") {
      const front = new T.Texture(barPicture(b.w, b.h, sh.bar, o.tone ?? "light", color));
      front.colorSpace = T.SRGBColorSpace;
      front.anisotropy = aniso;
      front.needsUpdate = true;
      group.add(
        new T.Mesh(face(b, b.r), mat(new T.MeshBasicMaterial({ map: front, toneMapped: false }))),
      );
      group.children[0].position.z = -1;
      group.add(new T.Mesh(block(b, b.depth, -2), metal()));
    } else {
      // the front: dark glass round the screen; behind it the body
      const fg = face(b, b.r);
      fg.translate(0, 0, -1);
      group.add(new T.Mesh(fg, glass()));
      group.add(new T.Mesh(block(b, b.depth, -2), metal()));
    }
    if (sh.deck) {
      const dk = sh.deck;
      // the keyboard half: its top in its own x (across) and y (out from the
      // hinge), turned to `open` degrees from the lid about the hinge
      const half = new T.Group();
      const deckBox = { x: b.x, y: 0, w: dk.w, h: dk.depth, r: b.r };
      const slabG = new T.ExtrudeGeometry(roundRect(deckBox.x, 0, dk.w, dk.depth, b.r), {
        depth: dk.thick,
        bevelEnabled: false,
        curveSegments: 16,
      });
      half.add(new T.Mesh(slabG, metal()));
      const topTex = new T.Texture(deckPicture(dk.w, dk.depth, color));
      topTex.colorSpace = T.SRGBColorSpace;
      topTex.anisotropy = aniso;
      topTex.generateMipmaps = true;
      topTex.minFilter = T.LinearMipmapLinearFilter;
      topTex.needsUpdate = true;
      const topG = face(deckBox, b.r);
      topG.translate(0, 0, -0.6);
      half.add(
        new T.Mesh(
          topG,
          mat(
            new T.MeshStandardMaterial({
              map: topTex,
              roughness: 0.5,
              metalness: 0.15,
              side: T.DoubleSide,
            }),
          ),
        ),
      );
      // its axes in the lid's space (y up): across, out from the hinge, and
      // into the body (the extrusion's +z, away from the keys)
      const th = dk.open * RAD;
      const out = new T.Vector3(0, Math.cos(th), Math.sin(th));
      const across = new T.Vector3(1, 0, 0);
      const into = new T.Vector3().crossVectors(across, out);
      // the shape's y runs down from 0 to -depth (y up): out is its −y
      const basis = new T.Matrix4().makeBasis(across, out.clone().negate(), into);
      basis.setPosition(0, -dk.hinge.y, dk.hinge.z);
      half.matrixAutoUpdate = false;
      half.matrix.copy(basis);
      group.add(half);
    }
    group.traverse((/** @type {any} */ x) => {
      x.frustumCulled = false;
    });
    scene.add(group);
    return { kind, group, shape: sh, mats };
  };

  /** the slab's matrix in the stage at t: turned and sized about its origin,
   *  moved from where it sat, then the world's turn and the lens's travel —
   *  stage.js's own sum */
  /** @param {Rec} r @param {number} t */
  const placed = (r, t) => {
    const p = r.inner.pose(t);
    const w = st.world(t);
    const b = r.box;
    const o = r.handle.origin;
    const ox = b.w * o[0];
    const oy = b.h * o[1];
    const own = M.mul(
      M.mul(
        M.translate(b.x + ox + p.x, b.y + oy + p.y, p.z),
        M.mul(M.mul(M.rotateX(p.rx), M.rotateY(p.ry)), M.rotateZ(p.rz)),
      ),
      // sized evenly in depth too, so a device round it keeps its shape
      M.mul(
        [p.scale, 0, 0, 0, 0, p.scale, 0, 0, 0, 0, p.scale, 0, 0, 0, 0, 1],
        M.translate(-ox, -oy),
      ),
    );
    const turned = M.mul(
      M.mul(
        M.translate(pivot[0], pivot[1], w.z),
        M.mul(M.mul(M.rotateX(w.rx), M.rotateY(w.ry)), M.rotateZ(w.rz)),
      ),
      M.translate(-pivot[0], -pivot[1]),
    );
    return M.mul(turned, own);
  };

  /** the lens at t as three's projection: the stage's camera view and
   *  perspective (stage.js's), then the picture's px as clip space; depth
   *  from 2 % of the lens's distance in front of it (where a slab is gone)
   *  to 100 lens-distances behind */
  /** @param {number} t */
  const lensAt = (t) => {
    let m = M.identity();
    let cx = content.width / 2;
    let cy = content.height / 2;
    if (cam) {
      const v = cam.at(t);
      const s = v.scale ?? W / v.w;
      m = M.mul(M.translate(W / 2 - v.cx * s, H / 2 - v.cy * s), M.scale(s));
      const j = cam.jitter?.(t);
      if (j && (j.x || j.y || j.rot))
        m = M.mul(
          M.mul(M.translate(W / 2 + j.x, H / 2 + j.y), M.rotateZ(j.rot)),
          M.mul(M.translate(-W / 2, -H / 2), m),
        );
      cx = v.cx;
      cy = v.cy;
    }
    const persp = M.mul(M.mul(M.translate(cx, cy), M.perspective(d)), M.translate(-cx, -cy));
    // depth: z / (1 − z/d) runs from far to near; mapped onto −1 (near) … 1 (far)
    /** @param {number} z */
    const u = (z) => (z * d) / (d - z);
    const un = u(0.98 * d);
    const uf = u(-100 * d);
    const a = -2 / (un - uf);
    const bb = -1 - a * un;
    const clip = [2 / W, 0, 0, 0, 0, -2 / H, 0, 0, 0, 0, a, 0, -1, 1, bb, 1];
    const eye = /** @type {[number, number, number]} */ ([cx, -cy, d]);
    const proj = M.mul(
      clip,
      M.mul(m, M.mul(persp, M.mul(FLIP, M.translate(eye[0], eye[1], eye[2])))),
    );
    return { proj, eye };
  };

  /** @param {number} t @returns {WorldSlabState[]} */
  const at = (t) =>
    st.at(t).map((s, i) => {
      const r = /** @type {Rec} */ (recs[i]);
      return {
        name: s.name,
        pose: s.pose,
        quad: s.quad,
        area: s.area,
        flat: s.flat,
        facing: s.facing,
        visible: s.style.visibility === "visible",
        opacity: Number(s.style.opacity),
        depth: s.depth,
        source: r.source,
        device: r.device?.kind ?? null,
      };
    });

  /** @param {number} t @returns {Frame} */
  const frame = (t) => {
    const l = lensAt(t);
    const states = st.at(t);
    return {
      t,
      projection: l.proj,
      eye: l.eye,
      slabs: states.map((s, i) => {
        const op = Number(s.style.opacity);
        return {
          matrix: up(placed(/** @type {Rec} */ (recs[i]), t)),
          opacity: op,
          visible: s.style.visibility === "visible",
          shown: op > 0 && Number.isFinite(s.area),
        };
      }),
    };
  };

  /** @param {Frame} f */
  const draw = (f) => {
    if (!T) throw new Error("world: drawing needs three — world({ three: THREE, … })");
    lens.position.set(f.eye[0], f.eye[1], f.eye[2]);
    lens.updateMatrixWorld(true);
    lens.projectionMatrix.fromArray(f.projection);
    lens.projectionMatrixInverse.copy(lens.projectionMatrix).invert();
    const live = new Set();
    f.slabs.forEach((s, i) => {
      const r = recs[i];
      if (!r) return;
      r.mesh.matrix.fromArray(s.matrix);
      r.mesh.matrixWorldNeedsUpdate = true;
      r.mesh.visible = s.visible;
      opacityOf(r.mesh.material, s.opacity);
      if (r.device) {
        r.device.group.matrix.fromArray(s.matrix);
        r.device.group.matrixWorldNeedsUpdate = true;
        r.device.group.visible = s.shown;
        for (const m of r.device.mats) opacityOf(m, s.opacity);
      }
      if (s.visible && r.tex?.live) live.add(r.tex);
    });
    for (const tx of live) /** @type {Tex} */ (tx).live?.();
    renderer.render(scene, lens);
  };

  /**
   * A slab: a picture flat in space, with a pose over time (stage.js's).
   * @param {Src} src a picture's URL, a video's URL (it plays from film time 0), or an <img>, <canvas> or <video>
   * @param {WorldSlabOpts} o
   * @returns {WorldSlab}
   */
  const slab = (src, o) => {
    const name = o?.name ?? `slab ${recs.length + 1}`;
    const source = checkSource(o?.source, name);
    if (src == null || (typeof src !== "string" && !(typeof src === "object" && "tagName" in src)))
      throw new Error(
        `world: ${name}: a picture's or a video's URL, or an <img>, <canvas> or <video>`,
      );
    const crop = o.crop ? boxOf(o.crop) : null;
    const box = o.box
      ? boxOf(o.box)
      : (crop ?? { x: 0, y: 0, w: content.width, h: content.height });
    if (!(box.w > 0 && box.h > 0)) throw new Error(`world: ${name} needs a box with a size`);
    const inner = st.slab(null, {
      box,
      name,
      ...(o.origin ? { origin: o.origin } : {}),
      ...(o.backface ? { backface: o.backface } : {}),
      ...(o.rest ? { rest: o.rest } : {}),
    });
    /** @type {WorldSlab} */
    const handle = {
      name,
      box,
      origin: inner.origin,
      source,
      to(to, when) {
        inner.to(to, when);
        return handle;
      },
      set(to, at) {
        inner.set(to, at);
        return handle;
      },
      pose: (t) => inner.pose(t),
    };
    /** @type {Rec} */
    const r = {
      handle,
      inner,
      box,
      crop,
      src,
      source,
      radius: o.radius ?? 0,
      mesh: null,
      tex: null,
      device: null,
    };
    if (T) {
      r.tex = textureOf(src, name);
      const m = new T.MeshBasicMaterial({
        map: r.tex.texture,
        toneMapped: false,
        side: (o.backface ?? "hidden") === "visible" ? T.DoubleSide : T.FrontSide,
      });
      r.mesh = new T.Mesh(screenGeometry(r), m);
      r.mesh.matrixAutoUpdate = false;
      r.mesh.frustumCulled = false;
      scene.add(r.mesh);
    }
    recs.push(r);
    return handle;
  };

  /**
   * A device round a slab — a laptop, a phone, a browser window: a plain
   * shape, no logo, no brand. It moves with its slab (pose the slab).
   * @param {"laptop" | "phone" | "browser"} kind
   * @param {WorldSlab} sl a slab of this world: its screen
   * @param {DeviceOpts} [o]
   */
  const device = (kind, sl, o = {}) => {
    const r = recs.find((x) => x.handle === sl);
    if (!r) throw new Error(`world: a ${kind} goes round a slab of this world (w.slab(…))`);
    if (r.device) throw new Error(`world: ${r.handle.name} already has a ${r.device.kind}`);
    const shape = deviceShape(kind, r.box.w, r.box.h, o);
    if (T) {
      if (shape.screenRadius && !r.radius) {
        r.radius = shape.screenRadius;
        r.mesh.geometry.dispose();
        r.mesh.geometry = screenGeometry(r);
      }
      r.device = buildDevice(kind, shape, o);
    } else r.device = { kind, group: null, shape, mats: [] };
    return {
      kind,
      name: r.handle.name,
      slab: sl,
      shape,
      /** what it takes up, in the stage's px where its slab sits (z toward the lens) */
      bounds: {
        x: r.box.x + shape.bounds.x,
        y: r.box.y + shape.bounds.y,
        z: shape.bounds.z,
        w: shape.bounds.w,
        h: shape.bounds.h,
        d: shape.bounds.d,
      },
      /** @param {Partial<Pose>} to @param {When} when */
      to: (to, when) => sl.to(to, when),
      /** @param {Partial<Pose>} to @param {number} at */
      set: (to, at) => sl.set(to, at),
      /** @param {number} t */
      pose: (t) => sl.pose(t),
    };
  };

  return {
    width: W,
    height: H,
    perspective: d,
    /** the canvas it draws in (null without three) */
    canvas,
    /** three's renderer and scene, for what the kit does not do (null without three) */
    renderer,
    scene,
    slab,
    device,
    /** the whole world turns about its pivot (stage.js's turn)
     * @param {{ rx?: number, ry?: number, rz?: number }} to @param {When} when */
    turn: (to, when) => st.turn(to, when),
    /** the lens travels into the world (stage.js's dolly)
     * @param {number} z @param {When} when */
    dolly: (z, when) => st.dolly(z, when),
    /** the world's own turn and the lens's travel at t */
    /** @param {number} t */
    world: (t) => st.world(t),
    at,
    frame,
    draw,
    /** draw frame t; every slab at t back — a promise of them while a
     *  video shows on a slab (`window.__render = (t) => w.apply(t)` waits) */
    /** @param {number} t */
    apply(t) {
      if (!T) return at(t);
      const f = frame(t);
      /** @type {Set<Tex>} */
      const vids = new Set();
      f.slabs.forEach((s, i) => {
        const tx = recs[i]?.tex;
        if (s.visible && tx?.sync) vids.add(tx);
      });
      const waits = [...vids].map((tx) => tx.sync?.()).filter(Boolean);
      if (!waits.length) {
        draw(f);
        return at(t);
      }
      // a video on a slab: drawn once its frame at t is there — return this
      // from __render, which waits for it
      return Promise.all(waits).then(() => {
        draw(f);
        return at(t);
      });
    },
    /** every picture's source, slab by slab */
    sources: () =>
      recs.map((r) => ({
        name: r.handle.name,
        source: r.source,
        src:
          typeof r.src === "string"
            ? r.src
            : /** @type {any} */ (r.src).currentSrc ||
              /** @type {any} */ (r.src).src ||
              `<${r.src.tagName.toLowerCase()}>`,
        device: r.device?.kind ?? null,
      })),
    /** every picture loaded (window.__film.ready) */
    ready: () => Promise.all(recs.map((r) => r.tex?.ready)).then(() => undefined),
    /**
     * Pictures drawn bigger than their own pixels — a slab whose picture is
     * stretched past 1.1 drawing-buffer px per picture px — and when, checked
     * every 1/30 s from `from` to `to` (default 0 to the last move plus a
     * second). Pictures not loaded yet are not checked.
     * @param {number} [from] @param {number} [to]
     */
    warnings(from = 0, to) {
      const end = to ?? from + 1;
      const dpr = renderer ? renderer.getPixelRatio() : 1;
      /** @type {Map<string, [number, number, number]>} */
      const over = new Map();
      /** @type {string[]} */
      const out = [];
      const flush = (/** @type {string} */ n) => {
        const r = over.get(n);
        if (!r) return;
        out.push(
          `${n}: its picture drawn at ${r[2].toFixed(2)}× its own pixels ${r[0].toFixed(2)}–${r[1].toFixed(2)} s — soft; a sharper picture (film picture --scale 2), or smaller on screen`,
        );
        over.delete(n);
      };
      for (let t = from; t <= end + 1e-9; t += 1 / 30) {
        at(t).forEach((s, i) => {
          const r = /** @type {Rec} */ (recs[i]);
          const n = r.tex?.size();
          if (!n || !s.visible) {
            flush(s.name);
            return;
          }
          const c = r.crop ?? { x: 0, y: 0, w: content.width, h: content.height };
          const own = r.crop
            ? (c.w * n.w * c.h * n.h) / (content.width * content.height)
            : n.w * n.h;
          const k = Math.sqrt((s.area * dpr * dpr) / own);
          if (k > 1.1) {
            const p = over.get(s.name);
            over.set(s.name, p ? [p[0], t, Math.max(p[2], k)] : [t, t, k]);
          } else flush(s.name);
        });
      }
      for (const n of [...over.keys()]) flush(n);
      return out;
    },
  };
}
