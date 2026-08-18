/** Sprint 0 — paths under SUT project root (same tree as Code Index `.ai-test/`). */

export const PROFILE_SCHEMA = "aitest-project-profile-v1" as const;

export const AI_TEST_DIR = ".ai-test";

export const PROFILE_REL_PATH = ".ai-test/project.profile.json";
export const E2E_CONVENTIONS_REL = ".ai-test/e2e-conventions.md";
export const UNIT_CONVENTIONS_REL = ".ai-test/unit-conventions.md";
export const TEST_CASES_DIR = "AItest/test-cases";

export const DEFAULT_TEST_ROOT = "AItest/E2ETest";
export const DEFAULT_CANONICAL_STORAGE = "./fixtures/storageState.json";
export const DEFAULT_SHARED_STORAGE = "AItest/E2ETest/_shared/fixtures/storageState.json";

export const PROFILE_DISCOVER_DIRS = [
  ".ai-test/auth",
  "AItest/E2ETest/_shared/fixtures",
] as const;

export const PLAYWRIGHT_CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
] as const;
