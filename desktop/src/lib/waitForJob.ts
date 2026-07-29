import { jobs } from "../api";
import type { Job } from "../api/types";

const JOB_ACTIVE = new Set(["Queued", "PendingWorker", "Running", "Pending"]);

type WaitOpts = {
  maxMs?: number;
  onProgress?: (message: string, job: Job) => void;
  onLog?: (lines: string[], job: Job) => void;
};

/** Default 15 phút — TC fan-out / Cursor CLI thường > 2 phút. */
export async function waitForJob(
  jobId: string,
  maxMsOrOpts: number | WaitOpts = 900_000
) {
  const opts: WaitOpts =
    typeof maxMsOrOpts === "number" ? { maxMs: maxMsOrOpts } : maxMsOrOpts ?? {};
  const maxMs = opts.maxMs ?? 900_000;
  const start = Date.now();
  let lastProgress = "";
  let lastLogLen = 0;
  while (Date.now() - start < maxMs) {
    const job = await jobs.get(jobId);
    const progress = (job.progressMessage || "").trim();
    if (progress && progress !== lastProgress) {
      lastProgress = progress;
      opts.onProgress?.(progress, job);
    }
    const log = job.progressLog ?? [];
    if (log.length !== lastLogLen) {
      lastLogLen = log.length;
      opts.onLog?.(log, job);
    }
    if (job.status === "Completed" || job.status === "Failed") {
      if (log.length) opts.onLog?.(log, job);
      return job;
    }
    if (!JOB_ACTIVE.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(
    "UI hết thời gian chờ job (job có thể vẫn Running trên server) — mở tab Công việc AI xem Completed/Failed."
  );
}
