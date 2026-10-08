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
//     steady,                    the steady wait's default (--no-steady: false)
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
//       state?,                  its saved screen's id: states/<state>/state.html
//       steadyMs?,               ms it waited for the screen to stop changing
//                                (present when the screen changed meanwhile)
//       moving?: { texts: [{ x, y, before, after }], moved?, animations },
//                                what was still changing as it was taken
//     }],
//     states?: { dir, items: [{ id, still, t, fidelity, moving? }] },
//                                the saved screens kept with stills, and how each
//                                re-rendered against its moment (fidelity.ok)
//     error? }                   only in a failed shoot's log
//
// Every position is PAGE CSS px, so a box stays put when the page scrolls; to
// place one on its still, subtract that still's scroll (times scale for image
// px). A still a call returns is its log entry: fields the script adds to it
// (a value read off the page) are saved with it.
//
// A saved screen — the interface itself, as `make --states` keeps it — goes
// by default with every still s.still() takes and with the still an action
// ends on; the stills on the way (a keystroke's with `each`, a drag step's
// with `every`) keep none unless asked. `state` on a call says yes or no for
// every still it takes; `states` for the whole shoot (`--states`: every
// still, `--no-states`: none). It is the same capture and the same fidelity check
// (dom-state.ts), written to <out>/states/<id>/ (state.html + index.json),
// the id being the still's name; the kit's screen() shows it, and lift() and
// isolate() work on it. A screen that cannot be read never fails the shoot:
// the still is kept without one, and a line says why.
//
// Material that is still animating: a product counts its own values up, slides
// panels in, fades lists — a still taken a few frames after the input shows a
// number on its way. So before a still, the shoot waits until what is on
// screen holds still (steady.ts: the visible text and where it is drawn, and
// finite animations on visible elements), up to a budget, and then reads the
// screen once more right after the screenshot. A still taken while it was
// changing says so in its `moving` (the texts that read differently, before
// and after); one the shoot waited for says how long in `steadyMs`. Nothing
// is dropped and nothing fails. `steady: false` on a call (or `settle:
// false`, "take it now"), or the shoot's `steady: false` / --no-steady, takes
// stills without that wait, as before; `moving` is still recorded.
//
// A shoot replaces the previous one in <out> only when its script finishes. A
// script that throws leaves the last good shoot as it was, and what it did
// take in <out>/.shoot/ with the error in its shots.json.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ComponentsFile,
  gatherComponents,
  readComponentSource,
  writeComponents,
} from "@open-take/compositor";
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
import {
  captureDomState,
  type DomStateItem,
  type DomStateRaw,
  finalizeDomStates,
} from "./dom-state";
import { DEFAULT_SETTLE_BUDGET_MS, installActivityProbe, settle } from "./settle";
import { SCREEN_JS, type Screen, type SteadyOutcome, screenChange, waitSteady } from "./steady";

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
  /** its saved screen: `states/<state>/state.html` beside shots.json */
  state?: string;
  /** ms spent waiting for what is on screen to stop changing before it was
   *  taken (present when it changed during the wait) */
  steadyMs?: number;
  /** present when what is on screen was still changing as it was taken: the
   *  texts that read differently just before and just after the screenshot
   *  (page CSS px; at most MOVING_TEXTS, `more` counts the rest), whether
   *  text moved or the page scrolled, and the finite animations running on
   *  visible elements. `after` is the next moment, not necessarily where the
   *  value comes to rest. */
  moving?: ShootMoving;
};
export type ShootMoving = {
  texts: { x: number; y: number; before: string; after: string }[];
  more?: number;
  moved?: true;
  animations: number;
};
/** a saved screen kept with a still, and how it re-rendered against it */
export type ShootStateItem = {
  id: string;
  /** the still it was kept with (its file) */
  still: string;
  t: number;
  fidelity: NonNullable<DomStateItem["fidelity"]>;
  /** its still was taken while the screen was still changing (the still's `moving`) */
  moving?: true;
};
export type ShootLog = {
  viewport: { w: number; h: number };
  scale: number;
  /** the shoot's steady default (false: --no-steady). Its presence says the
   *  log records `moving`: a log without it is from before, and says nothing
   *  either way */
  steady?: boolean;
  stills: ShootStill[];
  /** present when any still kept a saved screen */
  states?: { dir: "states"; items: ShootStateItem[] };
  error?: string;
};

