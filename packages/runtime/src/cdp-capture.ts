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
} from "./capture";
import { type CDP, type Browser, encodeFrames, fitViewport, launchBrowser, Screencast, makeFrameDir } from "./cdp";
import type { TakePlan } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const center = (b: Box): Pt => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });

// mouse via CDP Input — trusted events, near-zero per-call overhead.
// `buttons` is the bitmask of *currently-pressed* buttons (1 = left held);
// `button` names the one this event acts on ("none" for a bare move).
const mouse = (cdp: CDP, type: "mousePressed" | "mouseReleased" | "mouseMoved", x: number, y: number, buttons = 0) =>
  cdp.send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === "mouseMoved" ? "none" : "left",
    buttons,
    ...(type === "mouseMoved" ? {} : { clickCount: 1 }),
  });

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
    await sleep(opts.warmupMs ?? 900);

    const resolvePoint = async (spec: { point?: Pt; selector?: string; text?: string }): Promise<Pt | null> => {
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
        const pathPts: Pt[] = (step.path ?? []).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
        const from =
          (await resolvePoint({ point: step.from, selector: step.selector, text: step.text })) ?? pathPts[0] ?? null;
        const to =
          (await resolvePoint({ point: step.to, selector: step.toSelector, text: step.toText })) ??
          pathPts[pathPts.length - 1] ??
          null;
        const label = step.note ?? step.text ?? step.selector;
        if (!from || !to) {
          console.error(`captureTakeCDP: drag endpoint not found, skipped: ${JSON.stringify(label)}`);
          await sleep(step.settleMs ?? 600);
          continue;
        }
        const path: Pt[] = pathPts.length ? pathPts : [from, to];
        const target = step.durationMs ?? 1200;
        // ~16ms steps → ~60 distinct frames/sec captured (one redraw per move);
        // this is what keeps the ink from lagging the cursor (spike VERDICT).
        const n = Math.max(12, Math.round(target / 16));
        const tMs = Date.now() - t0;
        const tDrag = Date.now();
        await mouse(cdp, "mouseMoved", path[0]!.x, path[0]!.y, 0);
        await mouse(cdp, "mousePressed", path[0]!.x, path[0]!.y, 1);
        for (let k = 1; k <= n; k++) {
          const p = sampleAlong(path, k / n);
          await mouse(cdp, "mouseMoved", p.x, p.y, 1);
          // pace by absolute wall-clock so dispatch latency doesn't stretch the
          // stroke past its requested duration (drag stays on its editorial beat).
          const due = tDrag + (target * k) / n;
          const slack = due - Date.now();
          if (slack > 0) await sleep(slack);
        }
        const last = path[path.length - 1]!;
        await mouse(cdp, "mouseReleased", last.x, last.y, 0); // no buttons held after release
        // we drive the stroke ourselves with precise sleeps, so the on-screen
        // draw window IS the measured wall-clock window — no page-clock probe.
        events.push({
          kind: "drag",
          x: from.x,
          y: from.y,
          to,
          path,
          tMs,
          sel: label,
          note: step.note,
          durationMs: Date.now() - tDrag,
          ...(step.zoom ? { zoom: step.zoom } : {}),
        });
        await sleep(step.settleMs ?? 1100);
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
    await screencast.stop();
    await encodeFrames(screencast.frames, tEndMs + 400, out, fps);

    const probe = await ffprobe(out);
    return {
      video: { width: probe.width ?? inner[0], height: probe.height ?? inner[1], fps: probe.fps, durationS: probe.durationS },
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
