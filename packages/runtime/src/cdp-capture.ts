// captureTakeCDP — the high-fps capture path (HANDOFF #5).
//
// Same contract as captureTake (drive `plan` against the live app, emit the
// ground-truth CaptureLog + a video at `videoPath`), but it launches its own
// headless Chrome and drives AND captures over one CDP page session. That
// removes agent-browser's ~10fps recordVideo ceiling (→ ~60fps screencast)
// and the per-step process spawn (→ drags driven at ~16ms steps, so the
// captured ink stays in lockstep with the synthetic cursor). See
// spike-revideo/fps/VERDICT.md. The ELEMENT-RESOLUTION logic is reused
// verbatim from capture.ts — same locator JS, run via Runtime.evaluate —
// so robustness is shared, not re-derived.

import { existsSync, rmSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CaptureLog } from "@open-take/compositor";
import type { CaptureOpts } from "./capture";
import {
  type Box,
  boxByTextJs,
  boxSelectorJs,
  clickBySelectorJs,
  clickByTextJs,
  evalValue,
  ffprobe,
  findBox,
  focusFieldByTextJs,
  focusSelectorJs,
  hrefByTextJs,
  hrefSelectorJs,
  sampleAlong,
  scrollDeltaByTextJs,
  scrollDeltaSelectorJs,
  selectAllInFocusedJs,
} from "./capture";
import {
  type Browser,
  type CDP,
  Screencast,
  encodeFrames,
  fitViewport,
  launchBrowser,
  makeFrameDir,
} from "./cdp";
import { resolveNavigateUrl } from "./nav";
import {
  DEFAULT_SETTLE_BUDGET_MS,
  PAINT_BLIND_FRAC,
  installActivityProbe,
  makeBudgetGovernor,
  settle,
} from "./settle";
import type { TakePlan } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Report a settle wait only past this — a couple of polls is the probe
 *  confirming quiet, not the page being slow, and a log full of 60ms notes
 *  would bury the beat that actually needed a second. */
const SETTLE_NOTE_MS = 150;

// smootherstep — ease-in-out. Used to ease a drag along its path (must match
// the compositor's drag easing in math.ts exactly so the cursor stays locked
// to the captured ink).
const smoother = (u: number) => {
  const clamped = Math.max(0, Math.min(1, u));
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
};

type Pt = { x: number; y: number };

// Run a locator JS string (the same builders capture.ts uses) and parse the
// box it returns. `returnByValue` hands us the inner JSON string; evalValue
// unwraps any double-encoding, then findBox extracts the rect.
async function evalBox(cdp: CDP, js: string): Promise<Box | null> {
  const r = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression: js,
    returnByValue: true,
    awaitPromise: true,
  });
  const v = r.result?.value;
  if (v == null || v === "NOTFOUND") return null;
  return findBox(evalValue(typeof v === "string" ? v : JSON.stringify(v)));
}

// Run a locator JS string and return its parsed value (any shape), or null for
// a NOTFOUND / empty result. Used by scroll-to-element ({dy} delta).
async function evalAny(cdp: CDP, js: string): Promise<unknown> {
  const r = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression: js,
    returnByValue: true,
    awaitPromise: true,
  });
  const v = r.result?.value;
  if (v == null || v === "NOTFOUND") return null;
  return evalValue(typeof v === "string" ? v : JSON.stringify(v));
}

// Run a locator JS string and return its STRING result (a URL), or null for a
// NOTFOUND/empty one. Deliberately NOT evalAny: a URL is not JSON, and the
// deep-parse that unwraps box payloads would mangle it.
async function evalString(cdp: CDP, js: string): Promise<string | null> {
  const r = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression: js,
    returnByValue: true,
    awaitPromise: true,
  });
  const v = r.result?.value;
  return typeof v === "string" && v !== "NOTFOUND" && v !== "" ? v : null;
}

// Wait (bounded) for the document's webfonts. A capture runs on a fresh temp
// profile, so the HTTP cache is cold and third-party webfonts otherwise FOUT in
// the first ~700ms the document is on screen. Runs before the recording clock
// starts AND after every mid-take `navigate` — the second document is exactly
// as cold as the first, and a FOUT mid-shot is just as visible as one at the
// head. A page with no webfonts resolves immediately.
async function awaitFonts(cdp: CDP): Promise<void> {
  await Promise.race([
    cdp
      .send("Runtime.evaluate", {
        expression: "document.fonts.ready.then(() => true)",
        awaitPromise: true,
        returnByValue: true,
      })
      .catch(() => {}),
    sleep(3000),
  ]);
}

const center = (b: Box): Pt => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });

