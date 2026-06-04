import { useCallback, useEffect, useState } from "react";
import { BridgeError, detectBridge, renderViaBridge, saveComposition } from "../lib/bridge";
import type { UseComposition } from "./useComposition";
import type { UsePreview } from "./usePreview";

export type ExportPhase = "idle" | "saving" | "rendering" | "done" | "error";
export type ExportState = { phase: ExportPhase; progress: number; message?: string };

const errMsg = (e: unknown): string => {
  if (e instanceof BridgeError && e.issues?.length) {
    const errs = e.issues.filter((i) => i.severity === "error").length;
    return errs ? `${e.message} — ${errs} error${errs > 1 ? "s" : ""}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

// Connects the editor to the local edit-server: auto-loads the take when served
// behind the bridge, and exposes Save / Export (real render) / Download.
export function useBridge(p: UsePreview, c: UseComposition) {
  const [bridge, setBridge] = useState(false);
  const [ex, setEx] = useState<ExportState>({ phase: "idle", progress: 0 });

  useEffect(() => {
    if (!p.engine) return;
    let cancelled = false;
    void (async () => {
      const take = await detectBridge();
      if (cancelled || !take) return;
      setBridge(true);
      await p.load(
        take.composition,
        take.videoUrl,
        { name: take.source.name, kind: "bridge" },
        take.captureLog ?? null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [p.engine]); // the engine is created exactly once

  const save = useCallback(async () => {
    if (!c.comp) return;
    setEx({ phase: "saving", progress: 0 });
    try {
      await saveComposition(c.comp);
      c.commitSaved();
      setEx({ phase: "done", progress: 1, message: "Saved" });
    } catch (e) {
      setEx({ phase: "error", progress: 0, message: errMsg(e) });
    }
  }, [c]);

  const exportNow = useCallback(async () => {
    if (!c.comp) return;
    setEx({ phase: "rendering", progress: 0 });
    try {
      await renderViaBridge(c.comp, (pr) => setEx({ phase: "rendering", progress: pr }));
      c.commitSaved();
      setEx({ phase: "done", progress: 1, message: "Exported" });
    } catch (e) {
      setEx({ phase: "error", progress: 0, message: errMsg(e) });
    }
  }, [c]);

  const downloadComposition = useCallback(() => {
    if (!c.comp) return;
    const blob = new Blob([JSON.stringify(c.comp, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "composition.json";
    a.click();
    URL.revokeObjectURL(url);
    setEx({ phase: "done", progress: 1, message: "Downloaded" });
  }, [c]);

  const busy = ex.phase === "rendering" || ex.phase === "saving";
  return { bridge, ex, busy, save, exportNow, downloadComposition };
}
