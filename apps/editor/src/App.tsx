// Editor v4 shell: top bar · stage + icon-rail layered inspector · timeline.
// Selection model: clicking a zoom block selects that beat → the engine shows
// the wide INSPECT frame with the draggable region box and the Zoom pane opens.
// Playing exits inspect. Everything edits live; Export renders the real mp4.
import { useCallback, useEffect, useRef, useState } from "react";
import { type PaneKey, Rail } from "./components/Rail";
import { Stage } from "./components/Stage";
import { Timeline } from "./components/Timeline";
import {
  AgentPane,
  BgPane,
  ClipPane,
  CursorPane,
  FramePane,
  MotionPane,
  ZoomPane,
} from "./components/panels";
import { useBridge } from "./hooks/useBridge";
import { useComposition } from "./hooks/useComposition";
import { type SeedFn, usePreview } from "./hooks/usePreview";
import {
  ConflictError,
  detectBridge,
  getBaseMtime,
  getCompositionMtime,
  saveComposition,
  setBaseMtime,
} from "./lib/bridge";
import type { TakeComposition } from "./lib/compositor";
import {
  type ConflictNotice,
  type OperationResult,
  resolveConflictAction,
  shouldKeepConflict,
} from "./lib/conflict";
import { setBeatZoom, setStart, stageInspects } from "./lib/edit";
import { IcCompare, IcExport, IcRedo, IcUndo } from "./ui/icons";

type SaveState = "clean" | "saving" | "saved" | "error" | "export-error" | "invalid" | "conflict";

