import { jobs } from "../api";

const JOB_ACTIVE = new Set(["Queued", "PendingWorker", "Running", "Pending"]);

/** Default 10 phút — TC fan-out / Ollama thường > 2 phút. */
export async function waitForJob(jobId: string, maxMs = 600_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const job = await jobs.get(jobId);
    if (job.status === "Completed" || job.status === "Failed") return job;
    if (!JOB_ACTIVE.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    "UI hết thời gian chờ job (job có thể vẫn Running trên server) — mở tab Công việc AI xem Completed/Failed."
  );
}
