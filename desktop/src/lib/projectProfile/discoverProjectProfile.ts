import {
  DEFAULT_CANONICAL_STORAGE,
  DEFAULT_SHARED_STORAGE,
  DEFAULT_TEST_ROOT,
  PLAYWRIGHT_CONFIG_NAMES,
  PROFILE_DISCOVER_DIRS,
  PROFILE_SCHEMA,
} from "./constants.js";
import { createEmptyProfile, emptyPlaywrightRunDefaults } from "./loadSaveProfile.js";
import type { AuthStrategy, DiscoverResult, ProfileIo, ProjectProfile } from "./types.js";
import {
  buildE2eRouteCatalog,
  matchFeaturePathFromCatalog,
  STRONG_CATALOG_SCORE,
} from "../e2eWorkspace/e2eRouteCatalog.js";

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function hasPlaywrightPackage(files: string[], prefix = ""): boolean {
  const pre = prefix ? `${norm(prefix).replace(/\/$/, "")}/` : "";
  const exact = `${pre}node_modules/@playwright/test/package.json`;
  return files.some((f) => norm(f) === exact || norm(f).includes("/node_modules/@playwright/test/"));
}

/** Shallow package roots: project root + first-level children (skip dot dirs and node_modules). */
function candidatePackageRoots(files: string[]): string[] {
  const roots = new Set<string>();
  roots.add("");
  const skip = new Set(["node_modules", ".git", "dist", "build"]);
  for (const f of files) {
    const parts = norm(f).split("/");
    if (parts.length >= 2 && parts[0] && !parts[0].startsWith(".") && !skip.has(parts[0])) {
      roots.add(parts[0]);
    }
  }
  return [...roots];
}

function hasAnyPlaywrightPackage(files: string[]): boolean {
  return files.some(
    (f) =>
      norm(f).endsWith("node_modules/@playwright/test/package.json") ||
      norm(f).includes("/node_modules/@playwright/test/")
  );
}

function findPlaywrightPackageRoot(files: string[]): string {
  for (const root of candidatePackageRoots(files)) {
    if (hasPlaywrightPackage(files, root ? `${root}/` : "")) return root;
  }
  return "";
}

function findPlaywrightConfigPath(files: string[]): string | null {
  const configs = files
    .map(norm)
    .filter((f) => PLAYWRIGHT_CONFIG_NAMES.some((n) => f.endsWith(n)))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  return configs[0] ?? null;
}

type ParsedPwConfig = {
  baseURL?: string;
  storageState?: string;
  workers?: number;
  timeoutMs?: number;
  headless?: boolean;
  slowMoMs?: number;
  globalSetup?: string;
};

function parsePlaywrightConfigContent(text: string): ParsedPwConfig {
  const out: ParsedPwConfig = {};
  const base = text.match(/baseURL\s*:\s*['"]([^'"]+)['"]/);
  if (base) out.baseURL = base[1];
  const storage = text.match(/storageState\s*:\s*['"]([^'"]+)['"]/);
  if (storage) out.storageState = storage[1];
  const workers = text.match(/workers\s*:\s*(\d+)/);
  if (workers) out.workers = Number(workers[1]);
  const timeout = text.match(/timeout\s*:\s*(\d+)/);
  if (timeout) out.timeoutMs = Number(timeout[1]);
  if (/headless\s*:\s*true/i.test(text)) out.headless = true;
  if (/headless\s*:\s*false/i.test(text)) out.headless = false;
  const slow = text.match(/slowMo\s*:\s*(\d+)/);
  if (slow) out.slowMoMs = Number(slow[1]);
  const gs = text.match(/globalSetup\s*:\s*['"]([^'"]+)['"]/);
  if (gs) out.globalSetup = gs[1];
  return out;
}

function detectTestIdAttribute(sampleTexts: string[]): string {
  let cy = 0;
  let tid = 0;
  for (const t of sampleTexts) {
    if (/data-cy\s*=/.test(t)) cy++;
    if (/data-testid\s*=/.test(t)) tid++;
  }
  if (tid > cy) return "data-testid";
  if (cy > 0) return "data-cy";
  return "data-cy";
}

function detectLocatorPolicy(testIdAttr: string): string[] {
  const base = ["role", "label"];
  if (testIdAttr === "data-testid") return ["testid", ...base];
  return ["testid", ...base];
}

function findTestRoot(files: string[]): string {
  const normalized = files.map(norm);
  if (normalized.some((f) => f.startsWith("AItest/E2ETest") || f.includes("/AItest/E2ETest/"))) {
    return DEFAULT_TEST_ROOT;
  }
  if (normalized.some((f) => f.startsWith("e2e/") || f.includes("/e2e/"))) return "e2e";
  return DEFAULT_TEST_ROOT;
}

function findReuseRoots(files: string[]): string[] {
  const roots: string[] = [];
  const normalized = files.map(norm);
  if (normalized.some((f) => f.includes("AItest/E2ETest/_shared"))) {
    roots.push("AItest/E2ETest/_shared");
  }
  if (normalized.some((f) => f.includes("e2e/support"))) roots.push("e2e/support");
  return roots;
}

