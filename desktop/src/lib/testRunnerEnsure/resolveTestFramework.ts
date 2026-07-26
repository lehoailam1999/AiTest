import type { ProjectMeta } from "../../api/types";
import type { ProjectScan } from "../../tauri/bridge";
import type {
  PackageManager,
  TestFrameworkId,
  TestFrameworkResolution,
} from "./types";

const NODE_TEST_DEPS: { id: TestFrameworkId; label: string; keys: string[] }[] = [
  { id: "vitest", label: "Vitest", keys: ["vitest"] },
  { id: "jest", label: "Jest", keys: ["jest", "@jest/core"] },
  { id: "mocha", label: "Mocha", keys: ["mocha"] },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

export function detectPackageManager(rootFiles: string[]): PackageManager {
  const names = rootFiles.map((f) => f.replace(/\\/g, "/").split("/").pop()!.toLowerCase());
  if (names.includes("pnpm-lock.yaml")) return "pnpm";
  if (names.includes("yarn.lock")) return "yarn";
  if (names.includes("bun.lock") || names.includes("bun.lockb")) return "bun";
  if (names.includes("package-lock.json")) return "npm";
  if (names.some((n) => n.endsWith(".csproj") || n.endsWith(".sln"))) return "dotnet";
  if (
    names.includes("pyproject.toml") ||
    names.includes("requirements.txt") ||
    names.includes("pipfile")
  ) {
    return "pip";
  }
  if (names.includes("package.json")) return "npm";
  return "unknown";
}

export function parsePackageJsonDeps(content: string): {
  deps: Set<string>;
  hasVite: boolean;
  hasReactScripts: boolean;
  hasNext: boolean;
} {
  const deps = new Set<string>();
  let hasVite = false;
  let hasReactScripts = false;
  let hasNext = false;
  try {
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [k] of Object.entries(pkg.dependencies ?? {})) deps.add(k.toLowerCase());
    for (const [k] of Object.entries(pkg.devDependencies ?? {})) deps.add(k.toLowerCase());
    hasVite = deps.has("vite") || deps.has("@vitejs/plugin-react");
    hasReactScripts = deps.has("react-scripts");
    hasNext = deps.has("next");
  } catch {
    /* ignore */
  }
  return { deps, hasVite, hasReactScripts, hasNext };
}

function buildNodeInstall(pm: PackageManager, packages: string[]): string {
  const list = packages.join(" ");
  switch (pm) {
    case "pnpm":
      return `pnpm add -D ${list}`;
    case "yarn":
      return `yarn add -D ${list}`;
    case "bun":
      return `bun add -d ${list}`;
    default:
      return `npm install -D ${list}`;
  }
}

function suggestNodeFramework(input: {
  hasVite: boolean;
  hasReactScripts: boolean;
  hasNext: boolean;
  stacks: string[];
}): { id: TestFrameworkId; label: string; packages: string[]; reason: string } {
  const stacks = input.stacks.map(norm).join(" ");
  if (input.hasVite || stacks.includes("vite")) {
    return {
      id: "vitest",
      label: "Vitest",
      packages: ["vitest"],
      reason: "Phát hiện Vite → đề xuất Vitest",
    };
  }
  if (input.hasReactScripts || stacks.includes("createreactapp")) {
    return {
      id: "jest",
      label: "Jest",
      packages: ["jest", "@types/jest"],
      reason: "Phát hiện Create React App / react-scripts → đề xuất Jest",
    };
  }
  if (input.hasNext || stacks.includes("next.js") || stacks.includes("next")) {
    return {
      id: "jest",
      label: "Jest",
      packages: ["jest", "@types/jest"],
      reason: "Phát hiện Next.js → đề xuất Jest",
    };
  }
  return {
    id: "vitest",
    label: "Vitest",
    packages: ["vitest"],
    reason: "Node/TS chưa có test runner → đề xuất Vitest",
  };
}

