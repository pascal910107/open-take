// A small synthetic shoot for the parts tests: a counter page saved at each
// still. A heading that moves down once and then stays, an "Add" button the
// shoot clicks twice (the product moves it down on the second screen), a
// number that counts up on every screen, and four stills of a drag along a
// slider ("n-1" … "n-4", a saved screen each, the cursor kept at each step,
// the page scrolled 50 px). Written as the shoot and the component probe
// would write them: shots.json, and states/<id>/ with state.html,
// index.json (each element marked data-ot-id in state.html) and parts.json
// — so gatherComponents reads it like any shoot.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PartDomFile } from "../../src/film/part-files";

type Box = [number, number, number, number];

const look = {
  fontPx: 16,
  weight: 400,
  family: "sans-serif",
  fg: "#111111",
  fill: null,
  backdrop: "#ffffff",
  radius: 0,
  shadow: false,
  border: false,
};
const facts = {
  areaShare: 0.01,
  fontRatio: 1,
  contrast: 18,
  fillContrast: 1,
  numeric: false,
  inFirstScreen: true,
};

/** each screen: where the heading and the button are, what the number reads */
const SCREENS: { id: string; heading: number; button: number; value: string }[] = [
  { id: "home", heading: 20, button: 100, value: "3" },
  { id: "add-1", heading: 60, button: 100, value: "4" },
  { id: "add-2", heading: 60, button: 140, value: "5" },
  { id: "n-1", heading: 60, button: 140, value: "6" },
  { id: "n-2", heading: 60, button: 140, value: "7" },
  { id: "n-3", heading: 60, button: 140, value: "8" },
  { id: "n-4", heading: 60, button: 140, value: "9" },
];

/** the stills: where the mouse was (page px) and the page's scroll */
export const STILLS = [
  { name: "home", cursor: { x: 10, y: 10 }, scroll: { x: 0, y: 0 } },
  { name: "add-1", action: "click", cursor: { x: 70, y: 110 }, scroll: { x: 0, y: 0 } },
  { name: "add-2", action: "click", cursor: { x: 75, y: 115 }, scroll: { x: 0, y: 0 } },
  { name: "n-1", action: "drag", cursor: { x: 300, y: 250 }, scroll: { x: 0, y: 50 } },
  { name: "n-2", action: "drag", cursor: { x: 320, y: 250 }, scroll: { x: 0, y: 50 } },
  { name: "n-3", action: "drag", cursor: { x: 340, y: 250 }, scroll: { x: 0, y: 50 } },
  { name: "n-4", action: "drag", cursor: { x: 400, y: 250 }, scroll: { x: 0, y: 50 } },
];

