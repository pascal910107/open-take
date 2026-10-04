// open-take shoot — a film's material, shot by a script its author writes.
//
// Twelve promo films were written by agents as web pages, and every one of
// them first wrote its own Playwright/Puppeteer capture script (18–27% of all
// their code). Six invented "a 2× screenshot after every input" on their own,
// eight re-shot their material, at least seven copied element coordinates
// into the film page by hand, and none used `make --states`. So this imposes
// no plan format: the author keeps writing a script, and open-take supplies
// the browser and an object `s` that takes the boilerplate away —
//
//   // shoot.mjs
//   export default async (s) => {
//     await s.open("https://app.example");              // loaded, hydrated, settled
//     await s.track("#total");                           // its box in every later still
//     await s.still("home");                             // 000-home.png
//     await s.click("text=Add row");                     // real click, settle, still
//     await s.type("#name", "Ada", { each: true });      // a still per keystroke
//     await s.drag(".handle", { dx: 240 }, { every: 4 }); // a still every 4 px
//   };
//
// The log, `<out>/shots.json`, is what the film page imports — every
// coordinate it needs, measured:
//
//   { viewport: { w, h },        the page's size, CSS px
//     scale,                     image px per CSS px: a still is w·scale × h·scale
//     stills: [{
//       file,                    "NNN-<name>.png", beside shots.json, in shooting order
//       name,                    as given; a keystroke's or drag step's still is "<name>-<i>"
//       t,                       seconds since the shoot began, wall clock
//       cursor: { x, y },        the mouse
//       scroll: { x, y },        the page's scroll: the still's top-left on the page
//       boxes: { [target]: { x, y, width, height } },
//                                every target tracked or acted on that the page renders
//       action?,                 "click" | "type" | "drag" | "move" | "press": what took it
//       down?: true,             the mouse button is held (a drag's steps)
//     }],
//     error? }                   only in a failed shoot's log
//
// Every position is PAGE CSS px, so a box stays put when the page scrolls; to
// place one on its still, subtract that still's scroll (times scale for image
// px). A still a call returns is its log entry: fields the script adds to it
// (a value read off the page) are saved with it.
//
// A shoot replaces the previous one in <out> only when its script finishes. A
// script that throws leaves the last good shoot as it was, and what it did
// take in <out>/.shoot/ with the error in its shots.json.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BOX_CANDIDATES,
  CLICK_CANDIDATES,
  CLICK_FALLBACK_CANDIDATES,
  FIELD_CANDIDATES,
  HITTABLE_JS,
  NAME_JS,
  selectAllInFocusedJs,
  UNREACHABLE_JS,
} from "./capture";
import { type Browser, CDP, fitViewport, launchBrowser } from "./cdp";
import { awaitFonts, navigate, originAllowed, pressChord } from "./cdp-capture";
import { DEFAULT_SETTLE_BUDGET_MS, installActivityProbe, settle } from "./settle";

// --- the contract -------------------------------------------------------------

/** A CSS selector (the first match the page renders), `text=<name>` (an
 *  element by its accessible name, as `make` plans name them — controls
 *  first, then any element carrying exactly that name, then one containing
 *  it), or a point in VIEWPORT CSS px, where the mouse goes. */
export type ShootTarget = string | { x: number; y: number };
export type ShootBox = { x: number; y: number; width: number; height: number };
export type ShootAction = "click" | "type" | "drag" | "move" | "press";
export type ShootStill = {
  file: string;
  name: string;
  t: number;
  cursor: { x: number; y: number };
  scroll: { x: number; y: number };
  boxes: Record<string, ShootBox>;
  action?: ShootAction;
  down?: true;
};
export type ShootLog = {
  viewport: { w: number; h: number };
  scale: number;
  stills: ShootStill[];
  error?: string;
};

/** true: wait for the page to go quiet (activity probe, settle.ts) up to the
 *  default budget; a number: up to that many ms; false: not at all. */
export type ShootSettle = boolean | number;
export type ShootActOpts = {
  /** the still's name (default: the action's) */
  name?: string;
  /** default true */
  settle?: ShootSettle;
  /** take a still once the action is done (default true) */
  still?: boolean;
  /** how long the target may take to appear and become reachable (default 5000 ms) */
  timeoutMs?: number;
};
export type ShootOpenOpts = {
  /** what "ready" means for this page: a target that must appear, or a check
   *  run here (an async function) that must come true */
  ready?: string | (() => unknown);
  /** default true, waiting up to 3000 ms */
  settle?: ShootSettle;
  /** how long the page may take to show something (default 15000 ms) */
  timeoutMs?: number;
};

