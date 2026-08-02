/**
 * Output layout for generated tests applied into the user's repo.
 *
 * [{pkg}/]AItest/  ← sibling of package src/lib (backend/, frontend/, …)
 * Never monorepo-root AItest when source lives under a nested package.
 */

export const AITEST_ROOT = "AItest";

export type GeneratedTestKind = "unit" | "integration" | "api" | "e2e";

export const GENERATED_TEST_FOLDERS: Record<GeneratedTestKind, string> = {
  unit: "UnitTest",
  integration: "IntegrationTest",
  api: "APITest",
  e2e: "E2ETest",
};

const KIND_ALIASES: Record<string, GeneratedTestKind> = {
  apitest: "api",
  "api-test": "api",
  unittest: "unit",
  "unit-test": "unit",
  integrationtest: "integration",
  e2etest: "e2e",
  endtoend: "e2e",
};

const DEFAULT_STRUCTURAL_SEGMENTS = new Set([
  "src",
  "lib",
  "libs",
  "source",
  "sources",
  "dist",
  "build",
  "bin",
  "obj",
  "node_modules",
  "vendor",
  "third_party",
  "thirdparty",
  "__pycache__",
  "target",
  "out",
  "wwwroot",
  "public",
  "assets",
  "environments",
]);

/** SPA host shells — strip from module labels; package prefix still keeps them. */
const DEFAULT_SPA_SHELLS = new Set([
  "clientapp",
  "serverapp",
  "webapp",
  "webspa",
  "spa",
]);

function envSegmentSet(varName: string, defaults: Set<string>): Set<string> {
  const raw = (typeof process !== "undefined" ? process.env?.[varName] : "") || "";
  if (!raw.trim()) return defaults;
  const extra = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...defaults, ...extra]);
}

function structuralSegments(): Set<string> {
  return envSegmentSet("AITEST_STRUCTURAL_SEGMENTS", DEFAULT_STRUCTURAL_SEGMENTS);
}

function spaShellSegments(): Set<string> {
  return envSegmentSet("AITEST_SPA_SHELLS", DEFAULT_SPA_SHELLS);
}

function techSegments(): Set<string> {
  return new Set([...structuralSegments(), ...spaShellSegments()]);
}

const STRIP_PREFIX_TREES = [
  "aitest/",
  "unittest/",
  "integrationtest/",
  "apitest/",
  "e2etest/",
  "tests/",
  "test/",
  "__tests__/",
  "spec/",
  "specs/",
  "src/test/java/",
  "src/test/kotlin/",
];

const MAX_MODULE_DEPTH = 2;

/**
 * Layout Unit/API under AItest:
 *   AItest/UnitTest/{Requirement}/{TestCaseTitle}/{file}
 * Shared config stays at AItest/jest.config.cjs + AItest/tsconfig.json (not inside modules).
 *
 * Segments collapse whitespace → `-` so Windows `cmd` / pytest không cắt path (vd. "To do").
 */
