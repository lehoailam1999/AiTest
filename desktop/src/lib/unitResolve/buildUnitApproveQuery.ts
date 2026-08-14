/**
 * Query Builder — TC → portable UnitApproveQuery for index retrieval.
 * No product nouns; domain tokens only from projectAliases / tech stems.
 */
import {
  extractOpPreferTokens,
  extractUnitIntent,
  filterStrongRankTokens,
  matchingProjectAliasTokens,
  type UnitIntent,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { extractMatchTokens } from "../projectIntelligence/tcSeedResolver";
import type { CodeAliasMap } from "../projectIntelligence/viCodeAliases";
import { extractTechIdentifierStems } from "../approvedTcSync/progressiveSeedFromCodeIndex";
import type { TestPlan } from "../testPlanner/types";

export type UnitApproveQuery = {
  intent: UnitIntent;
  keywords: string[];
  /** Function (TC.module) — ranks files inside Module family */
  module: string;
  /** TC title — feature-folder / bridge discover */
  title: string;
  action: string;
  /** Module (Requirement Studio title) — scopes source-module family */
  requirementTitle: string;
  projectAliases: CodeAliasMap;
  requiresBodyRule: boolean;
  /** create + mã/code / auto_generate — widen CheckCode feature folders */
  codeFieldCreate: boolean;
  tcBlob: string;
  /** Raw Test Data — layerHint / sourceSignal for DTO|Validator promote */
  testData: string;
  preferTokens: string[];
  /**
   * Prefer tokens from Module/Function/Title (+ aliases) only —
   * soft writeBack / domain signal; excludes Steps/TestData noise.
   */
  preferTokensStrong: string[];
  /** Bridge to Gen retrieveUnitSources */
  plan: TestPlan;
};

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = String(x || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function stripBlob(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export type BuildUnitApproveQueryOpts = {
  requirementTitle?: string | null;
  projectAliases?: CodeAliasMap | null;
  /** Intent already merged with project intent rules (optional). */
  intent?: UnitIntent | null;
};

/**
 * Build retrieval query from Approved TC text.
 */
export function buildUnitApproveQuery(
  tc: Pick<
    TestCase,
    "title" | "module" | "steps" | "expectedResult" | "testData" | "precondition"
  >,
  opts?: BuildUnitApproveQueryOpts
): UnitApproveQuery {
  const requirementTitle = String(opts?.requirementTitle || "").trim();
  const projectAliases = opts?.projectAliases || {};
  const intent =
    opts?.intent ||
    extractUnitIntent(tc, {
      projectAliases,
      requirementTitle,
      uiFromTitleModuleOnly: true,
      cuesFromGroundingOnly: true,
    });

  const aliasDomain = matchingProjectAliasTokens(
    [requirementTitle, tc.module, tc.title].filter(Boolean).join(" "),
    projectAliases
  );
  // Soft tech stems only — must not drive intent class (path SoT = Module/Function/Title)
  const techStems = extractTechIdentifierStems(
    [tc.testData || "", tc.expectedResult || "", tc.precondition || ""].join("\n")
  );
  const titleModTokens = extractMatchTokens(
    [requirementTitle, tc.module, tc.title].filter(Boolean).join(" "),
    projectAliases
  );
  // Prefer alias + tech + intent class features; drop weak GENERIC_VI verb noise for retrieve
  const classFeats = filterStrongRankTokens(intent.classFeatureTokens || []);
  const keywords = filterStrongRankTokens(
    uniq([
      ...aliasDomain,
      ...classFeats,
      ...titleModTokens.filter((t) => t.length >= 4),
      ...techStems,
    ])
  ).slice(0, 32);

  // Grounding blob only — Steps/TestData must not flip create vs state_enable shape
  const tcBlob = [requirementTitle, tc.title, tc.module].filter(Boolean).join("\n");
  const blobNorm = stripBlob(tcBlob);
  const createCue = /tao\s*moi|\bcreate\b|them\s*moi/.test(blobNorm);
  const codeFieldCreate =
    intent.primaryClass === "auto_generate_code" ||
    (intent.classes || []).includes("auto_generate_code") ||
    (createCue &&
      /\bma\b|\bcode\b|de\s*trong|tu\s*sinh|empty\s*code|trung\s*(ma|code)/.test(
        blobNorm
      ));

  const module = String(tc.module || "").trim() || "unit";
  const action =
    intent.primaryClass ||
    (createCue ? "create" : "") ||
    "handle";

  // Op tokens from Function/Title (storage/authz/assign) — soft writeBack must hit these.
  const groundingBlob = [requirementTitle, tc.module, tc.title]
    .filter(Boolean)
    .join("\n");
  const opPrefer = extractOpPreferTokens(intent, groundingBlob);

  // Module/Function/Title (+ aliases) — domain latch. Tech stems from Test Data rank softer.
  const preferTokensStrong = uniq([
    ...aliasDomain,
    ...filterStrongRankTokens(titleModTokens),
    ...classFeats,
    ...opPrefer,
  ]);
  const preferTokens = uniq([
    ...preferTokensStrong,
    ...techStems,
    ...intent.featureTokens,
  ]);

  const testData = String(tc.testData || "").trim();
  const validationBucket =
    /primaryBucket:\s*VALIDATION_DATA/i.test(testData) ||
    /trace:\s*VALIDATION_DATA/i.test(testData);
  const resolvedIntent =
    validationBucket && !intent.requiresBodyRule
      ? { ...intent, requiresBodyRule: true }
      : intent;

  const plan: TestPlan = {
    testType: "Unit",
    module: aliasDomain[0] || module,
    action,
    keywords,
    hints: {
      confidence: keywords.length ? 0.7 : 0.4,
      reasons: [
        `intent:${intent.primaryClass || "none"}`,
        `kw:${keywords.slice(0, 6).join(",")}`,
      ],
    },
  };

  return {
    intent: resolvedIntent,
    keywords,
    module,
    title: String(tc.title || "").trim(),
    action,
    requirementTitle,
    projectAliases,
    requiresBodyRule: resolvedIntent.requiresBodyRule,
    codeFieldCreate,
    tcBlob,
    testData,
    preferTokens,
    preferTokensStrong,
    plan,
  };
}