export type Shoot = {
  /** navigate, then wait until the page answers, shows something, has its
   *  input handlers (has hydrated) and has gone quiet */
  open(
    url: string,
    opts?: ShootOpenOpts,
  ): Promise<{ url: string; title: string; errors: string[] }>;
  /** one PNG and its log entry, now (settle: false by default) */
  still(name?: string, opts?: { settle?: ShootSettle }): Promise<ShootStill>;
  /** move the mouse onto the target and click it, for real */
  click(target: ShootTarget, opts?: ShootActOpts): Promise<ShootStill | null>;
  /** click into the field unless it has the caret, then type key by key
   *  (`each`: a still after every key); a null target types into whatever
   *  has focus */
  type(
    target: ShootTarget | null,
    text: string,
    opts?: ShootActOpts & { each?: boolean; clear?: boolean },
  ): Promise<ShootStill | null>;
  /** press on the target, move in a straight line, release (`every`: a
   *  still every that many px on the way, button held) */
  drag(
    target: ShootTarget,
    to: { dx?: number; dy?: number } | { to: ShootTarget },
    opts?: ShootActOpts & { every?: number },
  ): Promise<ShootStill | null>;
  /** move the mouse onto the target (a hover) */
  move(target: ShootTarget, opts?: ShootActOpts): Promise<ShootStill | null>;
  /** a key or chord: "Enter", "Meta+k", "Shift+Tab" */
  press(keys: string, opts?: ShootActOpts): Promise<ShootStill | null>;
  /** record these targets' boxes in every later still */
  track(targets: string | string[]): Promise<void>;
  /** ms, a target that must appear, or a check run here that must come true */
  wait(what: number | string | (() => unknown), opts?: { timeoutMs?: number }): Promise<void>;
  /** run in the page: a function (with JSON arguments) or an expression */
  evaluate<T = unknown>(fn: string | ((...args: never[]) => T), ...args: unknown[]): Promise<T>;
  /** run before the page's own scripts on every later navigation (call it before open) */
  inject(js: string | (() => void)): Promise<void>;
  /** a raw CDP session on the shot page — its own, so its listeners cannot
   *  disturb the shoot's; mouse events sent through it move the logged cursor */
  readonly cdp: {
    send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    on<T = unknown>(event: string, fn: (params: T) => void): () => void;
  };
  /** the browser's DevTools endpoint: puppeteer.connect({ browserWSEndpoint })
   *  or Playwright's chromium.connectOverCDP reach the same page */
  readonly wsEndpoint: string;
  /** where the mouse is, viewport CSS px; set it after moving the mouse some
   *  other way (puppeteer, Playwright) so the log follows */
  cursor: { x: number; y: number };
  /** every still so far */
  readonly stills: readonly ShootStill[];
  readonly viewport: { w: number; h: number };
  readonly scale: number;
  /** the shoot's directory */
  readonly out: string;
};

export type ShootScript = (s: Shoot) => unknown;

export type ShootOpts = {
  /** a module whose default export is the script, or the script itself */
  script: string | ShootScript;
  outDir: string;
  /** viewport, CSS px (default 1920×1080) */
  width?: number;
  height?: number;
  /** image px per CSS px (default 2) */
  scale?: number;
  chromePath?: string;
  /** a persistent profile (`open-take auth`) */
  userDataDir?: string;
  headless?: boolean;
  /** advisories (default: stderr) */
  onNote?: (line: string) => void;
};

// --- timing ---------------------------------------------------------------------

/** how long a target may take to appear and become reachable */
const TARGET_WAIT_MS = 5000;
/** how long a page may take to show anything at all */
const OPEN_WAIT_MS = 15_000;
/** how long, once it shows something, a page with scripts may take to attach
 *  its input handlers. Pays out in full only on a page whose scripts never
 *  listen for input (a static page with analytics), so it is short. */
const HANDLERS_WAIT_MS = 3000;
/** a fresh page's trailing requests (fonts, analytics, lazy chunks) */
const OPEN_SETTLE_MS = 3000;
/** a mouse event's acknowledgement can be withheld for seconds in headless
 *  while the button is held and nothing paints (see cdp-capture's drag); the
 *  events stay ordered on the socket, so waiting longer buys nothing */
const ACK_MS = 150;
/** a link click or an Enter starts a navigation a moment after the input:
 *  long enough for Chrome to say so before the settle reads the old page */
const NAV_GRACE_MS = 50;
const NAV_WAIT_MS = 15_000;
/** a drag with no stills on the way still moves in small steps, at about
 *  60 per second: canvases draw and sliders follow only a moving pointer */
const DRAG_STEP_PX = 10;
const DRAG_STEP_MS = 16;

