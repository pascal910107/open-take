export type ConflictOperation = "save" | "export";

export type ConflictNotice = {
  mtime: number;
  operation: ConflictOperation;
};

export type OperationResult = "done" | "conflict" | "error";

/** Whether the choice itself is still unresolved. A keep-mine retry can fail
 *  after its guarded POST succeeded (for example the render stream drops), so
 *  an ordinary operation error must not resurrect the old write conflict. */
export function shouldKeepConflict(keep: "mine" | "theirs", result: OperationResult): boolean {
  return result === "conflict" || (keep === "theirs" && result === "error");
}

type ResolutionActions = {
  reload: () => Promise<boolean>;
  rebase: (mtime: number) => void;
  retrySave: () => Promise<OperationResult>;
  retryExport: () => Promise<OperationResult>;
};

/** Execute the user's explicit conflict choice. The operation that originally
 *  lost is retried directly, so a clean Export conflict does not depend on the
 *  autosave loop (which correctly does nothing when `dirty === false`). */
export async function resolveConflictAction(
  keep: "mine" | "theirs",
  conflict: ConflictNotice,
  actions: ResolutionActions,
): Promise<OperationResult> {
  if (keep === "theirs") return (await actions.reload()) ? "done" : "error";
  actions.rebase(conflict.mtime);
  return conflict.operation === "export" ? actions.retryExport() : actions.retrySave();
}
