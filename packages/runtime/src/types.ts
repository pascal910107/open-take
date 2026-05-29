// The take plan — the agent's IR. The agent emits this from one NL
// request ("make a demo of X"); the human talks to refine it. Kept thin:
// the planning intelligence lives in the agent, not here.
//
// The action vocabulary (all driven over pure CDP — see cdp-capture.ts):
//   click  — orient / navigate / trigger a payoff
//   type   — fill a field / search box / AI prompt (real keystrokes)
//   drag   — sketch / draw / move (a PATH, not a point — canvas wow)
//   scroll — pan the page / a feed to reveal content below or above the fold
//   hover  — dwell on an element to reveal a tooltip / menu / hover-state
//   press  — a key or shortcut (Enter to submit, Escape, ⌘K palette, …)
// plus `wait` for pacing.

/** A point in viewport CSS px (the capture coordinate space). */
export type PlanPoint = { x: number; y: number };

/** Editorial zoom intent: "auto" (heuristic), "never" (global/navigation
 *  payoff — keep full view), "always" (force fit-zoom). */
export type ZoomIntent = "auto" | "never" | "always";

// A click/type/drag targets an element by CSS `selector` or by accessible-
// name `text` (how an agent naturally thinks — robust on real apps where
// CSS hooks are unstable). drag can also use explicit viewport points
// (`from`/`to`) for canvas surfaces that have no addressable element.
export type TakeStep =
  | {
      action: "click";
      selector?: string;
      text?: string;
      note?: string;
      settleMs?: number;
      zoom?: ZoomIntent;
    }
  | {
      // Focus a field (located by selector/text) and type `value` with real
      // keystrokes. The cursor parks on the field and the zoom holds while
      // the text appears in the recording.
      action: "type";
      selector?: string;
      text?: string;
      /** the text to type into the focused field */
      value: string;
      note?: string;
      settleMs?: number;
      zoom?: ZoomIntent;
    }
  | {
      // Drag along a path with the button held — the canvas wow (sketch,
      // draw a shape, move an element). Start and end are each EITHER a
      // located element (selector/text → bbox centre) OR an explicit
      // viewport point (`from`/`to`). An optional `path` of viewport points
      // overrides the straight start→end line (freehand strokes).
      action: "drag";
      // start
      selector?: string;
      text?: string;
      from?: PlanPoint;
      // end
      toSelector?: string;
      toText?: string;
      to?: PlanPoint;
      /** freehand polyline (viewport px); when set, overrides from→to */
      path?: PlanPoint[];
      /** how long the drag takes on screen (default 1200ms) */
      durationMs?: number;
      note?: string;
      settleMs?: number;
      zoom?: ZoomIntent;
    }
  | {
      // Scroll the page (or a feed) to reveal content. The synthetic cursor
      // holds where it was — the CONTENT pans underneath, full-view (no zoom),
      // the natural "I'm reading down the page" beat. Either scroll a fixed
      // amount (`dy` viewport px; default ~0.8 viewport, positive = down) OR
      // scroll until a target element is centred (`to`/`toSelector`/`toText`).
      action: "scroll";
      /** pixels to scroll (positive = down); default ~0.8 × viewport height */
      dy?: number;
      /** scroll until this element is centred (overrides `dy`) */
      toSelector?: string;
      toText?: string;
      /** how long the scroll takes on screen (default 1000ms) */
      durationMs?: number;
      note?: string;
      settleMs?: number;
    }
  | {
      // Move the cursor onto an element and DWELL (no click) so a tooltip /
      // dropdown / hover-state reveals. The cursor travels + parks like a
      // click; the zoom can frame the element (default auto). Use zoom=never
      // when the reveal (a wide menu) spills past the element's bbox.
      action: "hover";
      selector?: string;
      text?: string;
      /** how long to dwell on screen so the reveal is visible (default 1200ms) */
      durationMs?: number;
      note?: string;
      settleMs?: number;
      zoom?: ZoomIntent;
    }
  | {
      // Press a key or shortcut. `keys` is a single chord: a named key
      // ("Enter", "Escape", "Tab", "ArrowDown") or a modifier combo joined by
      // "+" ("Meta+k", "Control+Shift+p", "Shift+Tab"). Keyboard-driven, so the
      // cursor does NOT move (it holds where it was). The press lands on
      // whatever currently has focus (e.g. a field filled by a prior `type`),
      // or the document (most ⌘K-style shortcuts listen there). Optionally name
      // the element the press REVEALS via `selector`/`text` — the zoom then
      // frames it (default auto when a reveal is named; never otherwise).
      action: "press";
      /** the chord, e.g. "Enter", "Escape", "Meta+k", "Control+Shift+p" */
      keys: string;
      /** the element the press reveals, to frame with zoom (optional) */
      selector?: string;
      text?: string;
      /** how long to hold while the effect plays out (default 1000ms) */
      durationMs?: number;
      note?: string;
      settleMs?: number;
      zoom?: ZoomIntent;
    }
  | { action: "wait"; ms: number };

export type TakePlan = {
  /** the running app under test (real app, or a served fixture) */
  url: string;
  viewport?: { width: number; height: number };
  /** where the synthetic cursor starts (viewport px) */
  startCursor?: { x: number; y: number };
  steps: TakeStep[];
};
