/**
 * P0 — Merge Agent retrieve (+ optional IDE semantic) → one AITestContextPacket.
 * Generate must use this packet; do not rebuild a parallel context.
 */
import type {
  BusinessIntent,
  ConfidenceReport,
  IdeSemanticPacket,
  RetrievedFile,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import {
  CONTEXT_PACKET_VERSION,
  type AITestContextPacket,
  type ContextPacketFile,
  type ContextPacketFileRole,
} from "../contextPacket/types";
import { packetForApi } from "../contextPacket/serialize";
import { getLanguageAdapter } from "../languageAdapters/registry";
import { languageFromSourcePath } from "../stackHints";
import {
  IDE_CONTEXT_BUDGET,
  TIER_PRIORITY,
  enforceContextBudget,
  isClientAppMirrorNoise,
  trimToBudget,
  type RankedFile,
} from "../projectIntelligence/contextBudget";

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function roleFromRetrieved(role: string, isPrimary: boolean): ContextPacketFileRole {
  if (isPrimary) return "primary";
  const r = role.toLowerCase();
  if (r.includes("test") || r.includes("sample")) return "test-sample";
  if (r.includes("overview")) return "overview";
  return "dependency";
}

function pickFrameworkForPath(
  language: string,
  pathRel: string,
  override?: string
): string {
  if (override && override !== "auto") return override;
  const conv = getLanguageAdapter(language, pathRel).conventions(language, override);
  return conv.testFramework || "";
}

export type BuildFromAgentRunInput = {
  intent: BusinessIntent;
  retrieved: RetrievedFile[];
  confidence: ConfidenceReport;
  testCase: Pick<TestCase, "id" | "module" | "title">;
  projectId: string;
  framework?: string;
  /** Prefer IDE/Tauri read to fill missing snippets */
  readFile: (pathRel: string) => Promise<string>;
  ideSemantic?: IdeSemanticPacket | null;
};

export type BuildFromAgentRunResult = {
  packet: AITestContextPacket;
  packetForApi: AITestContextPacket;
  language: string;
  framework: string;
  primaryPath: string;
  contextSource: "agent-ide";
};

/**
 * Build the single context packet used for generate-unit after Agent retrieve.
 */
export async function buildPacketFromAgentRun(
  input: BuildFromAgentRunInput
): Promise<BuildFromAgentRunResult> {
  const gaps: string[] = [...(input.confidence.missingHints ?? [])];
  const ranked: RankedFile[] = [];
  const seen = new Set<string>();

  const sorted = [...input.retrieved].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0)
  );

  // Prefer highest-scoring retrieved with a real path; else IDE focus
  let primaryPath =
    sorted.find((f) => f.path && !f.path.startsWith("("))?.path ||
    input.ideSemantic?.focus?.file ||
    "";
  primaryPath = normPath(primaryPath);

  async function loadContent(pathRel: string, snippet?: string): Promise<string> {
    if (snippet && snippet.trim().length >= 40) {
      return trimToBudget(snippet, IDE_CONTEXT_BUDGET.maxDependencyChars).text;
    }
    try {
      const raw = await input.readFile(pathRel);
      return trimToBudget(raw, IDE_CONTEXT_BUDGET.maxPrimaryChars).text;
    } catch {
      gaps.push(`unreadable:${pathRel}`);
      return snippet?.trim() || `// unable to read ${pathRel}`;
    }
  }

  if (primaryPath) {
    const primaryRow = sorted.find((f) => normPath(f.path) === primaryPath);
    let content = await loadContent(primaryPath, primaryRow?.snippet);
    // Prefer richer IDE focus snippet when same file
    if (
      input.ideSemantic?.focus?.file &&
      normPath(input.ideSemantic.focus.file) === primaryPath &&
      input.ideSemantic.focusSnippet &&
      input.ideSemantic.focusSnippet.length > content.length
    ) {
      content = trimToBudget(
        input.ideSemantic.focusSnippet,
        IDE_CONTEXT_BUDGET.maxPrimaryChars
      ).text;
    }
    const languageHint =
      languageFromSourcePath(primaryPath) ||
      input.ideSemantic?.language ||
      "unknown";
    ranked.push({
      pathRel: primaryPath,
      role: "primary",
      language: languageHint,
      content,
      why: `Agent primary · ${primaryRow?.role || "focus"} · score ${(
        primaryRow?.score ?? input.confidence.overall
      ).toFixed(2)}`,
      tier: "primary",
      rankScore: TIER_PRIORITY.primary + (primaryRow?.score ?? 0) * 10,
    });
    seen.add(primaryPath);
  }

  for (const f of sorted) {
    const pathRel = normPath(f.path || "");
    if (!pathRel || pathRel.startsWith("(") || seen.has(pathRel)) continue;
    if (primaryPath && isClientAppMirrorNoise(pathRel, primaryPath)) {
      gaps.push(`omitted_noise:${pathRel}`);
      continue;
    }
    if (ranked.length >= IDE_CONTEXT_BUDGET.maxDependencyFiles + 1) break;
    const content = await loadContent(pathRel, f.snippet);
    const lang = languageFromSourcePath(pathRel) || "unknown";
    ranked.push({
      pathRel,
      role: roleFromRetrieved(f.role, false),
      language: lang,
      content,
      why: `Agent retrieve · ${f.role}${
        typeof f.score === "number" ? ` · ${(f.score * 100).toFixed(0)}%` : ""
      }`,
      tier: f.role.includes("caret") ? "ctor" : "import",
      rankScore: TIER_PRIORITY.import + (f.score ?? 0) * 10,
    });
    seen.add(pathRel);
  }

  // Fold IDE semantic deps not already present
  for (const d of input.ideSemantic?.dependencies ?? []) {
    const pathRel = normPath(d.path || "");
    if (!pathRel || seen.has(pathRel)) continue;
    if (primaryPath && isClientAppMirrorNoise(pathRel, primaryPath)) continue;
    if (ranked.length >= IDE_CONTEXT_BUDGET.maxDependencyFiles + 3) break;
    let content = d.snippet || "";
    if (content.length < 40) {
      try {
        content = await input.readFile(pathRel);
      } catch {
        content = `// ${d.symbol || pathRel}`;
      }
    }
    ranked.push({
      pathRel,
      role: "dependency",
      language: languageFromSourcePath(pathRel) || undefined,
      content: trimToBudget(content, IDE_CONTEXT_BUDGET.maxDependencyChars).text,
      why: `IDE semantic dep · ${d.role}${d.symbol ? `: ${d.symbol}` : ""}`,
      tier: d.role === "constructor" ? "ctor" : "import",
      rankScore: TIER_PRIORITY.import,
    });
    seen.add(pathRel);
  }

  const enforced = enforceContextBudget(ranked, IDE_CONTEXT_BUDGET);
  const files: ContextPacketFile[] = enforced.files;

  const primary = files.find((f) => f.role === "primary") ?? files[0];
  const primaryRel = primary?.pathRel || primaryPath || "";
  const language =
    languageFromSourcePath(primaryRel) ||
    (input.ideSemantic?.language && input.ideSemantic.language !== "plaintext"
      ? input.ideSemantic.language
      : "") ||
    "unknown";
  const framework = pickFrameworkForPath(language, primaryRel, input.framework);
  const adapter = getLanguageAdapter(language, primaryRel);
  const conv = adapter.conventions(language, framework);

  const symbolHints = sorted
    .flatMap((f) => f.symbolIds ?? [])
    .filter(Boolean)
    .slice(0, 12);

  const focusMethod = input.ideSemantic?.focus?.method;
  const methods = focusMethod
    ? [focusMethod]
    : symbolHints.map((s) => s.split(".").pop() || s).slice(0, 8);

  const packet: AITestContextPacket = {
    packetVersion: CONTEXT_PACKET_VERSION,
    purpose: "generate-unit",
    meta: {
      language,
      framework: framework || undefined,
      projectId: input.projectId,
      testCaseId: input.testCase.id,
      module: input.testCase.module || undefined,
      testKind: "unit",
      runId: `agent-${Date.now()}`,
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
        "agent-run-p0",
        `confidence:${input.confidence.overall.toFixed(2)}`,
        input.confidence.enough ? "enough" : "needs_user",
        `adapter:${adapter.id}`,
      ],
      confidence: input.confidence.enough
        ? "high"
        : input.confidence.overall >= 0.55
          ? "medium"
          : "low",
    },
    sourceUnderTest: {
      pathRel: primaryRel || undefined,
      symbol:
        input.ideSemantic?.focus?.symbol ||
        symbolHints[0] ||
        input.intent.entity ||
        undefined,
      methods: methods.length ? methods : undefined,
      constructorDeps: input.ideSemantic?.constructors?.[0]?.params.map(
        (p) => `${p.name}: ${p.type}`
      ),
      externalCalls: input.intent.externalDeps.slice(0, 8),
    },
    unitStrategy: {
      whatToTest: [
        input.testCase.title,
        `Action: ${input.intent.action}`,
        `Entity: ${input.intent.entity}`,
        ...input.intent.expectedResults.slice(0, 4).map((e) => `Expect: ${e}`),
      ]
        .filter(Boolean)
        .join("\n"),
      whatToMock: input.intent.externalDeps.slice(0, 8),
      whatNotToMock: [input.intent.entity].filter(Boolean),
      forbidden: [
        "Do not mirror ClientApp/src/app trees into tests",
        "Do not invent APIs absent from packet files",
      ],
    },
    files,
    diagnostics: {
      truncated: enforced.truncated,
      omittedPaths: enforced.omittedPaths,
      seedReason: "agent-retrieve-p0",
      seedCandidates: input.confidence.candidates.slice(0, 8).map((c) => ({
        pathRel: c.path,
        score: c.score,
        reason: c.rationale,
      })),
      gaps: [
        ...gaps,
        ...(input.ideSemantic?.diagnostics?.gaps ?? []),
        `agent_overall:${input.confidence.overall.toFixed(2)}`,
        `agent_enough:${input.confidence.enough}`,
      ],
    },
  };

  return {
    packet,
    packetForApi: packetForApi(packet),
    language,
    framework,
    primaryPath: primaryRel,
    contextSource: "agent-ide",
  };
}
