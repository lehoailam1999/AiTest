/**
 * Approved TC → `.ai-test/test-cases/*.md` sync (Phase C).
 */

export type TcSyncApprovedMdParams = {
  commandId: string;
  projectId: string;
  projectRoot: string;
  /** Relative paths under `.ai-test/test-cases/` + markdown content */
  files: Array<{ path: string; content: string }>;
};

export type TcSyncFileStatus = "CREATED" | "UPDATED" | "SKIPPED" | "REJECTED_JAIL" | "ERROR";

export type TcSyncFileMeta = {
  path: string;
  status: TcSyncFileStatus;
  error?: string;
  size?: number;
};

export type TcSyncApprovedMdResult = {
  commandId: string;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  files: TcSyncFileMeta[];
  testCasesDir: string;
};
