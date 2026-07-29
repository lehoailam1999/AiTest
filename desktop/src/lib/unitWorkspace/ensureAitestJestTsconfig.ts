/**
 * Scaffold [{pkg}/]AItest/tsconfig.json + jest.config so Jest finds tests under
 * AItest/ (Nest default only scans src/ + .spec.ts under src).
 */
import { readTextFile, writeTextFile } from "../../tauri/bridge";
import { AITEST_ROOT, aitestRootFromTarget } from "../testOutputLayout";
import { overlayRelPath } from "./paths";
import { textFileEquals, writeTextFileIfChanged } from "./contentDedup";
import type { UnitWorkspaceManifest } from "./types";

async function pathExists(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    return true;
  } catch {
    return false;
  }
}

function joinRoot(projectRoot: string, rel: string): string {
  const base = projectRoot.replace(/[/\\]+$/, "").replace(/\\/g, "/");
  return `${base}/${rel.replace(/\\/g, "/")}`;
}

function normPkg(packagePrefix?: string | null): string {
  return (packagePrefix || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Relative path to AItest Jest config from project root. */
export function aitestJestConfigRel(packagePrefix?: string | null): string {
  const pkg = normPkg(packagePrefix);
  return pkg ? `${pkg}/AItest/jest.config.cjs` : "AItest/jest.config.cjs";
}

/**
 * Jest command that finds AItest test files — never Nest's src-only npm test.
 * Uses absolute --config so cwd (repo root vs package) does not break resolution.
 */
export function buildAitestJestCommand(
  projectRoot: string,
  packagePrefix?: string | null,
  opts?: { coverage?: boolean }
): string {
  const root = projectRoot.replace(/[/\\]+$/, "").replace(/\\/g, "/");
  let pkg = normPkg(packagePrefix);
  // If project root IS the package (…/backend), don't prefix again with "backend".
  if (pkg) {
    const base = root.split("/").pop()?.toLowerCase() || "";
    if (base === pkg.toLowerCase() || base === pkg.split("/").pop()?.toLowerCase()) {
      pkg = "";
    }
  }
  const rel = pkg ? `${pkg}/AItest/jest.config.cjs` : "AItest/jest.config.cjs";
  const abs = `${root}/${rel}`.replace(/\/{2,}/g, "/");
  const cov = opts?.coverage ? " --coverage" : "";
  return `npx jest --config "${abs}" --runInBand --passWithNoTests${cov}`;
}

/** True when cmd is Nest/default npm test / bare jest without AItest config. */
export function isDefaultNpmJestCommand(cmd: string): boolean {
  const c = (cmd || "").trim().toLowerCase();
  if (!c || /vitest/.test(c)) return false;
  if (c.includes("aitest/jest.config")) return false;
  if (c.includes("--config") && /jest\.config/.test(c)) return false;
  return (
    /^(npm\s+test|npm\s+run\s+test)\b/.test(c) ||
    /^(npx\s+)?jest\b/.test(c) ||
    (/\bnpm\b/.test(c) && /\btest\b/.test(c) && !/vitest/.test(c))
  );
}

/** @deprecated use aitestRootFromTarget */
export function aitestFolderFromTarget(targetRel?: string | null): string {
  return aitestRootFromTarget(targetRel);
}

export async function discoverJestTypeRootsAbs(
  projectRoot: string,
  packagePrefix?: string | null
): Promise<string[]> {
  const pkg = normPkg(packagePrefix);
  const candidates = [
    ...(pkg ? [`${pkg}/node_modules/@types`] : []),
    "node_modules/@types",
  ];
  const found: string[] = [];
  for (const root of candidates) {
    const jestPkg = `${root}/jest/package.json`;
    const jestIndex = `${root}/jest/index.d.ts`;
    if ((await pathExists(projectRoot, jestPkg)) || (await pathExists(projectRoot, jestIndex))) {
      found.push(joinRoot(projectRoot, root));
    }
  }
  if (found.length === 0) {
    return candidates.map((r) => joinRoot(projectRoot, r));
  }
  return [...new Set(found)];
}

/**
 * Self-contained Jest/ts-jest tsconfig (no `extends`) so Nest parent `baseUrl` /
 * `moduleResolution: node` deprecations (TS 6 → removed in 7) do not leak in.
 * Paths replace baseUrl; bundler+commonjs is the TS 6 migration path for Jest.
 */
export function buildAitestJestTsconfig(typeRootsAbs: string[]): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2021",
        lib: ["ES2021"],
        rootDir: "..",
        noEmit: true,
        module: "commonjs",
        moduleResolution: "bundler",
        isolatedModules: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: false,
        skipLibCheck: true,
        types: ["jest", "node"],
        typeRoots: typeRootsAbs,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        // Replace deprecated baseUrl — prefix inlined into paths (TS 6+).
        paths: {
          "src/*": ["../src/*"],
          "@/*": ["../src/*"],
        },
      },
      include: [
        "./**/*.ts",
        "./**/*.tsx",
        "../src/**/*.ts",
        "../src/**/*.tsx",
        "../src/**/*.js",
        "../src/**/*.jsx",
      ],
      exclude: ["../node_modules", "../dist", "../build"],
    },
    null,
    2
  )}\n`;
}

/**
 * Jest config next to AItest/ — rootDir = package (parent of AItest) via __dirname
 * so Nest's package.json jest (rootDir: src, testRegex: *.spec.ts) is never used.
 */
export function buildAitestJestConfigJs(): string {
  return `/** Generated by AITest — do not use Nest package.json jest (src-only). */
