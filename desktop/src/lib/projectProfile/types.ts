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
  roles: string[];
  loginPath?: string;
};

export type UnitProfile = {
  runner: string;
  testFrameworks: string[];
  mockHint: string;
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
