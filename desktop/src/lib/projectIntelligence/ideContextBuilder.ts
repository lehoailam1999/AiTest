/**
 * P3 — IdeSemanticPacket → AITestContextPacket
 * Rank: focus method > ctor deps > imports > refs > overview
 * Budget + ClientApp noise filter enforced.
 */
import type { IdeSemanticPacket } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import {
  CONTEXT_PACKET_VERSION,
  type AITestContextPacket,
} from "../contextPacket/types";
import { packetForApi } from "../contextPacket/serialize";
import { getLanguageAdapter } from "../languageAdapters/registry";
import {
  IDE_CONTEXT_BUDGET,
  TIER_PRIORITY,
  enforceContextBudget,
  isClientAppMirrorNoise,
  trimToBudget,
  type RankedFile,
  type ContextBudgetPolicy,
} from "./contextBudget";

function inferLanguage(packet: IdeSemanticPacket): string {
  const lang = (packet.language || "").trim();
  if (lang && lang !== "plaintext") return lang;
  const file = packet.focus.file.toLowerCase();
  if (file.endsWith(".cs")) return "csharp";
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (file.endsWith(".js") || file.endsWith(".jsx")) return "javascript";
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".rs")) return "rust";
  if (file.endsWith(".java")) return "java";
  if (file.endsWith(".kt")) return "kotlin";
  if (file.endsWith(".php")) return "php";
  return lang || "unknown";
}

function pickFramework(
  packet: IdeSemanticPacket,
  language: string,
  override?: string
): string {
  if (override && override !== "auto") return override;
  const hints = (packet.frameworkHints ?? []).map((h) => h.toLowerCase());
  const lang = language.toLowerCase();
  const file = packet.focus.file.toLowerCase();
  const isDotnet =
    file.endsWith(".cs") ||
    lang.includes("c#") ||
    lang.includes("csharp") ||
    lang.includes(".net");
  const isNode =
    !!file.match(/\.(tsx?|jsx?)$/) ||
    lang.includes("typescript") ||
    lang.includes("javascript");

  const known = isDotnet
    ? ["xunit", "nunit", "mstest"]
    : isNode
      ? ["vitest", "jest", "mocha"]
      : [
          "xunit",
          "nunit",
          "mstest",
          "vitest",
          "jest",
          "mocha",
          "pytest",
          "unittest",
          "junit",
          "testng",
          "gotest",
          "phpunit",
        ];
  for (const k of known) {
    if (hints.some((h) => h.includes(k))) return k;
  }
  return (
    getLanguageAdapter(language, packet.focus.file).conventions(language, hints[0])
      .testFramework || ""
  );
}

export type BuildFromIdeInput = {
  idePacket: IdeSemanticPacket;
  testCase?: Pick<TestCase, "id" | "module" | "title"> | null;
  projectId?: string;
  framework?: string;
  purpose?: "generate-unit" | "generate-tc";
  testKind?: "unit" | "api" | "integration";
  budget?: ContextBudgetPolicy;
  /** Enrich short snippets from disk (optional) */
  readFile?: (pathRel: string) => Promise<string>;
};

export type BuildFromIdeResult = {
  packet: AITestContextPacket;
  packetForApi: AITestContextPacket;
  language: string;
  framework: string;
  contextSource: "ide";
};

/**
 * Primary Context Builder entry for V2 unit generate (P3).
 */
