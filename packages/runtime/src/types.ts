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
      /** select the field's EXISTING value first, so the first keystroke
       *  replaces it — the "rename / edit a setting / correct text" beat.
       *  Without it, typing always appends at the caret. */
      clear?: boolean;
      /** ms per typed character on screen. Default auto-paces ~1.1s per beat
       *  (clamped 28–90ms; mostly-CJK strings run ~1.4× slower) — override for
       *  a deliberately slow reveal or a fast burst. */
      perCharMs?: number;
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
      // Drag REAL FILES from the OS onto the page and drop them. Driven via
      // CDP Input.dispatchDragEvent carrying the actual file paths, so the
      // page's dragenter/dragover state fires on the way in and the drop
      // delivers real Files (dataTransfer.files) — Vercel-Drop-style dropzones
      // receive the upload exactly as if a human dragged from the desktop.
      // The compositor draws a macOS-style "file ghost card" riding the
      // synthetic cursor for this beat (the page recording itself only shows
      // the page's reaction). Drop target = toSelector/toText/to (default
      // viewport centre); the carry starts at `from` (default: swings in from
      // the top-right edge, like a file dragged in from the desktop).
      action: "dropFiles";
      /** paths of the files to drop (resolved against the process cwd) */
      paths: string[];
      // drop target
      toSelector?: string;
      toText?: string;
      to?: PlanPoint;
      /** where the carry enters the viewport (default: top-right edge) */
      from?: PlanPoint;
      /** freehand polyline (viewport px); when set, overrides from→to */
      path?: PlanPoint[];
      /** how long the carry takes on screen (default 1400ms) */
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
  | {
      // Go to another page WITHOUT leaving the recording — the multi-page demo
      // in ONE take. Same tab, so the screencast never breaks; the activity
      // probe reinstalls itself on the new document, and the fonts/warm-up the
      // take's first page gets is repeated here (a mid-take page is as
      // cold-cache as the first one, and a FOUT mid-shot is just as visible).
      //
      // Emits NO beat: a navigation is a global change, and the editorial rule
      // is to show one full-view rather than punch into it. The camera stays at
      // rest across the seam by construction.
      //
      // The destination is LATE-BOUND, which is the point — a plan is authored
      // before the capture runs, so the second page's URL frequently does not
      // exist yet (a deploy's generated domain, a new record's permalink). Give
      // `hrefFrom` and the demo follows whatever the app actually linked to.
      // Precedence: hrefFrom > url > the current page. See nav.ts.
      action: "navigate";
      /** explicit destination — absolute, or relative to the current page */
      url?: string;
      /** read the destination off a link on the page instead (located the same
       *  way every other step locates: CSS `selector` or accessible `text`).
       *  Also the answer to a `target="_blank"` link: the screencast is bound
       *  to one page target and cannot follow a new tab, but it CAN go to the
       *  same href in the tab it is already recording. */
      hrefFrom?: { selector?: string; text?: string };
      /** params merged onto the resolved URL. The page links to the bare
       *  thing; the demo often needs it parameterised (`?speed=3` to fit a
       *  long animation in the shot) — which no click could ever produce. */
      query?: Record<string, string>;
      note?: string;
      settleMs?: number;
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
