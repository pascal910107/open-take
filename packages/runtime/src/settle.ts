// Capture-side settle: stop BETTING that the page finished inside settleMs.
//
// Every hold in cdp-capture.ts used to be `sleep(step.settleMs ?? N)` — a
// fixed guess authored before the app was ever run. Two different jobs were
// riding on that one number:
//
//   1. the EDITORIAL hold — how long the result stays on screen so a viewer
//      can read it. That is a taste call and belongs in the plan.
//   2. the bet that the page had actually finished rendering by then. That is
//      not a taste call, it is a fact about the app, and guessing it wrong
//      captures the NEXT beat against a half-built page: a stale bbox, a click
//      into a button that has not mounted, a payoff frame that shows a spinner.
//
// This module keeps (1) exactly as it was and MEASURES (2). `settle()` runs
// the editorial hold in full and only then, if the page is still visibly
// working, keeps waiting — up to a budget. So a settled app pays one CDP
// round-trip and nothing changes; a slow app gets the time it actually needs,
// and the capture REPORTS what it needed so the next plan can stop guessing.
//
// It can only ever ADD time, never cut a hold short: a shortened hold would
// silently degrade the video, which is a worse failure than waiting.
//
// WHAT IT SEES: DOM mutations, in-flight fetch/XHR, running finite animations,
// pending short setTimeouts, and document.readyState. WHAT IT DOES NOT SEE:
// repaints inside a <canvas> or <video> — no DOM signal exists for those (the
// same blind spot that made frame-diff.ts a pixel pass).
//
// Timers earn their place: the commonest slow beat is not a request in flight,
// it is "render a skeleton now, swap in the real thing on a timer", and DOM /
// network / animation are all quiet across that gap. Two guards keep the
// signal from turning into a permanent "busy": only timers under
// TIMER_MAX_MS count (a 5s poll loop is the page's heartbeat, not this beat's
// work), and infinite-iteration animations (spinners, pulses) are ignored
// outright — they never end, so counting them would spend the whole budget on
// every beat of any page that has one.

import type { CDP } from "./cdp";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extra time a hold may spend waiting for a busy page, per beat. Generous
 *  enough for a slow round-trip, short enough that a page which NEVER goes
 *  quiet (a live clock, a polling dashboard) costs a bounded, reported amount
 *  rather than stretching the take without explanation. */
export const DEFAULT_SETTLE_BUDGET_MS = 1200;
/** The page must have been still this long to count as settled — one paint
 *  plus slack, so a mutation and the layout it triggers aren't read as two
 *  separate quiet periods. */
const QUIET_MS = 120;
const POLL_MS = 60;
/** A pending setTimeout longer than this is the page's own heartbeat (a poll
 *  loop, a session timer), not this beat finishing. Counting it would make the
 *  page look permanently busy. */
const TIMER_MAX_MS = 2000;
/** Grace on a timer's own deadline before it stops counting as pending. Errs
 *  SHORT on purpose: expiring early costs the old behaviour (a beat that may
 *  be captured a touch soon), expiring late costs dead air in the cut on
 *  every remaining beat — a much worse trade. */
const TIMER_SLACK_MS = 250;
/** A <canvas>/<video> covering this much of the frame makes the probe
 *  effectively blind for that beat: the element never changes size, position
 *  or attributes no matter what is painted inside it, so "the page is done"
 *  is unanswerable. Set low on purpose — a needless note costs a line of
 *  output, a missed one costs an author trusting a quiet run that proved
 *  nothing. */
export const PAINT_BLIND_FRAC = 0.2;

