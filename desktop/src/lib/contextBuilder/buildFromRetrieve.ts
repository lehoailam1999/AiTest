/**
 * Phase 4 — Context Builder from Code Index + TestPlan + Retrieve.
 * Reads only Top-K files; builds portable prompt packet for Unit / E2E.
 */
import {
  CONTEXT_PACKET_VERSION,
  type AITestContextPacket,
  type ContextPacketFile,
} from "../contextPacket/types";
import type { CodeIndexIo, CodeIndexSnapshot } from "../codeIndex/types";
import { listDependencies, loadIndexSnapshot } from "../codeIndex/index";
import { syncProjectIndex } from "../codeIndex/incrementalSync";
import { CODE_INDEX_REL_PATH } from "../codeIndex/constants";
import { planFromTestCase } from "../testPlanner/planFromTestCase";
import type { PlannerRequirementInput, TestPlan } from "../testPlanner/types";
import { retrieveForPlan } from "../retrieval/retrieveForPlan";
import type { BusinessRetrieveResult, RetrieveFilesResult } from "../retrieval/types";
import type { TestCase } from "../../api/types";
import {
  E2E_INDEX_BUDGET,
  trimChars,
  UNIT_INDEX_BUDGET,
  type IndexContextBudget,
} from "./budgets";

export type BuildIndexContextInput = {
  projectRoot: string;
  testCase: TestCase;
  io: CodeIndexIo;
  /** Preloaded snapshot; if omitted, load `.ai-test/index.db` */
  snapshot?: CodeIndexSnapshot | null;
  /** Sync index when missing (can be slow on large repos) */
  syncIfMissing?: boolean;
  language?: string;
  framework?: string;
  testingFramework?: string;
  mockFramework?: string;
  requirement?: PlannerRequirementInput | null;
  /** Force Unit | E2E path */
  forceTestType?: TestPlan["testType"];
  budget?: IndexContextBudget;
};

export type IndexBackedContextResult = {
  plan: TestPlan;
  retrieve: RetrieveFilesResult;
  business: BusinessRetrieveResult;
  snapshot: CodeIndexSnapshot;
  /** Unit / shared API packet */
  packet: AITestContextPacket;
  /** E2E FE bundle shape (compatible with resolveE2eFeSources) */
  e2eFe: {
    sourceFileName: string;
    sourceCode: string;
    relatedSources: { path: string; content: string }[];
    notes: string[];
  } | null;
  dependencySummary: string;
  notes: string[];
  truncated: string[];
};

function tcToPlanner(tc: TestCase) {
  return {
    title: tc.title,
    type: tc.type,
    module: tc.module,
    precondition: tc.precondition,
    steps: tc.steps,
    expectedResult: tc.expectedResult,
    testData: tc.testData,
    testCaseId: tc.testCaseId,
  };
}

function buildDependencySummary(
  snapshot: CodeIndexSnapshot,
  paths: string[],
  maxChars: number
): string {
  const lines: string[] = [];
  for (const p of paths.slice(0, 12)) {
    const deps = listDependencies(snapshot, p);
    if (!deps.length) continue;
    lines.push(`${p} → ${deps.slice(0, 8).join(", ")}`);
  }
  const text = lines.join("\n");
  return trimChars(text, maxChars).text;
}

async function ensureSnapshot(
  input: BuildIndexContextInput
): Promise<{ snapshot: CodeIndexSnapshot; notes: string[] }> {
  const notes: string[] = [];
  if (input.snapshot) return { snapshot: input.snapshot, notes };
  const loaded = await loadIndexSnapshot(input.projectRoot, input.io, CODE_INDEX_REL_PATH);
  if (loaded && Object.keys(loaded.files).length) {
    notes.push("loaded .ai-test/index.db");
    return { snapshot: loaded, notes };
  }
  if (input.syncIfMissing !== false) {
    notes.push("index missing — syncProjectIndex");
    const sync = await syncProjectIndex(input.projectRoot, input.io);
    return { snapshot: sync.snapshot, notes };
  }
  throw new Error(
    "Code index missing — chạy Index project (Phase 1) trước khi Gen, hoặc bật syncIfMissing."
  );
}

/**
 * Build gen context: Plan → Retrieve Top-K → read sources under budget → packet.
 */