/** true: wait for the page to go quiet (activity probe, settle.ts) up to the
 *  default budget; a number: up to that many ms; false: not at all. */
export type ShootSettle = boolean | number;
/** true: before a still, wait until what is on screen stops changing
 *  (steady.ts) up to the default budget — STEADY_MS for the still an action
 *  ends on or s.still(), STEADY_STEP_MS for each still on the way; a number:
 *  up to that many ms for each; false: take it as it is. */
export type ShootSteady = boolean | number;
export type ShootActOpts = {
  /** the still's name (default: the action's) */
  name?: string;
  /** default true; false also skips the steady wait unless `steady` is given */
  settle?: ShootSettle;
  /** default: the shoot's `steady` (true) — see ShootSteady */
  steady?: ShootSteady;
  /** take a still once the action is done (default true) */
  still?: boolean;
  /** keep a saved screen with every still this call takes, or with none
   *  (default: the shoot's `states`; without one, the still the action ends
   *  on keeps one and the stills on the way do not) */
  state?: boolean;
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
  /** one PNG and its log entry, once what is on screen holds still (no
   *  activity settle by default; `settle: false` or `steady: false` takes
   *  it at once); with the interface itself kept as a saved screen in
   *  states/<name>/ unless `state: false` (or the shoot's `states: false`) */
  still(
    name?: string,
    opts?: { settle?: ShootSettle; steady?: ShootSteady; state?: boolean },
  ): Promise<ShootStill>;
  /** move the mouse onto the target and click it, for real */
  click(target: ShootTarget, opts?: ShootActOpts): Promise<ShootStill | null>;
  /** click into the field unless it has the caret, then type key by key
   *  (`each`: a still after every key, each once the screen holds still —
   *  `steady`); a null target types into whatever has focus */
  type(
    target: ShootTarget | null,
    text: string,
    opts?: ShootActOpts & { each?: boolean; clear?: boolean },
  ): Promise<ShootStill | null>;
  /** press on the target, move in a straight line, release (`every`: a
   *  still every that many px on the way, button held, each once the screen
   *  holds still — `steady`) */
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
  /** saved screens for the stills whose call does not say: true, every
   *  still; false, none; unset (default), every still but the ones on the
   *  way (a keystroke's with `each`, a drag step's with `every`) */
  states?: boolean;
  /** the steady wait for the stills whose call does not say (default true;
   *  false: every still is taken as it comes, as before — see ShootSteady) */
  steady?: boolean;
  /** measure the parts of each saved screen (states/<id>/parts.json, crisp
   *  pictures in states/assets/) and gather them into <out>/components.json —
   *  default true; false skips both */
  components?: boolean;
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
/** how long the still an action ends on (or s.still) may wait for the screen
 *  to stop changing: a product's count-up commonly runs 1–2 s */
const STEADY_MS = 3000;
/** the same, per still on the way (a keystroke's, a drag step's) */
const STEADY_STEP_MS = 2000;
/** steps in a row whose wait ran out before the rest of the call stops
 *  waiting: the page keeps changing while the button is held or the keys go
 *  on, and every step would pay the whole budget for nothing */
const STEADY_GIVE_UP = 3;
/** a call whose steps waited this long in all says so */
const STEADY_TELL_MS = 5000;
/** the changed texts a still's `moving` lists */
const MOVING_TEXTS = 8;

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
    `return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,tag:m.tagName,disabled:m.matches(':disabled'),` +
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
    `var ed=!!a&&a!==document.body&&(a.isContentEditable||(typeof a.value==='string'&&!a.readOnly&&!a.matches(':disabled')));` +
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
export async function runShoot(opts: ShootOpts): Promise<{
  log: ShootLog;
  path: string;
  /** the component inventory, when the shoot kept saved screens */
  components?: { file: ComponentsFile; path: string };
}> {
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
  const kept: DomStateRaw[] = [];
  let items: ShootStateItem[] = [];
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
      states: opts.states,
      steady: opts.steady !== false,
      kept,
    });
    let failed: string | null = null;
    try {
      await run(s);
    } catch (e) {
      failed = scriptFailure(e, file);
    }
    items = await finishStates(
      browser,
      stage,
      kept,
      stills,
      viewport,
      note,
      opts.components !== false,
    );
    if (failed != null) {
      const partial: ShootLog = {
        viewport,
        scale,
        steady: opts.steady !== false,
        stills,
        ...logStates(items),
        error: failed,
      };
      await writeFile(join(stage, "shots.json"), `${JSON.stringify(partial, null, 2)}\n`);
      if (stills.length)
        note(`shoot: the ${stills.length} still(s) taken before it stopped are in ${stage}`);
      throw new Error(`shoot: ${failed}`);
    }
  } finally {
    raw?.close();
    await browser?.close();
  }

  // the script finished: this shoot replaces the last one
  const log: ShootLog = {
    viewport,
    scale,
    steady: opts.steady !== false,
    stills,
    ...logStates(items),
  };
  await writeFile(join(stage, "shots.json"), `${JSON.stringify(log, null, 2)}\n`);
  // the parts each saved screen holds, gathered with what the log adds (no
  // browser); one that cannot be gathered never fails the shoot
  let inventory: ComponentsFile | null = null;
  if (items.length && opts.components !== false)
    try {
      inventory = gatherComponents(readComponentSource(stage));
      writeComponents(inventory, stage);
    } catch (e) {
      inventory = null;
      note(`shoot: no components.json (${(e as Error).message})`);
    }
  await replaceShoot(out, stage, [
    ...stills.map((st) => st.file),
    ...items.map((it) => `states/${it.id}`),
    ...(inventory ? ["components.json"] : []),
  ]);
  return {
    log,
    path: join(out, "shots.json"),
    ...(inventory ? { components: { file: inventory, path: join(out, "components.json") } } : {}),
  };
}