/** what a page listens to when it can be driven */
const INPUT_EVENTS = new Set([
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "change",
  "submit",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `p`'s value, or undefined once `ms` have passed — with its timer cleared,
 *  since a live one holds the process open */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`;
const show = (t: ShootTarget | null) =>
  typeof t === "string" ? JSON.stringify(t) : t == null ? "null" : `{ x: ${t.x}, y: ${t.y} }`;

/** a still's name as a file name: whatever a file system dislikes becomes "-" */
export function stillFile(index: number, name: string): string {
  const slug = name.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "") || "still";
  return `${String(index).padStart(3, "0")}-${slug}.png`;
}

// --- keys -----------------------------------------------------------------------

type Key = { key: string; code: string; vk: number; text: string; shift?: true };

// A typed character goes out as the key a US keyboard presses for it, so a
// page that listens to keydown (an editor's autocomplete, a math field) sees
// typing; anything else (CJK, emoji) is inserted as text, like an IME.
const PUNCT: Record<string, [string, number]> = {
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};
const SHIFTED: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

export function keyFor(ch: string): Key | null {
  if (ch === "\n") return { key: "Enter", code: "Enter", vk: 13, text: "\r" };
  if (ch === " ") return { key: " ", code: "Space", vk: 32, text: " " };
  if (/^[a-z]$/i.test(ch)) {
    const up = ch.toUpperCase();
    return {
      key: ch,
      code: `Key${up}`,
      vk: up.charCodeAt(0),
      text: ch,
      ...(ch === up ? { shift: true as const } : {}),
    };
  }
  const base = SHIFTED[ch] ?? ch;
  const shift = ch in SHIFTED ? { shift: true as const } : {};
  if (/^[0-9]$/.test(base))
    return { key: ch, code: `Digit${base}`, vk: base.charCodeAt(0), text: ch, ...shift };
  const p = PUNCT[base];
  return p ? { key: ch, code: p[0], vk: p[1], text: ch, ...shift } : null;
}

// --- in the page ----------------------------------------------------------------

type Kind = "click" | "field" | "box";

// locate(target, kind) → { el } | { err } | null. A CSS selector takes the
// first match the page renders: a hidden duplicate (the mobile menu's copy)
// is never what a shot means. `text=` tries, in turn: an exact name among the
// controls this kind of action uses (make's candidate sets), an exact name on
// any rendered element (the innermost — a React div-button has no role), then
// the same two by substring. A name's element is remembered per document, so
// tracking it in every one of a few hundred drag stills costs one lookup.
const LOCATE_JS =
  NAME_JS +
  `function shown(e){return e.getClientRects().length>0;}` +
  // in document order an element's descendants follow it, so the first match
  // whose successor is not inside it has no match inside it
  `function innermost(l){for(var i=0;i<l.length;i++){var n=l[i+1];if(!n||!l[i].contains(n))return l[i];}return null;}` +
  `function byName(t,kind){` +
  `var sets={click:[${JSON.stringify(CLICK_CANDIDATES)},${JSON.stringify(CLICK_FALLBACK_CANDIDATES)}],` +
  `field:[${JSON.stringify(FIELD_CANDIDATES)}],box:[${JSON.stringify(BOX_CANDIDATES)}]}[kind]||[];` +
  `var c=[];for(var s=0;s<sets.length;s++){c=c.concat(Array.prototype.slice.call(document.querySelectorAll(sets[s])).filter(shown));}` +
  `function exact(e){return names(e).indexOf(t)!==-1;}` +
  `function part(e){var n=names(e);for(var j=0;j<n.length;j++){if(n[j].indexOf(t)!==-1)return true;}return false;}` +
  `var m=c.find(exact);if(m)return m;` +
  `var all=Array.prototype.slice.call(document.body?document.body.querySelectorAll('*'):[]).filter(function(e){return !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(e.tagName)&&shown(e);});` +
  `return innermost(all.filter(exact))||c.find(part)||innermost(all.filter(part));}` +
  `function locate(q,kind){` +
  `if(q.slice(0,5)==='text='){var t=q.slice(5).replace(/\\s+/g,' ').trim();` +
  `var C=window.__openTakeShoot||(window.__openTakeShoot={});var k=kind+'\\n'+t,h=C[k];` +
  `if(h&&h.isConnected&&shown(h)&&names(h).some(function(n){return n.indexOf(t)!==-1;}))return {el:h};` +
  `var m=byName(t,kind);if(m)C[k]=m;return m?{el:m}:null;}` +
  `var l;try{l=document.querySelectorAll(q);}catch(e){return {err:String(e&&e.message||e)};}` +
  `for(var i=0;i<l.length;i++){if(shown(l[i]))return {el:l[i]};}return null;}`;

type Found = {
  x: number;
  y: number;
  w: number;
  h: number;
  tag: string;
  disabled: boolean;
  hit: boolean;
  why?: string;
  err?: string;
};

/** Resolve a target for an action. `scroll`: bring it into view first when
 *  any of it is outside — instantly, so the box and the click that follows
 *  describe the same layout (see capture.ts's CLICK_TAIL_JS). */
function findJs(target: string, kind: Kind, scroll: boolean): string {
  return (
    `(function(){${LOCATE_JS}${HITTABLE_JS}${UNREACHABLE_JS}` +
    `var f=locate(${JSON.stringify(target)},${JSON.stringify(kind)});if(!f)return null;` +
    `if(f.err)return JSON.stringify({err:f.err});var m=f.el,r=m.getBoundingClientRect();` +
    (scroll
      ? `if(r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth){` +
        `m.scrollIntoView({block:'center',inline:'center',behavior:'instant'});r=m.getBoundingClientRect();}`
      : "") +
    `var p=hittable(m,r);` +
    `return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,tag:m.tagName,disabled:m.disabled===true,` +
    `hit:!!p,why:p?undefined:unreachable(m)});})()`
  );
}

/** the scroll offset and the page box of every tracked target, in one read */
function geometryJs(tracked: [string, Kind][]): string {
  return (
    `(function(){${LOCATE_JS}var K=${JSON.stringify(tracked)},b={};` +
    `for(var i=0;i<K.length;i++){var f=locate(K[i][0],K[i][1]);if(!f||f.err)continue;` +
    `var r=f.el.getBoundingClientRect();b[K[i][0]]=[r.x+scrollX,r.y+scrollY,r.width,r.height];}` +
    `return JSON.stringify({sx:scrollX,sy:scrollY,b:b});})()`
  );
}

/** Where the caret is: whether the focused element takes typing, and whether
 *  it belongs to the target (across shadow roots, or as the editable host
 *  wrapping it). The same predicate as capture.ts's FOCUS_STATE_JS. */
function focusJs(target: string | null): string {
  const find = target == null ? "null" : `locate(${JSON.stringify(target)},'field')`;
  return (
    `(function(){${LOCATE_JS}var f=${find},m=f&&f.el;` +
    `var a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;` +
    `var ed=!!a&&a!==document.body&&(a.isContentEditable||(typeof a.value==='string'&&!a.readOnly&&!a.disabled));` +
    `function inside(n){while(n){if(n===m)return true;var rn=n.getRootNode?n.getRootNode():null;n=n.parentElement||(rn&&rn.host?rn.host:null);}return false;}` +
    `var own=!!m&&!!a&&(inside(a)||(a.isContentEditable&&a.contains(m)));` +
    `return JSON.stringify({editable:ed,own:own});})()`
  );
}

/** Whether the page shows anything in the viewport — laid-out text, or a
 *  picture, a canvas, a control — and whether it has scripts to hydrate (a
 *  JSON-LD or template block runs nothing, so it does not count). */
const SHOWS_JS =
  `(function(){var vw=innerWidth,vh=innerHeight,shows=false,run=0;` +
  `for(var j=0;j<document.scripts.length;j++){var ty=(document.scripts[j].type||'').trim().toLowerCase();` +
  `if(!ty||ty==='module'||/^(text|application)\\/(x-)?(java|ecma)script$/.test(ty))run++;}` +
  `function seen(r){return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<vw&&r.top<vh;}` +
  `var root=document.body||document.documentElement;if(root){` +
  `var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),n,k=0;` +
  `while(!shows&&k++<20000&&(n=w.nextNode())){if(!n.data.trim())continue;var p=n.parentElement;` +
  `if(p&&/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName))continue;` +
  `var g=document.createRange();g.selectNodeContents(n);if(seen(g.getBoundingClientRect()))shows=true;}` +
  `if(!shows){var e=root.querySelectorAll('img,svg,canvas,video,iframe,object,embed,input,button,select,textarea');` +
  `for(var i=0;i<e.length&&!shows;i++){if(seen(e[i].getBoundingClientRect()))shows=true;}}}` +
  `return JSON.stringify({shows:shows,scripts:run,url:location.href,title:document.title});})()`;

/** a frame later than any input already sent, and its rAF work (where many
 *  editors draw) done: what the next screenshot shows has caught up */
const FRAME_JS =
  "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))";

// --- the run --------------------------------------------------------------------

/** Run a shoot script against a fresh Chrome and write its stills and
 *  shots.json into `outDir`. A script that throws rejects with its own
 *  message (and where in the script it came from). */
export async function runShoot(opts: ShootOpts): Promise<{ log: ShootLog; path: string }> {
  const out = resolve(opts.outDir);
  const stage = join(out, ".shoot");
  const note = opts.onNote ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { run, file } = await loadScript(opts.script);
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const scale = opts.scale ?? 2;
  for (const [what, v] of [
    ["width", width],
    ["height", height],
  ] as const)
    if (!Number.isInteger(v) || v < 64 || v > 8192)
      throw new Error(`shoot: the viewport ${what} must be whole CSS px, 64–8192 (got ${v})`);
  if (!(scale > 0 && scale <= 4))
    throw new Error(`shoot: scale must be above 0 and at most 4 (got ${scale})`);

  await mkdir(out, { recursive: true });
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  let browser: Browser | null = null;
  let raw: CDP | null = null;
  const stills: ShootStill[] = [];
  let viewport = { w: width, h: height };
  try {
    browser = await launchBrowser({
      width,
      height,
      chromePath: opts.chromePath,
      deviceScaleFactor: scale,
      ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
      ...(opts.headless === false ? { headless: false } : {}),
    });
    const { cdp, port, targetId } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const inner = await fitViewport(cdp, targetId, width, height);
    viewport = { w: inner[0], h: inner[1] };
    if (inner[0] !== width || inner[1] !== height)
      note(
        `shoot: the window would only give a ${inner[0]}×${inner[1]} viewport (asked ${width}×${height}); the stills are that size`,
      );
    // installed for every document from here on, so open() and every action
    // can tell a page that is done from one that is still working
    await installActivityProbe(cdp);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    raw = await CDP.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    const s = await shoot({
      cdp,
      raw,
      wsEndpoint: version.webSocketDebuggerUrl,
      viewport,
      scale,
      out,
      stage,
      stills,
      note,
    });
    try {
      await run(s);
    } catch (e) {
      const message = scriptFailure(e, file);
      const partial: ShootLog = { viewport, scale, stills, error: message };
      await writeFile(join(stage, "shots.json"), `${JSON.stringify(partial, null, 2)}\n`);
      if (stills.length)
        note(`shoot: the ${stills.length} still(s) taken before it stopped are in ${stage}`);
      throw new Error(`shoot: ${message}`);
    }
  } finally {
    raw?.close();
    await browser?.close();
  }

  // the script finished: this shoot replaces the last one
  await retire(out);
  for (const st of stills) await rename(join(stage, st.file), join(out, st.file));
  const log: ShootLog = { viewport, scale, stills };
  const path = join(out, "shots.json");
  await writeFile(path, `${JSON.stringify(log, null, 2)}\n`);
  await rm(stage, { recursive: true, force: true });
  return { log, path };
}

async function loadScript(
  script: string | ShootScript,
): Promise<{ run: ShootScript; file?: string }> {
  if (typeof script === "function") return { run: script };
  const file = resolve(script);
  if (!existsSync(file)) throw new Error(`shoot: no script at ${file}`);
  let mod: { default?: unknown };
  try {
    // a fresh copy each run: an edited script must not come back from the cache
    mod = await import(`${pathToFileURL(file).href}?shoot=${Date.now()}`);
  } catch (e) {
    throw new Error(`shoot: ${basename(file)} did not load — ${scriptFailure(e, file)}`);
  }
  if (typeof mod.default !== "function")
    throw new Error(
      `shoot: ${basename(file)} has no default export — write \`export default async (s) => { … }\``,
    );
  return { run: mod.default as ShootScript, file };
}