export async function buildContextPacketFromIde(
  input: BuildFromIdeInput
): Promise<BuildFromIdeResult> {
  const budget = input.budget ?? IDE_CONTEXT_BUDGET;
  const ide = input.idePacket;
  const language = inferLanguage(ide);
  const framework = pickFramework(ide, language, input.framework);
  const adapter = getLanguageAdapter(language, ide.focus.file);
  const conv = adapter.conventions(language, framework);
  const confidence = ide.diagnostics?.confidence ?? "medium";
  const gaps = [...(ide.diagnostics?.gaps ?? [])];
  const seed = ide.focus.file.replace(/\\/g, "/");

  const ranked: RankedFile[] = [];

  // Tier: primary (focus method / class)
  const primaryRaw =
    ide.focusSnippet ||
    `// focus ${ide.focus.symbol}${ide.focus.method ? "." + ide.focus.method : ""}\n`;
  ranked.push({
    pathRel: seed,
    role: "primary",
    language,
    content: primaryRaw,
    why: `IDE focus ${ide.focus.kind} ${ide.focus.symbol}${
      ide.focus.method ? "." + ide.focus.method : ""
    } (${ide.ide})`,
    tier: "primary",
    rankScore: TIER_PRIORITY.primary,
  });

  // Tier: ctor deps then import deps
  const deps = ide.dependencies ?? [];
  for (const d of deps) {
    const pathRel = d.path.replace(/\\/g, "/");
    if (pathRel === seed) continue;
    if (isClientAppMirrorNoise(pathRel, seed)) {
      gaps.push(`omitted_noise:${pathRel}`);
      continue;
    }
    let content = d.snippet || "";
    if (input.readFile && content.length < 40) {
      try {
        content = await input.readFile(pathRel);
      } catch {
        gaps.push(`unreadable_dep:${pathRel}`);
      }
    }
    const tier = d.role === "constructor" ? "ctor" : "import";
    ranked.push({
      pathRel,
      role: "dependency",
      language,
      content: content || `// ${d.symbol || pathRel}`,
      why: `IDE ${d.role}${d.symbol ? `: ${d.symbol}` : ""}`,
      tier,
      rankScore: TIER_PRIORITY[tier] + (d.symbol ? 2 : 0),
    });
  }

  // Tier: references / implementations (short)
  const refPaths = [
    ...(ide.references ?? []).map((r) => ({ path: r.file, kind: "reference" as const })),
    ...(ide.implementations ?? []).map((r) => ({
      path: r.file,
      kind: "reference" as const,
    })),
  ];
  const seen = new Set(ranked.map((f) => f.pathRel));
  for (const r of refPaths) {
    const pathRel = r.path.replace(/\\/g, "/");
    if (seen.has(pathRel) || pathRel === seed) continue;
    if (isClientAppMirrorNoise(pathRel, seed)) continue;
    seen.add(pathRel);
    let content = `// reference ${pathRel}`;
    if (input.readFile) {
      try {
        const raw = await input.readFile(pathRel);
        content = trimToBudget(raw, 2000).text;
      } catch {
        /* keep stub */
      }
    }
    ranked.push({
      pathRel,
      role: "dependency",
      language,
      content,
      why: "IDE reference",
      tier: "reference",
      rankScore: TIER_PRIORITY.reference,
    });
  }

  const enforced = enforceContextBudget(ranked, budget);

  const ctorDeps =
    ide.constructors?.[0]?.params.map((p) => `${p.name}: ${p.type}`) ?? [];
  const methods = ide.focus.method
    ? [ide.focus.method]
    : ide.signatures?.map((s) => s.split("(")[0] || s).filter(Boolean);

  const packet: AITestContextPacket = {
    packetVersion: CONTEXT_PACKET_VERSION,
    purpose: input.purpose ?? "generate-unit",
    meta: {
      language,
      framework: framework || undefined,
      projectId: input.projectId,
      testCaseId: input.testCase?.id,
      module: input.testCase?.module || undefined,
      testKind: input.testKind ?? "unit",
    },
    conventions: {
      testFramework: conv.testFramework || framework || undefined,
      testFilePattern: conv.testFilePattern,
      mockFramework: conv.mockFramework,
      assertionLibrary: conv.assertionLibrary,
    },
    testingStack: {
      testingFramework: conv.testFramework || framework || undefined,
      mockFramework: conv.mockFramework,
      assertionLibrary: conv.assertionLibrary,
      detectedFrom: [
        `ide:${ide.ide}`,
        "context-builder-p3",
        ...(ide.frameworkHints ?? []).map((h) => `hint:${h}`),
        `adapter:${adapter.id}`,
      ],
      confidence,
    },
    sourceUnderTest: {
      pathRel: seed,
      symbol: ide.focus.symbol,
      methods,
      constructorDeps: ctorDeps,
    },
    unitStrategy: {
      whatToTest: ide.focus.method
        ? `Method ${ide.focus.symbol}.${ide.focus.method}`
        : `Symbol ${ide.focus.symbol} (${ide.focus.kind})`,
      whatToMock: ctorDeps.length
        ? ctorDeps.map((d) => d.split(":")[0]?.trim() || d)
        : undefined,
      whatNotToMock: [ide.focus.symbol],
      forbidden: [
        "Do not invent APIs not in focusSnippet / dependencies",
        "Do not mirror ClientApp/src/app trees into tests",
        "Prefer project testing stack from testingStack",
      ],
    },
    files: enforced.files,
    diagnostics: {
      truncated: enforced.truncated,
      omittedPaths: enforced.omittedPaths,
      seedReason: `ide-focus:${ide.ide}`,
      gaps,
      seedCandidates: [
        { pathRel: seed, score: 100, reason: "ide-caret" },
        ...deps.slice(0, 5).map((d, i) => ({
          pathRel: d.path.replace(/\\/g, "/"),
          score: 90 - i,
          reason: `ide-${d.role}`,
        })),
      ],
    },
  };

  // DoD: primary + prefer ctor deps present when IDE provided them
  const hasPrimary = packet.files.some((f) => f.role === "primary");
  if (!hasPrimary) gaps.push("missing_primary");
  const ctorProvided = deps.some((d) => d.role === "constructor");
  const ctorInPacket = packet.files.some(
    (f) => f.why?.includes("constructor") || f.role === "dependency"
  );
  if (ctorProvided && !ctorInPacket) gaps.push("ctor_deps_dropped_by_budget");

  return {
    packet,
    packetForApi: packetForApi(packet),
    language,
    framework,
    contextSource: "ide",
  };
}
