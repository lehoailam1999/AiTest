/**
 * Grounded AI pick for Approve Unit primary — path must ∈ shortlist from index.
 * No product dictionaries; no invented paths.
 */

export type UnitPrimaryShortlistItem = {
  pathRel: string;
  code?: string;
  score?: number;
  /** Bounded source owned by this exact candidate path. */
  excerpt?: string;
  /** Types defined by this exact candidate path. */
  symbols?: string[];
  /** DTO/input properties reachable from this candidate. */
  properties?: Array<{
    name: string;
    ownerPath: string;
    ownerType?: string;
    excerpt?: string;
  }>;
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
  property?: string;
  evidence?: string;
  confidence: number;
  source: "llm" | "mock";
};

const MIN_CONFIDENCE = 0.7;
/** Client-side cap — do not wait for provider's full 180s TC-gen timeout. */
const PICK_TIMEOUT_MS = 14_000;
/** Retry pass (batch Approve) — allow extra time after first concurrent wave. */
const PICK_RETRY_TIMEOUT_MS = 28_000;
const SHORTLIST_CAP = 8;
const BATCH_WINDOW_MS = 20;
const BATCH_CAP = 10;

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
    property?: string | null;
    evidence?: string | null;
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
  const code = String(pick.code || "").trim() || String(hit.code || "").trim();
  const allowedSymbols = new Set(
    [hit.code, ...(hit.symbols || [])]
      .map((s) => String(s || "").trim().split(".")[0]?.toLowerCase())
      .filter(Boolean)
  );
  const typeName = code.split(".")[0]?.trim().toLowerCase();
  if (!code || !typeName || !allowedSymbols.has(typeName)) return null;
  const evidence = String(pick.evidence || "").trim();
  if (hit.excerpt?.trim()) {
    if (!evidence || !hit.excerpt.toLowerCase().includes(evidence.toLowerCase())) {
      return null;
    }
  }
  const propertyWant = String(pick.property || "").trim();
  const property = propertyWant
    ? hit.properties?.find((p) => p.name.toLowerCase() === propertyWant.toLowerCase())
        ?.name
    : undefined;
  if (propertyWant && !property) return null;
  return {
    pathRel: hit.pathRel.replace(/\\/g, "/"),
    code,
    property,
    evidence: evidence || undefined,
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
    const properties = (s.properties || []).map((p) => p.name).join(", ");
    return [
      `${i + 1}. path=${s.pathRel.replace(/\\/g, "/")} code=${code}`,
      s.excerpt ? `SOURCE:\n${s.excerpt.slice(0, 2200)}` : "",
      properties ? `PROPERTIES: ${properties}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const system =
    "You pick the best Unit test primary SUT handler/service for a Test Case.\n" +
    "You MUST choose exactly one path from the candidate list. Never invent paths.\n" +
    "Prefer CommandHandler/Service matching Module/Title domain over Query/User/Account unless TC is about users.\n" +
    "Choose code only when that type is defined in the same candidate path.\n" +
    "Choose property only from PROPERTIES belonging to the chosen candidate. Do not guess translations.\n" +
    "Evidence must be a short exact quote copied from the chosen SOURCE.\n" +
    "Return ONLY JSON: {\"path\":\"...\",\"code\":\"...\",\"property\":\"...|null\",\"evidence\":\"exact quote\",\"confidence\":0.0-1.0}\n" +
    "If none fit, return {\"path\":null,\"code\":null,\"property\":null,\"evidence\":null,\"confidence\":0}.";
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
  property?: string | null;
  evidence?: string | null;
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
  return enqueuePrimaryPick(input);
}

type PendingPrimaryPick = {
  input: LlmPickUnitPrimaryInput;
  resolve: (result: LlmPickUnitPrimaryResult | null) => void;
};

const primaryPickQueues = new Map<string, PendingPrimaryPick[]>();
const primaryPickTimers = new Map<string, ReturnType<typeof setTimeout>>();

function candidatePayload(s: UnitPrimaryShortlistItem) {
  return {
    path: s.pathRel.replace(/\\/g, "/"),
    code: s.code || symbolFromPath(s.pathRel),
    score: s.score ?? 0,
    symbols: s.symbols || [],
    excerpt: (s.excerpt || "").slice(0, 1200),
    properties: (s.properties || []).slice(0, 24).map((p) => ({
      name: p.name,
      ownerPath: p.ownerPath.replace(/\\/g, "/"),
      ownerType: p.ownerType || "",
    })),
  };
}

function enqueuePrimaryPick(
  input: LlmPickUnitPrimaryInput
): Promise<LlmPickUnitPrimaryResult | null> {
  const key = String(input.projectId);
  return new Promise((resolve) => {
    const queue = primaryPickQueues.get(key) || [];
    queue.push({ input, resolve });
    primaryPickQueues.set(key, queue);
    if (queue.length >= BATCH_CAP) {
      const timer = primaryPickTimers.get(key);
      if (timer) clearTimeout(timer);
      primaryPickTimers.delete(key);
      void flushPrimaryPickQueue(key);
    } else if (!primaryPickTimers.has(key)) {
      primaryPickTimers.set(
        key,
        setTimeout(() => {
          primaryPickTimers.delete(key);
          void flushPrimaryPickQueue(key);
        }, BATCH_WINDOW_MS)
      );
    }
  });
}

async function flushPrimaryPickQueue(projectId: string): Promise<void> {
  const queued = primaryPickQueues.get(projectId) || [];
  const batch = queued.splice(0, BATCH_CAP);
  if (queued.length) {
    primaryPickQueues.set(projectId, queued);
    primaryPickTimers.set(
      projectId,
      setTimeout(() => {
        primaryPickTimers.delete(projectId);
        void flushPrimaryPickQueue(projectId);
      }, BATCH_WINDOW_MS)
    );
  } else {
    primaryPickQueues.delete(projectId);
  }
  if (!batch.length) return;
  try {
    const { authFetch } = await import("../../api/client");
    const controller = new AbortController();
    const timeoutMs = Math.max(
      40_000,
      ...batch.map((item) => item.input.pickTimeoutMs || PICK_TIMEOUT_MS)
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await authFetch<{ results?: ApiPickResponse[] }>(
        "/agent/pick-unit-grounding-batch",
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            projectId,
            items: batch.map(({ input }, id) => ({
              id,
              requirementTitle: input.requirementTitle || "",
              module: input.module || "",
              title: input.title || "",
              steps: (input.steps || "").slice(0, 600),
              expectedResult: (input.expectedResult || "").slice(0, 300),
              candidates: input.shortlist.slice(0, 5).map(candidatePayload),
            })),
          }),
        }
      );
      batch.forEach((pending, id) => {
        pending.resolve(
          acceptShortlistPick(response.results?.[id], pending.input.shortlist)
        );
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    batch.forEach((pending) => pending.resolve(null));
  }
}

/** Longer timeout for batch Approve retry pass (after concurrent wave). */
export const LLM_PICK_RETRY_TIMEOUT_MS = PICK_RETRY_TIMEOUT_MS;

export type PickFromShortlistFn = (
  input: LlmPickUnitPrimaryInput
) => Promise<LlmPickUnitPrimaryResult | null>;