function fromMetaOrScan(
  meta: ProjectMeta | null | undefined,
  scan: ProjectScan | null | undefined
): { ids: string[]; stacks: string[]; language: string } {
  const ids = uniq([
    ...(meta?.testFrameworks ?? []),
    ...(scan?.testFrameworks ?? []),
  ]).map(norm);
  const stacks = uniq([...(meta?.stacks ?? []), ...(scan?.stacks ?? [])]).map(norm);
  const language = (scan?.language ?? "").toLowerCase();
  return { ids, stacks, language };
}

function matchKnownId(token: string): TestFrameworkId | null {
  const t = norm(token);
  if (t.includes("vitest")) return "vitest";
  if (t.includes("jest")) return "jest";
  if (t.includes("mocha")) return "mocha";
  if (t.includes("xunit")) return "xunit";
  if (t.includes("nunit")) return "nunit";
  if (t.includes("mstest")) return "mstest";
  if (t.includes("pytest")) return "pytest";
  if (t.includes("unittest")) return "unittest";
  if (t.includes("junit")) return "junit";
  if (t.includes("gotest") || t === "go") return "gotest";
  if (t.includes("phpunit")) return "phpunit";
  return null;
}

function detectDotnetTestFwFromCsproj(
  content: string | null | undefined
): { id: TestFrameworkId; label: string; evidence: string } | null {
  if (!content) return null;
  const lower = content.toLowerCase();
  if (lower.includes("xunit")) {
    return { id: "xunit", label: "xUnit", evidence: "PackageReference xunit" };
  }
  if (lower.includes("nunit")) {
    return { id: "nunit", label: "NUnit", evidence: "PackageReference nunit" };
  }
  if (lower.includes("mstest") || lower.includes("microsoft.visualstudio.testplatform")) {
    return { id: "mstest", label: "MSTest", evidence: "PackageReference MSTest" };
  }
  return null;
}

function presentFromScanOrMeta(
  ids: string[],
  stacks: string[],
  pm: PackageManager
): TestFrameworkResolution | null {
  for (const id of ids) {
    const fw = matchKnownId(id);
    if (fw) {
      return {
        status: "present",
        framework: fw,
        label: id,
        reason: "Nhận diện từ scan project / meta đã đồng bộ",
        packageManager: pm,
        packages: [],
        installCommand: null,
        evidence: [id],
        locked: true,
      };
    }
  }
  for (const s of stacks) {
    const fw = matchKnownId(s);
    if (fw && ["vitest", "jest", "mocha", "xunit", "nunit", "mstest", "pytest"].includes(fw)) {
      return {
        status: "present",
        framework: fw,
        label: s,
        reason: `Stack marker: ${s}`,
        packageManager: pm,
        packages: [],
        installCommand: null,
        evidence: [s],
        locked: true,
      };
    }
  }
  return null;
}

/** Language / source file under test — dùng để không lấy Jest từ ClientApp khi đang test C#. */
export function languageFamilyFromHints(
  preferredLanguage?: string | null,
  sourceFile?: string | null
): "dotnet" | "node" | "python" | "go" | "other" {
  const lang = (preferredLanguage || "").toLowerCase();
  const file = (sourceFile || "").toLowerCase().replace(/\\/g, "/");
  if (
    file.endsWith(".cs") ||
    lang.includes("c#") ||
    lang.includes("csharp") ||
    lang.includes(".net")
  ) {
    return "dotnet";
  }
  if (
    file.match(/\.(tsx?|jsx?)$/) ||
    lang.includes("typescript") ||
    lang.includes("javascript") ||
    lang.includes("node")
  ) {
    return "node";
  }
  if (file.endsWith(".py") || lang.includes("python")) return "python";
  if (file.endsWith(".go") || lang.includes("go")) return "go";
  return "other";
}