/** Installed once per document; keeps `t` at the last moment anything moved. */
const PROBE_INSTALL_JS = `(() => {
  if (window.__openTakeActivity) return;
  const TIMER_MAX = ${TIMER_MAX_MS}, TIMER_SLACK = ${TIMER_SLACK_MS};
  const A = { t: 0, net: 0, timers: 0 };
  const touch = () => { A.t = performance.now(); };
  touch();
  try {
    new MutationObserver(touch).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  } catch (e) {}
  try {
    const of = window.fetch;
    if (typeof of === "function")
      window.fetch = function () {
        A.net++; touch();
        let p;
        try { p = of.apply(window, arguments); } catch (e) { A.net--; throw e; }
        return Promise.resolve(p).then(
          (r) => { A.net--; touch(); return r; },
          (e) => { A.net--; touch(); throw e; },
        );
      };
  } catch (e) {}
  try {
    const os = XMLHttpRequest.prototype.send;
    if (typeof os === "function")
      XMLHttpRequest.prototype.send = function () {
        A.net++; touch();
        // send() throws on API misuse (send before open, send after abort) and
        // then NO request exists, so loadend never fires — without this the
        // increment is permanent and the page reads busy for the rest of the
        // take. Same guard the fetch branch above already has.
        try { this.addEventListener("loadend", () => { A.net--; touch(); }); } catch (e) {}
        try { return os.apply(this, arguments); } catch (e) { A.net--; touch(); throw e; }
      };
  } catch (e) {}
  try {
    const st = window.setTimeout, ct = window.clearTimeout, ci = window.clearInterval;
    // id -> the moment it must have fired by. Counting by DEADLINE rather than
    // by cancellation bookkeeping is what makes this safe: a timer we never see
    // cancelled (clearInterval on a setTimeout id, an id coerced through a
    // dataset attribute, any API we did not wrap) simply expires and stops
    // counting. Chasing every cancellation path would leave one uncounted, and
    // ONE stuck entry means every remaining beat of the take waits the whole
    // budget for nothing.
    const live = new Map();
    const forget = function (id) { live.delete(Number(id)); };
    A.pending = function () {
      const now = performance.now();
      live.forEach(function (due, id) { if (due <= now) live.delete(id); });
      A.timers = live.size;
      return live.size;
    };
    window.setTimeout = function (fn, delay) {
      const d = Number(delay) || 0;
      // a string body keeps the original semantics (wrapping would stop the
      // code ever running), and a long delay is a heartbeat, not this beat
      if (typeof fn !== "function" || d > TIMER_MAX) return st.apply(window, arguments);
      const rest = Array.prototype.slice.call(arguments, 2);
      let id;
      const wrapped = function () {
        forget(id); touch();
        return fn.apply(this, arguments);
      };
      id = st.apply(window, [wrapped, d].concat(rest));
      live.set(Number(id), performance.now() + d + TIMER_SLACK);
      touch();
      return id;
    };
    // Both cancellers, and both coerce their argument the way the platform
    // does — clearInterval legally cancels a setTimeout (one timer map), and
    // clearTimeout(String(id)) is what you get back out of a dataset.
    window.clearTimeout = function (id) { forget(id); return ct.apply(window, arguments); };
    window.clearInterval = function (id) { forget(id); return ci.apply(window, arguments); };
  } catch (e) {}
  window.__openTakeActivity = A;
})()`;

/** Reads the probe. Returns a JSON string so one Runtime.evaluate round-trip
 *  carries the whole answer (returnByValue on a plain object also works, but
 *  the rest of this package already speaks the JSON-string convention). */
const PROBE_READ_JS = `(() => {
  const A = window.__openTakeActivity;
  if (!A) return JSON.stringify({ ok: false });
  let anims = 0;
  try {
    for (const a of document.getAnimations()) {
      if (a.playState !== "running") continue;
      let it = 1;
      try { it = a.effect.getTiming().iterations; } catch (e) {}
      if (it === Infinity) continue; // ambient — never settles, never counted
      anims++;
    }
  } catch (e) {}
  // The largest <canvas>/<video> as a fraction of the viewport, clipped to it
  // (an offscreen or scrolled-away surface is not what the viewer is watching).
  let paint = 0;
  try {
    const area = innerWidth * innerHeight;
    if (area > 0)
      for (const el of document.querySelectorAll("canvas,video")) {
        const r = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        if (w * h > paint * area) paint = (w * h) / area;
      }
  } catch (e) {}
  const timers = typeof A.pending === "function" ? A.pending() : (A.timers | 0);
  const busy = A.net > 0 || timers > 0 || anims > 0 || document.readyState !== "complete";
  return JSON.stringify({
    ok: true,
    quietMs: busy ? 0 : Math.max(0, performance.now() - A.t),
    net: A.net,
    timers,
    anims,
    paint,
  });
})()`;

