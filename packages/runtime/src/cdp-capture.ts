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

import { rmSync } from "node:fs";
import { resolve } from "node:path";
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
  sampleAlong,
  scrollDeltaByTextJs,
  scrollDeltaSelectorJs,
} from "./capture";
import {
  type CDP,
  type Browser,
  encodeFrames,
  fitViewport,
  launchBrowser,
  Screencast,
  makeFrameDir,
} from "./cdp";
import type { TakePlan } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// smootherstep — ease-in-out. Used to ease a drag along its path (must match
// the compositor's drag easing in math.ts exactly so the cursor stays locked
// to the captured ink).
const smoother = (u: number) => {
  u = Math.max(0, Math.min(1, u));
  return u * u * u * (u * (u * 6 - 15) + 10);
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
  const out = resolve(opts.videoPath);

  let browser: Browser | null = null;
  const frameDir = makeFrameDir();
  try {
    browser = await launchBrowser({ width: vw, height: vh, chromePath: opts.chromePath });
    const { cdp } = browser;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // Grow the window so the natural viewport == requested (headless reserves
    // window chrome). This — NOT a metrics override — keeps the captured frame,
    // the viewport, and the event coordinate space all the same size.
    const inner = await fitViewport(cdp, browser.targetId, vw, vh);

    await navigate(cdp, plan.url);

    const screencast = new Screencast(cdp, frameDir);
    const t0 = Date.now();
    await screencast.start(t0, { maxWidth: inner[0], maxHeight: inner[1], quality: 92 });

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
    for (const step of plan.steps) {
      if (step.action === "wait") {
        await sleep(step.ms);
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
          console.error(`captureTakeCDP: type target not found, skipped: ${JSON.stringify(label)}`);
          await sleep(step.settleMs ?? 600);
          continue;
        }
        // progressive char-by-char so the recording shows text appear; paced
        // by us (insertText fires `input` events React/inputs honour).
        const chars = [...step.value];
        const perChar = Math.min(60, Math.max(28, Math.round(1100 / Math.max(1, chars.length))));
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
        await sleep(step.settleMs ?? 900);
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
          console.error(
            `captureTakeCDP: drag endpoint not found, skipped: ${JSON.stringify(label)}`,
          );
          await sleep(step.settleMs ?? 600);
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
        await sleep(step.settleMs ?? 1100);
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
            console.error(
              `captureTakeCDP: scroll target not found, skipped: ${JSON.stringify(step.toText ?? step.toSelector)}`,
            );
            await sleep(step.settleMs ?? 600);
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
        await sleep(step.settleMs ?? 800);
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
          console.error(
            `captureTakeCDP: hover target not found, skipped: ${JSON.stringify(label)}`,
          );
          await sleep(step.settleMs ?? 600);
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
        await sleep(step.settleMs ?? 300);
        continue;
      }

      if (step.action === "press") {
        // Keyboard-driven: dispatch the chord to whatever has focus, then hold
        // while the effect plays out. The cursor does NOT move. If a reveal
        // element is named, locate its bbox AFTER the press so the zoom frames
        // what appeared.
        const tMs = Date.now() - t0;
        const tPress = Date.now();
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
        await sleep(step.settleMs ?? 400);
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
        console.error(`captureTakeCDP: target not found, skipped: ${JSON.stringify(label)}`);
      }
      await sleep(step.settleMs ?? 1300);
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
    };
  } finally {
    await browser?.close();
    rmSync(frameDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Navigate and wait for load (bounded) so the first frame isn't a blank page.
async function navigate(cdp: CDP, url: string): Promise<void> {
  const loaded = new Promise<void>((res) => {
    cdp.on("Page.loadEventFired", () => res());
    setTimeout(res, 8000); // don't hang on a never-firing load
  });
  await cdp.send("Page.navigate", { url });
  await loaded;
}
