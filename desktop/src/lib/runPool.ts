/**
 * Run async workers over a list with bounded concurrency.
 * Optional waitGate (e.g. pause) runs before claiming each next index.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  opts?: {
    waitGate?: () => Promise<void>;
    shouldStop?: () => boolean;
  }
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  async function slot(): Promise<void> {
    for (;;) {
      if (opts?.shouldStop?.()) return;
      if (opts?.waitGate) await opts.waitGate();
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => slot()));
}

/** Simple async mutex for shared merge / UI bookkeeping in parallel batches. */
export function createAsyncMutex() {
  let tail: Promise<void> = Promise.resolve();
  return {
    async run<T>(fn: () => Promise<T> | T): Promise<T> {
      const prev = tail;
      let release!: () => void;
      tail = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
