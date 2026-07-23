import { useCallback, useEffect, useState } from "react";
import {
  BridgeError,
  ConflictError,
  detectBridge,
  renderViaBridge,
  saveComposition,
} from "../lib/bridge";
import type { ConflictNotice, ConflictOperation, OperationResult } from "../lib/conflict";
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
//
// `onConflict` fires when the server refuses a write because the agent changed
// composition.json underneath us. Pass a stable setter — the App owns the
// resolution UI, since both this hook and the autosave loop can hit it.
export function useBridge(
  p: UsePreview,
  c: UseComposition,
  onConflict?: (conflict: ConflictNotice) => void,
) {
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
  }, [p.engine, p.load]); // the engine is created exactly once

  // A conflict isn't a failure of the export — nothing was written and the
  // user is about to be asked what to do — so drop back to idle rather than
  // parking a red error under the button.
  const handled = useCallback(
    (e: unknown, operation: ConflictOperation): boolean => {
      if (!(e instanceof ConflictError)) return false;
      onConflict?.({ mtime: e.mtime, operation });
      setEx({ phase: "idle", progress: 0 });
      return true;
    },
    [onConflict],
  );

  const save = useCallback(async (): Promise<OperationResult> => {
    const comp = c.comp;
    if (!comp) return "error";
    setEx({ phase: "saving", progress: 0 });
    try {
      await saveComposition(comp);
      c.commitSaved(comp);
      setEx({ phase: "done", progress: 1, message: "Saved" });
      return "done";
    } catch (e) {
      if (handled(e, "save")) return "conflict";
      setEx({ phase: "error", progress: 0, message: errMsg(e) });
      return "error";
    }
  }, [c, handled]);

  const exportNow = useCallback(async (): Promise<OperationResult> => {
    const comp = c.comp;
    if (!comp) return "error";
    setEx({ phase: "rendering", progress: 0 });
    try {
      await renderViaBridge(comp, (pr) => setEx({ phase: "rendering", progress: pr }));
      // Commit exactly what was sent. Edits made while rendering stay dirty and
      // are autosaved after `busy` drops instead of being mislabeled as saved.
      c.commitSaved(comp);
      setEx({ phase: "done", progress: 1, message: "Exported" });
      return "done";
    } catch (e) {
      if (handled(e, "export")) return "conflict";
      setEx({ phase: "error", progress: 0, message: errMsg(e) });
      return "error";
    }
  }, [c, handled]);

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