/** Write the shoot into `dir` (shots.json beside states/). */
export function writePartsShoot(dir: string): void {
  const stills = STILLS.map((s, i) => ({
    file: `${String(i).padStart(3, "0")}-${s.name}.png`,
    name: s.name,
    t: i,
    cursor: s.cursor,
    scroll: s.scroll,
    boxes: {},
    ...(s.action ? { action: s.action } : {}),
    // a drag's steps are taken with the button held
    ...(s.action === "drag" ? { down: true } : {}),
    state: s.name,
  }));
  writeFileSync(
    join(dir, "shots.json"),
    JSON.stringify({
      viewport: { w: 640, h: 360 },
      scale: 2,
      stills,
      states: {
        dir: "states",
        items: stills.map((s) => ({
          id: s.state,
          still: s.file,
          t: s.t,
          fidelity: { psnr: 40, diffFrac: 0, ok: true },
        })),
      },
    }),
  );
  SCREENS.forEach((s, i) => {
    const d = join(dir, "states", s.id);
    mkdirSync(d, { recursive: true });
    const heading: Box = [40, s.heading, 200, 30];
    const button: Box = [40, s.button, 100, 40];
    const value: Box = [300, 200, 80, 40];
    writeFileSync(
      join(d, "state.html"),
      `<!doctype html><html data-ot-id="e0"><head><meta charset="utf-8"><style>
html,body{margin:0;width:640px;height:360px;background:#fff;font:16px sans-serif}
h1,button,div{position:absolute;margin:0;padding:0;border:0}
h1{left:${heading[0]}px;top:${heading[1]}px;width:200px;height:30px;font-size:20px}
button{left:${button[0]}px;top:${button[1]}px;width:100px;height:40px;background:#ddd}
#n{left:${value[0]}px;top:${value[1]}px;width:80px;height:40px}
</style></head><body data-ot-id="e1"><h1 data-ot-id="e2">Counter</h1><button data-ot-id="e3">Add</button><div id="n" data-ot-id="e4">${s.value}</div></body></html>`,
    );
    writeFileSync(
      join(d, "index.json"),
      JSON.stringify({
        version: 1,
        id: s.id,
        url: "http://127.0.0.1:9/counter.html",
        title: "Counter",
        tMs: i * 1000,
        viewport: { w: 640, h: 360, dpr: 2 },
        scroll: STILLS[i]!.scroll,
        elements: [
          { id: "e0", path: [], tag: "html", box: [0, 0, 640, 360] },
          { id: "e1", path: [1], tag: "body", box: [0, 0, 640, 360] },
          { id: "e2", path: [1, 0], tag: "h1", text: "Counter", box: heading },
          {
            id: "e3",
            path: [1, 1],
            tag: "button",
            role: "button",
            name: "Add",
            text: "Add",
            box: button,
            interactive: true,
          },
          { id: "e4", path: [1, 2], tag: "div", text: s.value, box: value },
        ],
        layers: ["e1"],
      }),
    );
    const part = (el: string, kind: string, label: string, selector: string, box: Box) => ({
      el,
      kind,
      label,
      text: label,
      selector,
      box,
      look,
      facts: { ...facts, numeric: kind === "number" },
      lift: { around: "clear", box: "box", pad: 0 },
    });
    writeFileSync(
      join(d, "parts.json"),
      JSON.stringify({
        version: 1,
        state: s.id,
        viewport: { w: 640, h: 360 },
        scroll: { x: 0, y: 0 },
        medianTextPx: 16,
        parts: [
          part("e2", "heading", "Counter", "h1", heading),
          part("e3", "button", "Add", "button", button),
          part("e4", "number", s.value, "#n", value),
        ],
        skipped: [],
        ms: { measure: 1 },
      }),
    );
  });
}

/** Beside writePartsShoot: home's page linking a stylesheet that declares
 *  its font and @imports another, and what home's page gave of its parts as
 *  the runtime writes it (states/home/parts-dom.json) — the heading and the
 *  number (with a picture in it); the button skipped, with the page's reason. */
export function writePartDom(dir: string): void {
  const assets = join(dir, "states", "assets");
  mkdirSync(assets, { recursive: true });
  copyFileSync(
    join(import.meta.dirname, "fonts", "geist-mono-latin-400.woff2"),
    join(assets, "font.woff2"),
  );
  writeFileSync(join(assets, "mono.woff2"), "woff2");
  writeFileSync(
    join(assets, "pic.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#00f"/></svg>',
  );
  writeFileSync(
    join(assets, "a.css"),
    '@import url("b.css");\n@font-face{font-family:"Brand Sans";src:url(font.woff2) format("woff2");font-weight:400}\nh1{color:red}',
  );
  writeFileSync(
    join(assets, "b.css"),
    "@font-face{font-family:Mono;src:url('../assets/mono.woff2')}",
  );
  const home = join(dir, "states", "home");
  const html = readFileSync(join(home, "state.html"), "utf8").replace(
    "</head>",
    '<link rel="stylesheet" href="../assets/a.css"><style>@font-face{font-family:Unused;src:url(../assets/none.woff2)}</style></head>',
  );
  writeFileSync(join(home, "state.html"), html);
  const dom: PartDomFile = {
    version: 1,
    state: "home",
    parts: [
      {
        el: "e2",
        html: '<h1 style="font-family:&quot;Brand Sans&quot;, sans-serif;font-size:20px;margin:0;position:relative;float:none">Counter</h1>',
        css: "",
        defs: "",
        w: 200,
        h: 30,
        families: ["brand sans", "sans-serif"],
        nodes: 1,
      },
      {
        el: "e4",
        html: '<div id="n" data-ot-p="1" style="background-image:url(&quot;otrel:assets/pic.svg&quot;);margin:0"><img src="otrel:assets/pic.svg" style="width:20px;height:20px">3</div>',
        css: '[data-ot-p="1"]::before{content:"--> $"}',
        defs: "",
        w: 79.5,
        h: 40,
        families: ["mono"],
        nodes: 1,
      },
    ],
    skipped: [
      {
        el: "e3",
        why: "it holds an <iframe>: what is inside a frame is another page, not carried into a file",
      },
    ],
    ms: 3,
  };
  writeFileSync(join(home, "parts-dom.json"), JSON.stringify(dom));
}
