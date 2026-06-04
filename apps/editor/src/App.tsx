import { useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Inspector } from "./components/Inspector";
import { Timeline } from "./components/Timeline";
import { Transport } from "./components/Transport";
import { Viewer } from "./components/Viewer";
import { useBridge } from "./hooks/useBridge";
import { useComposition } from "./hooks/useComposition";
import { type SeedFn, usePreview } from "./hooks/usePreview";

export function App() {
  // The composition lives in useComposition, but its `seed` needs the engine,
  // which usePreview creates after first render. A stable wrapper over a ref
  // breaks the cycle: usePreview calls stableSeed during a load; the real seed
  // is wired in once useComposition has run.
  const seedRef = useRef<SeedFn | null>(null);
  const stableSeed = useCallback<SeedFn>((comp, log) => seedRef.current?.(comp, log), []);
  const p = usePreview(stableSeed);
  const c = useComposition(p.engine);
  useEffect(() => {
    seedRef.current = c.seed;
  }, [c.seed]);
  const b = useBridge(p, c);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const ready = p.status === "ready" && p.engine && c.derived;
  const pct = Math.round(b.ex.progress * 100);

  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app" data-status={p.status}>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        engine={p.engine}
        c={c}
        b={b}
        p={p}
        ready={!!ready}
        onOpenFiles={() => fileInput.current?.click()}
      />
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">◐</span>
          <span className="brand__name">
            open<span className="brand__dot">·</span>take
          </span>
          <span className="brand__sub">cinematic editor</span>
        </div>
        <div className="topbar__meta">
          {p.source && <span className="src-chip">{p.source.name}</span>}
          {ready && c.dirty && <span className="dirty-dot" title="unsaved edits" />}
        </div>
        <div className="topbar__actions">
          <button
            type="button"
            className="kbd"
            title="Command menu (⌘K)"
            onClick={() => setPaletteOpen(true)}
          >
            ⌘K
          </button>
          {ready && b.ex.phase === "done" && (
            <span className="export-status is-ok">{b.ex.message} ✓</span>
          )}
          {ready && b.ex.phase === "error" && (
            <span className="export-status is-err" title={b.ex.message}>
              {b.ex.message}
            </span>
          )}
          {!b.bridge && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => fileInput.current?.click()}
            >
              Open…
            </button>
          )}
          {!ready && !b.bridge && (
            <button type="button" className="btn" onClick={p.loadSample}>
              Load sample
            </button>
          )}
          {ready && b.bridge && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={b.save}
              disabled={!c.dirty || b.busy}
            >
              Save
            </button>
          )}
          {ready && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={b.busy || (b.bridge && !c.canSave)}
              title={b.bridge && !c.canSave ? "fix the validation errors first" : undefined}
              onClick={b.bridge ? b.exportNow : b.downloadComposition}
            >
              {b.ex.phase === "rendering"
                ? `Rendering ${pct}%`
                : b.bridge
                  ? "Export"
                  : "Download JSON"}
            </button>
          )}
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
      </header>

      <main className="stage-row">
        <Viewer
          canvasRef={p.canvasRef}
          videoRef={p.videoRef}
          status={p.status}
          onDropFiles={p.loadFiles}
        />
        {ready ? (
          <Inspector engine={p.engine!} c={c} currentBeat={p.currentBeat} />
        ) : (
          <aside className="panel panel--idle">
            <div className="panel__label">inspector</div>
            <p className="muted">Load a take to inspect its beats, framing, and validation.</p>
          </aside>
        )}
      </main>

      <footer className="dock">
        {ready ? (
          <>
            <Transport engine={p.engine!} derived={c.derived!} isPlaying={p.isPlaying} />
            <Timeline
              engine={p.engine!}
              derived={c.derived!}
              currentBeat={p.currentBeat}
              selectedBeat={c.selectedBeat}
              onSelectBeat={c.selectBeat}
            />
          </>
        ) : (
          <div className="dock__idle">read-only preview · drag the playhead to scrub</div>
        )}
      </footer>

      {(p.status === "empty" || p.status === "loading" || p.status === "error") && (
        <div
          className="overlay"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) p.loadFiles(e.dataTransfer.files);
          }}
        >
          <div className="overlay__card">
            <span className="overlay__mark">◐</span>
            <h1>Refine the cinematic layer</h1>
            <p>
              A live, scrubbable preview of a take — the same transform revideo exports, drawn in
              the browser over the capture. Nothing here re-records your app.
            </p>
            <div className="overlay__cta">
              <button type="button" className="btn btn--primary btn--lg" onClick={p.loadSample}>
                {p.status === "loading" ? "Loading…" : "Load the sample take"}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--lg"
                onClick={() => fileInput.current?.click()}
              >
                Open files…
              </button>
            </div>
            <p className="overlay__hint">
              or drop <code>composition.json</code> + <code>capture.mp4</code> anywhere
            </p>
            {p.error && <p className="overlay__error">{p.error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