const logStates = (items: ShootStateItem[]): Pick<ShootLog, "states"> =>
  items.length ? { states: { dir: "states", items } } : {};

/** The saved screens the stills kept, made whole (state.html, index.json)
 *  and checked against their moment, in the browser that took them. Nothing
 *  here fails the shoot: a screen that cannot be finished is a line. */
async function finishStates(
  browser: Browser,
  stage: string,
  kept: DomStateRaw[],
  stills: ShootStill[],
  viewport: { w: number; h: number },
  note: (line: string) => void,
  parts: boolean,
): Promise<ShootStateItem[]> {
  if (!kept.length) return [];
  let done: DomStateItem[];
  try {
    done = await finalizeDomStates({
      browser,
      statesDir: join(stage, "states"),
      states: kept,
      vw: viewport.w,
      vh: viewport.h,
      parts,
    });
  } catch (e) {
    note(`shoot: the saved screens could not be finished (${(e as Error).message})`);
    done = kept.map((k) => ({
      id: k.id,
      tMs: k.tMs,
      fidelity: { psnr: 0, diffFrac: 1, ok: false },
    }));
  }
  const items = done.map((d) => {
    const still = stills.find((st) => st.state === d.id);
    return {
      id: d.id,
      still: still?.file ?? "",
      t: still?.t ?? Math.round(d.tMs) / 1000,
      fidelity: d.fidelity ?? { psnr: 0, diffFrac: 1, ok: false },
      ...(still?.moving ? { moving: true as const } : {}),
    };
  });
  const bad = items.filter((i) => !i.fidelity.ok).map((i) => i.id);
  if (bad.length)
    note(
      `shoot: ${bad.length} of ${items.length} saved screen(s) did not re-render as shot (${bad.join(", ")}) — their stills are fine; \`open-take film picture <state.html>\` shows one as it renders`,
    );
  return items;
}

