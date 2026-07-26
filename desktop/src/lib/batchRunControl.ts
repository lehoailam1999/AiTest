/**
 * Cooperative pause/resume for sequential batch runs (TC fan-out, module code gen, gap-fill).
 * Pause waits *between* items — the current item always finishes first.
 */

export type BatchRunStatus = "idle" | "running" | "paused";

export type BatchRunControl = {
  /** Current status (sync read). */
  getStatus: () => BatchRunStatus;
  /** Mark batch as running (call at start). */
  start: () => void;
  /** Request pause after the current item completes. */
  pause: () => void;
  /** Resume a paused batch. */
  resume: () => void;
  /** Reset to idle (call when batch ends or is abandoned). */
  reset: () => void;
  /**
   * Await at the start of each loop iteration.
   * Resolves immediately if not paused; otherwise waits until resume/reset.
   */
  waitIfPaused: () => Promise<void>;
  /** Subscribe to status changes (for React UI). Returns unsubscribe. */
  subscribe: (listener: (status: BatchRunStatus) => void) => () => void;
};

export function createBatchRunControl(): BatchRunControl {
  let status: BatchRunStatus = "idle";
  let waiters: Array<() => void> = [];
  const listeners = new Set<(status: BatchRunStatus) => void>();

  function setStatus(next: BatchRunStatus) {
    if (status === next) return;
    status = next;
    for (const fn of listeners) fn(status);
  }

  function flushWaiters() {
    const q = waiters;
    waiters = [];
    for (const resolve of q) resolve();
  }

  return {
    getStatus: () => status,
    start: () => {
      setStatus("running");
    },
    pause: () => {
      if (status === "running") setStatus("paused");
    },
    resume: () => {
      if (status === "paused") {
        setStatus("running");
        flushWaiters();
      }
    },
    reset: () => {
      setStatus("idle");
      flushWaiters();
    },
    waitIfPaused: () => {
      if (status !== "paused") return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(status);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
