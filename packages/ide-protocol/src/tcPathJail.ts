/**
 * Path jail for Approved TC artifacts under `AItest/test-cases/`
 * (including `UnitTest/` and `E2ETest/` subfolders).
 * Allows `.md` and companion `.grounding.json` only.
 */

const PREFIX = "AItest/test-cases";
const LEGACY_PREFIX = ".ai-test/test-cases";

function normalizeAndValidate(targetRel: string): { path: string; low: string } {
  const path = (targetRel || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!path) {
    throw new Error("TC path jail: đường dẫn trống");
  }
  if (
    path.split("/").some((segment) => segment === ".." || segment === ".") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    throw new Error("TC path jail: không được chứa .. hoặc absolute drive");
  }
  const low = path.toLowerCase();
  const isMd = low.endsWith(".md");
  const isGrounding = low.endsWith(".grounding.json");
  if (!isMd && !isGrounding) {
    throw new Error(
      `TC path jail: chỉ cho phép .md hoặc .grounding.json (got ${path})`
    );
  }
  return { path, low };
}

export function assertSafeAiTestCasesRel(targetRel: string): string {
  const { path, low } = normalizeAndValidate(targetRel);
  if (!low.startsWith(`${PREFIX.toLowerCase()}/`)) {
    throw new Error(`TC path jail: chỉ ghi dưới ${PREFIX}/ (got ${path})`);
  }
  return path;
}

/** Read-only compatibility for repositories not yet re-synced to `AItest/test-cases`. */
export function assertSafeAiTestCasesReadRel(targetRel: string): string {
  const { path, low } = normalizeAndValidate(targetRel);
  const canonical = PREFIX.toLowerCase();
  const legacy = LEGACY_PREFIX.toLowerCase();
  if (!low.startsWith(`${canonical}/`) && !low.startsWith(`${legacy}/`)) {
    throw new Error(
      `TC path jail: chỉ đọc dưới ${PREFIX}/ hoặc ${LEGACY_PREFIX}/ (got ${path})`
    );
  }
  return path;
}

export const AI_TEST_CASES_DIR = PREFIX;
export const LEGACY_AI_TEST_CASES_DIR = LEGACY_PREFIX;