/** A saved screen's id: the still's name, made a safe folder name, and new
 *  in this shoot ("assets" holds their shared files). */
export function stateId(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^[-.]+|-+$/g, "") || "still";
  const free = (id: string) => !taken.has(id) && id !== "assets";
  if (free(base)) return base;
  for (let i = 2; ; i++) if (free(`${base}-${i}`)) return `${base}-${i}`;
}

/** One line on what a shoot kept: how many stills kept their saved screen —
 *  or, when none did, what keeps one. Information, printed with the result. */
export function shootStatesLine(log: ShootLog): string {
  const n = log.stills.length;
  const kept = log.states?.items ?? [];
  if (!kept.length)
    return `kept ${n} still${n === 1 ? "" : "s"}; no saved screens — { state: true } on a still (or --states) also keeps the interface itself, for screen() / lift() / isolate() in kit/media.js (skill film material)`;
  const ok = kept.filter((i) => i.fidelity.ok).length;
  return `saved screens: ${kept.length} of ${n} still${n === 1 ? "" : "s"} in ${log.states!.dir}/ (${ok} re-render as shot) — screen() / lift() / isolate() in kit/media.js take states/<id>/state.html (skill film material); --no-states or { state: false } keeps none`;
}

/** One line on the stills taken while what was on screen was still changing
 *  and the ones the shoot waited for; null when there were none. */
