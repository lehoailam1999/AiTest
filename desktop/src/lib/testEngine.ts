/**
 * R1 — map TestCase.type → automation engine (Unit | API | E2E).
 * Dùng cho chip Review, CTA deep-link, filter E2E Job.
 */

export type TestEngine = "unit" | "api" | "e2e";

/** Options form Sửa TC (value lưu DB qua type_vi / normalize). */
export const TC_TYPE_OPTIONS = [
  { value: "Unit", label: "Unit" },
  { value: "E2E", label: "E2E" },
  { value: "Api", label: "API" },
  { value: "Functional", label: "Chức năng" },
  { value: "Negative", label: "Phủ định" },
  { value: "Boundary", label: "Biên" },
] as const;

const E2E_KEYS = new Set([
  "e2e",
  "end-to-end",
  "end to end",
  "endtoend",
  "journey",
  "ui",
  "e2e test",
  "end-to-end test",
]);

const API_KEYS = new Set(["api", "apitest", "api test"]);

const UNIT_KEYS = new Set([
  "unit",
  "unittest",
  "unit test",
  "functional",
  "chức năng",
  "negative",
  "phủ định",
  "boundary",
  "biên",
]);

export function normalizeTypeKey(type?: string | null): string {
  return (type || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Engine chip cho một TC. Functional/Negative/Boundary → unit (mặc định Unit Job). */
export function resolveTestEngine(type?: string | null): TestEngine {
  const key = normalizeTypeKey(type);
  if (!key) return "unit";
  if (E2E_KEYS.has(key) || key.includes("e2e") || key.includes("journey")) {
    return "e2e";
  }
  if (API_KEYS.has(key) || key === "api") return "api";
  if (UNIT_KEYS.has(key) || key.includes("unit")) return "unit";
  // Vietnamese leftovers / unknown → unit (an toàn hơn mở Unit Job)
  return "unit";
}

export function isE2eTestCaseType(type?: string | null): boolean {
  return resolveTestEngine(type) === "e2e";
}

/** Unit Job / Generate Unit — chỉ TC engine=unit (không lấy E2E/API). */
export function isUnitTestCaseType(type?: string | null): boolean {
  return resolveTestEngine(type) === "unit";
}

export function engineLabel(engine: TestEngine): string {
  if (engine === "e2e") return "E2E";
  if (engine === "api") return "API";
  return "Unit";
}

export function engineTagColor(engine: TestEngine): string {
  if (engine === "e2e") return "purple";
  if (engine === "api") return "cyan";
  return "blue";
}

export const ENGINE_TOOLTIP =
  "Unit = 1 SUT/file · API = HTTP/handler · E2E = UI + Target URL (Playwright)";
