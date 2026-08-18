/**
 * C# / .NET Unit under [{pkg}/]AItest — project-agnostic.
 *
 * Problem: SDK-style production .csproj compiles every *.cs under the project dir,
 * so staging AItest/** into a library (Application) fails (no xUnit/Moq + duplicate types).
 *
 * Fix (no hard-coded product names):
 * 1. Exclude AItest/** and .ai-test/** from the sibling production .csproj
 * 2. Scaffold [{pkg}/]AItest/AItest.UnitTests.csproj (xUnit + Moq + ProjectReference)
 * 3. Rewrite verify to `dotnet test` that csproj
 * 4. Uniquify test class names (+ constructors) from file hash suffix
 */
import { listSourceFiles, readTextFile, writeTextFile } from "../../tauri/bridge";
import { detectCsharpPackagesFromTestCode } from "@aitest/ide-protocol";
import { overlayRelPath } from "./paths";
import type { UnitWorkspaceManifest } from "./types";
import {
  readDraftText,
  writeDraftText,
  writeDraftTextIfChanged,
} from "./draftStore";

function normPkg(packagePrefix?: string | null): string {
  return (packagePrefix || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function parentDir(rel: string): string {
  const p = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p.includes("/")) return "";
  return p.slice(0, p.lastIndexOf("/"));
}

/** list_source_files returns absolute paths — normalize to project-relative. */
export function toProjectRel(projectRoot: string, raw: string): string {
  let p = (raw || "").replace(/\\/g, "/");
  const root = (projectRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p || !root) return p.replace(/^\.\//, "");
  const pl = p.toLowerCase();
  const rl = root.toLowerCase();
  if (pl === rl) return "";
  if (pl.startsWith(rl + "/")) {
    p = p.slice(root.length).replace(/^\/+/, "");
  }
  return p.replace(/^\.\//, "");
}

/** Infer packagePrefix from first …/AItest/… target (agnostic). */
export function packagePrefixFromAitestTargets(
  targets: Array<{ targetRel: string; op?: string }>
): string {
  for (const f of targets) {
    if (f.op === "delete") continue;
    const norm = f.targetRel.replace(/\\/g, "/");
    const m = norm.match(/^(.*)\/AItest\//i);
    if (m) return m[1];
  }
  return "";
}

/**
 * Relative ProjectReference from {pkg}/AItest/AItest.UnitTests.csproj → SUT .csproj.
 */
export function projectRefFromAitestDir(
  sutRel: string,
  packagePrefix?: string | null
): string {
  const sut = sutRel.replace(/\\/g, "/");
  const file = sut.split("/").pop() || "Sut.csproj";
  const toDir = parentDir(sut);
  const fromDir = normPkg(packagePrefix) ? `${normPkg(packagePrefix)}/AItest` : "AItest";
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toDir.split("/").filter(Boolean);
  let j = 0;
  while (j < fromParts.length && j < toParts.length && fromParts[j] === toParts[j]) j++;
  const ups = fromParts.length - j;
  const down = toParts.slice(j);
  const parts = [...Array(ups).fill(".."), ...down, file];
  return parts.join("\\");
}

async function fileExists(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    return true;
  } catch {
    return false;
  }
}

export function manifestHasAitestCsharpTests(manifest: UnitWorkspaceManifest): boolean {
  return manifest.files.some(
    (f) =>
      f.op !== "delete" &&
      /(?:^|\/)AItest\//i.test(f.targetRel.replace(/\\/g, "/")) &&
      /\.cs$/i.test(f.targetRel)
  );
}

/** Short id from uniquified file name: FooTests_TC032.cs → TC032 (UUID fallback: _a1b2c3d4). */
export function csharpShortIdFromPath(rel: string): string {
  const base = rel.replace(/\\/g, "/").split("/").pop() || "";
  const tc = base.match(/_(TC[A-Za-z0-9]{1,20})\.cs$/i);
  if (tc) return tc[1].toUpperCase();
  const hex = base.match(/_([a-f0-9]{6,12})\.cs$/i);
  return hex ? hex[1].toLowerCase() : "";
}

/**
 * Ensure public test class/record names include file hash so multi-TC batch does not collide.
 * Also renames constructors (avoids CS1520 after class rename).
 */
export function ensureCsharpUniqueTestClass(code: string, shortId: string): string {
  const id = (shortId || "").replace(/[^a-zA-Z0-9_]/g, "");
  if (!id || !code.trim()) return code;
  const renamed = new Map<string, string>();
  let out = code.replace(
    /\b(public\s+)?(partial\s+)?(class|record)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
    (full, vis: string | undefined, partial: string | undefined, kw: string, name: string) => {
      if (!/Tests?$/i.test(name)) return full;
      if (name.toLowerCase().includes(`_${id.toLowerCase()}`)) return full;
      const next = `${name}_${id}`;
      renamed.set(name, next);
      const prefix = `${vis || ""}${partial || ""}`;
      return `${prefix}${kw} ${next}`;
    }
  );
  for (const [oldName, newName] of renamed) {
    // public FooTests( → public FooTests_id(
    const ctor = new RegExp(
      `\\b((?:public|private|protected|internal)\\s+)${oldName}(\\s*\\()`,
      "g"
    );
    out = out.replace(ctor, `$1${newName}$2`);
  }
  return out;
}

/**
 * Drop invented third-party usings that commonly break compile (CS0234).
 *
 * Example: `using SomeVendor.Core.Repository;` when interfaces live in the
 * app's `*.Repositories.Interfaces` and the NuGet package has no such child NS.
 * Agnostic heuristic: leaf is Repository/Service/… under Core/Common/Lib/… and
 * the full namespace is never used as an FQN prefix in the file body.
 */
export function removeBogusCsharpUsings(code: string): string {
  const raw = code || "";
  if (!raw.trim()) return raw;
  const lines = raw.split(/\r?\n/);
  const usingRe = /^\s*using\s+([A-Za-z_][\w.]*)\s*;\s*$/;
  const BOGUS_LEAF = /^(Repository|Repositories|Service|Services|Manager|Managers|Factory|Factories)$/i;
  const STRUCT_PARENT = /^(Core|Common|Lib|Shared|Abstractions|Internal)$/i;
  const SAFE_ROOT =
    /^(System|Xunit|Moq|NUnit|Microsoft|FluentAssertions|AutoMapper|MediatR|Castle|Newtonsoft)\b/i;

  const bodyWithoutUsings = lines
    .filter((ln) => !usingRe.test(ln))
    .join("\n");

  return lines
    .filter((ln) => {
      const m = ln.match(usingRe);
      if (!m) return true;
      const ns = m[1];
      if (SAFE_ROOT.test(ns)) return true;
      if (bodyWithoutUsings.includes(`${ns}.`)) return true;
      const parts = ns.split(".");
      if (parts.length < 3) return true;
      const leaf = parts[parts.length - 1];
      const parent = parts[parts.length - 2];
      if (BOGUS_LEAF.test(leaf) && STRUCT_PARENT.test(parent)) {
        return false;
      }
      return true;
    })
    .join("\n");
}

/**
 * Intentionally does NOT invent sibling usings (e.g. Domain.Entities).
 * Layout differs across repos; inventing namespaces caused CS0234 on real projects.
 * Usings must come from SUT / related source via codegen rules.
 */
export function ensureSiblingDomainEntitiesUsing(code: string): string {
  return code || "";
}

/**
 * Conservative Moq fixes that are language-level, not product-specific.
 * Avoid rewriting types/namespaces that only exist in some stacks (JHipster, etc.).
 */
export function fixCsharpMoqCompilePitfalls(code: string): string {
  let out = code || "";

  // Moq expression trees cannot omit optional parameters (CS0854).
  // Only expand empty SaveChangesAsync() — common across EF/UoW; do not change return type.
  out = out.replace(
    /(\.(?:Setup|Verify)\(\s*[^=]*?=>\s*\w+\.SaveChangesAsync)\(\s*\)/g,
    "$1(It.IsAny<CancellationToken>())"
  );
  out = out.replace(
    /(\w+\.Verify\(\s*\w+\s*=>\s*\w+\.SaveChangesAsync)\(\s*\)/g,
    "$1(It.IsAny<CancellationToken>())"
  );

  // Numeric long literals in page-size position often mismatch int APIs — only strip L/l
  // on 2-arg Of(page, size) when the identifier is Pageable (name is conventional, not a vendor).
  out = out.replace(/\bPageable\.Of\(([^,]+),\s*(\d+)[Ll]\s*\)/g, "Pageable.Of($1, $2)");

  return out;
}

/** Full sanitize pipeline for staged C# AItest files. */
export function sanitizeCsharpAitestCode(code: string, shortId: string): string {
  let out = removeBogusCsharpUsings(code);
  out = fixCsharpMoqCompilePitfalls(out);
  out = ensureCsharpUniqueTestClass(out, shortId);
  return out;
}

/** Parse `path.cs(line,col): error CSxxxx` paths from a dotnet build/test log. */
export function parseCsharpErrorFileRels(
  log: string,
  projectRoot: string,
  aitestRootHint?: string
): string[] {
  const root = (projectRoot || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const out: string[] = [];
  const re = /(?:^|[^\w])((?:[A-Za-z]:)?[^(\r\n]+?\.cs)\(\d+,\d+\):\s+error\s+CS\d+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log || ""))) {
    let p = m[1].replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/^\\\\\?\\/, "");
    const pl = p.toLowerCase();
    if (root && pl.startsWith(root + "/")) {
      p = p.slice(projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\/+/, "");
    }
    // Keep only under AItest/
    if (!/(?:^|\/)AItest\//i.test(p)) {
      if (aitestRootHint && p.toLowerCase().includes("aitest")) {
        /* keep */
      } else {
        continue;
      }
    }
    out.push(p.replace(/^\/+/, ""));
  }
  return [...new Set(out)];
}

const EXCLUDE_SNIPPET = `  <!-- AITest: generated tests — Remove only (never Include: copies bin/obj → MSB3030 nest) -->
  <PropertyGroup>
    <DefaultItemExcludes>$(DefaultItemExcludes);AItest\\**\\bin\\**;AItest\\**\\obj\\**;.ai-test\\**</DefaultItemExcludes>
  </PropertyGroup>
  <ItemGroup>
    <Compile Remove="AItest\\**" />
    <EmbeddedResource Remove="AItest\\**" />
    <Content Remove="AItest\\**" />
    <None Remove="AItest\\**" />
    <Compile Remove=".ai-test\\**" />
    <Content Remove=".ai-test\\**" />
    <None Remove=".ai-test\\**" />
  </ItemGroup>
`;

/** Legacy block that used None Include="AItest\\**" (causes recursive bin copy). */
const BAD_AITEST_INCLUDE_RE =
  /<!--\s*AITest:[\s\S]*?<ItemGroup>[\s\S]*?<\/ItemGroup>\s*/i;

export function csprojHasAitestExclude(csprojXml: string): boolean {
  const t = csprojXml || "";
  const hasRemove =
    /Compile\s+Remove\s*=\s*["']AItest\\+\*\*/i.test(t) ||
    /Compile\s+Remove\s*=\s*["']AItest\/\*\*/i.test(t);
  const hasBadInclude =
    /None\s+Include\s*=\s*["']AItest\\+\*\*/i.test(t) ||
    /None\s+Include\s*=\s*["']AItest\/\*\*/i.test(t);
  return hasRemove && !hasBadInclude;
}

export function csprojHasBadAitestInclude(csprojXml: string): boolean {
  const t = csprojXml || "";
  return (
    /None\s+Include\s*=\s*["']AItest\\+\*\*/i.test(t) ||
    /None\s+Include\s*=\s*["']AItest\/\*\*/i.test(t)
  );
}

/** True for *.Test.csproj / *Tests.csproj — must not be AItest ProjectReference target. */
export function isTestCsprojRel(rel: string): boolean {
  const base = (rel.replace(/\\/g, "/").split("/").pop() || "").toLowerCase();
  return (
    /(\.|_)(test|tests|specs?)\.csproj$/.test(base) ||
    /(^|[^a-z0-9])tests?\.csproj$/.test(base)
  );
}

/**
 * From a test-host csproj, pick best ProjectReference that is not another test project.
 * Prefers Application / Web / Api / Host over Domain / Dto / Contracts (agnostic).
 */
export function pickProductionProjectRefFromCsproj(
  csprojXml: string,
  fromCsprojRel: string
): string | null {
  const fromDir = parentDir(fromCsprojRel.replace(/\\/g, "/"));
  const re = /<ProjectReference\s+Include="([^"]+)"/gi;
  const scored: { abs: string; score: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(csprojXml || ""))) {
    const raw = m[1].replace(/\\/g, "/");
    const parts = [...fromDir.split("/").filter(Boolean), ...raw.split("/")];
    const stack: string[] = [];
    for (const p of parts) {
      if (p === "..") stack.pop();
      else if (p && p !== ".") stack.push(p);
    }
    const abs = stack.join("/");
    if (!abs || isTestCsprojRel(abs)) continue;
    const base = (abs.split("/").pop() || "").toLowerCase();
    let score = 10;
    if (/\.(application|web|api|host|server|app)\.csproj$/i.test(base)) score += 40;
    if (/(^|\/)(src|app|apps|backend|server)\//i.test(abs)) score += 15;
    if (/\.(domain|dto|contracts|shared|common|infrastructure)\.csproj$/i.test(base)) {
      score -= 20;
    }
    scored.push({ abs, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.abs ?? null;
}

/** Insert / repair AItest exclude ItemGroup (strip legacy None Include). */
export function ensureCsprojExcludesAitest(csprojXml: string): string {
  let raw = csprojXml || "";
  if (csprojHasBadAitestInclude(raw)) {
    raw = raw.replace(BAD_AITEST_INCLUDE_RE, "\n");
    raw = raw.replace(
      /\s*<None\s+Include\s*=\s*["']AItest\\+\*\*["'][^/]*\/>/gi,
      ""
    );
    raw = raw.replace(
      /\s*<None\s+Include\s*=\s*["']AItest\/\*\*["'][^/]*\/>/gi,
      ""
    );
  }
  if (csprojHasAitestExclude(raw)) return raw;
  if (!/<\/Project>/i.test(raw)) {
    return `${raw.trimEnd()}\n${EXCLUDE_SNIPPET}\n`;
  }
  return raw.replace(/<\/Project>/i, `${EXCLUDE_SNIPPET}</Project>`);
}

export function parseTargetFramework(csprojXml: string): string {
  const m = (csprojXml || "").match(
    /<TargetFrameworks?>\s*([^<]+)\s*<\/TargetFrameworks?>/i
  );
  if (!m) return "net8.0";
  const first = m[1].split(";")[0].trim();
  return first || "net8.0";
}

export function detectCentralPackageManagement(dirPackagesPropsXml: string | null): boolean {
  if (!dirPackagesPropsXml) return false;
  return /ManagePackageVersionsCentrally\s*>\s*true/i.test(dirPackagesPropsXml);
}

/** Package ids already declared as PackageVersion under CPM. */
export function parseCentralPackageVersionIds(
  dirPackagesPropsXml: string | null
): Set<string> {
  const out = new Set<string>();
  if (!dirPackagesPropsXml) return out;
  for (const m of dirPackagesPropsXml.matchAll(
    /<PackageVersion\s+Include="([^"]+)"/gi
  )) {
    const id = (m[1] || "").trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * Under CPM, only keep packages that already have PackageVersion in Directory.Packages.props.
 * Avoids NU1008 when AITest detects usings (e.g. Logging.Abstractions) not listed centrally.
 * Transitive refs via ProjectReference still work.
 */
export function filterPackagesForCentralManagement(
  packages: string[],
  centralIds: Set<string>
): string[] {
  if (!centralIds.size) return packages;
  return packages.filter((p) => centralIds.has(p));
}

export function buildAitestUnitTestsCsproj(opts: {
  targetFramework: string;
  sutCsprojRelFromAitest: string;
  centralPackageVersions: boolean;
  /** Extra NuGet packages detected from generated tests (FluentAssertions, EF Sqlite, …). */
  extraPackages?: string[];
}): string {
  const tfm = opts.targetFramework || "net8.0";
  const sut = opts.sutCsprojRelFromAitest.replace(/\//g, "\\");
  const basePkgs = [
    "Microsoft.NET.Test.Sdk",
    "xunit",
    "xunit.runner.visualstudio",
    "Moq",
  ];
  const extra = [...new Set(opts.extraPackages || [])].filter(
    (p) => !basePkgs.some((b) => b.toLowerCase() === p.toLowerCase())
  );
  const versions: Record<string, string> = {
    "Microsoft.NET.Test.Sdk": "17.11.1",
    xunit: "2.9.2",
    "xunit.runner.visualstudio": "2.8.2",
    Moq: "4.20.72",
    FluentAssertions: "6.12.2",
    "Microsoft.EntityFrameworkCore.Sqlite": "8.0.11",
    "Microsoft.EntityFrameworkCore.InMemory": "8.0.11",
    "Microsoft.EntityFrameworkCore": "8.0.11",
    "Microsoft.AspNetCore.Mvc.Testing": "8.0.11",
    "Microsoft.Extensions.DependencyInjection": "8.0.1",
    "Microsoft.Extensions.Logging.Abstractions": "8.0.2",
    NSubstitute: "5.1.0",
    AutoFixture: "4.18.1",
    Bogus: "35.6.1",
  };
  const allPkgs = [...basePkgs, ...extra];
  const pkgRefs = opts.centralPackageVersions
    ? allPkgs.map((p) => `    <PackageReference Include="${p}" />`)
    : allPkgs.flatMap((p) => {
        const ver = versions[p] || "8.0.0";
        if (p === "xunit.runner.visualstudio") {
          return [
            `    <PackageReference Include="${p}" Version="${ver}">`,
            `      <PrivateAssets>all</PrivateAssets>`,
            `      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>`,
            `    </PackageReference>`,
          ];
        }
        return [`    <PackageReference Include="${p}" Version="${ver}" />`];
      });
  return (
    `<Project Sdk="Microsoft.NET.Sdk">\n` +
    `\n` +
    `  <PropertyGroup>\n` +
    `    <TargetFramework>${tfm}</TargetFramework>\n` +
    `    <IsPackable>false</IsPackable>\n` +
    `    <IsTestProject>true</IsTestProject>\n` +
    `    <RootNamespace>AItest.UnitTests</RootNamespace>\n` +
    `    <Nullable>enable</Nullable>\n` +
    `    <ImplicitUsings>enable</ImplicitUsings>\n` +
    `  </PropertyGroup>\n` +
    `\n` +
    `  <ItemGroup>\n` +
    `${pkgRefs.join("\n")}\n` +
    `  </ItemGroup>\n` +
    `\n` +
    `  <ItemGroup>\n` +
    `    <Compile Remove="test-cases\\**\\*" />\n` +
    `    <Content Remove="test-cases\\**\\*" />\n` +
    `    <None Remove="test-cases\\**\\*" />\n` +
    `  </ItemGroup>\n` +
    `\n` +
    `  <ItemGroup>\n` +
    `    <ProjectReference Include="${sut}" />\n` +
    `  </ItemGroup>\n` +
    `\n` +
    `</Project>\n`
  );
}

/** Relative path to scaffolded test project. */
export function aitestUnitTestsCsprojRel(packagePrefix?: string | null): string {
  const pkg = normPkg(packagePrefix);
  return pkg ? `${pkg}/AItest/AItest.UnitTests.csproj` : "AItest/AItest.UnitTests.csproj";
}

export function buildAitestDotnetTestCommand(
  packagePrefix?: string | null
): string {
  const rel = aitestUnitTestsCsprojRel(packagePrefix);
  return `dotnet test "${rel}" --nologo`;
}

export function buildAitestDotnetBuildCommand(
  packagePrefix?: string | null
): string {
  const rel = aitestUnitTestsCsprojRel(packagePrefix);
  return `dotnet build "${rel}" --nologo`;
}

/**
 * Force Verify onto AItest.UnitTests.csproj when overlays contain C# under AItest/.
 * Prevents batch UI (empty targetRelPaths / wrong language) from running jest/npm.
 */
export function resolveAitestCsharpVerifyCommands(
  packagePrefix?: string | null,
  incoming?: { compile?: string; test?: string }
): { compile: string; test: string } {
  const compileIn = (incoming?.compile || "").trim();
  const testIn = (incoming?.test || "").trim();
  return {
    compile: /aitest\.unittests\.csproj/i.test(compileIn)
      ? compileIn
      : buildAitestDotnetBuildCommand(packagePrefix),
    test: /aitest\.unittests\.csproj/i.test(testIn)
      ? testIn
      : buildAitestDotnetTestCommand(packagePrefix),
  };
}

export function isDefaultDotnetTestCommand(cmd: string): boolean {
  const c = (cmd || "").trim().toLowerCase();
  if (!c) return false;
  if (/aitest\.unittests\.csproj/i.test(c)) return false;
  return /^dotnet\s+test\b/.test(c) && !/\.csproj\b/i.test(c);
}

async function findDirectoryPackagesProps(
  projectRoot: string,
  startDir: string
): Promise<string | null> {
  let dir = startDir.replace(/\\/g, "/").replace(/\/+$/, "");
  for (let i = 0; i < 8; i++) {
    const candidate = dir ? `${dir}/Directory.Packages.props` : "Directory.Packages.props";
    if (await fileExists(projectRoot, candidate)) {
      try {
        return await readTextFile(projectRoot, candidate);
      } catch {
        return null;
      }
    }
    if (!dir) break;
    dir = parentDir(dir);
  }
  return null;
}

/**
 * Prefer *.csproj that lives exactly in packagePrefix and is not a test project name.
 * Tries `{pkg}/{leaf}.csproj` first (reliable); then scan (absolute paths normalized).
 * Never returns *Test*.csproj when a production alternative exists — AItest must not
 * ProjectReference the host test project (MSB3030 recursive bin under AItest/).
 */
export async function findProductionCsprojRel(
  projectRoot: string,
  packagePrefix?: string | null
): Promise<string | null> {
  const pkg = normPkg(packagePrefix);
  if (pkg) {
    const leaf = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
    const guess = `${pkg}/${leaf}.csproj`;
    if ((await fileExists(projectRoot, guess)) && !isTestCsprojRel(guess)) {
      return guess;
    }
  }

  try {
    const all = await listSourceFiles(projectRoot, [".csproj"]);
    const scored: { rel: string; score: number }[] = [];
    for (const raw of all) {
      const rel = toProjectRel(projectRoot, raw);
      if (!rel || !/\.csproj$/i.test(rel)) continue;
      if (/(^|\/)AItest\//i.test(rel)) continue;
      if (/\.ai-test\//i.test(rel)) continue;
      if (isTestCsprojRel(rel)) continue;
      const dir = parentDir(rel);
      const base = (rel.split("/").pop() || "").toLowerCase();
      let score = 0;
      if (pkg) {
        if (dir === pkg) score += 100;
        else if (dir.startsWith(pkg + "/")) score += 10;
        else if (pkg.split("/").some((p) => /test/i.test(p))) {
          // AItest under a *Test* package — prefer sibling production trees (any layout).
          if (/(^|\/)(src|app|apps|backend|server)\//i.test(rel)) score += 40;
          else score += 5;
        } else {
          continue;
        }
      } else if (dir === "") {
        score += 40;
      } else {
        score += Math.max(1, 20 - dir.split("/").length);
      }
      if (/\.(application|web|api|host)\.csproj$/i.test(base)) score += 25;
      if (/(^|\/)(src|app|apps|backend|server)\//i.test(rel)) score += 10;
      const folder = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
      if (folder && !/test/i.test(folder) && base === `${folder.toLowerCase()}.csproj`) {
        score += 30;
      }
      scored.push({ rel, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0]?.rel) return scored[0].rel;
  } catch {
    /* fall through */
  }

  // Package is a test host — read its ProjectReferences for production SUT
  if (pkg) {
    const leaf = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
    const testGuess = `${pkg}/${leaf}.csproj`;
    if (await fileExists(projectRoot, testGuess)) {
      try {
        const xml = await readTextFile(projectRoot, testGuess);
        const prod = pickProductionProjectRefFromCsproj(xml, testGuess);
        if (prod) return prod;
      } catch {
        /* ignore */
      }
    }
  }

  if (pkg) {
    const leaf = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
    const guess = `${pkg}/${leaf}.csproj`;
    if (!isTestCsprojRel(guess)) return guess;
  }
  return null;
}

export async function ensureAitestDotnetInWorkspace(input: {
  projectRoot: string;
  manifest: UnitWorkspaceManifest;
}): Promise<UnitWorkspaceManifest> {
  if (!manifestHasAitestCsharpTests(input.manifest)) {
    return input.manifest;
  }

  let working: UnitWorkspaceManifest = { ...input.manifest, files: [...input.manifest.files] };
  let packagePrefix = normPkg(working.packagePrefix);
  if (!packagePrefix) {
    packagePrefix = packagePrefixFromAitestTargets(working.files);
  }
  if (packagePrefix && packagePrefix !== normPkg(working.packagePrefix)) {
    working = { ...working, packagePrefix };
  }
  const pkg = packagePrefix;

  // 1) Uniquify class names (+ ctors) in overlay csharp tests
  for (const f of working.files) {
    if (f.op === "delete") continue;
    if (!/\.cs$/i.test(f.targetRel)) continue;
    if (!/(?:^|\/)AItest\//i.test(f.targetRel.replace(/\\/g, "/"))) continue;
    const shortId = csharpShortIdFromPath(f.targetRel);
    try {
      let body = await readDraftText(input.projectRoot, f.workspaceRel);
      const next = sanitizeCsharpAitestCode(body, shortId || "");
      if (next !== body) {
        await writeDraftText(input.projectRoot, f.workspaceRel, next);
      }
    } catch {
      /* skip */
    }
  }

  // 2) Exclude AItest from host csproj (permanent on disk) + resolve production SUT
  const pkgLeaf = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
  const hostCsprojGuess = pkg ? `${pkg}/${pkgLeaf}.csproj` : null;
  // Always repair exclude on the package host (may be a *Test* project housing AItest/)
  if (hostCsprojGuess && (await fileExists(input.projectRoot, hostCsprojGuess))) {
    try {
      const hostXml = await readTextFile(input.projectRoot, hostCsprojGuess);
      const patchedHost = ensureCsprojExcludesAitest(hostXml);
      if (patchedHost !== hostXml) {
        await writeTextFile(input.projectRoot, hostCsprojGuess, patchedHost);
      }
    } catch {
      /* ignore */
    }
  }

  let sutRel = await findProductionCsprojRel(input.projectRoot, packagePrefix);
  // Extra guard: never ProjectReference a test project
  if (sutRel && isTestCsprojRel(sutRel) && hostCsprojGuess) {
    try {
      const hostXml = await readTextFile(input.projectRoot, hostCsprojGuess);
      sutRel =
        pickProductionProjectRefFromCsproj(hostXml, hostCsprojGuess) || sutRel;
    } catch {
      /* keep */
    }
  }
  if (sutRel && isTestCsprojRel(sutRel)) {
    sutRel = null;
  }

  let tfm = "net8.0";
  let sutFromAitest =
    sutRel && pkg
      ? projectRefFromAitestDir(sutRel, pkg)
      : pkg
        ? `../${pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg}.csproj`
        : "../Sut.csproj";

  if (sutRel) {
    try {
      const xml = await readTextFile(input.projectRoot, sutRel);
      tfm = parseTargetFramework(xml);
      // Also exclude if SUT happens to be the same folder (non-test)
      if (!hostCsprojGuess || sutRel.replace(/\\/g, "/") !== hostCsprojGuess) {
        const patched = ensureCsprojExcludesAitest(xml);
        if (patched !== xml) {
          await writeTextFile(input.projectRoot, sutRel, patched);
        }
      }
      sutFromAitest = projectRefFromAitestDir(sutRel, pkg);
    } catch {
      /* keep computed ProjectReference */
    }
  } else if (hostCsprojGuess && (await fileExists(input.projectRoot, hostCsprojGuess))) {
    try {
      const xml = await readTextFile(input.projectRoot, hostCsprojGuess);
      tfm = parseTargetFramework(xml);
    } catch {
      /* default tfm */
    }
  }

  // 3) Scaffold AItest.UnitTests.csproj into the Tool draft; Verify stages it
  // temporarily and Update/Apply is the only persistent write.
  const dirPackages = await findDirectoryPackagesProps(
    input.projectRoot,
    pkg || parentDir(sutRel || "") || ""
  );
  const central = detectCentralPackageManagement(dirPackages);
  const centralIds = central
    ? parseCentralPackageVersionIds(dirPackages)
    : new Set<string>();
  const extraPkgs = new Set<string>();
  for (const f of working.files) {
    if (f.op === "delete" || !/\.cs$/i.test(f.targetRel)) continue;
    if (!/(?:^|\/)AItest\//i.test(f.targetRel.replace(/\\/g, "/"))) continue;
    try {
      const body = await readDraftText(input.projectRoot, f.workspaceRel);
      for (const p of detectCsharpPackagesFromTestCode(body)) extraPkgs.add(p);
    } catch {
      /* skip */
    }
  }
  // CPM: never emit PackageReference for packages missing PackageVersion (NU1008).
  let extraList = [...extraPkgs];
  if (central) {
    extraList = filterPackagesForCentralManagement(extraList, centralIds);
  }
  const unitProjRel = aitestUnitTestsCsprojRel(packagePrefix);
  const unitProjBody = buildAitestUnitTestsCsproj({
    targetFramework: tfm,
    sutCsprojRelFromAitest: sutFromAitest,
    centralPackageVersions: central,
    extraPackages: extraList,
  });

  const workspaceRel = overlayRelPath(working.runId, unitProjRel, packagePrefix);
  await writeDraftTextIfChanged(input.projectRoot, workspaceRel, unitProjBody);
  const unitProjExists = await fileExists(input.projectRoot, unitProjRel);

  if (!working.files.some((f) => f.targetRel.replace(/\\/g, "/") === unitProjRel)) {
    working = {
      ...working,
      files: [
        ...working.files,
        {
          op: unitProjExists ? "modify" : "new",
          targetRel: unitProjRel,
          workspaceRel,
        },
      ],
    };
  }

  return working;
}
