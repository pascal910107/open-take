// The take plan — the agent's IR. The agent emits this from one NL
// request ("make a demo of X"); the human talks to refine it. Kept thin:
// the planning intelligence lives in the agent, not here.
//
// Three action vocabularies (all backed by the agent-browser driver):
//   click — orient / navigate / trigger a payoff
//   type  — fill a field / search box / AI prompt (real keystrokes)
//   drag  — sketch / draw / move (a PATH, not a point — canvas wow)
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
  | { action: "wait"; ms: number };

export type TakePlan = {
  /** the running app under test (real app, or a served fixture) */
  url: string;
  viewport?: { width: number; height: number };
  /** where the synthetic cursor starts (viewport px) */
  startCursor?: { x: number; y: number };
  steps: TakeStep[];
};