function pushUnique(out: string[], value: string): void {
  if (!value) return;
  if (!out.includes(value)) out.push(value);
}

async function detectUnitFrameworks(
  projectRoot: string,
  io: ProfileIo,
  files: string[]
): Promise<string[]> {
  const frameworks: string[] = [];
  const normalized = files.map(norm);
  if (normalized.some((f) => /(?:^|\/)vitest\.config\.(?:ts|js|mts|mjs|cts|cjs)$/i.test(f))) {
    pushUnique(frameworks, "vitest");
  }
  if (normalized.some((f) => /(?:^|\/)jest\.config\.(?:ts|js|mts|mjs|cts|cjs)$/i.test(f))) {
    pushUnique(frameworks, "jest");
  }
  if (normalized.some((f) => /(?:^|\/)pyproject\.toml$/i.test(f))) {
    const pyproject = (await io.readFileOptional(projectRoot, "pyproject.toml")) || "";
    if (/pytest/i.test(pyproject)) pushUnique(frameworks, "pytest");
  }
  if (
    normalized.some((f) => /(?:^|\/)tests?\/.*test_.*\.py$/i.test(f)) ||
    normalized.some((f) => /(?:^|\/).*_test\.py$/i.test(f))
  ) {
    pushUnique(frameworks, "pytest");
  }
  const csprojTests = normalized.filter((f) => f.endsWith(".csproj") && /test/i.test(f));
  for (const rel of csprojTests.slice(0, 20)) {
    const content = await io.readFileOptional(projectRoot, rel);
    if (!content) continue;
    if (/PackageReference[^>]+xunit/i.test(content)) pushUnique(frameworks, "xunit");
    if (/PackageReference[^>]+nunit/i.test(content)) pushUnique(frameworks, "nunit");
    if (/PackageReference[^>]+MSTest/i.test(content)) pushUnique(frameworks, "mstest");
  }
  return frameworks;
}

