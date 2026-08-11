/**
 * Grounded AI pick for Approve Unit primary — path must ∈ shortlist from index.
 * No product dictionaries; no invented paths.
 */

export type UnitPrimaryShortlistItem = {
  pathRel: string;
  code?: string;
  score?: number;
};

export type LlmPickUnitPrimaryInput = {
  projectId?: string | null;
  requirementTitle?: string | null;
  module?: string | null;
  title?: string | null;
  steps?: string | null;
  expectedResult?: string | null;
  shortlist: UnitPrimaryShortlistItem[];
  /** Override client timeout (ms) — e.g. batch retry pass. */
  pickTimeoutMs?: number;
};

export type LlmPickUnitPrimaryResult = {
  pathRel: string;
  code: string;
  confidence: number;
  source: "llm" | "mock";
};

const MIN_CONFIDENCE = 0.7;
/** Client-side cap — do not wait for provider's full 180s TC-gen timeout. */
const PICK_TIMEOUT_MS = 14_000;
/** Retry pass (batch Approve) — allow extra time after first concurrent wave. */
const PICK_RETRY_TIMEOUT_MS = 28_000;
const SHORTLIST_CAP = 8;
/** Cap parallel LLM picks — bulk Approve timeouts when 6+ fire at once. */
const LLM_PICK_MAX_INFLIGHT = 2;
let llmPickInflight = 0;
const llmPickWaiters: Array<() => void> = [];

async function withLlmPickSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (llmPickInflight >= LLM_PICK_MAX_INFLIGHT) {
    await new Promise<void>((resolve) => llmPickWaiters.push(resolve));
  }
  llmPickInflight += 1;
  try {
    return await fn();
  } finally {
    llmPickInflight -= 1;
    const next = llmPickWaiters.shift();
    if (next) next();
  }
}

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").toLowerCase();
}

function symbolFromPath(pathRel: string): string {
  const base = (pathRel || "").replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "") || "Sut";
}

/**
 * Validate LLM (or mock) pick against shortlist — refuse invented paths.
 */
export function acceptShortlistPick(
  pick: {
    path?: string | null;
    code?: string | null;
    confidence?: number | null;
  } | null | undefined,
  shortlist: UnitPrimaryShortlistItem[],
  opts?: { minConfidence?: number }
): LlmPickUnitPrimaryResult | null {
  if (!pick || !shortlist.length) return null;
  const minC = opts?.minConfidence ?? MIN_CONFIDENCE;
  const conf = Number(pick.confidence);
  if (!Number.isFinite(conf) || conf < minC) return null;
  const want = normPath(String(pick.path || ""));
  if (!want) return null;
  const hit = shortlist.find((s) => {
    const p = normPath(s.pathRel);
    return p === want || p.endsWith(`/${want}`) || want.endsWith(`/${p}`);
  });
  if (!hit) return null;
  const code =
    String(pick.code || "").trim() ||
    String(hit.code || "").trim() ||
    symbolFromPath(hit.pathRel);
  return {
    pathRel: hit.pathRel.replace(/\\/g, "/"),
    code,
    confidence: conf,
    source: "llm",
  };
}

export function buildPickUnitPrimaryPrompt(input: LlmPickUnitPrimaryInput): {
  system: string;
  user: string;
} {
  const lines = input.shortlist.slice(0, SHORTLIST_CAP).map((s, i) => {
    const code = s.code || symbolFromPath(s.pathRel);
    return `${i + 1}. path=${s.pathRel.replace(/\\/g, "/")} code=${code}`;
  });
  const system =
    "You pick the best Unit test primary SUT handler/service for a Test Case.\n" +
    "You MUST choose exactly one path from the candidate list. Never invent paths.\n" +
    "Prefer CommandHandler/Service matching Module/Title domain over Query/User/Account unless TC is about users.\n" +
    "Return ONLY JSON: {\"path\":\"...\",\"code\":\"...\",\"confidence\":0.0-1.0}\n" +
    "If none fit, return {\"path\":null,\"code\":null,\"confidence\":0}.";
  const user = [
    `Module (requirement): ${input.requirementTitle || "—"}`,
    `Function: ${input.module || "—"}`,
    `Title: ${input.title || "—"}`,
    `Steps:\n${(input.steps || "—").slice(0, 800)}`,
    `Expected:\n${(input.expectedResult || "—").slice(0, 400)}`,
    "",
    "Candidates (index only):",
    ...lines,
  ].join("\n");
  return { system, user };
}

type ApiPickResponse = {
  path?: string | null;
  code?: string | null;
  confidence?: number | null;
  source?: string;
};

/**
 * Call Backend AI to pick among shortlist. Returns null on refuse/error/AI-not-ready/timeout.
 */
export async function llmPickUnitPrimary(
  input: LlmPickUnitPrimaryInput
): Promise<LlmPickUnitPrimaryResult | null> {
  if (!input.shortlist.length) return null;
  if (!input.projectId) return null;
  const timeoutMs = input.pickTimeoutMs ?? PICK_TIMEOUT_MS;
  return withLlmPickSlot(async () => {
    try {
      // Lazy import — keep unitResolve tests free of Vite import.meta.env
      const { authFetch } = await import("../../api/client");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const raw = await authFetch<ApiPickResponse>("/agent/pick-unit-primary", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            projectId: input.projectId,
            requirementTitle: input.requirementTitle || "",
            module: input.module || "",
            title: input.title || "",
            steps: (input.steps || "").slice(0, 600),
            expectedResult: (input.expectedResult || "").slice(0, 300),
            candidates: input.shortlist.slice(0, SHORTLIST_CAP).map((s) => ({
              path: s.pathRel.replace(/\\/g, "/"),
              code: s.code || symbolFromPath(s.pathRel),
              score: s.score ?? 0,
            })),
          }),
        });
        return acceptShortlistPick(raw, input.shortlist);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  });
}

/** Longer timeout for batch Approve retry pass (after concurrent wave). */
export const LLM_PICK_RETRY_TIMEOUT_MS = PICK_RETRY_TIMEOUT_MS;

export type PickFromShortlistFn = (
  input: LlmPickUnitPrimaryInput
) => Promise<LlmPickUnitPrimaryResult | null>;
