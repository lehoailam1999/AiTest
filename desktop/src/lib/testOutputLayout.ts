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

const TECH_SEGMENTS = new Set([
  "src",
  "app",
  "lib",
  "libs",
  "source",
  "sources",
  "backend",
  "frontend",
  "server",
  "client",
  "clientapp",
  "serverapp",
  "webapp",
  "web",
  "wwwroot",
  "public",
  "packages",
  "pkg",
  "internal",
  "cmd",
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
  "assets",
  "environments",
  "shared",
  "core",
  "common",
  "components",
]);

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

/** TC.module → safe short folder. */
export function sanitizeModuleLabel(module?: string | null): string {
  let mod = (module || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  mod = mod.replace(/[<>:"|?*]/g, "");
  const parts = mod.split("/").filter((p) => p && p !== "." && p !== "..");
  return parts.slice(0, MAX_MODULE_DEPTH).join("/");
}

/**
 * Short module from source — strip ClientApp/src/app/…, cap depth.
 * Forensic/ClientApp/src/app/admin/case-record/update/x.ts → Forensic/update
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

  let parts = p.split("/").filter((s) => s && s !== "." && s !== "..");
  parts = parts.filter((seg) => !TECH_SEGMENTS.has(seg.toLowerCase()));

  if (parts[0]?.toLowerCase() === AITEST_ROOT.toLowerCase()) {
    parts.shift();
    const kinds = new Set(Object.values(GENERATED_TEST_FOLDERS).map((x) => x.toLowerCase()));
    if (parts[0] && kinds.has(parts[0].toLowerCase())) parts.shift();
  }

  if (!parts.length) return "";
  if (parts.length <= MAX_MODULE_DEPTH) return parts.join("/");
  return `${parts[0]}/${parts[parts.length - 1]}`;
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

/** Structural code-root folders — AItest is placed as a sibling of these. */
const CODE_ROOT_MARKERS = new Set(["src", "lib", "libs"]);

/**
 * Directory that owns the source package — place AItest next to its src/lib.
 * Generic for any project name:
 *   {any}/src/… → {any}
 *   Forensic/ClientApp/src/app/x.ts → Forensic/ClientApp
 *   src/todos/x.ts → ""
 *
 * Optional packagePrefix overrides path heuristic (from FS discovery).
 * Pass packagePrefix="" to force repo-root AItest/.
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
  for (let i = 0; i < parts.length - 1; i++) {
    if (!CODE_ROOT_MARKERS.has(parts[i].toLowerCase())) continue;
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
 * AItest/{Kind}/{Module}/file — TC.module ưu tiên; nest under package owning src/.
 */
export function underGeneratedTestFolder(
  kind: GeneratedTestKind | string,
  fileName: string,
  sourceDir?: string | null,
  opts?: {
    sourceFileName?: string | null;
    module?: string | null;
    /** Override path heuristic (from FS discovery). "" = repo-root AItest. */
    packagePrefix?: string | null;
  }
): string {
  let kindRoot = aitestKindRoot(kind);
  const srcKey = opts?.sourceFileName || sourceDir;
  const usedTcModule = Boolean(sanitizeModuleLabel(opts?.module));
  const pkg = packagePrefixFromSource(srcKey, opts?.packagePrefix);
  if (pkg) kindRoot = `${pkg}/${kindRoot}`;
  const name = (fileName || "Tests.txt").replace(/\\/g, "/").replace(/^\/+/, "");

  let mod = sanitizeModuleLabel(opts?.module);
  if (!mod) {
    mod = moduleRelFromSource(srcKey);
  }
  if (mod.toLowerCase().startsWith(`${AITEST_ROOT.toLowerCase()}/`)) {
    mod = moduleRelFromSource(mod);
  }

  if (mod) {
    const kindName = generatedTestRoot(kind).toLowerCase();
    let parts = mod.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === kindName) parts.shift();
    parts = parts.filter((p) => !TECH_SEGMENTS.has(p.toLowerCase()));
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
 * Force path into [{pkg}/]AItest/{Kind}/{Module}/file.
 * Never keep a bare repo-root AItest/ when the source lives under a package (backend/…).
 */
export function coerceAitestApplyPath(
  targetRel: string,
  opts?: {
    kind?: GeneratedTestKind | string;
    module?: string | null;
    sourceFileName?: string | null;
    packagePrefix?: string | null;
  }
): string {
  const raw = (targetRel || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  const kind = normalizeKind(opts?.kind);
  const base = raw.split("/").pop() || "GeneratedTests.txt";
  const preferred = assertSafeAitestTargetRel(
    underGeneratedTestFolder(kind, base, null, {
      module: opts?.module,
      sourceFileName: opts?.sourceFileName || raw,
      packagePrefix: opts?.packagePrefix,
    })
  );

  if (!raw || !isFlatAitestTarget(raw)) {
    return preferred;
  }

  const preferredRoot = (preferred.match(/^(.*?\/)?AItest(?=\/|$)/i) || [])[0] || AITEST_ROOT;
  const rawRoot = (raw.match(/^(.*?\/)?AItest(?=\/|$)/i) || [])[0] || AITEST_ROOT;
  if (preferredRoot.replace(/\\/g, "/").toLowerCase() === rawRoot.replace(/\\/g, "/").toLowerCase()) {
    return assertSafeAitestTargetRel(raw);
  }
  return preferred;
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
