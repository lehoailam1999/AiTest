import type { PROFILE_SCHEMA } from "./constants.js";

export type AuthStrategy = "storageState" | "uiLogin" | "public";

export type StorageStateProfile = {
  strategy: AuthStrategy;
  canonicalRel: string;
  discoverDirs: string[];
  sharedRel: string;
};

export type PlaywrightSeedProfile = {
  globalSetupRel: string | null;
  seedCommand: string;
  teardownCommand: string;
};

export type PlaywrightRunProfile = {
  packageRoot: string;
  workCwd: "per-tc-config" | "monorepo-root";
  configPattern: string;
  baseURLEnv: string;
  defaultBaseURL: string;
  testIdAttribute: string;
  storageState: StorageStateProfile;
  seed: PlaywrightSeedProfile;
  run: {
    workers: number;
    timeoutMs: number;
    headless: boolean;
    slowMoMs: number;
    browser: string;
  };
  envAllowlist: string[];
};

export type AuthProfile = {
  strategy: AuthStrategy;
  storageDir: string;
  /** Roles to seed/persist. Empty → only admin/default from mine. */
  roles: string[];
  /** Optional extra files (project-relative) with username/password. */
  seedFiles?: string[];
  loginPath?: string;
};

/** Optional domain guard rule (mirrors ide-protocol UnitDomainGuardRule). */
export type UnitDomainGuardRuleProfile = {
  whenModuleMatches?: string;
  allowPathContains?: string[];
  denyPathContains?: string[];
};

export type UnitProfile = {
  runner: string;
  testFrameworks: string[];
  mockHint: string;
  /**
   * Unit Gen target layer. Default `"backend"` — UI/master TCs → FAIL_FEATURE_GAP.
   * Set `"frontend"` / `"any"` only when the profile intentionally allows UI Unit Gen.
   */
  scope?: "backend" | "frontend" | "any";
  /** Absolute Gen floor (default 50). alignment &lt; this → never call CLI. */
  minAlignment?: number;
  /**
   * strict_spec (default): missing behavior/feature gap blocks Gen.
   * always_generate: allow fallback generation with gap skeleton/note.
   */
  genMode?: "strict_spec" | "always_generate";
  /** Require path:/code: markers before Gen. Array form = require those keys. */
  requireMarkers?: boolean | string[];
  /**
   * When true, Extension may fuzzy-resolve SUT from disk if packet/markers fail.
   * Default false — Desktop owns resolve; Extension verify-only.
   */
  allowDiskReresolve?: boolean;
  /** Optional TC-id / cue → primary path overrides (per-repo only). */
  sutMap?: Record<string, string>;
  /** Portable domain allow/deny by module cue. */
  domainGuards?: UnitDomainGuardRuleProfile[];
  /** Relative path to VI→code aliases (default `.ai-test/code-aliases.json`). */
  codeAliasesFile?: string;
  /** Relative path to project intent rules (default `.ai-test/unit-intent-rules.json`). */
  intentRulesFile?: string;
};

export type ProjectProfile = {
  schema: typeof PROFILE_SCHEMA;
  runner: "playwright" | "cypress" | "unknown";
  testRoot: string;
  playwrightRun?: PlaywrightRunProfile;
  auth: AuthProfile;
  locatorPolicy: string[];
  moduleMap: Record<string, string>;
  reuseRoots: string[];
  unit?: UnitProfile;
  updatedAt: string;
};

export type DiscoverResult = {
  profile: ProjectProfile;
  notes: string[];
};

export type ProfileIo = {
  listFiles: (projectRoot: string, extensions?: string[]) => Promise<string[]>;
  readFile: (projectRoot: string, pathRel: string) => Promise<string>;
  writeFile: (projectRoot: string, pathRel: string, content: string) => Promise<void>;
  readFileOptional: (projectRoot: string, pathRel: string) => Promise<string | null>;
  fileExists: (projectRoot: string, pathRel: string) => Promise<boolean>;
};