export async function buildIndexBackedContext(
  input: BuildIndexContextInput
): Promise<IndexBackedContextResult> {
  const notes: string[] = [];
  const truncated: string[] = [];
  const { snapshot, notes: snapNotes } = await ensureSnapshot(input);
  notes.push(...snapNotes);

  const plannerTc = tcToPlanner(input.testCase);
  const plan = planFromTestCase(plannerTc, {
    requirement: input.requirement,
    forceTestType: input.forceTestType,
  });
  const { files: retrieve, business } = retrieveForPlan(
    snapshot,
    plan,
    plannerTc,
    { topK: 8 }
  );
  notes.push(...retrieve.notes, ...business.notes);

  const isE2e = plan.testType === "E2E";
  const budget = input.budget || (isE2e ? E2E_INDEX_BUDGET : UNIT_INDEX_BUDGET);

  const ranked = retrieve.files;
  if (!ranked.length) {
    notes.push("retrieve returned 0 files");
  }

  const packetFiles: ContextPacketFile[] = [];
  let total = 0;
  let primaryPath = "";
  let primaryContent = "";
  const relatedSources: { path: string; content: string }[] = [];

  for (let i = 0; i < ranked.length; i++) {
    const hit = ranked[i];
    if (i > 0 && packetFiles.length > budget.maxRelatedFiles) break;
    let raw = "";
    try {
      raw = await input.io.readFile(input.projectRoot, hit.pathRel);
    } catch {
      truncated.push(hit.pathRel);
      continue;
    }
    const max = i === 0 ? budget.maxPrimaryChars : budget.maxRelatedChars;
    const { text, truncated: wasTrunc } = trimChars(raw, max);
    if (wasTrunc) truncated.push(hit.pathRel);
    if (total + text.length > budget.maxTotalChars && i > 0) {
      truncated.push(`omitted:${hit.pathRel}`);
      break;
    }
    total += text.length;
    const role = i === 0 ? "primary" : "dependency";
    packetFiles.push({
      pathRel: hit.pathRel,
      role,
      content: text,
      why: `rank=${hit.rankScore}; ${hit.reasons.slice(0, 3).join(",")}`,
    });
    if (i === 0) {
      primaryPath = hit.pathRel;
      primaryContent = text;
    } else {
      relatedSources.push({ path: hit.pathRel, content: text });
    }
  }

  const depPaths = packetFiles.map((f) => f.pathRel);
  const dependencySummary = buildDependencySummary(
    snapshot,
    depPaths,
    budget.maxDepSummaryChars
  );

  const bizText = trimChars(
    business.snippets.map((s) => s.text).join("\n"),
    budget.maxBusinessChars
  ).text;

  const packet: AITestContextPacket = {
    packetVersion: CONTEXT_PACKET_VERSION,
    purpose: "generate-unit",
    meta: {
      language: input.language,
      framework: input.framework,
      projectId: undefined,
      testCaseId: input.testCase.id,
      module: plan.module || input.testCase.module || undefined,
      testKind: isE2e ? undefined : plan.testType === "API" ? "api" : "unit",
    },
    testingStack: {
      testingFramework: input.testingFramework || input.framework,
      mockFramework: input.mockFramework,
      detectedFrom: ["code-index-retrieve", `plan:${plan.testType}`],
      confidence: plan.hints.confidence && plan.hints.confidence >= 0.8 ? "high" : "medium",
    },
    sourceUnderTest: {
      pathRel: primaryPath || undefined,
      symbol: plan.action,
    },
    unitStrategy: {
      whatToTest: plan.action,
      whatToMock: plan.keywords.filter((k) => /service|repo|client|http/i.test(k)).slice(0, 6),
      forbidden: [
        "Do not invent APIs absent from provided sources",
        "Do not hardcode project-specific absolute paths or secrets",
        "Do not modify production source",
      ],
    },
    files: packetFiles,
    diagnostics: {
      truncated,
      omittedPaths: truncated.filter((t) => t.startsWith("omitted:")).map((t) => t.slice(8)),
      seedReason: retrieve.primary
        ? `index-retrieve score=${retrieve.primary.rankScore}`
        : "index-retrieve-empty",
      seedCandidates: ranked.slice(0, 10).map((r) => ({
        pathRel: r.pathRel,
        score: r.rankScore,
        reason: r.reasons.slice(0, 2).join(",") || "rank",
      })),
      gaps: [],
    },
  };

  // Keep seedReason short — long business/deps dump polluted prompts and caused bad gen.
  if (dependencySummary) {
    packet.diagnostics.gaps = [
      ...(packet.diagnostics.gaps || []),
      `deps:\n${dependencySummary.slice(0, 800)}`,
    ];
  }
  if (bizText) {
    packet.unitStrategy = {
      ...packet.unitStrategy,
      whatToTest: [packet.unitStrategy?.whatToTest, bizText.slice(0, 600)]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const e2eFe =
    primaryPath && primaryContent
      ? {
          sourceFileName: primaryPath,
          sourceCode: primaryContent,
          relatedSources,
          notes: [
            ...notes,
            `Phase4 index-context primary=${primaryPath}`,
            plan.hints.featurePath ? `featurePath=${plan.hints.featurePath}` : "",
          ].filter(Boolean),
        }
      : null;

  if (e2eFe && isE2e) {
    try {
      const { attachSiblingFeTemplates } = await import("../e2eWorkspace/resolveE2eFeSources");
      const withTpl = await attachSiblingFeTemplates({
        projectRoot: input.projectRoot,
        sourceFileName: e2eFe.sourceFileName,
        relatedSources: e2eFe.relatedSources,
        readFile: (root, pathRel) => input.io.readFile(root, pathRel),
        actionHint: [
          input.testCase?.title,
          input.testCase?.module,
          input.testCase?.steps,
          input.testCase?.testData,
          plan.action,
        ]
          .filter(Boolean)
          .join("\n"),
      });
      e2eFe.relatedSources = withTpl.relatedSources;
      e2eFe.notes.push(...withTpl.notes);
    } catch {
      /* optional */
    }
  }

  return {
    plan,
    retrieve,
    business,
    snapshot,
    packet,
    e2eFe,
    dependencySummary,
    notes,
    truncated,
  };
}
