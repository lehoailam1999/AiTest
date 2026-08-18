/**
 * Path jail for Approved TC artifacts under `AItest/test-cases/`
 * (including `UnitTest/` and `E2ETest/` subfolders).
 * Allows `.md` and companion `.grounding.json` only.
 */
export declare function assertSafeAiTestCasesRel(targetRel: string): string;
/** Read-only compatibility for repositories not yet re-synced to `AItest/test-cases`. */
export declare function assertSafeAiTestCasesReadRel(targetRel: string): string;
export declare const AI_TEST_CASES_DIR = "AItest/test-cases";
export declare const LEGACY_AI_TEST_CASES_DIR = ".ai-test/test-cases";