export function buildRequirementTcModule(
  requirementTitle?: string | null,
  testCaseTitle?: string | null,
  fallbackModule?: string | null
): string {
  const oneSeg = (raw?: string | null): string => {
    let mod = (raw || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
    mod = mod.replace(/[<>:"|?*]/g, "");
    const parts = mod.split("/").filter((p) => p && p !== "." && p !== "..");
    return sanitizePathSegment(parts[0] || "");
  };
  const req = oneSeg(requirementTitle);
  const tc = oneSeg(testCaseTitle);
  if (req && tc) return `${req}/${tc}`;
  if (req) return req;
  if (tc) return tc;
  return sanitizeModuleLabel(fallbackModule);
}

export function normalizeKind(kind?: string | null): GeneratedTestKind {
  const k = (kind || "unit").trim().toLowerCase().replace(/\s+/g, "");
  const aliased = KIND_ALIASES[k] ?? (k as GeneratedTestKind);
  if (aliased in GENERATED_TEST_FOLDERS) return aliased;
  return "unit";
}

export function generatedTestRoot(kind: GeneratedTestKind | string = "unit"): string {
  return GENERATED_TEST_FOLDERS[normalizeKind(kind)];
}

export function aitestKindRoot(kind: GeneratedTestKind | string = "unit"): string {
  return `${AITEST_ROOT}/${generatedTestRoot(kind)}`;
}

export function reportsDir(): string {
  return `${AITEST_ROOT}/Reports`;
}

export function coverageDir(): string {
  return `${AITEST_ROOT}/Coverage`;
}

export function metadataDir(): string {
  return `${AITEST_ROOT}/Metadata`;
}

export function metadataPath(runId: string, fileName?: string): string {
  return `${metadataDir()}/${fileName || `${runId}.json`}`.replace(/\/+/g, "/");
}

function normRel(path?: string | null): string {
  let p = (path || "").replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  return p.replace(/^\/+|\/+$/g, "");
}

/** Safe folder segment: no traversal; length-capped for Windows MAX_PATH. */
const MAX_PATH_SEGMENT_LEN = 48;

/** Keep Playwright/test + POM compound suffixes when truncating long filenames. */
const COMPOUND_FILE_EXTS = [
  ".spec.ts",
  ".spec.tsx",
  ".test.ts",
  ".test.tsx",
  ".page.ts",
  ".page.tsx",
  ".setup.ts",
  ".helper.ts",
  ".d.ts",
] as const;

function truncatePathSegment(seg: string, maxLen = MAX_PATH_SEGMENT_LEN): string {
  const s = (seg || "").trim();
  if (!s || s.length <= maxLen) return s;
  // FNV-1a over UTF-8 bytes — must match api truncate_path_segment
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  const digest = (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
  const keep = Math.max(8, maxLen - 9);
  const prefix = s.slice(0, keep).replace(/[-._\s]+$/g, "");
  return `${prefix}-${digest}`;
}

export function sanitizePathSegment(raw?: string | null, maxLen = MAX_PATH_SEGMENT_LEN): string {
  let s = (raw || "").trim();
  if (!s) return "";
  s = s.replace(/[<>:"|?*\[\]]/g, "");
  s = s.replace(/\//g, "-");
  s = s.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (s === "." || s === "..") return "";
  return truncatePathSegment(s, maxLen);
}

function splitE2eFilename(name: string): [string, string] {
  const n = name || "";
  const low = n.toLowerCase();
  for (const ext of COMPOUND_FILE_EXTS) {
    if (low.endsWith(ext)) {
      return [n.slice(0, -ext.length), n.slice(-ext.length)];
    }
  }
  const dot = n.lastIndexOf(".");
  if (dot > 0) return [n.slice(0, dot), n.slice(dot)];
  return [n, ""];
}

/** Shorten oversized segments in already-generated E2E rel paths. */
export function shortenE2eRelPath(rel: string, maxSeg = MAX_PATH_SEGMENT_LEN): string {
  const p = (rel || "").replace(/\\/g, "/").trim();
  if (!p) return p;
  const structural = new Set([
    "aitest",
    "e2etest",
    "pages",
    "specs",
    "fixtures",
    "helpers",
    "unittest",
    "apitest",
    "integrationtest",
  ]);
  const parts = p.split("/").filter(Boolean);
  return parts
    .map((part, i) => {
      const isFile = i === parts.length - 1 && part.includes(".");
      if (structural.has(part.toLowerCase())) return part;
      if (isFile) {
        const [stem, ext] = splitE2eFilename(part);
        if (stem && part.length > maxSeg + ext.length) {
          return `${truncatePathSegment(stem, maxSeg)}${ext}`;
        }
        return part;
      }
      return truncatePathSegment(part, maxSeg);
    })
    .join("/");
}

/** TC.module → safe short folder. */
export function sanitizeModuleLabel(module?: string | null): string {
  let mod = (module || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  mod = mod.replace(/[<>:"|?*]/g, "");
  const parts = mod
    .split("/")
    .map((p) => sanitizePathSegment(p))
    .filter((p) => p && p !== "." && p !== "..");
  return parts.slice(0, MAX_MODULE_DEPTH).join("/");
}

/**
 * Short module from source — strip structural/SPA shells, cap depth.
 * Generic for any project: last N business folders after shells removed.
 */
export function moduleRelFromSource(sourceRel?: string | null): string {
  let p = normRel(sourceRel);
  if (!p) return "";

  const base = p.split("/").pop() || "";
  if (base.includes(".") && !p.endsWith("/")) {
    p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  }
  p = p.replace(/^\/+|\/+$/g, "");
  let low = p.toLowerCase();

  for (const prefix of STRIP_PREFIX_TREES) {
    if (low.startsWith(prefix)) {
      p = p.slice(prefix.length);
      low = p.toLowerCase();
      break;
    }
  }

  const rawParts = p.split("/").filter((s) => s && s !== "." && s !== "..");
  const tech = techSegments();
  const spa = spaShellSegments();
  const parts: string[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const seg = rawParts[i];
    const lowSeg = seg.toLowerCase();
    if (tech.has(lowSeg) || spa.has(lowSeg)) continue;
    // Angular: strip `app` only when it sits under `src`
    if (lowSeg === "app" && i > 0 && rawParts[i - 1].toLowerCase() === "src") continue;
    parts.push(seg);
  }

  if (parts[0]?.toLowerCase() === AITEST_ROOT.toLowerCase()) {
    parts.shift();
    const kinds = new Set(Object.values(GENERATED_TEST_FOLDERS).map((x) => x.toLowerCase()));
    if (parts[0] && kinds.has(parts[0].toLowerCase())) parts.shift();
  }

  if (!parts.length) return "";
  if (parts.length <= MAX_MODULE_DEPTH) return parts.join("/");
  return parts.slice(-MAX_MODULE_DEPTH).join("/");
}

export function testFileNameFromSource(opts: {
  sourceFileName?: string | null;
  language?: string | null;
  className?: string | null;
  kind?: GeneratedTestKind | string;
}): string {
  const src = normRel(opts.sourceFileName);
  const stem = src ? (src.split("/").pop() || "").replace(/\.[^.]+$/, "") : "";
  const base = (opts.className || stem || "Target").replace(/[^a-zA-Z0-9_]/g, "") || "Target";
  const lang = (opts.language || "").toLowerCase();
  const ext = src.includes(".") ? `.${src.split(".").pop()!.toLowerCase()}` : "";
  const kind = normalizeKind(opts.kind);

  if (lang.includes("python") || ext === ".py") {
    let name = (stem || base).toLowerCase();
    if (!name.startsWith("test_")) name = `test_${name}`;
    return name.endsWith(".py") ? name : `${name}.py`;
  }
  if (lang.includes("go") || ext === ".go") {
    const stemG = stem || base;
    return kind === "api" ? `${stemG.toLowerCase()}_api_test.go` : `${stemG}_test.go`;
  }
  if (
    lang.includes("typescript") ||
    lang.includes("javascript") ||
    [".ts", ".tsx", ".js", ".jsx"].includes(ext)
  ) {
    const useExt = [".ts", ".tsx", ".js", ".jsx"].includes(ext)
      ? ext
      : lang.includes("typescript")
        ? ".ts"
        : ".js";
    const stemJs = stem || base;
    return kind === "api" ? `${stemJs}.api.test${useExt}` : `${stemJs}.test${useExt}`;
  }
  if (lang.includes("java") || ext === ".java") {
    return base.endsWith("Test") ? `${base}.java` : `${base}Test.java`;
  }
  if (lang.includes("kotlin") || ext === ".kt") {
    return base.endsWith("Test") ? `${base}.kt` : `${base}Test.kt`;
  }
  if (lang.includes("c#") || lang.includes("csharp") || ext === ".cs") {
    if (kind === "api") {
      return base.includes("ApiTests") ? `${base}.cs` : `${base}ApiTests.cs`;
    }
    return base.endsWith("Tests") ? `${base}.cs` : `${base}Tests.cs`;
  }
  if (lang.includes("rust") || ext === ".rs") {
    return `${base.toLowerCase()}_test.rs`;
  }
  return `${base}Tests${ext || ".txt"}`;
}

/**
 * Ensure each Unit TC gets a distinct file under the same module/source.
 * Without this, batch verify stages N overlays onto one path → Jest chỉ chạy 1 file
 * trong khi UI vẫn gắn PASS cho mọi TC.
 *
 * Examples:
 *   foo.test.ts + id 1b899cf6-… → foo.1b899cf6.test.ts
 *   FooTests.cs + id → FooTests_1b899cf6.cs
 */
export function uniquifyTestTargetRel(targetRel: string, testCaseId: string): string {
  const short = (testCaseId || "").replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!short) return targetRel.replace(/\\/g, "/");
  const norm = targetRel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.toLowerCase().includes(`.${short}.`) || norm.toLowerCase().includes(`_${short}.`)) {
    return norm;
  }
  const testSpec = norm.match(/^(.*?)(\.(?:test|spec))(\.[^.]+)$/i);
  if (testSpec) {
    return `${testSpec[1]}.${short}${testSpec[2]}${testSpec[3]}`;
  }
  const csStyle = norm.match(/^(.*?)(Tests?)(\.[^.]+)$/);
  if (csStyle) {
    return `${csStyle[1]}${csStyle[2]}_${short}${csStyle[3]}`;
  }
  const pyStyle = norm.match(/^(.*)\/(test_)([^/]+)$/i);
  if (pyStyle) {
    return `${pyStyle[1]}/${pyStyle[2]}${short}_${pyStyle[3]}`;
  }
  const anyExt = norm.match(/^(.*)(\.[^.]+)$/);
  if (anyExt) {
    return `${anyExt[1]}.${short}${anyExt[2]}`;
  }
  return `${norm}.${short}`;
}

/** Structural code-root folders — AItest is placed as a sibling of these. */
const DEFAULT_CODE_ROOT_MARKERS = new Set(["src", "lib", "libs"]);

function codeRootMarkers(): Set<string> {
  return envSegmentSet("AITEST_CODE_ROOT_MARKERS", DEFAULT_CODE_ROOT_MARKERS);
}

/**
 * Directory that owns the source package — place AItest next to its src/lib.
 * Generic for any project name. Optional packagePrefix overrides heuristic.
 */
export function packagePrefixFromSource(
  sourceRel?: string | null,
  packagePrefix?: string | null
): string {
  if (packagePrefix !== undefined && packagePrefix !== null) {
    return normRel(packagePrefix);
  }
  const p = normRel(sourceRel);
  if (!p) return "";
  const parts = p.split("/").filter((s) => s && s !== "." && s !== "..");
  if (parts.length < 2) return "";
  const markers = codeRootMarkers();
  for (let i = 0; i < parts.length - 1; i++) {
    const low = parts[i].toLowerCase();
    if (!markers.has(low)) continue;
    // Django-style `app` root: only when not under `src`
    if (low === "app" && i > 0 && parts[i - 1].toLowerCase() === "src") continue;
    if (i === 0) return "";
    const prefixParts = parts.slice(0, i);
    const lowJoin = prefixParts.map((s) => s.toLowerCase()).join("/");
    if (lowJoin === AITEST_ROOT.toLowerCase() || `/${lowJoin}/`.includes("/aitest/")) {
      return "";
    }
    return prefixParts.join("/");
  }
  return "";
}

/** Relative import from generated test → source (TS/JS, no extension). */
export function relativeModuleSpecifier(fromFile: string, toFile: string): string {
  const frm = normRel(fromFile);
  const to = normRel(toFile);
  if (!frm || !to) return "";
  const fromDir = frm.includes("/") ? frm.slice(0, frm.lastIndexOf("/")) : ".";
  const toNoExt = to.replace(/\.(tsx?|jsx?)$/i, "");
  const fromParts = fromDir === "." ? [] : fromDir.split("/");
  const toParts = toNoExt.split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.length - i;
  const down = toParts.slice(i).join("/");
  const rel = `${"../".repeat(up)}${down}` || "./";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Prefer package-root `src/…` (Nest baseUrl) so AItest depth does not break imports.
 */
export function sutModuleSpecifier(testRel: string, sourceRel: string): string {
  const to = normRel(sourceRel);
  if (!to) return "";
  const parts = to.split("/").filter(Boolean);
  const srcIdx = parts.findIndex((p) => p.toLowerCase() === "src");
  if (srcIdx >= 0) {
    return parts.slice(srcIdx).join("/").replace(/\.(tsx?|jsx?)$/i, "");
  }
  return relativeModuleSpecifier(testRel, sourceRel);
}

/**
 * AItest/{Kind}/{Requirement}/{TestCaseTitle}/file
 * Prefer opts.requirementTitle + testCaseTitle; else legacy opts.module / source path.
 * jest/tsconfig are NOT placed here — only under AItest/ root via ensureAitestJestTsconfig.
 */
export function underGeneratedTestFolder(
  kind: GeneratedTestKind | string,
  fileName: string,
  sourceDir?: string | null,
  opts?: {
    sourceFileName?: string | null;
    module?: string | null;
    requirementTitle?: string | null;
    testCaseTitle?: string | null;
    /** Override path heuristic (from FS discovery). "" = repo-root AItest. */
    packagePrefix?: string | null;
  }
): string {
  const normKind = normalizeKind(kind);
  let kindRoot = aitestKindRoot(normKind);
  const srcKey = opts?.sourceFileName || sourceDir;
  const reqModule = buildRequirementTcModule(
    opts?.requirementTitle,
    opts?.testCaseTitle,
    opts?.module
  );
  const usedTcModule = Boolean(reqModule);
  const pkg = packagePrefixFromSource(srcKey, opts?.packagePrefix);
  if (pkg) kindRoot = `${pkg}/${kindRoot}`;
  const name = (fileName || "Tests.txt").replace(/\\/g, "/").replace(/^\/+/, "");

  let mod = reqModule;
  if (!mod) {
    mod = moduleRelFromSource(srcKey);
  }
  if (mod.toLowerCase().startsWith(`${AITEST_ROOT.toLowerCase()}/`)) {
    mod = moduleRelFromSource(mod);
  }

  // Unit layout: keep one parent folder (Requirement/module), no nested TC tree.
  if (normKind === "unit") {
    const reqOnly =
      sanitizePathSegment(opts?.requirementTitle) ||
      sanitizePathSegment((reqModule || "").split("/")[0] || "") ||
      sanitizePathSegment(opts?.module) ||
      "";
    if (reqOnly) return `${kindRoot}/${reqOnly}/${name}`.replace(/\/+/g, "/");
    return `${kindRoot}/${name}`.replace(/\/+/g, "/");
  }

  if (mod) {
    const kindName = generatedTestRoot(kind).toLowerCase();
    let parts = mod.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === kindName) parts.shift();
    const drop = techSegments();
    parts = parts.filter((p) => !drop.has(p.toLowerCase()));
    if (pkg && !usedTcModule) {
      const pkgParts = pkg.toLowerCase().split("/");
      while (parts.length && pkgParts.length && parts[0].toLowerCase() === pkgParts[0]) {
        parts.shift();
        pkgParts.shift();
      }
    }
    mod = parts.slice(0, MAX_MODULE_DEPTH).join("/");
  }

  if (mod) return `${kindRoot}/${mod}/${name}`.replace(/\/+/g, "/");
  return `${kindRoot}/${name}`.replace(/\/+/g, "/");
}

/**
 * P5 path jail — Apply under AItest/ or {anyPkg}/AItest/; no production mirror under AItest.
 */
export function assertSafeAitestTargetRel(targetRel: string): string {
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
  const forbiddenUnderAitest = new Set([
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
  if (after.some((seg) => forbiddenUnderAitest.has(seg))) {
    throw new Error(`Path jail: không mirror thư mục production dưới AItest (got ${p})`);
  }
  return p;
}

/** True when path already looks like a flat AItest layout target. */
export function isFlatAitestTarget(targetRel: string): boolean {
  try {
    assertSafeAitestTargetRel(targetRel);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep everything from the AItest/ segment onward; optionally relocate package prefix.
 * Universal monorepo rule: never rebuild Requirement/TC folders from filename alone.
 */
export function relocateAitestPackagePrefix(
  targetRel: string,
  packagePrefix?: string | null
): string {
  const raw = (targetRel || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  assertSafeAitestTargetRel(raw);
  const parts = raw.split("/").filter(Boolean);
  const low = parts.map((s) => s.toLowerCase());
  const aitIdx = low.indexOf(AITEST_ROOT.toLowerCase());
  if (aitIdx < 0) {
    throw new Error(`Path jail: missing ${AITEST_ROOT}/ in ${raw}`);
  }
  const tail = parts.slice(aitIdx).join("/"); // AItest/...
  const pkg = (packagePrefix ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!pkg) return assertSafeAitestTargetRel(tail);
  return assertSafeAitestTargetRel(`${pkg}/${tail}`.replace(/\/+/g, "/"));
}

/**
 * Normalize Apply target into [{pkg}/]AItest/{Kind}/… .
 *
 * When `targetRel` is already a valid flat AItest path (from staging/manifest),
 * PRESERVE the full path under AItest/ (Requirement folder, uniquify id, scaffolds).
 * Only relocate the package prefix. Never rebuild from basename — that drops files
 * into the wrong folder on Apply (any monorepo / any language).
 */
export function coerceAitestApplyPath(
  targetRel: string,
  opts?: {
    kind?: GeneratedTestKind | string;
    module?: string | null;
    sourceFileName?: string | null;
    packagePrefix?: string | null;
    /** When true (Apply/Verify), never rebuild path from filename. Default true if raw is safe. */
    preserveLayout?: boolean;
  }
): string {
  const raw = (targetRel || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  const kind = normalizeKind(opts?.kind);
  const pkgOpt =
    opts?.packagePrefix !== undefined && opts?.packagePrefix !== null
      ? opts.packagePrefix
      : undefined;

  const collapseDuplicateAnchors = (path: string): string => {
    const segments = path.split("/").filter(Boolean);
    const low = segments.map((s) => s.toLowerCase());
    const kindName = generatedTestRoot(kind).toLowerCase();
    const anchors: number[] = [];
    for (let i = 0; i < low.length - 1; i += 1) {
      if (low[i] === AITEST_ROOT.toLowerCase() && low[i + 1] === kindName) {
        anchors.push(i);
      }
    }
    if (anchors.length <= 1) return path;
    const lastAi = anchors[anchors.length - 1];
    const prefix = segments.slice(0, anchors[0]).join("/");
    const tail = segments.slice(lastAi).join("/"); // starts with AItest
    return (prefix ? `${prefix}/${tail}` : tail).replace(/\/+/g, "/");
  };

  if (raw && isFlatAitestTarget(raw)) {
    const collapsed = assertSafeAitestTargetRel(collapseDuplicateAnchors(raw));
    const preserve = opts?.preserveLayout !== false;
    if (preserve) {
      // Explicit packagePrefix (including "") relocates; undefined keeps existing root.
      if (pkgOpt !== undefined) {
        return relocateAitestPackagePrefix(collapsed, pkgOpt);
      }
      return collapsed;
    }
  }

  // Unsafe / missing layout — build from kind + module + source (generate path).
  const base = raw.split("/").pop() || "GeneratedTests.txt";
  return assertSafeAitestTargetRel(
    underGeneratedTestFolder(kind, base, null, {
      module: opts?.module,
      sourceFileName: opts?.sourceFileName || raw,
      packagePrefix: pkgOpt,
    })
  );
}

/** AItest folder root for a target, e.g. backend/AItest or AItest. */
export function aitestRootFromTarget(targetRel?: string | null): string {
  const p = (targetRel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const m = p.match(/^(.*?\/)?AItest(?=\/|$)/i);
  if (!m) return AITEST_ROOT;
  return (m[0] || AITEST_ROOT).replace(/\/+$/, "") || AITEST_ROOT;
}

/** Rewrite SUT + local imports to stable `src/…` (or relative) that resolve from AItest. */
export function rewriteSutImports(
  code: string,
  opts: { testRel: string; sourceRel: string }
): string {
  if (!code || !opts.testRel || !opts.sourceRel) return code;
  const correct = sutModuleSpecifier(opts.testRel, opts.sourceRel);
  if (!correct) return code;
  const srcNorm = normRel(opts.sourceRel);
  const srcBase = (srcNorm.split("/").pop() || "").replace(/\.[^.]+$/, "");
  if (!srcBase) return code;

  const sourceDir = srcNorm.includes("/")
    ? srcNorm.slice(0, srcNorm.lastIndexOf("/"))
    : ".";

  const stripExt = (p: string) => p.replace(/\.(tsx?|jsx?)$/i, "");

  /** `foo/bar/src/x` or `src/x` → `src/x` */
  const asSrcSpecifier = (spec: string): string | null => {
    const n = stripExt(spec.replace(/\\/g, "/"));
    if (n.startsWith("src/")) return n;
    const idx = n.toLowerCase().indexOf("/src/");
    if (idx >= 0) return n.slice(idx + 1);
    return null;
  };

  /** Resolve path segments like path.posix.normalize without depending on node:path. */
  const normJoin = (baseDir: string, relSpec: string): string => {
    const baseParts = baseDir === "." ? [] : baseDir.split("/").filter(Boolean);
    const relParts = relSpec.replace(/\\/g, "/").split("/");
    const out = [...baseParts];
    for (const part of relParts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out.join("/");
  };

  const isBareNpmPackage = (spec: string) => {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("src/")) return false;
    if (spec.startsWith("@/")) return false;
    if (spec.startsWith("@") && spec.includes("/")) {
      // @nestjs/common — leave; @app/foo with SUT name — rewrite
      return !spec.toLowerCase().includes(srcBase.toLowerCase());
    }
    // lodash, reflect-metadata, …
    if (!spec.includes("/") && !spec.startsWith("@")) return true;
    return false;
  };

  return code.replace(
    /((?:from|require\s*\()\s*['"])([^'"]+)(['"])/g,
    (full, prefix: string, spec: string, suffix: string) => {
      const specNorm = spec.replace(/\\/g, "/");
      if (isBareNpmPackage(specNorm)) return full;

      // Always normalize @/ → src/
      if (specNorm.startsWith("@/")) {
        return `${prefix}src/${stripExt(specNorm.slice(2))}${suffix}`;
      }
      if (specNorm.startsWith("~/")) {
        return `${prefix}src/${stripExt(specNorm.slice(2))}${suffix}`;
      }

      const fromSrcPath = asSrcSpecifier(specNorm);
      if (fromSrcPath) {
        // Prefer canonical SUT specifier when this points at the SUT file
        if (
          fromSrcPath.toLowerCase() === correct.toLowerCase() ||
          fromSrcPath.toLowerCase().endsWith(`/${srcBase.toLowerCase()}`) ||
          fromSrcPath.toLowerCase() === srcBase.toLowerCase()
        ) {
          return `${prefix}${correct}${suffix}`;
        }
        return `${prefix}${fromSrcPath}${suffix}`;
      }

      const specBase = (specNorm.split("/").pop() || "").replace(/\.[^.]+$/, "");
      if (
        specBase.toLowerCase() === srcBase.toLowerCase() ||
        specNorm.toLowerCase().includes(srcBase.toLowerCase())
      ) {
        // Avoid rewriting scoped packages that merely mention a substring
        if (
          specNorm.startsWith("@") &&
          !specNorm.startsWith("@/") &&
          specBase.toLowerCase() !== srcBase.toLowerCase()
        ) {
          return full;
        }
        return `${prefix}${correct}${suffix}`;
      }

      // Relatives in AI output are usually written as if next to the SUT
      if (specNorm.startsWith(".")) {
        const resolved = normJoin(sourceDir, specNorm);
        const srcSpec = asSrcSpecifier(resolved) || (resolved.toLowerCase().startsWith("src/")
          ? stripExt(resolved)
          : null);
        if (srcSpec) {
          if (
            srcSpec.toLowerCase() === correct.toLowerCase() ||
            (srcSpec.split("/").pop() || "").toLowerCase() === srcBase.toLowerCase()
          ) {
            return `${prefix}${correct}${suffix}`;
          }
          return `${prefix}${srcSpec}${suffix}`;
        }
        // No src/ in tree — keep relative from test → resolved file
        const fromTest = relativeModuleSpecifier(opts.testRel, resolved);
        if (fromTest) return `${prefix}${stripExt(fromTest)}${suffix}`;
      }

      return full;
    }
  );
}

/** [{pkg}/]AItest/E2ETest/{Requirement}/{TC} */
export function e2eModuleRoot(
  module?: string | null,
  opts?: {
    packagePrefix?: string | null;
    sourceFileName?: string | null;
    requirementTitle?: string | null;
    testCaseTitle?: string | null;
  }
): string {
  let kindRoot = aitestKindRoot("e2e");
  const pkg = packagePrefixFromSource(opts?.sourceFileName, opts?.packagePrefix);
  if (pkg) kindRoot = `${pkg}/${kindRoot}`;
  const mod = buildRequirementTcModule(
    opts?.requirementTitle,
    opts?.testCaseTitle,
    module
  );
  if (mod) return `${kindRoot}/${mod}`.replace(/\/+/g, "/");
  return kindRoot;
}

/** Default fixtures/storageState.json under E2E module */
export function e2eStorageStateRel(
  module?: string | null,
  opts?: {
    packagePrefix?: string | null;
    fileName?: string;
    requirementTitle?: string | null;
    testCaseTitle?: string | null;
  }
): string {
  const root = e2eModuleRoot(module, opts);
  const name = opts?.fileName || "storageState.json";
  return `${root}/fixtures/${name}`.replace(/\/+/g, "/");
}
