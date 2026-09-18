let renderQueue: Promise<unknown> = Promise.resolve();

/** Revideo changes process.cwd(), so all compositor renders share one lock. */
export function withRenderLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(operation, operation);
  renderQueue = run.catch(() => {});
  return run;
}