export function App() {
  const seedRef = useRef<SeedFn | null>(null);
  const stableSeed = useCallback<SeedFn>((comp, log) => seedRef.current?.(comp, log), []);
  const p = usePreview(stableSeed);
  const c = useComposition(p.engine);
  useEffect(() => {
    seedRef.current = c.seed;
  }, [c.seed]);
  // Declared before useBridge so its stable callback can be the bridge's
  // conflict sink. Both autosave and export use the same resolution UI.
  const [conflict, setConflict] = useState<ConflictNotice | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const handleBridgeConflict = useCallback((next: ConflictNotice) => {
    setConflict(next);
    setSaveState("conflict");
  }, []);
  const b = useBridge(p, c, handleBridgeConflict);

  const [pane, setPane] = useState<PaneKey>("zoom");
  const [comparing, setComparing] = useState(false);
  const [pickingStart, setPickingStart] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const ready = p.status === "ready" && !!p.engine && !!c.derived;
  const sel = c.selectedBeat;
  // `comparing` suspends inspect so hold-to-compare shows the frame the ORIGIN
  // actually composes instead of the same rest frame twice — see stageInspects.
  const inspecting = stageInspects({ ready, selectedBeat: sel, playing: p.isPlaying, comparing });

  // inspect mode follows selection (and start-picking, whose inverse mapping
  // assumes the rest-centred frame); playing always exits it
  useEffect(() => {
    p.engine?.setInspectMode(inspecting || pickingStart);
  }, [p.engine, inspecting, pickingStart]);
  useEffect(() => {
    if (p.isPlaying && sel >= 0) c.selectBeat(-1);
  }, [p.isPlaying, sel, c.selectBeat]);

  const selectBeat = useCallback(
    (i: number) => {
      const comp = c.comp;
      const eng = p.engine;
      if (!comp || !eng) return;
      eng.pause();
      c.selectBeat(i);
      setPane("zoom");
      const e = comp.events[i];
      if (e) eng.seek(Math.min(e.tMs / 1000, eng.duration));
    },
    [c, p.engine],
  );

  const enableZoom = useCallback(
    (i: number) => {
      c.update((cc) => setBeatZoom(cc, i, { enabled: true }));
      selectBeat(i);
    },
    [c, selectBeat],
  );

  // Re-read the take from disk and adopt it wholesale (also re-bases the
  // conflict guard — detectBridge records the mtime it read).
  const reloadFromDisk = useCallback(async (): Promise<boolean> => {
    const take = await detectBridge();
    if (!take) return false;
    c.seed(take.composition, take.captureLog);
    return true;
  }, [c.seed]);

  const persistDraft = useCallback(
    async (comp: TakeComposition | null): Promise<OperationResult> => {
      if (!comp) {
        setSaveState("error");
        return "error";
      }
      setSaveState("saving");
      try {
        await saveComposition(comp);
        // Mark only the snapshot that actually reached disk as saved. If the
        // user edited during the request, the newer draft remains dirty.
        c.commitSaved(comp);
        setSaveState("saved");
        return "done";
      } catch (e) {
        if (e instanceof ConflictError) {
          setConflict({ mtime: e.mtime, operation: "save" });
          setSaveState("conflict");
          return "conflict";
        }
        setSaveState("error");
        return "error";
      }
    },
    [c.commitSaved],
  );

  // debounced autosave over the bridge (the v4 top bar promises "Saved
  // automatically"). Invalid edits show "Invalid settings" instead of silently
  // freezing the save; failures retry with a longer backoff (the effect re-runs
  // on saveState changes). A pending conflict parks the loop — retrying would
  // just 409 again, and the decision is the user's.
  useEffect(() => {
    if (!b.bridge || b.busy || !c.dirty || !c.comp || conflict || saveState === "saving") {
      return;
    }
    if (!c.canSave) {
      if (saveState !== "invalid") setSaveState("invalid");
      return;
    }
    const comp = c.comp;
    const h = setTimeout(
      () => {
        void persistDraft(comp);
      },
      saveState === "error" ? 3000 : 700,
    );
    return () => clearTimeout(h);
  }, [b.bridge, b.busy, c.comp, c.dirty, c.canSave, conflict, saveState, persistDraft]);

  // Notice AGENT edits on disk. Every round-trip re-bases the guard's mtime
  // (lib/bridge), so a mtime we didn't cause IS an outside write — no
  // just-saved timing window to get wrong any more. When we're clean we adopt
  // it silently; when the user has unsaved edits we leave it, because the save
  // that would have clobbered it now comes back 409 and asks.
  useEffect(() => {
    if (!b.bridge) return;
    const t = setInterval(async () => {
      const m = await getCompositionMtime();
      if (m == null) return;
      if (getBaseMtime() === undefined) {
        setBaseMtime(m);
        return;
      }
      if (m === getBaseMtime()) return;
      if (c.dirty || saveState === "saving" || b.busy || conflict) return;
      await reloadFromDisk();
    }, 2000);
    return () => clearInterval(t);
  }, [b.bridge, c.dirty, saveState, b.busy, conflict, reloadFromDisk]);

  // Keep mine / Take theirs — the whole point of the 409: the loser of a
  // dual-write is a person who gets asked, not an edit that vanishes.
  const exportCurrent = useCallback(async (): Promise<OperationResult> => {
    const result = await b.exportNow();
    if (result === "done") setSaveState("saved");
    else if (result === "error") setSaveState("export-error");
    return result;
  }, [b.exportNow]);

  const resolveConflict = useCallback(
    async (keep: "mine" | "theirs") => {
      const current = conflict;
      if (!current || resolvingConflict) return;
      setResolvingConflict(true);
      try {
        const result = await resolveConflictAction(keep, current, {
          reload: reloadFromDisk,
          rebase: setBaseMtime,
          retrySave: () => persistDraft(c.comp),
          retryExport: exportCurrent,
        });
        if (result === "done") {
          // A retry can itself discover a newer conflict. Only clear the
          // original notice, never one installed while the retry was running.
          setConflict((latest) => (latest === current ? null : latest));
          setSaveState("saved");
        } else if (result === "error") {
          if (!shouldKeepConflict(keep, result)) {
            // The guarded POST may already have succeeded before rendering or
            // its SSE stream failed. The old write conflict is resolved; leave
            // the operation error visible and let Export/autosave retry it.
            setConflict((latest) => (latest === current ? null : latest));
            setSaveState(current.operation === "export" ? "export-error" : "error");
          } else {
            // Reload failed, so adopting theirs did not happen. Keep asking.
            setSaveState("conflict");
          }
        }
      } finally {
        setResolvingConflict(false);
      }
    },
    [conflict, resolvingConflict, reloadFromDisk, persistDraft, c.comp, exportCurrent],
  );

  // hold-to-compare: a transient engine push of the SESSION ORIGIN (what this
  // editor loaded), never the last-saved comp — autosave commits ~700ms after
  // every edit, so "last saved" is the same thing you are already looking at.
  // React state is untouched, so autosave keeps writing the real draft while
  // the frame on screen shows the old one.
  const compare = useCallback(
    (on: boolean) => {
      const eng = p.engine;
      if (!eng || !c.comp) return;
      // Release ALWAYS restores the draft, even if the comparison stopped
      // being available mid-hold (an undo back to origin, a re-seed).
      if (on && (!c.origin || !c.changedFromOrigin)) return;
      setComparing(on);
      eng.setComposition(on && c.origin ? c.origin : c.comp);
    },
    [p.engine, c.origin, c.comp, c.changedFromOrigin],
  );

  // keyboard: space play/pause · ⌘Z/⇧⌘Z undo/redo · esc deselect
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // swallow shortcuts only in TEXT-entry fields — a focused range slider
      // (the common state right after a drag) must not eat ⌘Z/space
      const el = e.target as HTMLInputElement;
      if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "range")) return;
      if (e.key === " ") {
        e.preventDefault();
        p.engine?.toggle();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? c.redo() : c.undo();
      } else if (e.key === "Escape") {
        c.selectBeat(-1);
        setPickingStart(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.engine, c]);

  const pct = Math.round(b.ex.progress * 100);
  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Save failed, retrying…"
        : saveState === "export-error"
          ? "Export failed — try again"
          : saveState === "invalid"
            ? "Invalid settings — not saved"
            : saveState === "conflict"
              ? "Conflict — not saved"
              : "Saved automatically";

  return (
    <div className="app">
      <div className="top">
        <span className="name">{p.source?.name ?? "open-take"}</span>
        {ready && c.comp && (
          <span className="meta">
            {(c.comp.durationMs / 1000).toFixed(1)}s · {c.comp.output.width}×{c.comp.output.height}{" "}
            ·{" "}
            {b.bridge ? (
              <span
                className={
                  saveState === "error" ||
                  saveState === "export-error" ||
                  saveState === "invalid" ||
                  saveState === "conflict"
                    ? "err"
                    : "ok"
                }
              >
                {saveLabel}
              </span>
            ) : (
              "Local file"
            )}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="iconbtn"
          title="Undo (⌘Z)"
          disabled={!c.canUndo}
          onClick={c.undo}
        >
          <IcUndo />
        </button>
        <button
          type="button"
          className="iconbtn"
          title="Redo (⇧⌘Z)"
          disabled={!c.canRedo}
          onClick={c.redo}
        >
          <IcRedo />
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!ready || !c.changedFromOrigin}
          title={
            c.changedFromOrigin
              ? "Hold to compare against the version you opened"
              : "Nothing to compare yet — unchanged since you opened it"
          }
          onPointerDown={() => compare(true)}
          onPointerUp={() => compare(false)}
          onPointerCancel={() => compare(false)}
          onPointerLeave={() => comparing && compare(false)}
        >
          {/* while held, the stage itself shows the ORIGINAL badge (Stage.tsx) —
              the label stays put so the top bar never reflows mid-hold */}
          <IcCompare /> Compare
        </button>
        <button
          type="button"
          className="export"
          disabled={
            !ready || b.busy || saveState === "saving" || !!conflict || (b.bridge && !c.canSave)
          }
          title={
            conflict
              ? "Resolve the edit conflict first"
              : saveState === "saving"
                ? "Wait for the current save to finish"
                : b.bridge && !c.canSave
                  ? "Fix the invalid settings first"
                  : undefined
          }
          onClick={b.bridge ? () => void exportCurrent() : b.downloadComposition}
        >
          <IcExport />
          {b.ex.phase === "rendering" ? `${pct}%` : b.bridge ? "Export" : "Download JSON"}
        </button>
      </div>

      {conflict && (
        <div className="conflict">
          <span>
            The agent changed this take while you were editing. Which side do you want to keep?
            {c.dirty && <em>“Take theirs” discards the edits you haven't saved yet.</em>}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="ghost"
            disabled={resolvingConflict}
            onClick={() => void resolveConflict("theirs")}
          >
            Take theirs
          </button>
          <button
            type="button"
            className="export"
            disabled={resolvingConflict}
            onClick={() => void resolveConflict("mine")}
          >
            Keep mine
          </button>
        </div>
      )}

      <div className="main">
        <Stage
          canvasRef={p.canvasRef}
          videoRef={p.videoRef}
          c={c}
          inspecting={inspecting}
          comparing={comparing}
          pickingStart={pickingStart}
          onPickStart={(pt) => {
            c.update((cc) => setStart(cc, pt));
            setPickingStart(false);
          }}
          onDeselect={() => c.selectBeat(-1)}
        />
        <div className="side">
          <div className="panel">
            {pane === "zoom" && <ZoomPane c={c} />}
            {pane === "bg" && <BgPane c={c} />}
            {pane === "frame" && <FramePane c={c} />}
            {pane === "cursor" && <CursorPane c={c} />}
            {pane === "motion" && <MotionPane c={c} />}
            {pane === "clip" && (
              <ClipPane
                c={c}
                pickingStart={pickingStart}
                onArmPickStart={() => {
                  p.engine?.pause();
                  setPickingStart(true);
                }}
              />
            )}
            {pane === "agent" && <AgentPane bridge={b.bridge} />}
          </div>
          <Rail active={pane} onSelect={setPane} />
        </div>
      </div>

      {ready && p.engine && c.comp && c.derived && (
        <Timeline
          engine={p.engine}
          comp={c.comp}
          derived={c.derived}
          videoSrc={p.videoSrc}
          isPlaying={p.isPlaying}
          selectedBeat={sel}
          onSelectBeat={selectBeat}
          onEnableZoom={enableZoom}
        />
      )}

      {(p.status === "empty" || p.status === "loading" || p.status === "error") && (
        <div
          className="overlay"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) p.loadFiles(e.dataTransfer.files);
          }}
        >
          <div className="ocard">
            <h1>open-take editor</h1>
            <p>
              Open a take and adjust every zoom, the background and the pace right on the frame — it
              all previews live, and only Export renders.
            </p>
            <div className="cta">
              <button type="button" className="export" onClick={p.loadSample}>
                {p.status === "loading" ? "Loading…" : "Load a sample take"}
              </button>
              <button type="button" className="ghost" onClick={() => fileInput.current?.click()}>
                Open files…
              </button>
            </div>
            <p className="hintline">
              or drop a <code>composition.json</code> + <code>capture.mp4</code> here
            </p>
            {p.error && <p className="err">{p.error}</p>}
            <input
              ref={fileInput}
              type="file"
              accept=".json,video/*,.mp4,.webm,.mov"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) p.loadFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