export function shootSteadyLine(log: ShootLog): string | null {
  const moving = log.stills.filter((s) => s.moving);
  const waited = log.stills.filter((s) => (s.steadyMs ?? 0) > 0);
  if (!moving.length && !waited.length) return null;
  const n = log.stills.length;
  const names = moving.slice(0, 6).map((s) => s.name);
  const changed = moving.flatMap((s) => s.moving!.texts).slice(0, 3);
  const ms = waited.reduce((a, s) => a + s.steadyMs!, 0);
  return [
    moving.length
      ? `${moving.length} of ${n} still${n === 1 ? "" : "s"} taken while the screen was still changing (moving in shots.json): ${names.join(", ")}${moving.length > names.length ? ", …" : ""}${changed.length ? ` — e.g. ${changed.map((c) => `${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join(", ")}` : ""}`
      : `no still taken while the screen was changing`,
    waited.length
      ? `${waited.length} waited for it to stop, ${secs(ms)} in all (steadyMs); steady: false / --no-steady takes stills without waiting`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Put the shoot staged in `stage` (its stills and saved screens, `names` —
 *  "states/<id>" is a screen's folder — and its shots.json) in place of the
 *  last one in `out`, but only once all of it is in place —
 *  the last one is moved aside first, and put back if anything of the new one
 *  cannot go where it belongs. Nothing of the last one is deleted unless the
 *  new one is whole in place: what cannot be put back stays aside, in a
 *  directory of this run's own, and the error says where. `move` is rename;
 *  a test makes it fail. */
export async function replaceShoot(
  out: string,
  stage: string,
  names: readonly string[],
  move: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  const aside = await mkdtemp(join(out, ".shoot-previous-"));
  const previous: string[] = [];
  const placed: string[] = [];
  // a nested name ("states/<id>") goes into a folder that may not exist yet
  const into = async (from: string, to: string) => {
    await mkdir(dirname(to), { recursive: true });
    await move(from, to);
  };
  try {
    // the screens' shared files first: named by their content, so one already
    // there is the same file, and none of the last shoot's is replaced
    await mergeAssets(join(stage, "states", "assets"), join(out, "states", "assets"));
    await moveAside(out, aside, previous, into);
    for (const name of [...names, "shots.json"]) {
      await into(join(stage, name), join(out, name));
      placed.push(name);
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // the new files go back to the stage; one that cannot is left where it
    // is, and the last shoot's file of the same name is not put over it
    const left: string[] = [];
    for (const name of placed.reverse())
      await into(join(out, name), join(stage, name)).catch(() => left.push(name));
    const stuck: string[] = [];
    for (const name of previous)
      if (left.includes(name)) stuck.push(name);
      else await into(join(aside, name), join(out, name)).catch(() => stuck.push(name));
    // all of it is back: what is left aside is empty folders
    if (!stuck.length) await rm(aside, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `shoot: the new shoot could not replace the last one (${why}) — ${
        stuck.length
          ? `the last one could not all be put back: ${stuck.join(", ")} ${stuck.length === 1 ? "is" : "are"} in ${aside}`
          : "the last one is back in place"
      }, the new one is in ${stage}${left.length ? ` (but for ${left.join(", ")}, left in ${out})` : ""}`,
    );
  }
  await rm(aside, { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
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

/** Move the previous shoot's stills (exactly the files its log names) and its
 *  log into `aside`, adding each to `moved` as it goes, so that what was moved
 *  can be put back even if the rest cannot. Anything else in the directory is
 *  the author's and stays where it is. */
async function moveAside(
  out: string,
  aside: string,
  moved: string[],
  move: (from: string, to: string) => Promise<void>,
): Promise<void> {
  let old: ShootLog;
  try {
    old = JSON.parse(await readFile(join(out, "shots.json"), "utf8")) as ShootLog;
  } catch {
    return;
  }
  const names = (Array.isArray(old.stills) ? old.stills : [])
    .map((st) => st?.file)
    .filter((f): f is string => typeof f === "string" && /^\d{3,}-[^/\\]+\.png$/.test(f));
  // its saved screens: the folders its log names, and no other
  const screens = (Array.isArray(old.states?.items) ? old.states.items : [])
    .map((it) => it?.id)
    .filter(
      (id): id is string =>
        typeof id === "string" && /^[^/\\.][^/\\]*$/.test(id) && id !== "assets",
    )
    .map((id) => `states/${id}`);
  // its inventory goes with it: a shoot that keeps none must not leave the
  // last one's components.json naming screens that are gone
  for (const name of [...names, ...screens, "components.json", "shots.json"]) {
    if (!existsSync(join(out, name))) continue;
    await move(join(out, name), join(aside, name));
    moved.push(name);
  }
}

/** The folders in `<out>/states/` the last shoot's log does not name: a
 *  new screen of the same name could not go there, so its id steers round
 *  them. */
async function foreignStates(out: string): Promise<Set<string>> {
  const dirs = await readdir(join(out, "states"), { withFileTypes: true }).catch(() => []);
  let own: unknown[] = [];
  try {
    const old = JSON.parse(await readFile(join(out, "shots.json"), "utf8")) as ShootLog;
    if (Array.isArray(old.states?.items)) own = old.states.items.map((it) => it?.id);
  } catch {}
  return new Set(dirs.filter((d) => d.isDirectory() && !own.includes(d.name)).map((d) => d.name));
}

/** Move the files of `from` that `to` lacks into it (a missing `from` is
 *  nothing to do). */
async function mergeAssets(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from))
    if (!existsSync(join(to, name))) await rename(join(from, name), join(to, name));
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
  /** saved screens for the stills whose call does not say (unset: all but
   *  the stills on the way) */
  states: boolean | undefined;
  /** the steady wait for the stills whose call does not say */
  steady: boolean;
  /** the saved screens kept so far, raw (finished once the script is done) */
  kept: DomStateRaw[];
};

async function shoot(ctx: Ctx): Promise<Shoot> {
  const { cdp, raw, viewport, stills, note, kept } = ctx;
  // a folder already in <out>/states/ that the last shoot's log does not name
  // (film init's home, the author's own) is not this shoot's to replace
  const stateIds = await foreignStates(ctx.out);
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

  /** the interface as the still shows it, kept as a saved screen (the same
   *  read-only capture as `make --states`); a page that cannot be read keeps
   *  the still without one */
  const keepState = async (still: ShootStill) => {
    const id = stateId(still.name, stateIds);
    try {
      kept.push(
        await captureDomState(cdp, {
          statesDir: join(ctx.stage, "states"),
          id,
          tMs: Math.round(still.t * 1000),
          vw: viewport.w,
          vh: viewport.h,
          dpr: ctx.scale,
        }),
      );
      stateIds.add(id);
      still.state = id;
    } catch (e) {
      await rm(join(ctx.stage, "states", id), { recursive: true, force: true }).catch(() => {});
      note(
        `shoot: ${still.file} kept no saved screen (${(e as Error).message}) — the still is fine`,
      );
    }
  };

  /** what is on screen now (steady.ts); null while the page cannot be read */
  const readScreen = async (): Promise<Screen | null> => {
    try {
      return JSON.parse(await evaluate<string>(SCREEN_JS, "s.still")) as Screen;
    } catch {
      return null;
    }
  };

  /** how long a call's stills may wait for the screen to hold still (0: not at all) */
  const steadyBudget = (
    what: string,
    o: { settle?: ShootSettle; steady?: ShootSteady },
    step: boolean,
  ): number => {
    const v = o.steady ?? (o.settle === false || o.settle === 0 ? false : ctx.steady);
    if (typeof v === "number" && !(v >= 0 && Number.isFinite(v)))
      throw new Error(`${what}: steady is true, false or ms to wait at most (got ${v})`);
    if (v === false || v === 0) return 0;
    return typeof v === "number" ? v : step ? STEADY_STEP_MS : STEADY_MS;
  };

  /** the last capture's wait for a steady screen (null: it did not wait) */
  let lastSteady: SteadyOutcome | null = null;

  /** one PNG and its log entry */
  const capture = async (
    name: string,
    action?: ShootAction,
    state?: boolean,
    /** a still on the way: a keystroke's (each) or a drag step's (every) */
    onTheWay = false,
    /** ms it may wait for what is on screen to stop changing first (0: none) */
    steadyMs = 0,
  ): Promise<ShootStill> => {
    await within(
      evaluate(FRAME_JS, "s.still").catch(() => {}),
      500,
    );
    lastSteady = steadyMs > 0 ? await waitSteady(readScreen, steadyMs) : null;
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
    // the screen just before and just after the picture: a difference, or a
    // finite animation running, says the still caught it on its way
    const before = await readScreen();
    const shot = await within(
      cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }),
      60_000,
    );
    if (!shot)
      throw new Error(`s.still(${JSON.stringify(name)}): the page did not paint within 60 s`);
    const afterShot = await readScreen();
    const change = before && afterShot ? screenChange(before, afterShot) : null;
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
      // only a wait that saw the screen change: one already steady costs the
      // reading's minimum and is not worth a field
      ...(lastSteady?.changed ? { steadyMs: Math.round(lastSteady.waitedMs) } : {}),
      ...(change && (change.texts.length || change.moved || change.animations)
        ? {
            moving: {
              texts: change.texts.slice(0, MOVING_TEXTS).map((c) => ({
                x: r2(c.x),
                y: r2(c.y),
                before: c.before,
                after: c.after,
              })),
              ...(change.texts.length > MOVING_TEXTS
                ? { more: change.texts.length - MOVING_TEXTS }
                : {}),
              ...(change.moved ? { moved: true as const } : {}),
              animations: change.animations,
            },
          }
        : {}),
    };
    stills.push(still);
    if (state ?? ctx.states ?? !onTheWay) await keepState(still);
    return still;
  };

  /** a still the shoot waited for and that still caught the screen changing */
  const tellUnsteady = (still: ShootStill) => {
    if (lastSteady && !lastSteady.steady && still.moving)
      once(
        "steady",
        `shoot: ${still.file}: what is on screen was still changing after ${secs(lastSteady.waitedMs)} (a clock, a ticker, a long animation?) — it is marked moving in shots.json; steady: <ms> waits longer, steady: false (--no-steady) takes stills without waiting`,
      );
    return still;
  };

  /** The stills on the way (each, every) wait for a steady screen one by one.
   *  That is the default because a step still is shown as what the product
   *  says at that point of the drag or the typing: a count-up restarting
   *  from 0 on every change gives, without the wait, a run of stills whose
   *  numbers jump back and forth (2,576 → 993 → 2,705 → 1,305) — values the
   *  product never rests on, in a flipbook the viewer reads as the result.
   *  The input itself is not disturbed: the button stays held, the field
   *  keeps its caret, and the next step goes on from where this one is. The
   *  cost is time between steps (the log's `t` spreads out); steady: false
   *  keeps the old timing — every step as it comes, its in-between values
   *  included as material — and `moving` marks the steps taken changing
   *  either way. A page that keeps changing while held (a hold-to-fill,
   *  a live preview) would pay the whole budget at every step, so after
   *  STEADY_GIVE_UP waits in a row run out, the rest of the call's steps are
   *  taken as they come, and a line says so. */
  const stepper = (what: string, o: ShootActOpts) => {
    let wait = steadyBudget(what, o, true);
    const first = wait;
    let outInARow = 0;
    let spent = 0;
    let waited = 0;
    let gaveUp = false;
    return {
      get wait() {
        return wait;
      },
      took() {
        const r = lastSteady;
        if (!r) return;
        waited++;
        spent += r.waitedMs;
        if (r.steady) outInARow = 0;
        else if (++outInARow >= STEADY_GIVE_UP && !gaveUp) {
          gaveUp = true;
          wait = 0;
        }
      },
      done() {
        if (gaveUp)
          note(
            `${what}: the screen was still changing after ${STEADY_GIVE_UP} steps in a row (${secs(first)} each) — the rest of its steps were taken as they came (marked moving in shots.json where they were changing); steady: <ms> sets the wait, steady: false takes every step at once`,
          );
        else if (spent >= STEADY_TELL_MS)
          note(
            `${what}: its ${waited} steps waited ${secs(spent)} in all for the screen to stop changing (steadyMs in shots.json); a larger step, or steady: false, takes them sooner`,
          );
      },
    };
  };

  const after = async (
    what: string,
    o: ShootActOpts,
    action: ShootAction,
    name: string,
  ): Promise<ShootStill | null> => {
    const wait = steadyBudget(what, o, false);
    await settleFor(o.settle, true, true);
    if (o.still === false) return null;
    return tellUnsteady(await capture(name, action, o.state, false, wait));
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
      const wait = steadyBudget(`s.still(${JSON.stringify(name)})`, o, false);
      await settleFor(o.settle, false, false);
      return tellUnsteady(await capture(name, undefined, o.state, false, wait));
    },

    async click(target, o = {}) {
      const what = `s.click(${show(target)})`;
      const p = await point(what, target, "click", o);
      if (p.tag === "SELECT")
        throw new Error(
          `${what}: a native <select> does not open in headless Chrome — set it with s.evaluate (el.value = …, then dispatch a "change" event)`,
        );
      await click(p.x, p.y);
      return after(what, o, "click", o.name ?? "click");
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
      const steps = stepper(what, o);
      let i = 0;
      for (const ch of text.replace(/\r\n?/g, "\n")) {
        await key(ch);
        if (!o.each) continue;
        await capture(`${name}-${++i}`, "type", o.state, true, steps.wait);
        steps.took();
      }
      steps.done();
      return after(what, o, "type", name);
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
      const steps = stepper(what, o);
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
        if (every != null) {
          await capture(`${name}-${i}`, "drag", o.state, true, steps.wait);
          steps.took();
        } else await sleep(DRAG_STEP_MS);
      }
      steps.done();
      await mouse("mouseReleased", to.x, to.y);
      return after(what, o, "drag", name);
    },

    async move(target, o = {}) {
      const what = `s.move(${show(target)})`;
      const p = await point(what, target, "box", o);
      await mouse("mouseMoved", p.x, p.y);
      return after(what, o, "move", o.name ?? "move");
    },

    async press(keys, o = {}) {
      if (typeof keys !== "string" || !keys.trim())
        throw new Error(`s.press: name a key, e.g. "Enter" or "Meta+k"`);
      await pressChord(cdp, keys);
      return after(`s.press(${JSON.stringify(keys)})`, o, "press", o.name ?? "press");
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

// --- one page's saved screen --------------------------------------------------------

export type ShootHomeOpts = {
  url: string;
  /** the folder states/<name>/ goes in (a film's folder) */
  dir: string;
  /** default "home" */
  name?: string;
  width?: number;
  height?: number;
  scale?: number;
  chromePath?: string;
  userDataDir?: string;
  /** measure its parts and write states/<name>/components.json (default true) */
  components?: boolean;
  /** wait for what is on screen to stop changing first (default true; see
   *  ShootOpts.steady) */
  steady?: boolean;
  onNote?: (line: string) => void;
};

/** Open `url` the way `s.open` does and keep that moment as a saved screen
 *  in `<dir>/states/<name>/` (state.html, index.json, live.png), its shared
 *  files in `<dir>/states/assets/` — `film init --url`. A screen already
 *  there under that name is replaced once the new one is in hand. */
export async function shootHome(opts: ShootHomeOpts): Promise<{
  /** states/<name>/ */
  dir: string;
  url: string;
  title: string;
  fidelity: ShootStateItem["fidelity"];
  /** its component inventory, states/<name>/components.json */
  components?: { file: ComponentsFile; path: string };
  /** present when the screen was still changing as it was kept (the
   *  still's `moving`: its shoot log is not kept) */
  moving?: ShootMoving;
}> {
  const dir = resolve(opts.dir);
  const name = opts.name ?? "home";
  if (stateId(name, new Set()) !== name)
    throw new Error(`shoot: ${JSON.stringify(name)} is not a folder name a saved screen can have`);
  await mkdir(dir, { recursive: true });
  const work = await mkdtemp(join(dir, ".shoot-home-"));
  try {
    let page = { url: opts.url, title: "" };
    const { log } = await runShoot({
      script: async (s) => {
        page = await s.open(opts.url);
        await s.still(name, { state: true });
      },
      outDir: work,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
      ...(opts.scale ? { scale: opts.scale } : {}),
      ...(opts.chromePath ? { chromePath: opts.chromePath } : {}),
      ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
      ...(opts.onNote ? { onNote: opts.onNote } : {}),
      ...(opts.components === false ? { components: false } : {}),
      ...(opts.steady === false ? { steady: false } : {}),
    });
    const item = log.states?.items.find((i) => i.id === name);
    const moving = log.stills.find((s) => s.state === name)?.moving;
    if (!item) throw new Error(`shoot: ${opts.url} gave no saved screen`);
    const states = join(dir, "states");
    await mergeAssets(join(work, "states", "assets"), join(states, "assets"));
    const to = join(states, name);
    if (existsSync(to)) await rename(to, join(work, "previous"));
    await rename(join(work, "states", name), to);
    // its parts, gathered where the screen now is (picture paths are relative to it)
    let components: { file: ComponentsFile; path: string } | undefined;
    if (opts.components !== false && existsSync(join(to, "parts.json")))
      try {
        const file = gatherComponents(readComponentSource(to));
        components = { file, path: writeComponents(file, to) };
      } catch (e) {
        (opts.onNote ?? ((l: string) => process.stderr.write(`${l}\n`)))(
          `shoot: no components.json for ${name} (${(e as Error).message})`,
        );
      }
    return {
      dir: to,
      url: page.url,
      title: page.title,
      fidelity: item.fidelity,
      ...(components ? { components } : {}),
      ...(moving ? { moving } : {}),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
