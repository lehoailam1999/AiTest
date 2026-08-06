/**
 * BusinessRetriever — TC-first; optional Knowledge/freeze keyword filter.
 *
 * Product intent: Test Case (from SRS analysis) already carries business meaning.
 * This only adds short AC/rules from Knowledge when provided — does NOT re-parse SRS.
 */
import type { PlannerTestCaseInput, TestPlan } from "../testPlanner/types";
import type {
  BusinessRetrieveResult,
  BusinessSnippet,
  KnowledgeSliceInput,
} from "./types";

function clip(text: string, max = 280): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function keywordHit(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const k of keywords) {
    if (k.length >= 2 && lower.includes(k.toLowerCase())) n += 1;
  }
  return n;
}

export type BusinessRetrieveOptions = {
  /** Max snippets (default 6) */
  limit?: number;
  /**
   * Optional Knowledge / freeze slice.
   * Omit when TC is enough (recommended default for gen).
   */
  knowledge?: KnowledgeSliceInput | null;
};

/**
 * Always includes compact TC expected + steps; Knowledge rows only if keyword-overlap.
 */
export function retrieveBusinessContext(
  plan: TestPlan,
  tc: PlannerTestCaseInput,
  opts?: BusinessRetrieveOptions
): BusinessRetrieveResult {
  const limit = opts?.limit ?? 6;
  const notes: string[] = ["BusinessRetriever: TC-first"];
  const keywords = plan.keywords.map((k) => k.toLowerCase());
  const snippets: BusinessSnippet[] = [];

  const expected = (tc.expectedResult || "").trim();
  if (expected) {
    snippets.push({
      kind: "fromTc",
      text: clip(`Expected: ${expected}`),
      score: 100,
    });
  }
  const steps = (tc.steps || "").trim();
  if (steps) {
    snippets.push({
      kind: "fromTc",
      text: clip(`Steps: ${steps}`, 400),
      score: 90,
    });
  }
  const pre = (tc.precondition || "").trim();
  if (pre) {
    snippets.push({
      kind: "fromTc",
      text: clip(`Precondition: ${pre}`),
      score: 80,
    });
  }

  const knowledge = opts?.knowledge;
  if (!knowledge) {
    notes.push("no Knowledge slice — TC only (by design)");
  } else {
    notes.push("Knowledge optional filter by plan.keywords");
    for (const ac of knowledge.acceptanceCriteria || []) {
      const text = (ac.text || "").trim();
      if (!text) continue;
      const hit = keywordHit(text, keywords);
      if (hit === 0 && keywords.length) continue;
      snippets.push({
        kind: "acceptance",
        text: clip(`AC: ${text}`),
        score: 50 + hit * 10,
      });
    }
    for (const br of knowledge.businessRules || []) {
      const text = (br.text || "").trim();
      if (!text) continue;
      const hit = keywordHit(text, keywords);
      if (hit === 0 && keywords.length) continue;
      snippets.push({
        kind: "businessRule",
        text: clip(`BR${br.id ? `(${br.id})` : ""}: ${text}`),
        score: 45 + hit * 10,
      });
    }
    for (const f of knowledge.features || []) {
      const blob = `${f.name || ""} ${f.description || ""}`.trim();
      if (!blob) continue;
      const hit = keywordHit(blob, keywords);
      if (hit === 0 && keywords.length) continue;
      snippets.push({
        kind: "feature",
        text: clip(`Feature: ${blob}`),
        score: 40 + hit * 10,
      });
    }
    for (const v of knowledge.validationRules || []) {
      const text = `${v.field || ""} ${v.rule || ""}`.trim();
      if (!text) continue;
      const hit = keywordHit(text, keywords);
      if (hit === 0 && keywords.length) continue;
      snippets.push({
        kind: "validation",
        text: clip(`Validation: ${text}`),
        score: 35 + hit * 10,
      });
    }
  }

  snippets.sort((a, b) => b.score - a.score);
  return {
    snippets: snippets.slice(0, limit),
    notes,
  };
}
