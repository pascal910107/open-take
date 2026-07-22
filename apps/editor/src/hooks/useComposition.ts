// useComposition — the single owner of the EDITABLE composition. React holds
// the draft; the engine is a downstream consumer it pushes into. (Milestone 1
// had it backwards: the comp lived in the engine and the UI read it back via
// derived.comp. 2a flips that so a property panel can drive edits.)
//
// The live-edit loop is: a control calls update(setter) → we compute the next
// immutable comp via lib/edit setters → engine.setComposition(next) draws it on
// the SAME tick (independent of React) → setComp(next) re-renders the panel.
// Validation runs continuously (the Save/Export gate). Undo/redo is a snapshot
// stack; rapid scrubber drags coalesce into one entry via a coalesceKey.

import { useCallback, useMemo, useRef, useState } from "react";
import type { PreviewEngine } from "../engine/preview";
import {
  type CaptureLog,
  type CompositionIssue,
  type TakeComposition,
  validateComposition,
} from "../lib/compositor";
import { type Derived, derive } from "../lib/derive";

export type CompSetter = (c: TakeComposition) => TakeComposition;

export type UseComposition = {
  comp: TakeComposition | null;
  derived: Derived | null;
  captureLog: CaptureLog | null;
  issues: CompositionIssue[];
  errors: CompositionIssue[];
  warns: CompositionIssue[];
  canSave: boolean;
  dirty: boolean;
  /** the last-saved comp — for transient hold-to-compare previews */
  baseline: TakeComposition | null;
  selectedBeat: number;
  /** load a fresh take (resets baseline + history); pushes it to the engine. */
  seed: (comp: TakeComposition, captureLog?: CaptureLog | null) => void;
  /** apply an editable mutation; coalesceKey merges consecutive edits (a drag). */
  update: (setter: CompSetter, coalesceKey?: string) => void;
  /** mark the start of a gesture so the next coalesced edit opens a fresh undo
   *  entry (call on pointer-down / focus of a scrubber/slider/picker). */
  beginGesture: () => void;
  selectBeat: (i: number) => void;
  reset: () => void;
  /** mark the current (or given) comp as saved — clears dirty. */
  commitSaved: (comp?: TakeComposition) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

export function useComposition(engine: PreviewEngine | null): UseComposition {
  const [comp, setComp] = useState<TakeComposition | null>(null);
  const [baseline, setBaseline] = useState<TakeComposition | null>(null);
  const [captureLog, setCaptureLog] = useState<CaptureLog | null>(null);
  const [selectedBeat, setSelectedBeat] = useState(-1);

  // refs mirror the latest values so rapid (rAF-rate) updates chain without
  // stale closures, and so we never run side effects inside a setState updater.
  const compRef = useRef<TakeComposition | null>(null);
  const past = useRef<TakeComposition[]>([]);
  const future = useRef<TakeComposition[]>([]);
  const lastKey = useRef<string | null>(null);
  const [, bumpHist] = useState(0); // force re-eval of canUndo/canRedo from refs

  const push = useCallback(
    (next: TakeComposition) => {
      compRef.current = next;
      engine?.setComposition(next);
      setComp(next);
    },
    [engine],
  );

  const seed = useCallback(
    (c: TakeComposition, log: CaptureLog | null = null) => {
      past.current = [];
      future.current = [];
      lastKey.current = null;
      setBaseline(c);
      setCaptureLog(log);
      setSelectedBeat(-1);
      push(c);
      bumpHist((v) => v + 1);
    },
    [push],
  );

  const update = useCallback(
    (setter: CompSetter, coalesceKey?: string) => {
      const cur = compRef.current;
      if (!cur) return;
      const next = setter(cur);
      if (next === cur) return;
      const coalesce = coalesceKey != null && coalesceKey === lastKey.current;
      if (!coalesce) {
        past.current.push(cur);
        future.current = [];
      }
      lastKey.current = coalesceKey ?? null;
      push(next);
      bumpHist((v) => v + 1);
    },
    [push],
  );

  const undo = useCallback(() => {
    const cur = compRef.current;
    if (!cur || past.current.length === 0) return;
    const prev = past.current.pop()!;
    future.current.push(cur);
    lastKey.current = null;
    push(prev);
    bumpHist((v) => v + 1);
  }, [push]);

  const redo = useCallback(() => {
    const cur = compRef.current;
    if (!cur || future.current.length === 0) return;
    const next = future.current.pop()!;
    past.current.push(cur);
    lastKey.current = null;
    push(next);
    bumpHist((v) => v + 1);
  }, [push]);

  const reset = useCallback(() => {
    if (!baseline) return;
    past.current = [];
    future.current = [];
    lastKey.current = null;
    push(baseline);
    bumpHist((v) => v + 1);
  }, [baseline, push]);

  const commitSaved = useCallback((c?: TakeComposition) => {
    setBaseline(c ?? compRef.current);
  }, []);

  const beginGesture = useCallback(() => {
    lastKey.current = null;
  }, []);

  const selectBeat = useCallback((i: number) => setSelectedBeat(i), []);

  const derived = useMemo<Derived | null>(() => (comp ? derive(comp) : null), [comp]);
  const issues = useMemo<CompositionIssue[]>(
    () => (comp ? validateComposition(comp, captureLog ? { captureLog } : {}) : []),
    [comp, captureLog],
  );
  const errors = useMemo(() => issues.filter((i) => i.severity === "error"), [issues]);
  const warns = useMemo(() => issues.filter((i) => i.severity === "warn"), [issues]);

  return {
    comp,
    derived,
    captureLog,
    issues,
    errors,
    warns,
    canSave: comp != null && errors.length === 0,
    dirty: comp != null && comp !== baseline,
    baseline,
    selectedBeat,
    seed,
    update,
    beginGesture,
    selectBeat,
    reset,
    commitSaved,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