function slugToken(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function isWeakModuleToken(token: string): boolean {
  if (!token || token.length < 4) return true;
  return [
    "src",
    "app",
    "apps",
    "clientapp",
    "components",
    "pages",
    "modules",
    "module",
    "feature",
    "features",
    "shared",
    "common",
    "core",
    "layout",
    "admin",
    "wwwroot",
    "assets",
    "test",
    "tests",
    "e2e",
    "aitest",
  ].includes(token);
}

function collectModuleCandidates(files: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const n = (name || "").trim();
    if (!n) return;
    const key = slugToken(n);
    if (isWeakModuleToken(key) || seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  for (const f of files.map(norm)) {
    const segs = f.split("/").filter(Boolean);
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const prev = i > 0 ? segs[i - 1].toLowerCase() : "";
      if (
        prev === "features" ||
        prev === "modules" ||
        prev === "pages" ||
        (prev === "app" && seg.toLowerCase() !== "shared")
      ) {
        push(seg);
      }
    }
  }
  return out.slice(0, 40);
}

async function suggestModuleMapFromRoutes(
  projectRoot: string,
  io: ProfileIo,
  files: string[]
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const candidates = collectModuleCandidates(files);
  if (!candidates.length) return map;
  const catalog = await buildE2eRouteCatalog({
    paths: files,
    readFile: async (pathRel) => (await io.readFileOptional(projectRoot, pathRel)) || "",
    maxFiles: 80,
  });
  if (!catalog.routes.length) return map;
  for (const moduleName of candidates) {
    const matched = matchFeaturePathFromCatalog(
      {
        module: moduleName,
        title: moduleName,
        steps: "",
        testData: "",
        precondition: "",
      },
      catalog,
      { minScore: STRONG_CATALOG_SCORE }
    );
    if (matched.path) {
      map[moduleName] = matched.path;
    }
  }
  return map;
}

async function collectStorageDiscoverDirs(
  projectRoot: string,
  io: ProfileIo,
  files: string[]
): Promise<string[]> {
  const dirs = new Set<string>(PROFILE_DISCOVER_DIRS);
  const normalized = files.map(norm);
  for (const f of normalized) {
    if (/storageState[^/]*\.json$/i.test(f)) {
      const idx = f.lastIndexOf("/");
      if (idx > 0) dirs.add(f.slice(0, idx));
    }
  }
  const existing: string[] = [];
  for (const d of dirs) {
    if (await io.fileExists(projectRoot, d) || normalized.some((f) => f.startsWith(`${d}/`))) {
      existing.push(d);
    }
  }
  return existing.length ? existing : [...PROFILE_DISCOVER_DIRS];
}

function inferAuthStrategy(parsed: ParsedPwConfig, hasStorageFiles: boolean): AuthStrategy {
  if (parsed.storageState || parsed.globalSetup || hasStorageFiles) return "storageState";
  return "storageState";
}

export async function discoverProjectProfile(
  projectRoot: string,
  io: ProfileIo
): Promise<DiscoverResult> {
  const notes: string[] = [];
  const files = await io.listFiles(projectRoot);
  const normalized = files.map(norm);

  const profile = createEmptyProfile();
  profile.updatedAt = new Date().toISOString();

  const packageRoot = findPlaywrightPackageRoot(normalized);
  const configPath = findPlaywrightConfigPath(normalized);
  if (hasAnyPlaywrightPackage(normalized) || Boolean(configPath)) {
    profile.runner = "playwright";
    notes.push(`playwright packageRoot=${packageRoot || "(root)"}`);
  } else if (normalized.some((f) => f.includes("cypress.config"))) {
    profile.runner = "cypress";
    notes.push("cypress config detected");
  }

  profile.testRoot = findTestRoot(normalized);
  profile.reuseRoots = findReuseRoots(normalized);

  const pw = emptyPlaywrightRunDefaults()!;
  pw.packageRoot = packageRoot;

  let parsedConfig: ParsedPwConfig = {};
  if (configPath) {
    notes.push(`playwright config=${configPath}`);
    const cfgText = await io.readFileOptional(projectRoot, configPath);
    if (cfgText) {
      parsedConfig = parsePlaywrightConfigContent(cfgText);
      if (parsedConfig.baseURL) pw.defaultBaseURL = parsedConfig.baseURL;
      if (parsedConfig.storageState) pw.storageState.canonicalRel = parsedConfig.storageState;
      if (parsedConfig.workers != null) pw.run.workers = parsedConfig.workers;
      if (parsedConfig.timeoutMs != null) pw.run.timeoutMs = parsedConfig.timeoutMs;
      if (parsedConfig.headless != null) pw.run.headless = parsedConfig.headless;
      if (parsedConfig.slowMoMs != null) pw.run.slowMoMs = parsedConfig.slowMoMs;
      if (parsedConfig.globalSetup) pw.seed.globalSetupRel = parsedConfig.globalSetup;
    }
  }

  pw.storageState.discoverDirs = await collectStorageDiscoverDirs(projectRoot, io, normalized);

  const feSamples = normalized
    .filter((f) => /\.(html|tsx|ts|vue)$/i.test(f) && !f.includes("node_modules"))
    .slice(0, 12);
  const sampleTexts: string[] = [];
  for (const rel of feSamples) {
    const t = await io.readFileOptional(projectRoot, rel);
    if (t) sampleTexts.push(t);
  }
  pw.testIdAttribute = detectTestIdAttribute(sampleTexts);
  profile.locatorPolicy = detectLocatorPolicy(pw.testIdAttribute);

  const hasStorageJson = normalized.some((f) => /storageState.*\.json$/i.test(f));
  let hasCredentialSeed = false;
  for (const dir of pw.storageState.discoverDirs) {
    for (const name of ["default.json", "admin.json", "user.json"]) {
      const rel = `${dir}/${name}`.replace(/\\/g, "/");
      const raw = await io.readFileOptional(projectRoot, rel);
      if (!raw) continue;
      try {
        const data = JSON.parse(raw) as { username?: string; password?: string; cookies?: unknown };
        if (data.username && data.password && !Array.isArray(data.cookies)) {
          hasCredentialSeed = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (hasCredentialSeed) break;
  }
  profile.auth.strategy = hasStorageJson
    ? "storageState"
    : hasCredentialSeed
      ? "uiLogin"
      : inferAuthStrategy(parsedConfig, hasStorageJson);
  if (hasCredentialSeed && !hasStorageJson) {
    notes.push("auth strategy=uiLogin (credential seed, no Playwright storageState yet)");
  }
  const unitFrameworks = await detectUnitFrameworks(projectRoot, io, normalized);
  profile.unit = {
    runner: unitFrameworks[0] || "",
    testFrameworks: unitFrameworks,
    mockHint:
      unitFrameworks.includes("jest") || unitFrameworks.includes("vitest")
        ? "Prefer isolated unit tests with explicit mocks/spies per test case."
        : unitFrameworks.includes("xunit") || unitFrameworks.includes("nunit")
          ? "Prefer Arrange/Act/Assert with clear test doubles (mock/fake) for external dependencies."
          : unitFrameworks.includes("pytest")
            ? "Prefer fixtures + monkeypatch for dependency isolation; keep assertions business-focused."
            : "",
  };
  if (unitFrameworks.length) {
    notes.push(`unit frameworks=${unitFrameworks.join(",")}`);
  }
  try {
    const suggestedModuleMap = await suggestModuleMapFromRoutes(projectRoot, io, normalized);
    profile.moduleMap = { ...profile.moduleMap, ...suggestedModuleMap };
    if (Object.keys(suggestedModuleMap).length) {
      notes.push(`moduleMap suggest=${Object.keys(suggestedModuleMap).length}`);
    }
  } catch {
    /* best effort */
  }
  profile.playwrightRun = pw;

  profile.schema = PROFILE_SCHEMA;

  if (!notes.length) notes.push("discover: minimal profile (no playwright package detected)");

  return { profile, notes };
}
