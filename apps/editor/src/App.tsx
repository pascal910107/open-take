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
import { getCompositionMtime, saveComposition } from "./lib/bridge";
import { setBeatZoom, setStart } from "./lib/edit";
import { IcCompare, IcExport, IcRedo, IcUndo } from "./ui/icons";

type SaveState = "clean" | "saving" | "saved" | "error" | "invalid";

export function App() {
  const seedRef = useRef<SeedFn | null>(null);
  const stableSeed = useCallback<SeedFn>((comp, log) => seedRef.current?.(comp, log), []);
  const p = usePreview(stableSeed);
  const c = useComposition(p.engine);
  useEffect(() => {
    seedRef.current = c.seed;
  }, [c.seed]);
  const b = useBridge(p, c);

  const [pane, setPane] = useState<PaneKey>("zoom");
  const [comparing, setComparing] = useState(false);
  const [pickingStart, setPickingStart] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("clean");
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
  }, [p.isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // debounced autosave over the bridge (the v4 top bar promises 已自動儲存).
  // Invalid edits show 設定無效 instead of silently freezing the save; failures
  // retry with a longer backoff (the effect re-runs on saveState changes).
  const lastSaveAt = useRef(0);
  const mtimeRef = useRef<number | null>(null);
  useEffect(() => {
    if (!b.bridge || !c.dirty || !c.comp) return;
    if (!c.canSave) {
      setSaveState("invalid");
      return;
    }
    setSaveState("saving");
    const comp = c.comp;
    const h = setTimeout(
      () => {
        saveComposition(comp)
          .then(async () => {
            lastSaveAt.current = Date.now();
            const m = await getCompositionMtime();
            if (m != null) mtimeRef.current = m; // our own write, absorbed here
            c.commitSaved(comp);
            setSaveState("saved");
          })
          .catch(() => setSaveState("error"));
      },
      saveState === "error" ? 3000 : 700,
    );
    return () => clearTimeout(h);
  }, [b.bridge, c.comp, c.dirty, c.canSave, saveState === "error"]); // eslint-disable-line react-hooks/exhaustive-deps

  // notice AGENT edits on disk. Our own writes are absorbed at save/export
  // time, so any OTHER mtime move is external. While the guards (dirty /
  // saving / busy / just-saved) suppress pickup we leave mtimeRef stale — the
  // change stays pending and is retried once quiet, instead of being silently
  // swallowed. Known limit (recorded): an agent write landing while the user
  // is mid-edit can still lose to the next autosave (last-writer-wins).
  useEffect(() => {
    if (!b.bridge) return;
    const t = setInterval(async () => {
      const m = await getCompositionMtime();
      if (m == null) return;
      if (mtimeRef.current == null) {
        mtimeRef.current = m;
        return;
      }
      if (m === mtimeRef.current) return;
      const suppressed =
        Date.now() - lastSaveAt.current < 3000 || c.dirty || saveState === "saving" || b.busy;
      if (suppressed) return; // keep pending — retried next tick
      mtimeRef.current = m;
      const r = await fetch("/api/take").catch(() => null);
      if (!r?.ok) return;
      const take = (await r.json()) as {
        composition: Parameters<typeof c.seed>[0];
        captureLog: Parameters<typeof c.seed>[1];
      };
      c.seed(take.composition, take.captureLog);
    }, 2000);
    return () => clearInterval(t);
  }, [b.bridge, c.dirty, saveState, b.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // Export persists composition.json server-side — absorb that write so the
  // poll doesn't mistake our own render for an agent edit (which would wipe
  // the undo stack on every export).
  const exportNow = useCallback(async () => {
    lastSaveAt.current = Date.now();
    await b.exportNow();
    lastSaveAt.current = Date.now();
    const m = await getCompositionMtime();
    if (m != null) mtimeRef.current = m;
  }, [b.exportNow]); // eslint-disable-line react-hooks/exhaustive-deps

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
        : saveState === "invalid"
          ? "設定無效 — 未儲存"
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
              <span className={saveState === "error" || saveState === "invalid" ? "err" : "ok"}>
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
          disabled={!ready || b.busy || (b.bridge && !c.canSave)}
          title={b.bridge && !c.canSave ? "先修正無效的設定" : undefined}
          onClick={b.bridge ? exportNow : b.downloadComposition}
        >
          <IcExport />
          {b.ex.phase === "rendering" ? `${pct}%` : b.bridge ? "Export" : "下載 JSON"}
        </button>
      </div>

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
