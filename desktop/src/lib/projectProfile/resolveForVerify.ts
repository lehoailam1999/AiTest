import type { E2EFileDto } from "../../api";
import { DEFAULT_SHARED_STORAGE } from "./constants.js";
import type { ProfileIo, ProjectProfile } from "./types.js";
import { loadProjectProfile } from "./loadSaveProfile.js";
import { createTauriProfileIo } from "./tauriIo.js";
import {
  findAuthSeedCredentialsOnDisk,
  findValidStorageStateInFiles,
  findValidStorageStateOnDisk,
  isValidStorageStateJson,
} from "./storageStateValidation.js";

export type VerifyProfileUiFallback = {
  targetUrl?: string;
  useStorageState?: boolean;
  storageStateRel?: string;
  username?: string;
  password?: string;
  role?: string;
  /** Optional verify bundle — checked before disk */
  files?: Array<{ path: string; content?: string }>;
};

export type VerifyProfileContext = {
  profile: ProjectProfile | null;
  storageStateValid: boolean;
  storageStateSource?: "disk" | "bundle" | "ui" | "auth-seed";
  storageStateProjectRel?: string;
  storageStateContent?: string;
  /** UI-login credentials resolved from auth-seed when storageState cookies missing */
  resolvedUsername?: string;
  resolvedPassword?: string;
  packageRoot: string;
  playwrightInstalled: boolean;
  playwrightSource?: "project" | "aitest-shared" | "none";
  preflightErrors: string[];
  defaultBaseURL?: string;
  canonicalStorageRel?: string;
  sharedStorageRel?: string;
  testIdAttribute?: string;
  authStrategy: "storageState" | "uiLogin" | "public";
};

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function checkSharedAitestPlaywright(): Promise<boolean> {
  // Mirror api/aitest_playwright_runner.py — ~/.aitest/playwright-runner
  try {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { access } = await import("node:fs/promises");
    const home = (process.env.AITEST_HOME || "").trim() || join(homedir(), ".aitest");
    const marker = join(home, "playwright-runner", "node_modules", "@playwright", "test");
    await access(marker);
    return true;
  } catch {
    return false;
  }
}

async function checkPlaywrightInstalled(
  projectRoot: string,
  packageRoot: string,
  io: ProfileIo
): Promise<"project" | "aitest-shared" | "none"> {
  const prefix = packageRoot ? `${norm(packageRoot)}/` : "";
  const candidates = [
    `${prefix}node_modules/@playwright/test/package.json`,
    "node_modules/@playwright/test/package.json",
  ];
  for (const rel of candidates) {
    if (await io.fileExists(projectRoot, rel)) return "project";
  }
  const files = await io.listFiles(projectRoot);
  if (files.some((f) => norm(f).includes("node_modules/@playwright/test/"))) {
    return "project";
  }
  // Monorepo/workspace: package may be declared at packageRoot even when node_modules
  // is not listed by file provider (or uses non-standard linker).
  const checkPkg = (raw: string | null): boolean => {
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Boolean(
        parsed?.dependencies?.["@playwright/test"] ||
          parsed?.devDependencies?.["@playwright/test"]
      );
    } catch {
      return false;
    }
  };
  const pkgJsonPath = `${prefix}package.json`;
  if (checkPkg(await io.readFileOptional(projectRoot, pkgJsonPath))) {
    return "project";
  }
  // Monorepo fallback: scan package.json files for declared @playwright/test.
  const pkgFiles = files
    .map((f) => norm(f))
    .filter((f) => /(?:^|\/)package\.json$/i.test(f))
    .slice(0, 80);
  for (const rel of pkgFiles) {
    if (checkPkg(await io.readFileOptional(projectRoot, rel))) {
      return "project";
    }
  }
  if (await checkSharedAitestPlaywright()) return "aitest-shared";
  return "none";
}

