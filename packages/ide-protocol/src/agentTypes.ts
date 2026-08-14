/**
 * V2.1 Agentic types — shared Desktop ↔ Backend (P9+).
 * Analyzer/Planner/Confidence live on Backend; Desktop orchestrates IDE retrieval.
 */

export type BusinessIntent = {
  action: string;
  entity: string;
  expectedResults: string[];
  businessRules: string[];
  validationRules: string[];
  externalDeps: string[];
  domainTerms: string[];
  /** Tokens for Planner / IDE search (may include EN aliases) */
  searchHints: string[];
};

export type ContextPlanStepOp =
  | "searchSymbol"
  | "searchText"
  | "searchClass"
  | "searchMethod"
  | "goToDefinition"
  | "findReferences"
  | "readFile"
  | "getSemanticContext";

export type ContextPlanStep = {
  op: ContextPlanStepOp;
  query: string;
  reason: string;
};

export type ContextPlan = {
  round: number;
  rationale: string;
  steps: ContextPlanStep[];
  stopWhen: {
    minConfidence: number;
    maxFiles: number;
  };
};

export type RetrievedFile = {
  path: string;
  role: string;
  snippet?: string;
  symbolIds?: string[];
  score?: number;
};

export type RetrievalResult = {
  files: RetrievedFile[];
  evidence: string[];
};

export type ConfidenceCandidate = {
  symbol: string;
  path: string;
  score: number;
  rationale: string;
};

export type ConfidenceReport = {
  candidates: ConfidenceCandidate[];
  overall: number;
  enough: boolean;
  missingHints: string[];
};

export type AgentRunPhase =
  | "idle"
  | "analyzing"
  | "planning"
  | "retrieving"
  | "evaluating"
  | "generating"
  | "needs_user"
  | "done"
  | "error";