export type SettleOutcome = {
  /** the editorial hold, run in full and unchanged */
  heldMs: number;
  /** extra time spent waiting for the page AFTER the hold */
  waitedMs: number;
  /** how the wait ended: the page went quiet, the budget ran out, or no probe
   *  was installed (an older page context / a navigation in flight) */
  reason: "idle" | "budget" | "unavailable";
  /** biggest share of the frame a <canvas>/<video> held while this beat waited.
   *  Past PAINT_BLIND_FRAC the "idle" verdict above says nothing about what was
   *  painted inside it — see the module header. */
  paintFrac: number;
};

/** Install the activity probe for the current document AND every future one
 *  (a plan may navigate mid-take). Never throws — a capture must not fail
 *  because a diagnostic could not be attached. */
export async function installActivityProbe(cdp: CDP): Promise<void> {
  await cdp
    .send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_INSTALL_JS })
    .catch(() => {});
  await cdp.send("Runtime.evaluate", { expression: PROBE_INSTALL_JS }).catch(() => {});
}

type Probe = { quietMs: number; net: number; timers: number; anims: number; paint: number };

async function readProbe(cdp: CDP): Promise<Probe | null> {
  try {
    const r = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: PROBE_READ_JS,
      returnByValue: true,
    });
    const v = r.result?.value;
    if (typeof v !== "string") return null;
    const p = JSON.parse(v) as Partial<Probe> & { ok?: boolean };
    if (!p.ok) return null;
    return {
      quietMs: p.quietMs ?? 0,
      net: p.net ?? 0,
      timers: p.timers ?? 0,
      anims: p.anims ?? 0,
      paint: p.paint ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Hold for `heldMs` (the editorial beat — always run in full), then keep
 * waiting while the page is still working, up to `budgetMs`.
 *
 * `budgetMs <= 0` reduces this to the old fixed sleep exactly — the escape
 * hatch for a page that never goes quiet (`CaptureOpts.settleBudgetMs: 0`),
 * and what the unit tests use to pin the legacy timing.
 */
export async function settle(
  cdp: CDP,
  heldMs: number,
  opts: { budgetMs?: number } = {},
): Promise<SettleOutcome> {
  const budget = opts.budgetMs ?? DEFAULT_SETTLE_BUDGET_MS;
  await sleep(Math.max(0, heldMs));
  if (!(budget > 0)) return { heldMs, waitedMs: 0, reason: "budget", paintFrac: 0 };
  const t0 = Date.now();
  let paintFrac = 0;
  for (;;) {
    const p = await readProbe(cdp);
    const waitedMs = Date.now() - t0;
    if (!p) return { heldMs, waitedMs, reason: "unavailable", paintFrac };
    paintFrac = Math.max(paintFrac, p.paint);
    if (p.quietMs >= QUIET_MS) return { heldMs, waitedMs, reason: "idle", paintFrac };
    if (waitedMs >= budget) return { heldMs, waitedMs, reason: "budget", paintFrac };
    await sleep(POLL_MS);
  }
}

/** How many beats in a row may spend the WHOLE budget without the page ever
 *  settling before the waiting is written off. */
export const SETTLE_GIVE_UP_STREAK = 2;

/**
 * Budget policy across one take. Some pages never go quiet — a one-second
 * clock, a poll loop, a streaming widget — and no DOM signal can tell that
 * apart from real work. So do not try: once a run of beats has each spent the
 * entire budget with no result, the waiting is provably not helping, and
 * paying it on every remaining beat would add more dead air than the whole
 * demo is long. Give up once, loudly, and let the author set settleMs by eye.
 */
export function makeBudgetGovernor(budgetMs: number, giveUpStreak = SETTLE_GIVE_UP_STREAK) {
  let budget = budgetMs;
  let streak = 0;
  return {
    get budgetMs() {
      return budget;
    },
    get gaveUp() {
      return budget <= 0 && budgetMs > 0;
    },
    /** Feed every outcome back. Returns true on the ONE call that gives up. */
    record(reason: SettleOutcome["reason"]): boolean {
      if (reason === "idle") {
        streak = 0;
        return false;
      }
      if (reason !== "budget" || budget <= 0) return false;
      if (++streak < giveUpStreak) return false;
      budget = 0;
      return true;
    },
  };
}
