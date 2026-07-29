/**
 * Parse BE job progressMessage from TC fan-out and update Hub queue rows.
 * Expected shapes (jobs.py):
 *   Module 2/5: Foo — đang gọi AI CLI…
 *   Module 2/5: Foo — xong (+3 TC)
 *   Module 2/5: Foo — lỗi: …
 */

export type FanOutQueueStatus = "pending" | "running" | "done" | "error";

export type FanOutQueueItem = {
  title: string;
  status: FanOutQueueStatus;
};

const MODULE_PROGRESS_RE =
  /^Module\s+(\d+)\s*\/\s*(\d+)\s*:\s*(.+?)\s*—\s*(.+)$/i;

function normTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function findQueueIndex(queue: FanOutQueueItem[], title: string): number {
  const n = normTitle(title);
  let idx = queue.findIndex((r) => normTitle(r.title) === n);
  if (idx >= 0) return idx;
  idx = queue.findIndex(
    (r) => normTitle(r.title).includes(n) || n.includes(normTitle(r.title))
  );
  return idx;
}

export function applyFanOutProgressToQueue(
  prev: FanOutQueueItem[] | null,
  message: string
): FanOutQueueItem[] | null {
  if (!prev?.length) return prev;
  const msg = (message || "").trim();
  if (!msg) return prev;

  const m = MODULE_PROGRESS_RE.exec(msg);
  if (!m) {
    if (/fan-out xong/i.test(msg)) {
      return prev.map((row) =>
        row.status === "error" ? row : { ...row, status: "done" as const }
      );
    }
    return prev;
  }

  const title = m[3].trim();
  const tail = m[4].trim().toLowerCase();
  const idx = findQueueIndex(prev, title);
  if (idx < 0) return prev;

  let status: FanOutQueueStatus = "running";
  if (tail.startsWith("xong") || tail.startsWith("done")) status = "done";
  else if (tail.startsWith("lỗi") || tail.startsWith("loi") || tail.startsWith("error"))
    status = "error";

  return prev.map((row, i) => {
    if (i === idx) return { ...row, status };
    // Keep prior done/error; leave other pending/running as-is (parallel fan-out)
    return row;
  });
}
