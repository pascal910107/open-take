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
import { setBeatZoom, setStart } from "./lib/edit";
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
  const inspecting = ready && sel >= 0 && !p.isPlaying;

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

  // debounced autosave over the bridge (the v4 top bar promises 已自動儲存).
  // Invalid edits show 設定無效 instead of silently freezing the save; failures
  // retry with a longer backoff (the effect re-runs on saveState changes). A
  // pending conflict parks the loop — retrying would just 409 again, and the
  // decision is the user's.
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

  // 保留我的 / 採用對方 — the whole point of the 409: the loser of a
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

  // hold-to-compare: transient engine push of the last-saved baseline
  const compare = useCallback(
    (on: boolean) => {
      const eng = p.engine;
      if (!eng || !c.baseline || !c.comp) return;
      setComparing(on);
      eng.setComposition(on ? c.baseline : c.comp);
    },
    [p.engine, c.baseline, c.comp],
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
      ? "儲存中…"
      : saveState === "error"
        ? "儲存失敗，重試中…"
        : saveState === "export-error"
          ? "Export 失敗 — 請重試"
          : saveState === "invalid"
            ? "設定無效 — 未儲存"
            : saveState === "conflict"
              ? "有衝突 — 未儲存"
              : "已自動儲存";

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
              "本機檔案"
            )}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="iconbtn"
          title="復原 (⌘Z)"
          disabled={!c.canUndo}
          onClick={c.undo}
        >
          <IcUndo />
        </button>
        <button
          type="button"
          className="iconbtn"
          title="重做 (⇧⌘Z)"
          disabled={!c.canRedo}
          onClick={c.redo}
        >
          <IcRedo />
        </button>
        <button
          type="button"
          className="ghost"
          title="按住可對比上次儲存的版本"
          onPointerDown={() => compare(true)}
          onPointerUp={() => compare(false)}
          onPointerLeave={() => comparing && compare(false)}
        >
          <IcCompare /> 對比原版
        </button>
        <button
          type="button"
          className="export"
          disabled={
            !ready || b.busy || saveState === "saving" || !!conflict || (b.bridge && !c.canSave)
          }
          title={
            conflict
              ? "請先處理編輯衝突"
              : saveState === "saving"
                ? "請等待目前的儲存完成"
                : b.bridge && !c.canSave
                  ? "先修正無效的設定"
                  : undefined
          }
          onClick={b.bridge ? () => void exportCurrent() : b.downloadComposition}
        >
          <IcExport />
          {b.ex.phase === "rendering" ? `${pct}%` : b.bridge ? "Export" : "下載 JSON"}
        </button>
      </div>

      {conflict && (
        <div className="conflict">
          <span>
            Agent 在你編輯的同時改了這個 take。要保留哪一邊？
            {c.dirty && <em>「採用對方」會丟掉你目前未儲存的修改。</em>}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="ghost"
            disabled={resolvingConflict}
            onClick={() => void resolveConflict("theirs")}
          >
            採用對方
          </button>
          <button
            type="button"
            className="export"
            disabled={resolvingConflict}
            onClick={() => void resolveConflict("mine")}
          >
            保留我的
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
              打開一個 take，直接在畫面上調整每一段 Zoom、背景與節奏 — 全部即時預覽，Export
              才真正輸出。
            </p>
            <div className="cta">
              <button type="button" className="export" onClick={p.loadSample}>
                {p.status === "loading" ? "載入中…" : "載入範例 take"}
              </button>
              <button type="button" className="ghost" onClick={() => fileInput.current?.click()}>
                開啟檔案…
              </button>
            </div>
            <p className="hintline">
              或把 <code>composition.json</code> + <code>capture.mp4</code> 拖進來
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
