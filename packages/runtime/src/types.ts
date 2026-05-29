// The take plan — the agent's IR. The agent emits this from one NL
// request ("make a demo of X"); the human talks to refine it. Kept thin:
// the planning intelligence lives in the agent, not here.

// A click targets an element by CSS `selector` or by accessible-name
// `text` (how an agent naturally thinks — robust on real apps where CSS
// hooks are unstable). Exactly one of selector/text.
export type TakeStep =
  | { action: "click"; selector?: string; text?: string; note?: string; settleMs?: number }
  | { action: "wait"; ms: number };

export type TakePlan = {
  /** the running app under test (real app, or a served fixture) */
  url: string;
  viewport?: { width: number; height: number };
  /** where the synthetic cursor starts (viewport px) */
  startCursor?: { x: number; y: number };
  steps: TakeStep[];
};