/** the error's message, and the line of the script it came from */
function scriptFailure(e: unknown, file?: string): string {
  const err = e instanceof Error ? e : new Error(String(e));
  if (!file || !err.stack) return err.message;
  const href = pathToFileURL(file).href;
  const line = err.stack.split("\n").find((l) => l.includes(href) || l.includes(file));
  const at = line?.match(/:(\d+):(\d+)\)?\s*$/) ?? line?.match(/:(\d+)\s*$/);
  return at
    ? `${err.message} (${basename(file)}:${at.slice(1).filter(Boolean).join(":")})`
    : err.message;
}

/** Remove the previous shoot's stills (exactly the files its log names) and
 *  its log. Anything else in the directory is the author's. */
async function retire(out: string): Promise<void> {
  let old: ShootLog;
  try {
    old = JSON.parse(await readFile(join(out, "shots.json"), "utf8")) as ShootLog;
  } catch {
    return;
  }
  for (const st of Array.isArray(old.stills) ? old.stills : [])
    if (typeof st?.file === "string" && /^\d{3,}-[^/\\]+\.png$/.test(st.file))
      await rm(join(out, st.file), { force: true });
  await rm(join(out, "shots.json"), { force: true });
}

// --- s ----------------------------------------------------------------------------

type Ctx = {
  cdp: CDP;
  raw: CDP;
  wsEndpoint: string;
  viewport: { w: number; h: number };
  scale: number;
  out: string;
  stage: string;
  stills: ShootStill[];
  note: (line: string) => void;
};