const path = require("path");
const pkgRoot = path.join(__dirname, "..");

module.exports = {
  rootDir: pkgRoot,
  moduleFileExtensions: ["js", "json", "ts", "tsx"],
  testMatch: [
    "<rootDir>/AItest/**/*.test.ts",
    "<rootDir>/AItest/**/*.test.tsx",
    "<rootDir>/AItest/**/*.spec.ts",
    "<rootDir>/AItest/**/*.spec.tsx",
    "<rootDir>/AItest/**/*.test.js",
    "<rootDir>/AItest/**/*.spec.js",
  ],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/build/"],
  transform: {
    "^.+\\\\.(t|j)sx?$": [
      "ts-jest",
      {
        tsconfig: path.join(__dirname, "tsconfig.json"),
      },
    ],
  },
  testEnvironment: "node",
  moduleNameMapper: {
    "^src/(.*)$": "<rootDir>/src/$1",
    "^@/(.*)$": "<rootDir>/src/$1",
  },
};
`;
}

export async function ensureAitestJestTsconfigInWorkspace(input: {
  projectRoot: string;
  manifest: UnitWorkspaceManifest;
  targetRel?: string | null;
}): Promise<UnitWorkspaceManifest> {
  const packagePrefix = input.manifest.packagePrefix;
  const typeRoots = await discoverJestTypeRootsAbs(input.projectRoot, packagePrefix);
  const tsconfigContent = buildAitestJestTsconfig(typeRoots);
  const jestContent = buildAitestJestConfigJs();
  const aitestFolder =
    aitestRootFromTarget(input.targetRel) ||
    (packagePrefix ? `${normPkg(packagePrefix)}/${AITEST_ROOT}` : AITEST_ROOT);

  let files = [...input.manifest.files];
  const writes: { rel: string; content: string }[] = [
    { rel: `${aitestFolder}/tsconfig.json`, content: tsconfigContent },
    { rel: `${aitestFolder}/jest.config.cjs`, content: jestContent },
  ];

  for (const w of writes) {
    // Shared scaffold already on disk with same bytes → do not clone into this
    // run's .ai-test overlay (N jobs × identical jest/tsconfig was pure waste).
    // Verify still uses on-disk AItest/jest.config.cjs.
    if (await textFileEquals(input.projectRoot, w.rel, w.content)) {
      files = files.filter((f) => f.targetRel !== w.rel);
      continue;
    }

    const workspaceRel = overlayRelPath(input.manifest.runId, w.rel, packagePrefix);
    await writeTextFile(input.projectRoot, workspaceRel, w.content);
    // Refresh on-disk scaffold when content changed (broken Nest-extends, etc.).
    await writeTextFileIfChanged(input.projectRoot, w.rel, w.content);

    const exists = await pathExists(input.projectRoot, w.rel);
    files = files.filter((f) => f.targetRel !== w.rel);
    files.push({
      op: exists ? "modify" : "new",
      targetRel: w.rel,
      workspaceRel,
    });
  }

  return {
    ...input.manifest,
    files,
  };
}

export function looksLikeJestTsTest(targetRel: string, content: string): boolean {
  const rel = targetRel.replace(/\\/g, "/").toLowerCase();
  const isTs = /\.(ts|tsx|js|jsx)$/.test(rel) && !/\.d\.ts$/.test(rel);
  if (!isTs) return false;
  if (!/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(rel) && !rel.includes("/unittest/")) {
    return false;
  }
  const body = content.slice(0, 4000);
  return (
    /\b(describe|beforeEach|afterEach|it|test|expect)\s*\(/.test(body) ||
    /\bjest\.(mock|fn|spyOn)\b/.test(body)
  );
}

export function manifestHasAitestTests(manifest: UnitWorkspaceManifest): boolean {
  return manifest.files.some((f) => {
    if (f.op === "delete") return false;
    const p = f.targetRel.replace(/\\/g, "/");
    return /(?:^|\/)AItest\//i.test(p) && /\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(p);
  });
}