/**
 * Resolve test framework from scan/meta + optional package.json / requirements / csproj.
 *
 * Priority (scoped by source language when known):
 * 1. Explicit test deps matching the source family (Node ↔ package.json, .NET ↔ csproj/scan)
 * 2. Scan/meta testFrameworks
 * 3. Heuristic đề xuất theo ngôn ngữ / stack
 *
 * Forensic-style monorepo: C# + Angular ClientApp — không lấy Jest khi đang sinh unit cho .cs.
 */
export function resolveTestFramework(input: {
  meta?: ProjectMeta | null;
  scan?: ProjectScan | null;
  packageJsonContent?: string | null;
  requirementsContent?: string | null;
  csprojContent?: string | null;
  rootFileNames?: string[];
  preferredCsproj?: string | null;
  /** Language of the file / TC under test (not whole-repo mashup). */
  preferredLanguage?: string | null;
  /** Relative path of source under test (e.g. Services/Foo.cs). */
  sourceFile?: string | null;
}): TestFrameworkResolution {
  const { ids, stacks, language } = fromMetaOrScan(input.meta, input.scan);
  const family = languageFamilyFromHints(
    input.preferredLanguage || language,
    input.sourceFile
  );
  const rootFiles = input.rootFileNames ?? [
    ...(input.scan?.solutionFiles ?? []),
    ...(input.scan?.csprojFiles ?? []),
  ];
  const pm = detectPackageManager([
    ...rootFiles,
    ...(input.packageJsonContent ? ["package.json"] : []),
    ...(input.requirementsContent ? ["requirements.txt"] : []),
    ...(stacks.includes("node.js") || stacks.includes("nodejs") ? ["package.json"] : []),
  ]);

  let nodeSuggestion: ReturnType<typeof suggestNodeFramework> | null = null;
  let nodePm: PackageManager =
    pm === "dotnet" || pm === "pip" ? "npm" : pm === "unknown" ? "npm" : pm;
  let nodeEvidence: string[] = [];
  let nodePresent: TestFrameworkResolution | null = null;

  if (input.packageJsonContent && family !== "dotnet" && family !== "python") {
    const { deps, hasVite, hasReactScripts, hasNext } = parsePackageJsonDeps(
      input.packageJsonContent
    );
    for (const row of NODE_TEST_DEPS) {
      if (row.keys.some((k) => deps.has(k))) {
        const needsJestTypes = row.id === "jest" && !deps.has("@types/jest");
        nodePresent = {
          status: needsJestTypes ? "missing" : "present",
          framework: row.id,
          label: row.label,
          reason: needsJestTypes
            ? "Có Jest nhưng thiếu @types/jest — IDE sẽ báo Cannot find name 'beforeEach'"
            : `Đã có trong package.json: ${row.keys.find((k) => deps.has(k))}`,
          packageManager: pm === "unknown" ? "npm" : pm,
          packages: needsJestTypes ? ["@types/jest"] : [],
          installCommand: needsJestTypes
            ? buildNodeInstall(pm === "unknown" ? "npm" : pm, ["@types/jest"])
            : null,
          evidence: [...deps].filter((d) => row.keys.includes(d) || d === "@types/jest"),
          locked: !needsJestTypes,
        };
        break;
      }
    }
    if (!nodePresent) {
      nodeSuggestion = suggestNodeFramework({
        hasVite,
        hasReactScripts,
        hasNext,
        stacks,
      });
      nodePm = pm === "dotnet" || pm === "pip" ? "npm" : pm === "unknown" ? "npm" : pm;
      nodeEvidence = uniq([
        hasVite ? "vite" : "",
        hasReactScripts ? "react-scripts" : "",
        hasNext ? "next" : "",
      ]);
    }
  } else if (input.packageJsonContent && family === "other") {
    // Unknown source — still parse Node so pure-SPA repos keep working
    const { deps, hasVite, hasReactScripts, hasNext } = parsePackageJsonDeps(
      input.packageJsonContent
    );
    for (const row of NODE_TEST_DEPS) {
      if (row.keys.some((k) => deps.has(k))) {
        const needsJestTypes = row.id === "jest" && !deps.has("@types/jest");
        nodePresent = {
          status: needsJestTypes ? "missing" : "present",
          framework: row.id,
          label: row.label,
          reason: needsJestTypes
            ? "Có Jest nhưng thiếu @types/jest — IDE sẽ báo Cannot find name 'beforeEach'"
            : `Đã có trong package.json: ${row.keys.find((k) => deps.has(k))}`,
          packageManager: pm === "unknown" ? "npm" : pm,
          packages: needsJestTypes ? ["@types/jest"] : [],
          installCommand: needsJestTypes
            ? buildNodeInstall(pm === "unknown" ? "npm" : pm, ["@types/jest"])
            : null,
          evidence: [...deps].filter((d) => row.keys.includes(d) || d === "@types/jest"),
          locked: !needsJestTypes,
        };
        break;
      }
    }
    if (!nodePresent) {
      nodeSuggestion = suggestNodeFramework({
        hasVite,
        hasReactScripts,
        hasNext,
        stacks,
      });
      nodePm = pm === "dotnet" || pm === "pip" ? "npm" : pm === "unknown" ? "npm" : pm;
      nodeEvidence = uniq([
        hasVite ? "vite" : "",
        hasReactScripts ? "react-scripts" : "",
        hasNext ? "next" : "",
      ]);
    }
  }

  // .NET under test: scan/csproj trước — bỏ qua Jest từ ClientApp
  if (family === "dotnet") {
    const fromScanDotnet = presentFromScanOrMeta(
      ids.filter((id) => {
        const fw = matchKnownId(id);
        return fw === "xunit" || fw === "nunit" || fw === "mstest";
      }),
      stacks,
      "dotnet"
    );
    if (fromScanDotnet) return fromScanDotnet;

    const fromCsproj = detectDotnetTestFwFromCsproj(input.csprojContent);
    if (fromCsproj) {
      return {
        status: "present",
        framework: fromCsproj.id,
        label: fromCsproj.label,
        reason: `Đã có trong .csproj: ${fromCsproj.evidence}`,
        packageManager: "dotnet",
        packages: [],
        installCommand: null,
        evidence: [fromCsproj.evidence],
        locked: true,
      };
    }

    const anyScan = presentFromScanOrMeta(ids, stacks, pm);
    if (
      anyScan &&
      (anyScan.framework === "xunit" ||
        anyScan.framework === "nunit" ||
        anyScan.framework === "mstest")
    ) {
      return anyScan;
    }

    const csproj =
      input.preferredCsproj ||
      input.scan?.testProjects?.[0] ||
      input.scan?.csprojFiles?.[0] ||
      null;
    const cmd = csproj
      ? `dotnet add "${csproj}" package Xunit && dotnet add "${csproj}" package xunit.runner.visualstudio`
      : `dotnet new xunit -n AItest.UnitTests -o AItest/UnitTest --force`;
    return {
      status: "missing",
      framework: "xunit",
      label: "xUnit",
      reason:
        "Source đang test là C#/.NET — dùng xUnit (bỏ qua Jest/Vitest từ ClientApp nếu có)",
      packageManager: "dotnet",
      packages: ["Xunit", "xunit.runner.visualstudio"],
      installCommand: cmd,
      evidence: input.scan?.csprojFiles?.slice(0, 3) ?? [],
      locked: false,
    };
  }

  if (nodePresent) return nodePresent;

  // Scan/meta đã thấy framework thật — không bị package.json trống ghi đè
  const fromScan = presentFromScanOrMeta(ids, stacks, pm);
  if (fromScan) {
    // Node under test: đừng khóa xUnit của backend khi đang test .ts
    if (family === "node") {
      if (
        fromScan.framework === "vitest" ||
        fromScan.framework === "jest" ||
        fromScan.framework === "mocha"
      ) {
        return fromScan;
      }
    } else {
      return fromScan;
    }
  }

  const fromCsproj = detectDotnetTestFwFromCsproj(input.csprojContent);
  if (fromCsproj) {
    return {
      status: "present",
      framework: fromCsproj.id,
      label: fromCsproj.label,
      reason: `Đã có trong .csproj: ${fromCsproj.evidence}`,
      packageManager: "dotnet",
      packages: [],
      installCommand: null,
      evidence: [fromCsproj.evidence],
      locked: true,
    };
  }

  // Node không có test runner → đề xuất theo stack (chỉ khi không phải project .NET rõ ràng)
  const isDotnet =
    language.includes("c#") ||
    language.includes("csharp") ||
    stacks.some((s) => s.includes("asp.net") || s.includes(".net")) ||
    (input.scan?.csprojFiles?.length ?? 0) > 0;

  if (nodeSuggestion && !isDotnet) {
    return {
      status: "missing",
      framework: nodeSuggestion.id,
      label: nodeSuggestion.label,
      reason: nodeSuggestion.reason,
      packageManager: nodePm,
      packages: nodeSuggestion.packages,
      installCommand: buildNodeInstall(nodePm, nodeSuggestion.packages),
      evidence: nodeEvidence,
      locked: false,
    };
  }

  if (isDotnet) {
    const csproj =
      input.preferredCsproj ||
      input.scan?.testProjects?.[0] ||
      input.scan?.csprojFiles?.[0] ||
      null;
    const pkg = "Xunit";
    const cmd = csproj
      ? `dotnet add "${csproj}" package ${pkg} && dotnet add "${csproj}" package xunit.runner.visualstudio`
      : `dotnet new xunit -n AItest.UnitTests -o AItest/UnitTest --force`;
    return {
      status: "missing",
      framework: "xunit",
      label: "xUnit",
      reason: "Project .NET chưa thấy xUnit/NUnit/MSTest → đề xuất xUnit",
      packageManager: "dotnet",
      packages: ["Xunit", "xunit.runner.visualstudio"],
      installCommand: cmd,
      evidence: input.scan?.csprojFiles?.slice(0, 3) ?? [],
      locked: false,
    };
  }

  if (nodeSuggestion) {
    return {
      status: "missing",
      framework: nodeSuggestion.id,
      label: nodeSuggestion.label,
      reason: nodeSuggestion.reason,
      packageManager: nodePm,
      packages: nodeSuggestion.packages,
      installCommand: buildNodeInstall(nodePm, nodeSuggestion.packages),
      evidence: nodeEvidence,
      locked: false,
    };
  }

  const isPython =
    language.includes("python") ||
    stacks.some((s) => s.includes("fastapi") || s.includes("django")) ||
    Boolean(input.requirementsContent);

  if (isPython) {
    const req = (input.requirementsContent || "").toLowerCase();
    if (req.includes("pytest")) {
      return {
        status: "present",
        framework: "pytest",
        label: "pytest",
        reason: "Đã khai báo pytest trong requirements/pyproject",
        packageManager: "pip",
        packages: [],
        installCommand: null,
        evidence: ["pytest"],
        locked: true,
      };
    }
    return {
      status: "missing",
      framework: "pytest",
      label: "pytest",
      reason: "Python chưa có pytest → đề xuất cài pytest",
      packageManager: "pip",
      packages: ["pytest"],
      installCommand: "python -m pip install pytest",
      evidence: [],
      locked: false,
    };
  }

  if (language.includes("go")) {
    return {
      status: "present",
      framework: "gotest",
      label: "go test",
      reason: "Go dùng go test (stdlib)",
      packageManager: "unknown",
      packages: [],
      installCommand: null,
      evidence: ["go"],
      locked: true,
    };
  }

  return {
    status: "unknown",
    framework: "auto",
    label: "Auto",
    reason: "Chưa đủ marker để khóa framework — AI tự chọn theo ngôn ngữ",
    packageManager: pm,
    packages: [],
    installCommand: null,
    evidence: [],
    locked: false,
  };
}