// mouse via CDP Input — trusted events, near-zero per-call overhead.
// `buttons` is the bitmask of *currently-pressed* buttons (1 = left held);
// `button` names the one this event acts on ("none" for a bare move).
const mouse = (
  cdp: CDP,
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  x: number,
  y: number,
  buttons = 0,
) =>
  cdp.send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === "mouseMoved" ? "none" : "left",
    buttons,
    ...(type === "mouseMoved" ? {} : { clickCount: 1 }),
  });

// --- keyboard ----------------------------------------------------------
// CDP modifier bitmask: Alt=1, Ctrl=2, Meta(⌘)=4, Shift=8.
const MOD: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  win: 4,
  shift: 8,
};
type KeyInfo = { key: string; code: string; vk: number; text?: string };
// Named non-printable keys an editorial demo reaches for. `text` only where a
// page expects a character (Enter submits forms via "\r"; Space inserts " ").
const NAMED: Record<string, KeyInfo> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

// VK code for the Left variant of each modifier (dispatched as its own key
// event so apps that track modifier keydown state see it pressed).
const MOD_KEY: Record<number, KeyInfo> = {
  1: { key: "Alt", code: "AltLeft", vk: 18 },
  2: { key: "Control", code: "ControlLeft", vk: 17 },
  4: { key: "Meta", code: "MetaLeft", vk: 91 },
  8: { key: "Shift", code: "ShiftLeft", vk: 16 },
};

// Parse "Meta+k" / "Enter" / "Control+Shift+p" into a modifier bitmask + the
// main key's CDP fields. The last token is the key; the rest are modifiers.
function parseChord(keys: string): { mods: number; info: KeyInfo } {
  const tokens = keys
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  const main = tokens.pop() ?? "";
  let mods = 0;
  for (const t of tokens) mods |= MOD[t.toLowerCase()] ?? 0;
  const named = NAMED[main.toLowerCase()];
  let info: KeyInfo;
  if (named) {
    info = named;
  } else {
    // a single printable character
    const ch = main;
    const code = /^[a-z]$/i.test(ch)
      ? `Key${ch.toUpperCase()}`
      : /^[0-9]$/.test(ch)
        ? `Digit${ch}`
        : "";
    info = { key: ch, code, vk: ch.toUpperCase().charCodeAt(0) || 0 };
    // include the character ONLY for a bare key (no Ctrl/Meta/Alt) — a shortcut
    // must not also insert text.
    if (!(mods & (1 | 2 | 4))) info.text = ch;
  }
  return { mods, info };
}

async function dispatchKey(
  cdp: CDP,
  type: "keyDown" | "keyUp",
  info: KeyInfo,
  mods: number,
): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", {
    type: info.text && type === "keyDown" ? "keyDown" : type,
    modifiers: mods,
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    ...(info.text ? { text: info.text } : {}),
  });
}

// Press a chord: hold modifiers, tap the key, release in reverse — the order a
// real keyboard produces, so apps tracking modifier state respond correctly.
async function pressChord(cdp: CDP, keys: string): Promise<void> {
  const { mods, info } = parseChord(keys);
  const active = [1, 2, 4, 8].filter((m) => mods & m);
  for (const m of active) await dispatchKey(cdp, "keyDown", MOD_KEY[m]!, mods);
  await dispatchKey(cdp, "keyDown", info, mods);
  await sleep(40);
  await dispatchKey(cdp, "keyUp", info, mods);
  for (const m of active.reverse()) await dispatchKey(cdp, "keyUp", MOD_KEY[m]!, 0);
}