async function shoot(ctx: Ctx): Promise<Shoot> {
  const { cdp, raw, viewport, stills, note } = ctx;
  const t0 = Date.now();
  // the mouse, viewport CSS px — until the script moves it, where a take's
  // cursor rests (cdp-capture's start: a quarter across, near the bottom)
  let cursor = { x: r2(viewport.w * 0.25), y: r2(viewport.h * 0.9) };
  let down = false;
  const tracked = new Map<string, Kind>();
  const noted = new Set<string>();
  const once = (key: string, line: string) => {
    if (noted.has(key)) return;
    noted.add(key);
    note(line);
  };

  // every mouse event, ours or one sent through s.cdp, moves the logged mouse
  const follow = (p: Record<string, unknown>) => {
    if (typeof p.x === "number" && typeof p.y === "number") cursor = { x: p.x, y: p.y };
    if (p.type === "mousePressed") down = true;
    if (p.type === "mouseReleased") down = false;
  };

  // Navigations of the main frame — a link click, an Enter in a form — so an
  // action that starts one returns on the page it leads to.
  const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  const main = tree.frameTree.frame.id;
  let loading = false;
  let stopped: (() => void)[] = [];
  cdp.on<{ frameId: string }>("Page.frameStartedLoading", (p) => {
    if (p.frameId === main) loading = true;
  });
  cdp.on<{ frameId: string }>("Page.frameStoppedLoading", (p) => {
    if (p.frameId !== main) return;
    loading = false;
    for (const r of stopped.splice(0)) r();
  });
  const pageErrors: string[] = [];
  cdp.on<{ exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    "Runtime.exceptionThrown",
    (p) => {
      const d = p.exceptionDetails;
      pageErrors.push((d?.exception?.description ?? d?.text ?? "an error").split("\n")[0]!);
    },
  );

  const evaluate = async <T>(expression: string, what: string): Promise<T> => {
    const r = await cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(
        `${what}: ${(d.exception?.description ?? d.text ?? "it threw").split("\n")[0]}`,
      );
    }
    return r.result?.value as T;
  };

  const mouse = async (
    type: "mouseMoved" | "mousePressed" | "mouseReleased",
    x: number,
    y: number,
    ackMs = ACK_MS,
  ) => {
    const params = {
      type,
      x,
      y,
      button: type === "mouseMoved" && !down ? "none" : "left",
      buttons: type === "mouseReleased" || (type === "mouseMoved" && !down) ? 0 : 1,
      ...(type === "mouseMoved" ? {} : { clickCount: 1 }),
    };
    follow(params);
    const sent = cdp.send("Input.dispatchMouseEvent", params).catch(() => {});
    if (ackMs > 0) await within(sent, ackMs);
  };

  const key = async (ch: string) => {
    const k = keyFor(ch);
    if (!k) {
      await cdp.send("Input.insertText", { text: ch });
      return;
    }
    const base = {
      modifiers: k.shift ? 8 : 0,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
    };
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      text: k.text,
      unmodifiedText: k.text,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  /** the input just sent may have started a navigation: return on the new page */
  const arrive = async () => {
    await sleep(NAV_GRACE_MS);
    if (!loading) return;
    await within(new Promise<void>((r) => stopped.push(r)), NAV_WAIT_MS);
    stopped = [];
    await awaitFonts(cdp);
  };

  const settleFor = async (opt: ShootSettle | undefined, fallback: ShootSettle, input: boolean) => {
    const on = opt ?? fallback;
    if (on === false || on === 0) return;
    const budgetMs = typeof on === "number" ? on : DEFAULT_SETTLE_BUDGET_MS;
    if (input) await arrive();
    let r = await settle(cdp, 0, { budgetMs });
    if (input && loading) {
      // it began while the old page was being read
      await arrive();
      r = await settle(cdp, 0, { budgetMs });
    }
    if (r.reason === "budget")
      once(
        "quiet",
        `shoot: the page did not go quiet within ${budgetMs} ms (a clock, a poll, a stream?) — every settle on it costs that much; pass settle: false where the moment does not need it`,
      );
  };

  /** one PNG and its log entry */
  const capture = async (name: string, action?: ShootAction): Promise<ShootStill> => {
    await within(
      evaluate(FRAME_JS, "s.still").catch(() => {}),
      500,
    );
    const t = Math.round(Date.now() - t0) / 1000;
    let geo: {
      sx: number;
      sy: number;
      b: Record<string, [number, number, number, number]>;
    } | null = null;
    // a document being swapped (settle: false across a navigation) cannot be read for a moment
    for (let i = 0; !geo; i++) {
      try {
        geo = JSON.parse(await evaluate<string>(geometryJs([...tracked]), "s.still"));
      } catch (e) {
        if (i >= 5) throw e;
        await sleep(100);
      }
    }
    const shot = await within(
      cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }),
      60_000,
    );
    if (!shot)
      throw new Error(`s.still(${JSON.stringify(name)}): the page did not paint within 60 s`);
    const file = stillFile(stills.length, name);
    await writeFile(join(ctx.stage, file), Buffer.from(shot.data, "base64"));
    const g = geo!;
    const boxes: Record<string, ShootBox> = {};
    for (const [k, [x, y, width, height]] of Object.entries(g.b))
      boxes[k] = { x: r2(x), y: r2(y), width: r2(width), height: r2(height) };
    const still: ShootStill = {
      file,
      name,
      t,
      cursor: { x: r2(cursor.x + g.sx), y: r2(cursor.y + g.sy) },
      scroll: { x: r2(g.sx), y: r2(g.sy) },
      boxes,
      ...(action ? { action } : {}),
      ...(down ? { down: true as const } : {}),
    };
    stills.push(still);
    return still;
  };

  const after = async (
    o: ShootActOpts,
    action: ShootAction,
    name: string,
  ): Promise<ShootStill | null> => {
    await settleFor(o.settle, true, true);
    return o.still === false ? null : capture(name, action);
  };

  /** wait for the target to appear (and, `reach`, to be hittable and enabled) */
  const find = async (
    what: string,
    target: string,
    kind: Kind,
    timeoutMs: number,
    o: { reach: boolean; scroll: boolean },
  ): Promise<Found> => {
    const deadline = Date.now() + timeoutMs;
    let last: Found | null = null;
    for (;;) {
      const json = await evaluate<string | null>(findJs(target, kind, o.scroll), what);
      if (json) {
        const f = JSON.parse(json) as Found;
        if (f.err)
          throw new Error(`${what}: ${JSON.stringify(target)} is not a valid selector (${f.err})`);
        if (!o.reach || (f.hit && !f.disabled)) return f;
        last = f;
      }
      if (Date.now() >= deadline) {
        if (!last)
          throw new Error(
            `${what}: nothing on the page matches ${JSON.stringify(target)} (waited ${secs(timeoutMs)})`,
          );
        throw new Error(
          `${what}: ${JSON.stringify(target)} ${last.disabled ? "stayed disabled" : `cannot be reached — ${last.why}`} (waited ${secs(timeoutMs)}); a point { x, y } clicks wherever you say`,
        );
      }
      await sleep(100);
    }
  };

  /** where the mouse goes for a target: a given point, or the centre of the element */
  const point = async (
    what: string,
    target: ShootTarget,
    kind: Kind,
    o: { timeoutMs?: number; reach?: boolean; scroll?: boolean } = {},
  ): Promise<{ x: number; y: number; tag?: string }> => {
    if (typeof target !== "string") {
      if (!Number.isFinite(target?.x) || !Number.isFinite(target?.y))
        throw new Error(`${what}: a point needs numbers { x, y } (viewport CSS px)`);
      return { x: target.x, y: target.y };
    }
    const f = await find(what, target, kind, o.timeoutMs ?? TARGET_WAIT_MS, {
      reach: o.reach ?? true,
      scroll: o.scroll ?? true,
    });
    // acting on it puts it in the log: an action's own kind of lookup wins over
    // a plain track, so the box recorded is the element acted on
    tracked.set(target, kind);
    return { x: r2(f.x + f.w / 2), y: r2(f.y + f.h / 2), tag: f.tag };
  };

  const click = async (x: number, y: number) => {
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y);
    await sleep(40);
    await mouse("mouseReleased", x, y);
  };

  const waitFor = async (
    what: string,
    cond: number | string | (() => unknown),
    timeoutMs: number,
  ) => {
    if (typeof cond === "number") {
      await sleep(cond);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (typeof cond === "string") {
        const json = await evaluate<string | null>(findJs(cond, "box", false), what);
        const f = json ? (JSON.parse(json) as Found) : null;
        if (f?.err)
          throw new Error(`${what}: ${JSON.stringify(cond)} is not a valid selector (${f.err})`);
        if (f) return;
      } else if (await cond()) return;
      if (Date.now() >= deadline)
        throw new Error(
          `${what}: ${typeof cond === "string" ? `${JSON.stringify(cond)} never appeared` : "the condition never held"} (waited ${secs(timeoutMs)})`,
        );
      await sleep(100);
    }
  };

  /** input handlers the page has attached anywhere (-1: could not tell) */
  const inputHandlers = async (): Promise<number> => {
    const group = "open-take-shoot";
    try {
      let n = 0;
      for (const [expression, depth] of [
        ["document", -1],
        ["window", 0],
      ] as const) {
        const r = await cdp.send<{ result?: { objectId?: string } }>("Runtime.evaluate", {
          expression,
          objectGroup: group,
        });
        if (!r.result?.objectId) continue;
        const l = await cdp.send<{ listeners?: { type: string }[] }>(
          "DOMDebugger.getEventListeners",
          { objectId: r.result.objectId, depth, pierce: true },
        );
        n += (l.listeners ?? []).filter((x) => INPUT_EVENTS.has(x.type)).length;
      }
      return n;
    } catch {
      return -1;
    } finally {
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
  };

  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const exit: Shoot["cdp"] = {
    send: <T>(method: string, params: Record<string, unknown> = {}) => {
      if (method === "Input.dispatchMouseEvent") follow(params);
      return raw.send<T>(method, params);
    },
    on: <T>(event: string, fn: (params: T) => void) => {
      let set = listeners.get(event);
      if (!set) {
        const fns = new Set<(p: unknown) => void>();
        raw.on(event, (p) => {
          for (const f of fns) f(p);
        });
        listeners.set(event, fns);
        set = fns;
      }
      const f = fn as (p: unknown) => void;
      set.add(f);
      return () => {
        set.delete(f);
      };
    },
  };

  return {
    async open(url, o = {}) {
      const what = `s.open(${JSON.stringify(url)})`;
      if (!originAllowed(url)) throw new Error(`${what}: outside OPEN_TAKE_ALLOWED_ORIGINS`);
      const before = pageErrors.length;
      const failed = await navigate(cdp, url);
      if (failed)
        throw new Error(`${what}: the page did not answer (${failed}) — is the app running?`);
      await awaitFonts(cdp);
      // Hydrated: the page shows something, and if it has scripts, they have
      // attached input handlers. Server-rendered HTML looks finished long
      // before its framework listens; a click in between does nothing, and
      // the still after it shows nothing happening.
      const timeoutMs = o.timeoutMs ?? OPEN_WAIT_MS;
      const deadline = Date.now() + timeoutMs;
      let page = { url, title: "" };
      let shownAt = 0;
      let hydrated = false;
      for (;;) {
        const p = JSON.parse(await evaluate<string>(SHOWS_JS, what)) as {
          shows: boolean;
          scripts: number;
          url: string;
          title: string;
        };
        page = { url: p.url, title: p.title };
        if (p.shows) {
          shownAt ||= Date.now();
          if (p.scripts === 0 || (await inputHandlers()) !== 0) {
            hydrated = true;
            break;
          }
          if (Date.now() - shownAt >= HANDLERS_WAIT_MS) break;
        }
        if (Date.now() >= deadline) break;
        await sleep(150);
      }
      if (!shownAt)
        throw new Error(
          `${what}: the page shows nothing after ${secs(timeoutMs)} — did its script fail, or does it need a login (--profile)?`,
        );
      if (!hydrated)
        note(
          `${what}: the page's scripts attached no click, key or pointer handlers within ${secs(HANDLERS_WAIT_MS)} — fine for a static page; an app has not hydrated, and clicks on it will do nothing`,
        );
      if (o.ready != null) await waitFor(what, o.ready, timeoutMs);
      await settleFor(o.settle === true ? OPEN_SETTLE_MS : o.settle, OPEN_SETTLE_MS, false);
      const errors = pageErrors.slice(before);
      if (errors.length)
        note(`${what}: the page threw while loading — ${errors.slice(0, 3).join(" · ")}`);
      return { url: page.url, title: page.title, errors };
    },

    async still(name = "still", o = {}) {
      await settleFor(o.settle, false, false);
      return capture(name);
    },

    async click(target, o = {}) {
      const what = `s.click(${show(target)})`;
      const p = await point(what, target, "click", o);
      if (p.tag === "SELECT")
        throw new Error(
          `${what}: a native <select> does not open in headless Chrome — set it with s.evaluate (el.value = …, then dispatch a "change" event)`,
        );
      await click(p.x, p.y);
      return after(o, "click", o.name ?? "click");
    },

    async type(target, text, o = {}) {
      const what = `s.type(${show(target)}, ${JSON.stringify(text)})`;
      if (typeof text !== "string") throw new Error(`${what}: the text must be a string`);
      if (target != null) {
        const own =
          typeof target === "string"
            ? (JSON.parse(await evaluate<string>(focusJs(target), what)) as {
                editable: boolean;
                own: boolean;
              })
            : null;
        if (own?.editable && own.own) {
          tracked.set(target as string, "field"); // the caret is already in it: leave it where it is
        } else {
          const p = await point(what, target, "field", o);
          await click(p.x, p.y);
          // an editor may arm a beat after the click (a state update)
          let editable = false;
          for (let i = 0; i < 8 && !editable; i++) {
            if (i) await sleep(100);
            editable = (
              JSON.parse(await evaluate<string>(focusJs(null), what)) as { editable: boolean }
            ).editable;
          }
          if (!editable)
            throw new Error(
              `${what}: clicking it put no caret anywhere — is it a field? (null types into whatever has focus)`,
            );
        }
      }
      if (o.clear) await evaluate(selectAllInFocusedJs(), what);
      const name = o.name ?? "type";
      let i = 0;
      for (const ch of text.replace(/\r\n?/g, "\n")) {
        await key(ch);
        if (o.each) await capture(`${name}-${++i}`, "type");
      }
      return after(o, "type", name);
    },

    async drag(target, dest, o = {}) {
      const what = `s.drag(${show(target)})`;
      const every = o.every;
      if (every != null && !(every > 0))
        throw new Error(`${what}: every is px between stills, above 0`);
      const from = await point(what, target, "box", o);
      let to: { x: number; y: number };
      if (dest && "to" in dest && dest.to != null) {
        to = await point(what, dest.to, "box", { ...o, reach: false, scroll: false });
      } else {
        const d = dest as { dx?: number; dy?: number } | undefined;
        const dx = d?.dx ?? 0;
        const dy = d?.dy ?? 0;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy))
          throw new Error(`${what}: say where to — { dx, dy } in CSS px, or { to: target }`);
        to = { x: from.x + dx, y: from.y + dy };
      }
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const step = every ?? DRAG_STEP_PX;
      const n = Math.max(1, Math.ceil(dist / step - 1e-9));
      const name = o.name ?? "drag";
      await mouse("mouseMoved", from.x, from.y);
      await mouse("mousePressed", from.x, from.y);
      for (let i = 1; i <= n; i++) {
        const u = dist > 0 ? Math.min(1, (i * step) / dist) : 1;
        // not awaited: a held button's ack can wait seconds for a paint (ACK_MS)
        void mouse(
          "mouseMoved",
          r2(from.x + (to.x - from.x) * u),
          r2(from.y + (to.y - from.y) * u),
          0,
        );
        if (every != null) await capture(`${name}-${i}`, "drag");
        else await sleep(DRAG_STEP_MS);
      }
      await mouse("mouseReleased", to.x, to.y);
      return after(o, "drag", name);
    },

    async move(target, o = {}) {
      const p = await point(`s.move(${show(target)})`, target, "box", o);
      await mouse("mouseMoved", p.x, p.y);
      return after(o, "move", o.name ?? "move");
    },

    async press(keys, o = {}) {
      if (typeof keys !== "string" || !keys.trim())
        throw new Error(`s.press: name a key, e.g. "Enter" or "Meta+k"`);
      await pressChord(cdp, keys);
      return after(o, "press", o.name ?? "press");
    },

    async track(targets) {
      for (const t of [targets].flat()) {
        if (typeof t !== "string" || !t)
          throw new Error(`s.track: targets are selectors or text=… strings`);
        if (!t.startsWith("text=")) {
          const bad = await evaluate<string | null>(
            `(function(){try{document.querySelector(${JSON.stringify(t)});return null;}catch(e){return String(e&&e.message||e);}})()`,
            "s.track",
          );
          if (bad)
            throw new Error(`s.track: ${JSON.stringify(t)} is not a valid selector (${bad})`);
        }
        if (!tracked.has(t)) tracked.set(t, "box");
      }
    },

    async wait(what, o = {}) {
      await waitFor(
        `s.wait(${typeof what === "function" ? "…" : JSON.stringify(what)})`,
        what,
        o.timeoutMs ?? 10_000,
      );
    },

    async evaluate<T>(fn: string | ((...args: never[]) => T), ...args: unknown[]): Promise<T> {
      const expression =
        typeof fn === "function" ? `(${fn.toString()})(...${JSON.stringify(args)})` : String(fn);
      return evaluate<T>(expression, "s.evaluate");
    },

    async inject(js) {
      const source = typeof js === "function" ? `(${js.toString()})()` : String(js);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    },

    cdp: exit,
    wsEndpoint: ctx.wsEndpoint,
    get cursor() {
      return { ...cursor };
    },
    set cursor(p: { x: number; y: number }) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y))
        throw new Error("s.cursor: { x, y } in viewport CSS px");
      cursor = { x: p.x, y: p.y };
    },
    get stills() {
      return stills;
    },
    viewport,
    scale: ctx.scale,
    out: ctx.out,
  };
}
