import {
  DEFAULT_CANONICAL_STORAGE,
  DEFAULT_SHARED_STORAGE,
  DEFAULT_TEST_ROOT,
  E2E_CONVENTIONS_REL,
  E2E_PLAYWRIGHT_RUN_REL,
  PROFILE_REL_PATH,
  PROFILE_SCHEMA,
  UNIT_CONVENTIONS_REL,
} from "./constants.js";
import type { ProjectProfile, UnitProfile } from "./types.js";
import type { ProfileIo } from "./types.js";

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Fill missing unit gate knobs — portable defaults for every SUT repo. */
export function normalizeUnitProfile(
  unit?: Partial<UnitProfile> | null
): UnitProfile {
  const u = unit || {};
  return {
    runner: u.runner ?? "",
    testFrameworks: Array.isArray(u.testFrameworks) ? u.testFrameworks : [],
    mockHint: u.mockHint ?? "",
    scope: u.scope === "frontend" || u.scope === "any" || u.scope === "backend"
      ? u.scope
      : "backend",
    minAlignment:
      typeof u.minAlignment === "number" && Number.isFinite(u.minAlignment)
        ? u.minAlignment
        : 50,
    requireMarkers:
      u.requireMarkers === false
        ? false
        : Array.isArray(u.requireMarkers) && u.requireMarkers.length
          ? u.requireMarkers
          : u.requireMarkers === true
            ? true
            : ["path", "code"],
    sutMap: u.sutMap && typeof u.sutMap === "object" ? u.sutMap : {},
    domainGuards: Array.isArray(u.domainGuards) ? u.domainGuards : [],
    codeAliasesFile: u.codeAliasesFile || ".ai-test/code-aliases.json",
    intentRulesFile: u.intentRulesFile || ".ai-test/unit-intent-rules.json",
    allowDiskReresolve: u.allowDiskReresolve === true,
  };
}

export function parseProjectProfileJson(raw: string): ProjectProfile | null {
  try {
    const data = JSON.parse(raw) as ProjectProfile;
    if (!data || data.schema !== PROFILE_SCHEMA) return null;
    data.unit = normalizeUnitProfile(data.unit);
    return data;
  } catch {
    return null;
  }
}

export async function loadProjectProfile(
  projectRoot: string,
  io: ProfileIo
): Promise<ProjectProfile | null> {
  const raw = await io.readFileOptional(projectRoot, PROFILE_REL_PATH);
  if (!raw?.trim()) return null;
  return parseProjectProfileJson(raw);
}

/**
 * Merge discovered profile into existing — user `moduleMap` keys always win.
 */
export function mergeProjectProfile(
  existing: ProjectProfile | null,
  discovered: ProjectProfile
): ProjectProfile {
  if (!existing) return discovered;
  const moduleMap: Record<string, string> = { ...discovered.moduleMap };
  for (const [key, value] of Object.entries(existing.moduleMap)) {
    if (key && value) moduleMap[key] = value;
  }
  const reuseRoots =
    existing.reuseRoots?.length ? existing.reuseRoots : discovered.reuseRoots;
  return {
    ...discovered,
    moduleMap,
    reuseRoots,
    unit: normalizeUnitProfile({
      ...discovered.unit,
      ...existing.unit,
      // Preserve per-repo SoT arrays/maps when discover returns empty shells
      sutMap:
        existing.unit?.sutMap && Object.keys(existing.unit.sutMap).length
          ? existing.unit.sutMap
          : discovered.unit?.sutMap,
      domainGuards:
        existing.unit?.domainGuards?.length
          ? existing.unit.domainGuards
          : discovered.unit?.domainGuards,
    }),
    updatedAt: discovered.updatedAt,
  };
}

export async function saveProjectProfile(
  projectRoot: string,
  profile: ProjectProfile,
  io: ProfileIo,
  conventionFiles: Record<string, string>
): Promise<void> {
  const toSave: ProjectProfile = {
    ...profile,
    unit: normalizeUnitProfile(profile.unit),
  };
  const json = JSON.stringify(toSave, null, 2);
  await io.writeFile(projectRoot, PROFILE_REL_PATH, json);
  for (const [rel, content] of Object.entries(conventionFiles)) {
    await io.writeFile(projectRoot, rel, content);
  }
}

export function emptyPlaywrightRunDefaults(): ProjectProfile["playwrightRun"] {
  return {
    packageRoot: "",
    workCwd: "per-tc-config",
    configPattern: "**/playwright.config.ts",
    baseURLEnv: "E2E_BASE_URL",
    defaultBaseURL: "http://localhost:4200",
    testIdAttribute: "data-cy",
    storageState: {
      strategy: "storageState",
      canonicalRel: DEFAULT_CANONICAL_STORAGE,
      discoverDirs: [".ai-test/auth", "AItest/E2ETest/_shared/fixtures"],
      sharedRel: DEFAULT_SHARED_STORAGE,
    },
    seed: { globalSetupRel: null, seedCommand: "", teardownCommand: "" },
    run: {
      workers: 1,
      timeoutMs: 90000,
      headless: false,
      slowMoMs: 500,
      browser: "chromium",
    },
    envAllowlist: [
      "E2E_BASE_URL",
      "E2E_STORAGE_STATE",
      "E2E_USERNAME",
      "E2E_PASSWORD",
      "E2E_ROLE",
      "E2E_FEATURE_PATH",
      "E2E_LOGIN_PATH",
      "E2E_TEST_ID_ATTRIBUTE",
    ],
  };
}

export function createEmptyProfile(projectName = ""): ProjectProfile {
  return {
    schema: PROFILE_SCHEMA,
    runner: "unknown",
    testRoot: DEFAULT_TEST_ROOT,
    playwrightRun: emptyPlaywrightRunDefaults(),
    auth: {
      strategy: "storageState",
      storageDir: ".ai-test/auth",
      roles: [],
    },
    locatorPolicy: ["testid", "role", "label"],
    moduleMap: {},
    reuseRoots: [],
    unit: normalizeUnitProfile({
      runner: "",
      testFrameworks: [],
      mockHint: "",
    }),
    updatedAt: new Date().toISOString(),
  };
}

export async function readConventionExcerpt(
  projectRoot: string,
  relPath: string,
  io: ProfileIo,
  maxChars = 2500
): Promise<string> {
  const raw = await io.readFileOptional(projectRoot, norm(relPath));
  if (!raw?.trim()) return "";
  const t = raw.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n…[truncated]";
}

export const CONVENTION_PATHS = {
  profile: PROFILE_REL_PATH,
  e2eConventions: E2E_CONVENTIONS_REL,
  e2ePlaywrightRun: E2E_PLAYWRIGHT_RUN_REL,
  unitConventions: UNIT_CONVENTIONS_REL,
} as const;