export async function resolveProfileForVerify(
  projectRoot: string,
  ui: VerifyProfileUiFallback,
  io?: ProfileIo
): Promise<VerifyProfileContext> {
  const profileIo = io ?? createTauriProfileIo();
  const profile = await loadProjectProfile(projectRoot, profileIo);
  const pw = profile?.playwrightRun;
  const authStrategy =
    profile?.auth?.strategy ||
    (ui.useStorageState ? "storageState" : "uiLogin");
  const packageRoot = pw?.packageRoot ?? "";
  const playwrightSource = await checkPlaywrightInstalled(
    projectRoot,
    packageRoot,
    profileIo
  );
  const playwrightInstalled = playwrightSource !== "none";

  const discoverDirs = pw?.storageState?.discoverDirs ?? [".ai-test/auth"];
  const canonicalRel = pw?.storageState?.canonicalRel ?? "./fixtures/storageState.json";
  const sharedRel = pw?.storageState?.sharedRel ?? DEFAULT_SHARED_STORAGE;

  const ctx: VerifyProfileContext = {
    profile,
    storageStateValid: false,
    packageRoot,
    playwrightInstalled,
    playwrightSource,
    preflightErrors: [],
    defaultBaseURL: pw?.defaultBaseURL,
    canonicalStorageRel: canonicalRel,
    sharedStorageRel: sharedRel,
    testIdAttribute: pw?.testIdAttribute,
    authStrategy,
  };

  if (!playwrightInstalled) {
    const where = packageRoot || "project root";
    ctx.preflightErrors.push(
      `PreconditionFailed: @playwright/test not found under ${where} ` +
        `(and no AITest shared runner ~/.aitest/playwright-runner). ` +
        `Run: npm i -D @playwright/test — or install shared runner in AITest.`
    );
  }

  const needsStorage =
    authStrategy === "storageState" ||
    Boolean(ui.useStorageState) ||
    Boolean(ui.storageStateRel?.trim());

  if (!needsStorage) {
    ctx.storageStateValid = true;
    return ctx;
  }

  const bundleRels = [sharedRel, canonicalRel, DEFAULT_SHARED_STORAGE];
  if (ui.files?.length) {
    const inBundle = findValidStorageStateInFiles(ui.files, bundleRels);
    if (inBundle) {
      ctx.storageStateValid = true;
      ctx.storageStateSource = "bundle";
      ctx.storageStateProjectRel = inBundle.projectRel;
      ctx.storageStateContent = inBundle.content;
      return ctx;
    }
  }

  const onDisk = await findValidStorageStateOnDisk(
    projectRoot,
    discoverDirs,
    (root) => profileIo.listFiles(root),
    (root, rel) => profileIo.readFileOptional(root, rel)
  );

  if (onDisk) {
    ctx.storageStateValid = true;
    ctx.storageStateSource = "disk";
    ctx.storageStateProjectRel = onDisk.projectRel;
    ctx.storageStateContent = onDisk.content;
    return ctx;
  }

  if (ui.storageStateRel?.trim()) {
    const rel = norm(ui.storageStateRel);
    const content = await profileIo.readFileOptional(projectRoot, rel);
    if (content && isValidStorageStateJson(content)) {
      ctx.storageStateValid = true;
      ctx.storageStateSource = "ui";
      ctx.storageStateProjectRel = rel;
      ctx.storageStateContent = content;
      return ctx;
    }
  }

  // If explicit credentials exist, allow UI-login fallback without blocking verify.
  // storageState remains optional in this mode.
  const hasUiCreds = Boolean((ui.username || "").trim() && (ui.password || "").trim());
  if (hasUiCreds) {
    ctx.storageStateValid = true;
    ctx.storageStateSource = "ui";
    ctx.resolvedUsername = (ui.username || "").trim();
    ctx.resolvedPassword = (ui.password || "").trim();
    ctx.authStrategy = "uiLogin";
    return ctx;
  }

  // Auth Discover often writes credential seeds (username/password) under .ai-test/auth/*.json
  // before a real Playwright storageState (cookies/origins) exists — use UI-login fallback.
  const seed = await findAuthSeedCredentialsOnDisk(
    projectRoot,
    discoverDirs,
    (root) => profileIo.listFiles(root),
    (root, rel) => profileIo.readFileOptional(root, rel),
    ui.role || profile?.auth?.roles?.[0]
  );
  if (seed) {
    ctx.storageStateValid = true;
    ctx.storageStateSource = "auth-seed";
    ctx.storageStateProjectRel = seed.projectRel;
    ctx.resolvedUsername = seed.username;
    ctx.resolvedPassword = seed.password;
    ctx.authStrategy = "uiLogin";
    return ctx;
  }

  ctx.preflightErrors.push(
    "PreconditionFailed: storageState missing or invalid — run Auth Discover / Seed login " +
      `(expected Playwright cookies under ${discoverDirs.join(", ")} or ${canonicalRel}; ` +
      `or auth-seed username/password JSON)`
  );
  return ctx;
}

/**
 * Ensure valid storageState exists in verify file bundle at shared + TC fixture paths.
 */
export function applyStorageStateToVerifyFiles(
  files: E2EFileDto[],
  ctx: VerifyProfileContext
): E2EFileDto[] {
  if (!ctx.storageStateValid || !ctx.storageStateContent) return files;

  const content = ctx.storageStateContent;
  const targets = new Set<string>();
  if (ctx.sharedStorageRel) targets.add(norm(ctx.sharedStorageRel));
  targets.add(norm(DEFAULT_SHARED_STORAGE));

  for (const f of files) {
    const p = norm(f.path);
    if (/storageState[^/]*\.json$/i.test(p)) targets.add(p);
    if (p.endsWith("/fixtures/storageState.json")) targets.add(p);
  }

  const byPath = new Map(files.map((f) => [norm(f.path), f]));
  for (const rel of targets) {
    byPath.set(rel, {
      path: rel,
      content,
      kind: "fixture",
    });
  }
  return [...byPath.values()];
}

export function resolveVerifyStorageStateRel(
  ctx: VerifyProfileContext,
  uiRel?: string
): string | undefined {
  if (uiRel?.trim()) return uiRel.trim().replace(/\\/g, "/");
  if (ctx.canonicalStorageRel) return ctx.canonicalStorageRel;
  return undefined;
}

export function formatVerifyProfileLog(ctx: VerifyProfileContext): string {
  const parts = [
    `profile=${ctx.profile ? "loaded" : "none"}`,
    `packageRoot=${ctx.packageRoot || "(root)"}`,
    `playwright=${ctx.playwrightSource || (ctx.playwrightInstalled ? "yes" : "no")}`,
    `auth=${ctx.authStrategy}`,
    `storageValid=${ctx.storageStateValid ? "yes" : "no"}`,
    ctx.storageStateSource ? `storageSource=${ctx.storageStateSource}` : "",
    ctx.storageStateProjectRel ? `storageFile=${ctx.storageStateProjectRel}` : "",
    ctx.resolvedUsername ? `user=${ctx.resolvedUsername}` : "",
    ctx.testIdAttribute ? `testId=${ctx.testIdAttribute}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}
