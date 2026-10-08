// Is what the viewer sees still changing? The shoot's question before it
// keeps a still.
//
// Products animate their own values: a total that counts up from 0 every time
// it changes, a panel that slides open, a list that fades in. A still taken a
// few frames after the input catches an in-between value — a calculator's
// total read 2,576 → 993 → 2,705 → 1,305 across four drag stills because each
// was taken partway through the product's count-up, and a film's caption then
// quoted the in-between numbers. settle.ts cannot answer this on its own: it
// watches the whole document (a mutation anywhere, a request, a timer) within
// a budget made for a page finishing its work, and a two-second count-up
// outlasts it; the stills on the way (each, every) never asked it at all.
//
// This reads only what is on screen: the text of every visible text node and
// field with where it is drawn, and the finite Web Animations / CSS
// transitions running on visible elements (infinite ones — spinners, pulses —
// never end, and are left out as settle.ts leaves them out). The screen is
// steady when two readings STEADY_QUIET_MS apart and every one between them
// are the same and nothing finite is running. It does not see inside a
// <canvas> or <video>, and a change a debounce holds back for longer than
// STEADY_QUIET_MS (a search that answers 300 ms after the last key) reads as
// steady before it arrives — the reading taken right after the screenshot
// still catches it when it lands in between, and marks the still.

/** two readings this far apart, all equal, with nothing finite running */
export const STEADY_QUIET_MS = 100;
const SAMPLE_MS = 50;
/** text nodes read per screen; a page with more is read up to here */
const MAX_TEXTS = 4000;

/** what is on screen at one moment: [text, x, y] per visible text (viewport
 *  CSS px), the page's scroll, and how many finite animations run on visible
 *  elements */
export type Screen = { t: [string, number, number][]; sx: number; sy: number; a: number };

/** an expression for the page: the Screen, as a JSON string */
export const SCREEN_JS = `(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  const on = (r) => r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  const shows = (el) => {
    if (typeof el.checkVisibility === "function")
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const cs = getComputedStyle(el);
    return cs.visibility === "visible" && cs.display !== "none";
  };
  try {
    if (document.body) {
      const range = document.createRange();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n && out.length < ${MAX_TEXTS}; n = w.nextNode()) {
        const v = (n.nodeValue || "").trim();
        if (!v) continue;
        const el = n.parentElement;
        if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !shows(el)) continue;
        range.selectNodeContents(n);
        const r = Array.from(range.getClientRects()).find(on);
        if (r) out.push([v.slice(0, 200), Math.round(r.left), Math.round(r.top)]);
      }
      for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=password]),textarea")) {
        const v = String(el.value || "").trim();
        if (!v || out.length >= ${MAX_TEXTS}) continue;
        const r = el.getBoundingClientRect();
        if (on(r) && shows(el)) out.push([v.slice(0, 200), Math.round(r.left), Math.round(r.top)]);
      }
    }
  } catch (e) {}
  let a = 0;
  try {
    for (const an of document.getAnimations()) {
      if (an.playState !== "running") continue;
      let it = 1;
      try { it = an.effect.getTiming().iterations; } catch (e) {}
      if (it === Infinity) continue;
      const el = an.effect && an.effect.target;
      if (el && typeof el.getBoundingClientRect === "function" && !on(el.getBoundingClientRect())) continue;
      a++;
    }
  } catch (e) {}
  return JSON.stringify({ t: out, sx: scrollX, sy: scrollY, a });
})()`;

const sameScreen = (a: Screen, b: Screen): boolean => {
  if (a.sx !== b.sx || a.sy !== b.sy || a.t.length !== b.t.length) return false;
  for (let i = 0; i < a.t.length; i++) {
    const x = a.t[i]!;
    const y = b.t[i]!;
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
  }
  return true;
};

/** a text that read differently in two readings: where (page CSS px, the
 *  first reading's place) and what each showed */
export type ScreenChange = { x: number; y: number; before: string; after: string };

/** What changed between two readings of the screen, the moment before a
 *  still and the moment after it. `texts`: the texts that read differently —
 *  paired by order when both readings hold as many texts (a number that
 *  grows a digit moves but keeps its place in the page), else the ones only
 *  one reading holds, paired in order; `moved`: the same text drawn
 *  elsewhere, or the page scrolled. */
export function screenChange(
  a: Screen,
  b: Screen,
): { texts: ScreenChange[]; moved: boolean; animations: number } {
  const texts: ScreenChange[] = [];
  let moved = a.sx !== b.sx || a.sy !== b.sy;
  const at = (e: [string, number, number], s: Screen) => ({ x: e[1] + s.sx, y: e[2] + s.sy });
  if (a.t.length === b.t.length) {
    a.t.forEach((x, i) => {
      const y = b.t[i]!;
      if (x[0] !== y[0]) texts.push({ ...at(x, a), before: x[0], after: y[0] });
      else if (x[1] !== y[1] || x[2] !== y[2]) moved = true;
    });
  } else {
    const key = (e: [string, number, number]) => `${e[0]}\u0000${e[1]}\u0000${e[2]}`;
    const inB = new Set(b.t.map(key));
    const inA = new Set(a.t.map(key));
    const onlyA = a.t.filter((e) => !inB.has(key(e)));
    const onlyB = b.t.filter((e) => !inA.has(key(e)));
    for (let i = 0; i < Math.max(onlyA.length, onlyB.length); i++) {
      const x = onlyA[i];
      const y = onlyB[i];
      texts.push({
        ...(x ? at(x, a) : at(y!, b)),
        before: x?.[0] ?? "",
        after: y?.[0] ?? "",
      });
    }
  }
  return { texts, moved, animations: a.a };
}

export type SteadyOutcome = {
  /** the screen reached steady within the budget */
  steady: boolean;
  /** ms spent reading it */
  waitedMs: number;
  /** it changed while read: the wait was for something, not only the
   *  STEADY_QUIET_MS it takes to tell */
  changed: boolean;
};

/** Read the screen every SAMPLE_MS until it holds still for STEADY_QUIET_MS
 *  with nothing finite running on it, or `budgetMs` runs out. `read` gives
 *  one reading (null: the page could not be read — a navigation — and the
 *  reading starts over). It only ever adds time; a page that is steady at
 *  once costs STEADY_QUIET_MS. */
export async function waitSteady(
  read: () => Promise<Screen | null>,
  budgetMs: number,
  o: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SteadyOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let prev = await read();
  let since = now();
  let changed = !prev || prev.a > 0;
  for (;;) {
    const t = now();
    if (prev && prev.a === 0 && t - since >= STEADY_QUIET_MS)
      return { steady: true, waitedMs: t - start, changed };
    if (t - start >= budgetMs) return { steady: false, waitedMs: t - start, changed };
    await sleep(SAMPLE_MS);
    const cur = await read();
    if (!cur || !prev || cur.a > 0 || !sameScreen(prev, cur)) {
      since = now();
      changed = true;
    }
    prev = cur;
  }
}
