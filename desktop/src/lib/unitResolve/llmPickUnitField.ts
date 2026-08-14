/**
 * Grounded AI pick for Approve Unit field property — must ∈ shortlist from index.
 * No product dictionaries; no invented property names.
 */

export type LlmPickUnitFieldInput = {
  projectId?: string | null;
  fieldLabel: string;
  inputKeys?: string[];
  title?: string | null;
  steps?: string | null;
  primaryPath?: string | null;
  candidates: string[];
  pickTimeoutMs?: number;
};

export type LlmPickUnitFieldResult = {
  property: string;
  confidence: number;
  source: "llm" | "mock";
};

const MIN_CONFIDENCE = 0.7;
const PICK_TIMEOUT_MS = 14_000;
const SHORTLIST_CAP = 24;
const LLM_PICK_MAX_INFLIGHT = 2;
let llmFieldPickInflight = 0;
const llmFieldPickWaiters: Array<() => void> = [];

async function withLlmFieldPickSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (llmFieldPickInflight >= LLM_PICK_MAX_INFLIGHT) {
    await new Promise<void>((resolve) => llmFieldPickWaiters.push(resolve));
  }
  llmFieldPickInflight += 1;
  try {
    return await fn();
  } finally {
    llmFieldPickInflight -= 1;
    const next = llmFieldPickWaiters.shift();
    if (next) next();
  }
}

/**
 * Validate LLM (or mock) pick against property shortlist — refuse invented names.
 */
export function acceptFieldShortlistPick(
  pick: {
    property?: string | null;
    confidence?: number | null;
  } | null | undefined,
  shortlist: string[],
  opts?: { minConfidence?: number }
): LlmPickUnitFieldResult | null {
  if (!pick || !shortlist.length) return null;
  const minC = opts?.minConfidence ?? MIN_CONFIDENCE;
  const conf = Number(pick.confidence);
  if (!Number.isFinite(conf) || conf < minC) return null;
  const want = String(pick.property || "").trim();
  if (!want || !/^[A-Za-z_][\w]*$/.test(want)) return null;
  const wantL = want.toLowerCase();
  const hit = shortlist.find((s) => s.trim().toLowerCase() === wantL);
  if (!hit) return null;
  return {
    property: hit.trim(),
    confidence: conf,
    source: "llm",
  };
}

export function buildPickUnitFieldPrompt(input: LlmPickUnitFieldInput): {
  system: string;
  user: string;
} {
  const lines = input.candidates.slice(0, SHORTLIST_CAP).map((p, i) => `${i + 1}. ${p}`);
  const keys = (input.inputKeys || []).filter(Boolean).slice(0, 12).join(", ") || "—";
  const system =
    "You pick the best backend DTO/command property for a Unit validation Test Case.\n" +
    "You MUST choose exactly one property name from the candidate list. Never invent names.\n" +
    "Match the human field label / input keys / title meaning to the Latin property.\n" +
    'Return ONLY JSON: {"property":"...","confidence":0.0-1.0}\n' +
    'If none fit, return {"property":null,"confidence":0}.';
  const user = [
    `Field label: ${input.fieldLabel || "—"}`,
    `Input keys: ${keys}`,
    `Title: ${input.title || "—"}`,
    `Primary path: ${(input.primaryPath || "—").replace(/\\/g, "/")}`,
    `Steps:\n${(input.steps || "—").slice(0, 800)}`,
    "",
    "Candidates (index DTO properties only):",
    ...lines,
  ].join("\n");
  return { system, user };
}

type ApiPickFieldResponse = {
  property?: string | null;
  confidence?: number | null;
  source?: string;
};

/**
 * Call Backend AI to pick among property shortlist. Returns null on refuse/error/timeout.
 */
export async function llmPickUnitField(
  input: LlmPickUnitFieldInput
): Promise<LlmPickUnitFieldResult | null> {
  if (!input.candidates.length) return null;
  if (!input.projectId) return null;
  const timeoutMs = input.pickTimeoutMs ?? PICK_TIMEOUT_MS;
  return withLlmFieldPickSlot(async () => {
    try {
      const { authFetch } = await import("../../api/client");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const raw = await authFetch<ApiPickFieldResponse>("/agent/pick-unit-field", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            projectId: input.projectId,
            fieldLabel: input.fieldLabel || "",
            inputKeys: (input.inputKeys || []).slice(0, 12),
            title: input.title || "",
            steps: (input.steps || "").slice(0, 600),
            primaryPath: (input.primaryPath || "").replace(/\\/g, "/"),
            candidates: input.candidates.slice(0, SHORTLIST_CAP).map((property) => ({
              property,
            })),
          }),
        });
        return acceptFieldShortlistPick(raw, input.candidates);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  });
}

export type PickFieldFromShortlistFn = (
  input: LlmPickUnitFieldInput
) => Promise<LlmPickUnitFieldResult | null>;
