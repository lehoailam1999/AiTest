/** Phase 3 — Retrieval Engine types. */

import type { TestPlan } from "../testPlanner/types";

export type RankedFileHit = {
  pathRel: string;
  rankScore: number;
  reasons: string[];
};

export type RetrieveFilesResult = {
  /** Top-K paths (default 5–10) */
  files: RankedFileHit[];
  primary: RankedFileHit | null;
  notes: string[];
  plan: TestPlan;
};

export type BusinessSnippetKind = "fromTc" | "acceptance" | "businessRule" | "feature" | "validation";

export type BusinessSnippet = {
  kind: BusinessSnippetKind;
  text: string;
  score: number;
};

export type BusinessRetrieveResult = {
  /** TC-first; Knowledge only if provided and keyword-matched */
  snippets: BusinessSnippet[];
  notes: string[];
};

/** Optional Knowledge / freeze slice — NOT re-parse SRS. */
export type KnowledgeSliceInput = {
  features?: { name?: string; description?: string }[];
  businessRules?: { id?: string; text?: string }[];
  acceptanceCriteria?: { text?: string }[];
  validationRules?: { field?: string; rule?: string; module?: string }[];
  summary?: string | null;
};

export type RetrieveOptions = {
  /** Top-K files (default 8, clamp 5–10 for KPI band) */
  topK?: number;
};
