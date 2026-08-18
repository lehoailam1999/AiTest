/**
 * Approved TC → `AItest/test-cases/*.md` (+ `.grounding.json`) sync (Phase C).
 */
export type TcSyncApprovedMdParams = {
    commandId: string;
    projectId: string;
    projectRoot: string;
    /** Relative paths under `AItest/test-cases/` + markdown/json content */
    files: Array<{
        path: string;
        content: string;
    }>;
    /** Explicit deletions (tombstones); legacy `.ai-test/test-cases/` is read/delete-only. */
    deletePaths?: string[];
};
export type TcSyncFileStatus = "CREATED" | "UPDATED" | "DELETED" | "SKIPPED" | "REJECTED_JAIL" | "ERROR";
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