/** High-fps twin of captureTake. Drives + records via CDP. */
export async function captureTakeCDP(plan: TakePlan, opts: CaptureOpts): Promise<CaptureLog> {
  const vw = plan.viewport?.width ?? 1920;
  const vh = plan.viewport?.height ?? 1080;
  const fps = Math.min(60, Math.max(24, Math.round(opts.fps ?? 60)));
  const scale = Math.max(1, opts.captureScale ?? 2);
  const out = resolve(opts.videoPath);

  let browser: Browser | null = null;
  const frameDir = makeFrameDir();
  try {
    browser = await launchBrowser({
      width: vw,
      height: vh,
      chromePath: opts.chromePath,
      deviceScaleFactor: scale,
      ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
      ...(opts.headless === false ? { headless: false } : {}),
    });
    const { cdp } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // Grow the window so the natural viewport == requested (headless reserves
    // window chrome). This — NOT a metrics override — keeps the captured frame,
    // the viewport, and the event coordinate space all the same size (the
    // frame is exactly `scale`× the CSS event space; see launchBrowser).
    const inner = await fitViewport(cdp, browser.targetId, vw, vh);

    // Watch the page for activity from the very first document (and every
    // one a mid-take navigation creates) so a hold can tell "finished" from
    // "still working" instead of betting on settleMs. Diagnostic only — a
    // failure to install just returns the old fixed-sleep behaviour.
    await installActivityProbe(cdp);
    if (!originAllowed(plan.url))
      throw new Error(
        `captureTakeCDP: plan.url ${plan.url} is outside OPEN_TAKE_ALLOWED_ORIGINS — an unattended run only films the app it was pointed at`,
      );
    await navigate(cdp, plan.url);
    await installActivityProbe(cdp);

    // Fonts before frames — the recording's first ~700ms is the one place a
    // viewer's eye is guaranteed to be. Every mid-take `navigate` repeats this.
    await awaitFonts(cdp);

    const screencast = new Screencast(cdp, frameDir);
    const t0 = Date.now();
    // max dims in PHYSICAL px — at deviceScaleFactor 2 the surface is 2× the
    // CSS viewport; capping at CSS size would silently downscale back to 1×.
    await screencast.start(t0, {
      maxWidth: inner[0] * scale,
      maxHeight: inner[1] * scale,
      quality: 92,
    });

    // Raster pump. Page.startScreencast only emits a frame when the renderer
    // produces one, and in headless a state change that isn't driven by trusted
    // input — a CSS :hover reveal, a keyboard-opened modal, window.scrollTo —
    // updates the DOM/scroll offset but does NOT re-raster, so the screencast
    // composites STALE tiles and the recording freezes on the old frame.
    // Page.captureScreenshot forces a fresh raster; running it on a steady tick
    // keeps the screencast current for the whole capture, so every action is
    // recorded regardless of how it's driven. (quality:1 → cheap; the result is
    // discarded — only the re-raster side effect matters.)
    // captureScreenshot STALLS while a mouse button is held (mid-drag), and a
    // stalled screenshot BLOCKS the whole CDP session — Chrome won't process the
    // drag's mouseMoved events until it resolves, wedging the capture. So the
    // pump PAUSES around a drag (a drag draws real ink, so it self-rasters and
    // needs no pump). The timeout race is a second belt: it keeps a stall during
    // any other beat from wedging the final `await pump`.
    let pumping = true;
    let pumpPaused = false;
    const pump = (async () => {
      while (pumping) {
        if (!pumpPaused)
          await Promise.race([
            cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 1 }).catch(() => {}),
            sleep(150),
          ]);
        await sleep(45);
      }
    })();

    await sleep(opts.warmupMs ?? 900);

    const resolvePoint = async (spec: {
      point?: Pt;
      selector?: string;
      text?: string;
    }): Promise<Pt | null> => {
      if (spec.point) return { x: Math.round(spec.point.x), y: Math.round(spec.point.y) };
      if (spec.selector) {
        const b = await evalBox(cdp, boxSelectorJs(spec.selector));
        return b ? center(b) : null;
      }
      if (spec.text) {
        const b = await evalBox(cdp, boxByTextJs(spec.text));
        return b ? center(b) : null;
      }
      return null;
    };

    const events: CaptureLog["events"] = [];
    // Dropped steps are collected onto the log (and echoed to stderr at the
    // moment they happen) so the end-of-run summary and --strict can see them
    // — an early stderr line alone gets buried under render progress.
    const skipped: NonNullable<CaptureLog["skipped"]> = [];
    // Beats whose hold was NOT long enough for the page — the measurement that
    // turns `settleMs` from a guess into a number the next plan can copy.
    const settleWaits: NonNullable<CaptureLog["settleWaits"]> = [];
    // Bounds what a page that never goes quiet can cost the take — see
    // makeBudgetGovernor.
    const governor = makeBudgetGovernor(opts.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS);
    // Biggest paint surface seen. Reported ONCE — an author who sees no ⏱
    // lines would otherwise read that as "my timings were right", which on a
    // canvas app is exactly the wrong conclusion.
    let paintedFrac = 0;
    let paintNoted = false;
    for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
      const step = plan.steps[stepIdx]!;
      const skip = (action: string, target: string | undefined, reason: string) => {
        skipped.push({ step: stepIdx, action, ...(target ? { target } : {}), reason });
        console.error(`captureTakeCDP: ${action} ${reason}, skipped: ${JSON.stringify(target)}`);
      };
      // The editorial hold, then — only if the page is still working — the
      // time it actually needs. `defaultMs` stays the per-action default the
      // plan author never has to think about; `step.settleMs` still wins.
      const hold = async (defaultMs: number) => {
        // `step` is the un-narrowed union here (every action calls this), and
        // `wait` is the one variant with no settleMs — it IS a hold.
        const heldMs = ("settleMs" in step ? step.settleMs : undefined) ?? defaultMs;
        const r = await settle(cdp, heldMs, { budgetMs: governor.budgetMs });
        paintedFrac = Math.max(paintedFrac, r.paintFrac);
        if (paintedFrac >= PAINT_BLIND_FRAC && !paintNoted) {
          paintNoted = true;
          console.error(
            `captureTakeCDP: a <canvas>/<video> covers ~${Math.round(paintedFrac * 100)}% of the frame — the settle probe reads page STRUCTURE and cannot see what is painted inside one, so on beats whose payoff is drawn there, settleMs is doing the whole job. Set those by eye and check \`frames\`.`,
          );
        }
        if (governor.record(r.reason))
          console.error(
            "captureTakeCDP: this page never goes quiet (consecutive beats spent the whole settle budget) — settle waiting is OFF for the rest of the take; set each beat's settleMs explicitly instead",
          );
        if (r.waitedMs < SETTLE_NOTE_MS) return;
        const waitedMs = Math.round(r.waitedMs);
        settleWaits.push({
          step: stepIdx,
          action: step.action,
          heldMs,
          waitedMs,
          reason: r.reason,
        });
        console.error(
          `captureTakeCDP: step ${stepIdx} (${step.action}) held ${heldMs}ms, then waited ${waitedMs}ms more for the page to settle (${r.reason})`,
        );
      };
      if (step.action === "wait") {
        await sleep(step.ms);
        continue;
      }

      if (step.action === "navigate") {
        // Late-bind the destination FIRST — reading a link's href is the whole
        // reason this step can reach a page the plan's author could not name
        // (a deploy's generated domain, a permalink the run just created).
        const spec = step.hrefFrom;
        let href: string | null = null;
        if (spec) {
          const target = spec.text ?? spec.selector;
          if (!target) {
            skip("navigate", undefined, "hrefFrom has neither `selector` nor `text`");
            continue;
          }
          href = spec.selector
            ? await evalString(cdp, hrefSelectorJs(spec.selector))
            : await evalString(cdp, hrefByTextJs(spec.text!));
          if (!href) {
            skip("navigate", target, "no link with an href found");
            continue;
          }
        }
        const current = (await evalString(cdp, "location.href")) ?? plan.url;
        const dest = resolveNavigateUrl({ current, url: step.url, href, query: step.query });
        if (!dest) {
          skip("navigate", step.url ?? href ?? current, "destination is not a resolvable URL");
          continue;
        }
        if (!originAllowed(dest)) {
          skip("navigate", dest, "destination is outside OPEN_TAKE_ALLOWED_ORIGINS");
          continue;
        }
        // Same tab ⇒ same page target ⇒ the screencast never breaks. The
        // activity probe reinstalls itself on the new document (it is an
        // addScriptToEvaluateOnNewDocument), so the hold below can still tell
        // "finished" from "still working".
        await navigate(cdp, dest);
        await awaitFonts(cdp);
        // Then the ordinary settle. A navigate with no hold cuts to a
        // half-painted screen — this is the beat where the new page arrives,
        // even though it emits no event.
        await hold(1200);
        continue;
      }

      if (step.action === "type") {
        const label = step.text ?? step.selector;
        const tMs = Date.now() - t0;
        const box = step.text
          ? await evalBox(cdp, focusFieldByTextJs(step.text))
          : step.selector
            ? await evalBox(cdp, focusSelectorJs(step.selector))
            : null;
        if (!box) {
          skip("type", label, "target not found");
          await hold(600);
          continue;
        }
        // Unattended runs must never film a credential being typed — the plan
        // is agent-written and the mp4 is the one artifact nobody reviews.
        // The focus JS above already parked focus on the field, so ask the
        // page what kind of field it actually is.
        if (
          process.env.OPEN_TAKE_CI &&
          (await evalString(cdp, credentialFieldProbeJs())) === "secret"
        ) {
          skip("type", label, "refusing to type into a credential field (OPEN_TAKE_CI)");
          await hold(600);
          continue;
        }
        // Replace-not-append: select the field's existing value in-page so the
        // first inserted character replaces it (dispatched "Meta+a" key events
        // never run Chrome's editing commands — see selectAllInFocusedJs).
        if (step.clear) await evalAny(cdp, selectAllInFocusedJs());
        // progressive char-by-char so the recording shows text appear; paced
        // by us (insertText fires `input` events React/inputs honour).
        const chars = [...step.value];
        // ~1.1s per beat, clamped 28–90ms/char. The cap used to be 60ms, which
        // made SHORT strings the FASTEST typing in the video (inverted feel);
        // 90 lets a short hero string read deliberate while long strings keep
        // their genre-normal pace. Mostly-CJK strings slow ~1.4× (every glyph
        // is a word — the viewer reads, not skims). perCharMs overrides.
        const cjk = chars.filter((c) =>
          /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9F]/.test(c),
        ).length;
        const auto =
          Math.min(90, Math.max(28, Math.round(1100 / Math.max(1, chars.length)))) *
          (cjk * 2 > chars.length ? 1.4 : 1);
        const perChar = Math.round(step.perCharMs ?? auto);
        const tType = Date.now();
        for (const ch of chars) {
          await cdp.send("Input.insertText", { text: ch });
          await sleep(perChar);
        }
        events.push({
          kind: "type",
          ...center(box),
          box,
          tMs,
          sel: label,
          note: step.note,
          text: step.value,
          durationMs: Date.now() - tType,
          ...(step.zoom ? { zoom: step.zoom } : {}),
        });
        await hold(900);
        continue;
      }

      if (step.action === "drag") {
        // A freehand `path` carries its own endpoints — fall back to them so a
        // path-only drag (no addressable element) isn't dropped.
        const pathPts: Pt[] = (step.path ?? []).map((p) => ({
          x: Math.round(p.x),
          y: Math.round(p.y),
        }));
        const from =
          (await resolvePoint({ point: step.from, selector: step.selector, text: step.text })) ??
          pathPts[0] ??
          null;
        const to =
          (await resolvePoint({ point: step.to, selector: step.toSelector, text: step.toText })) ??
          pathPts[pathPts.length - 1] ??
          null;
        const label = step.note ?? step.text ?? step.selector;
        if (!from || !to) {
          skip("drag", label, "endpoint not found");
          await hold(600);
          continue;
        }
        const path: Pt[] = pathPts.length ? pathPts : [from, to];
        const target = step.durationMs ?? 1200;
        // Stroke pacing baked into the ink. "smooth" (default) accelerates in /
        // decelerates out (a natural hand-draw); "linear" is constant speed. The
        // compositor cursor replays the SAME curve (it's recorded on the event)
        // so it stays locked to the ink. Time steps stay uniform; the EASING is
        // applied to the along-path position, so the pen moves slow-fast-slow.
        const dragEase = opts.dragEasing ?? "smooth";
        const easeParam = dragEase === "smooth" ? smoother : (u: number) => u;
        // ~16ms steps → ~60 distinct frames/sec captured (one redraw per move);
        // this is what keeps the ink from lagging the cursor (spike VERDICT).
        const n = Math.max(12, Math.round(target / 16));
        const tMs = Date.now() - t0;
        // Pause the raster pump for the held-button stroke (a stalled
        // captureScreenshot would block the drag's mouse events). Drain any
        // in-flight (button-up) screenshot first.
        pumpPaused = true;
        await sleep(160);
        const tDrag = Date.now();
        // All pointer events are fire-and-forget (see the move loop) — a
        // held-button dispatch withholds its ack ~5s in headless, so awaiting
        // press/release/moves would stall the stroke. Sends stay ordered on the
        // socket, and Chrome processes them promptly (only the ack is delayed).
        mouse(cdp, "mouseMoved", path[0]!.x, path[0]!.y, 0).catch(() => {});
        mouse(cdp, "mousePressed", path[0]!.x, path[0]!.y, 1).catch(() => {});
        for (let k = 1; k <= n; k++) {
          // Eased along-path position over UNIFORM time steps → the pen draws
          // slow-fast-slow (smooth) or constant (linear). cursorPos replays the
          // same `easeParam`, so cursor and ink stay locked (math.ts).
          const p = sampleAlong(path, easeParam(k / n));
          // FIRE-AND-FORGET the move (don't await its ack). A held-button
          // dispatchMouseEvent that paints nothing withholds its response ~5s in
          // headless (waiting for a frame commit) — awaiting each would stall the
          // whole stroke. Chrome still processes the moves in send order; we pace
          // the stroke by wall-clock below.
          mouse(cdp, "mouseMoved", p.x, p.y, 1).catch(() => {});
          // pace by absolute wall-clock so dispatch latency doesn't stretch the
          // stroke past its requested duration (drag stays on its editorial beat).
          const due = tDrag + (target * k) / n;
          const slack = due - Date.now();
          if (slack > 0) await sleep(slack);
        }
        const last = path[path.length - 1]!;
        mouse(cdp, "mouseReleased", last.x, last.y, 0).catch(() => {}); // no buttons held after release
        // durationMs is the STROKE window only (loop end ≈ target) — measured
        // before the flush/settle sleeps so the compositor cursor traces exactly
        // the ink's draw window and stays locked to it (not the longer wall time).
        const drawnMs = Date.now() - tDrag;
        await sleep(120); // let the release + last moves flush before resuming
        pumpPaused = false; // button released — safe to resume forced rasters
        events.push({
          kind: "drag",
          x: from.x,
          y: from.y,
          to,
          path,
          tMs,
          sel: label,
          note: step.note,
          durationMs: drawnMs,
          ease: dragEase,
          ...(step.zoom ? { zoom: step.zoom } : {}),
        });
        await hold(1100);
        continue;
      }

      if (step.action === "dropFiles") {
        // Synthesize an OS-level file drag-and-drop: CDP Input.dispatchDragEvent
        // carries REAL file paths, so the page's dragenter/dragover state fires
        // on the way in and the drop delivers actual Files (dataTransfer.files).
        // The DragData must ride EVERY dispatch (enter, each over, drop), not
        // just the drop (spiked: baseline {items:[], files, mask:1} works in
        // --headless=new with no focus requirement).
        const label = step.note ?? step.paths.map((p) => basename(p)).join(", ");
        if (!step.paths.length) {
          skip("dropFiles", label, "no files given (empty paths)");
          await hold(600);
          continue;
        }
        const absPaths = step.paths.map((p) => resolve(p));
        const missing = absPaths.filter((p) => !existsSync(p));
        if (missing.length) {
          skip("dropFiles", label, `file not found: ${missing.join(", ")}`);
          await hold(600);
          continue;
        }
        const files = absPaths.map((p) => {
          const st = statSync(p);
          return { name: basename(p), size: st.size };
        });
        // Drop target: locator when given (a FAILED lookup skips — dropping real
        // files "somewhere in the middle" would fabricate the beat, and Chrome's
        // default drop action could even navigate the tab to the file). The
        // viewport-centre default applies only when the plan names NO target.
        let to: Pt;
        if (step.to || step.toSelector || step.toText) {
          const found = await resolvePoint({
            point: step.to,
            selector: step.toSelector,
            text: step.toText,
          });
          if (!found) {
            skip("dropFiles", label, "drop target not found");
            await hold(600);
            continue;
          }
          to = found;
        } else {
          to = { x: Math.round(inner[0] / 2), y: Math.round(inner[1] / 2) };
        }
        // default entry: swing in from the top-right edge, like a file dragged
        // in from the desktop; deterministic so re-makes reproduce the take.
        const from: Pt = step.from
          ? { x: Math.round(step.from.x), y: Math.round(step.from.y) }
          : { x: inner[0] - 28, y: Math.round(inner[1] * 0.18) };
        const pathPts: Pt[] = (step.path ?? []).map((p) => ({
          x: Math.round(p.x),
          y: Math.round(p.y),
        }));
        const path: Pt[] = pathPts.length ? pathPts : [from, to];
        const target = step.durationMs ?? 1400;
        const dragEase = opts.dragEasing ?? "smooth";
        const easeParam = dragEase === "smooth" ? smoother : (u: number) => u;
        const data = { items: [], files: absPaths, dragOperationsMask: 1 };
        const dragEvt = (type: "dragEnter" | "dragOver" | "drop", p: Pt) =>
          cdp.send("Input.dispatchDragEvent", {
            type,
            x: Math.round(p.x),
            y: Math.round(p.y),
            data,
          });
        const n = Math.max(12, Math.round(target / 16));
        const tMs = Date.now() - t0;
        // Pause the raster pump for the carry (mirroring drag): a mid-drag
        // captureScreenshot could stall the CDP session; the page's dragover
        // reaction (dropzone morph) self-rasters, so nothing is lost.
        pumpPaused = true;
        await sleep(160);
        const tCarry = Date.now();
        const last = path[path.length - 1]!;
        let carriedMs: number;
        try {
          // dragEnter and the final drop are load-bearing (the page's drag
          // state, then the actual file delivery) — a rejection there means the
          // beat did NOT happen, so it must SKIP, not fabricate a success.
          // The mid-march dragOvers stay fire-and-forget: they only pace the
          // carry, and awaiting each ack would stall the stroke (see drag).
          await dragEvt("dragEnter", path[0]!);
          for (let k = 1; k <= n; k++) {
            const p = sampleAlong(path, easeParam(k / n));
            dragEvt("dragOver", p).catch(() => {});
            const due = tCarry + (target * k) / n;
            const slack = due - Date.now();
            if (slack > 0) await sleep(slack);
          }
          await dragEvt("dragOver", last).catch(() => {});
          await dragEvt("drop", last);
          carriedMs = Date.now() - tCarry;
        } catch (e) {
          pumpPaused = false;
          skip("dropFiles", label, `drag dispatch failed: ${(e as Error).message}`);
          await hold(600);
          continue;
        }
        await sleep(120);
        pumpPaused = false;
        events.push({
          kind: "dropFiles",
          x: path[0]!.x,
          y: path[0]!.y,
          to: last,
          path,
          tMs,
          sel: label,
          note: step.note,
          durationMs: carriedMs,
          ease: dragEase,
          files,
          ...(step.zoom ? { zoom: step.zoom } : {}),
        });
        // dropzones usually kick off real work (parse / upload UI) — default a
        // longer settle than a click so the payoff is on screen.
        await hold(1600);
        continue;
      }

      if (step.action === "scroll") {
        // Resolve the scroll distance: to an element's centre, or a fixed dy
        // (default ~0.8 viewport down). The cursor holds; the content pans.
        const tMs = Date.now() - t0;
        let dy: number;
        if (step.toSelector || step.toText) {
          const r = (await evalAny(
            cdp,
            step.toSelector
              ? scrollDeltaSelectorJs(step.toSelector)
              : scrollDeltaByTextJs(step.toText!),
          )) as { dy?: number } | null;
          if (r && typeof r.dy === "number") {
            dy = r.dy;
          } else {
            skip("scroll", step.toText ?? step.toSelector, "target not found");
            await hold(600);
            continue;
          }
        } else {
          dy = step.dy ?? Math.round(vh * 0.8);
        }
        const targetMs = step.durationMs ?? 1000;
        const cx = Math.round(inner[0] / 2),
          cy = Math.round(inner[1] / 2);
        // Programmatic window.scrollTo, eased and paced from node. The raster
        // pump (see above) forces the re-raster that makes the screencast
        // actually capture the motion — a bare scrollTo would otherwise freeze
        // the recording on stale tiles. No trusted wheel: it hangs forever in
        // headless if dispatched after an Escape keypress.
        const start = Number(await evalAny(cdp, "window.scrollY")) || 0;
        const n = Math.max(12, Math.round(targetMs / 16));
        const tScroll = Date.now();
        for (let k = 1; k <= n; k++) {
          const u = k / n;
          const want = Math.round(dy * (u * u * u * (u * (u * 6 - 15) + 10))); // eased cumulative
          await cdp.send("Runtime.evaluate", { expression: `window.scrollTo(0, ${start + want})` });
          const due = tScroll + (targetMs * k) / n;
          const slack = due - Date.now();
          if (slack > 0) await sleep(slack);
        }
        events.push({
          kind: "scroll",
          x: cx,
          y: cy,
          tMs,
          dy,
          durationMs: Date.now() - tScroll,
          note: step.note,
        });
        await hold(800);
        continue;
      }

      if (step.action === "hover") {
        // Move the real pointer onto the element (triggers :hover / mouseenter)
        // and dwell so the tooltip/menu is visible. No click. The synthetic
        // cursor travels + parks at the same point (compositor).
        const label = step.text ?? step.selector;
        const tMs = Date.now() - t0;
        const box = step.text
          ? await evalBox(cdp, boxByTextJs(step.text))
          : step.selector
            ? await evalBox(cdp, boxSelectorJs(step.selector))
            : null;
        if (!box) {
          skip("hover", label, "target not found");
          await hold(600);
          continue;
        }
        const c = center(box);
        const dwell = step.durationMs ?? 1200;
        await mouse(cdp, "mouseMoved", c.x, c.y, 0);
        events.push({
          kind: "hover",
          ...c,
          box,
          tMs,
          sel: label,
          note: step.note,
          durationMs: dwell,
          ...(step.zoom ? { zoom: step.zoom } : {}),
        });
        await sleep(dwell);
        // A hover DWELLS on its target and the cursor is parked for all of it, so
        // this settle is the ONLY room the next glide has. 300ms could not fit
        // one (travelMaxMs is 850 at the shipped pace) and the cursor darted.
        await hold(900);
        continue;
      }

      if (step.action === "press") {
        // Keyboard-driven: dispatch the chord to whatever has focus, then hold
        // while the effect plays out. The cursor does NOT move. If a reveal
        // element is named, locate its bbox AFTER the press so the zoom frames
        // what appeared.
        const tMs = Date.now() - t0;
        try {
          await pressChord(cdp, step.keys);
        } catch (e) {
          console.error(
            `captureTakeCDP: press failed for ${JSON.stringify(step.keys)}: ${(e as Error).message}`,
          );
        }
        const dwell = step.durationMs ?? 1000;
        let box: Box | null = null;
        if (step.selector || step.text) {
          await sleep(250); // let the revealed UI mount before measuring
          box = step.text
            ? await evalBox(cdp, boxByTextJs(step.text))
            : await evalBox(cdp, boxSelectorJs(step.selector!));
        }
        const anchor = box
          ? center(box)
          : { x: Math.round(inner[0] / 2), y: Math.round(inner[1] / 2) };
        events.push({
          kind: "press",
          ...anchor,
          ...(box ? { box } : {}),
          tMs,
          keys: step.keys,
          sel: step.text ?? step.selector,
          note: step.note,
          durationMs: dwell,
          ...(step.zoom ? { zoom: step.zoom } : {}),
        });
        await sleep(dwell);
        // Same as hover: the cursor is parked through the reveal, so this settle is
        // the entire window the next travel has to glide in. See hold() above.
        await hold(900);
        continue;
      }

      // click: timestamp, resolve bbox + programmatic click in one eval
      const label = step.text ?? step.selector;
      const tMs = Date.now() - t0;
      const box = step.text
        ? await evalBox(cdp, clickByTextJs(step.text))
        : step.selector
          ? await evalBox(cdp, clickBySelectorJs(step.selector))
          : null;
      if (box) {
        events.push({
          kind: "click",
          ...center(box),
          box,
          tMs,
          sel: label,
          note: step.note,
          ...(step.zoom ? { zoom: step.zoom } : {}),
        });
      } else {
        skip("click", label, "target not found");
      }
      await hold(1300);
    }

    const tEndMs = Date.now() - t0;
    await sleep(400);
    pumping = false;
    await pump;
    await screencast.stop();
    await encodeFrames(screencast.frames, tEndMs + 400, out, fps);

    const probe = await ffprobe(out);
    return {
      video: {
        width: probe.width ?? inner[0],
        height: probe.height ?? inner[1],
        fps: probe.fps,
        durationS: probe.durationS,
      },
      viewport: { w: inner[0], h: inner[1] },
      start: plan.startCursor ?? { x: Math.round(inner[0] * 0.25), y: Math.round(inner[1] * 0.9) },
      events,
      tEndMs,
      // Both of these were collected all along but never reached the caller on
      // this path, so the end-of-run summary and --strict saw an empty list and
      // a dropped beat lived only in an early stderr line — exactly what the
      // CaptureLog.skipped contract says must not happen.
      ...(skipped.length ? { skipped } : {}),
      ...(settleWaits.length ? { settleWaits } : {}),
      ...(paintedFrac >= PAINT_BLIND_FRAC
        ? { paintedFrac: Math.round(paintedFrac * 100) / 100 }
        : {}),
    };
  } finally {
    await browser?.close();
    rmSync(frameDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Navigate and wait for load (bounded) so the first frame isn't a blank page.
/** CI containment. A plan is agent-written, and the agent reads the very page
 *  it films — a hostile string ON that page can talk its way into a plan step.
 *  When OPEN_TAKE_ALLOWED_ORIGINS is set (comma-separated origins; `open-take
 *  ci` sets it to the app's own origin), any navigation outside the list is a
 *  skipped step, never a request. Unset (the interactive default), everything
 *  is allowed — a human is watching. */
function originAllowed(url: string): boolean {
  const raw = process.env.OPEN_TAKE_ALLOWED_ORIGINS;
  if (!raw) return true;
  try {
    const origin = new URL(url).origin;
    return raw.split(",").some((entry) => entry.trim() === origin);
  } catch {
    return false;
  }
}

/** Runs in-page AFTER focus landed on the type target: names the field
 *  "secret" when it is a password input or smells like a credential field.
 *  Only consulted under OPEN_TAKE_CI — locally the human sees what is typed. */
function credentialFieldProbeJs(): string {
  return `(() => {
    const el = document.activeElement;
    if (!el) return "ok";
    const type = (el.getAttribute("type") || "").toLowerCase();
    const smell = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("autocomplete"), el.getAttribute("placeholder")]
      .filter(Boolean).join(" ").toLowerCase();
    return type === "password" || /passw|secret|api[-_]?key|access[-_]?token/.test(smell) ? "secret" : "ok";
  })()`;
}

async function navigate(cdp: CDP, url: string): Promise<void> {
  const loaded = new Promise<void>((res) => {
    cdp.on("Page.loadEventFired", () => res());
    setTimeout(res, 8000); // don't hang on a never-firing load
  });
  await cdp.send("Page.navigate", { url });
  await loaded;
}
