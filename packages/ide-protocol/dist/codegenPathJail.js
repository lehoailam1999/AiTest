/**
 * Shared path jail + E2E env allowlist for Extension Apply/Run.
 * Mirrors desktop/src/lib/testOutputLayout.assertSafeAitestTargetRel.
 */
const AITEST_ROOT = "AItest";
const FORBIDDEN_UNDER_AITEST = new Set([
    "src",
    "app",
    "lib",
    "libs",
    "clientapp",
    "serverapp",
    "webapp",
    "wwwroot",
    "node_modules",
    "dist",
    "build",
    "bin",
    "obj",
]);
const ALLOWED_E2E_ENV_EXACT = new Set([
    "E2E_BASE_URL",
    "E2E_STORAGE_STATE",
    "E2E_USERNAME",
    "E2E_PASSWORD",
    "E2E_LOGIN_PATH",
    "E2E_ROLE",
    "E2E_AUTH_ROLE",
    "E2E_FEATURE_PATH",
    "E2E_AUTH_MODE",
    "E2E_TEST_ID_ATTRIBUTE",
]);
const ALLOWED_E2E_ENV_ROLE_RE = /^E2E_[A-Z0-9_]+_(?:USERNAME|PASSWORD)$/;
export function assertSafeAitestTargetRel(targetRel) {
    const p = (targetRel || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
    if (!p) {
        throw new Error("Path jail: đường dẫn Apply trống");
    }
    if (p.split("/").some((s) => s === ".." || s === ".") || /^[a-zA-Z]:/.test(p)) {
        throw new Error("Path jail: đường dẫn không được chứa .. hoặc absolute drive");
    }
    const parts = p.split("/");
    const lowParts = parts.map((s) => s.toLowerCase());
    const aitIdx = lowParts.indexOf(AITEST_ROOT.toLowerCase());
    if (aitIdx < 0) {
        throw new Error(`Path jail: Apply chỉ ghi dưới ${AITEST_ROOT}/ (got ${p})`);
    }
    const after = lowParts.slice(aitIdx + 1);
    if (!after.length) {
        throw new Error(`Path jail: đường dẫn dưới ${AITEST_ROOT}/ chưa đủ`);
    }
    if (after.some((seg) => FORBIDDEN_UNDER_AITEST.has(seg))) {
        throw new Error(`Path jail: không mirror thư mục production dưới AItest (got ${p})`);
    }
    return p;
}
/**
 * Unit Apply paths: real tests under UnitTest/, plus AItest-root scaffolding
 * (AItest.UnitTests.csproj, jest.config, tsconfig) — not nested production mirrors.
 */
export function isAllowedUnitLayoutPath(safeRel) {
    const p = (safeRel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!p)
        return false;
    if (/(?:^|\/)aitest\/test-cases(?:\/|$)/i.test(p))
        return false;
    if (/\/unittest\//i.test(`/${p}/`))
        return true;
    const low = p.toLowerCase();
    const marker = "aitest/";
    const at = low.indexOf(marker);
    if (at < 0)
        return false;
    const after = p.slice(at + marker.length);
    if (!after || after.includes("/"))
        return false;
    return (/\.(csproj|props|targets)$/i.test(after) ||
        /^(jest\.config\.[cm]?js|package\.json|tsconfig(\.[\w-]+)?\.json)$/i.test(after));
}
export function isAllowedE2eEnvKey(key) {
    const k = (key || "").trim();
    if (!k)
        return false;
    if (ALLOWED_E2E_ENV_EXACT.has(k))
        return true;
    return ALLOWED_E2E_ENV_ROLE_RE.test(k);
}
export function filterAllowedEnv(env) {
    const out = {};
    if (!env)
        return out;
    for (const [k, v] of Object.entries(env)) {
        // Non-E2E keys allowed for runners; E2E_* must be allowlisted.
        if (k.startsWith("E2E_")) {
            if (isAllowedE2eEnvKey(k))
                out[k] = v;
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
