/**
 * Path jail for Approved TC markdown under `.ai-test/test-cases/`.
 * Separate from AItest codegen jail.
 */
const PREFIX = ".ai-test/test-cases";
export function assertSafeAiTestCasesRel(targetRel) {
    const p = (targetRel || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
    if (!p) {
        throw new Error("TC path jail: đường dẫn trống");
    }
    if (p.split("/").some((s) => s === ".." || s === ".") || /^[a-zA-Z]:/.test(p)) {
        throw new Error("TC path jail: không được chứa .. hoặc absolute drive");
    }
    const low = p.toLowerCase();
    if (!low.startsWith(`${PREFIX}/`) && low !== PREFIX) {
        throw new Error(`TC path jail: chỉ ghi dưới ${PREFIX}/ (got ${p})`);
    }
    if (!low.endsWith(".md") && low !== PREFIX) {
        throw new Error(`TC path jail: chỉ cho phép file .md (got ${p})`);
    }
    return p;
}
export const AI_TEST_CASES_DIR = PREFIX;
