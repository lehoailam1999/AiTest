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
// Primary resolution and source reads finish at slightly different times per
// TC. A 20 ms window fragmented one Approve wave into concurrent CLI cold
// starts; 750 ms reliably coalesces the wave while adding negligible latency.
const BATCH_WINDOW_MS = 750;
const BATCH_CAP = 10;

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
  return enqueueFieldPick(input);
}

type PendingFieldPick = {
  input: LlmPickUnitFieldInput;
  resolve: (result: LlmPickUnitFieldResult | null) => void;
};

const fieldPickQueues = new Map<string, PendingFieldPick[]>();
const fieldPickTimers = new Map<string, ReturnType<typeof setTimeout>>();

function enqueueFieldPick(
  input: LlmPickUnitFieldInput
): Promise<LlmPickUnitFieldResult | null> {
  const key = String(input.projectId);
  return new Promise((resolve) => {
    const queue = fieldPickQueues.get(key) || [];
    queue.push({ input, resolve });
    fieldPickQueues.set(key, queue);
    if (queue.length >= BATCH_CAP) {
      const timer = fieldPickTimers.get(key);
      if (timer) clearTimeout(timer);
      fieldPickTimers.delete(key);
      void flushFieldPickQueue(key);
    } else if (!fieldPickTimers.has(key)) {
      fieldPickTimers.set(
        key,
        setTimeout(() => {
          fieldPickTimers.delete(key);
          void flushFieldPickQueue(key);
        }, BATCH_WINDOW_MS)
      );
    }
  });
}

async function flushFieldPickQueue(projectId: string): Promise<void> {
  const queued = fieldPickQueues.get(projectId) || [];
  const batch = queued.splice(0, BATCH_CAP);
  if (queued.length) fieldPickQueues.set(projectId, queued);
  else fieldPickQueues.delete(projectId);
  if (!batch.length) return;
  try {
    const { authFetch } = await import("../../api/client");
    const controller = new AbortController();
    const timeoutMs = Math.max(
      40_000,
      PICK_TIMEOUT_MS,
      ...batch.map((item) => item.input.pickTimeoutMs || PICK_TIMEOUT_MS)
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await authFetch<{ results?: ApiPickFieldResponse[] }>(
        "/agent/pick-unit-field-batch",
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            projectId,
            items: batch.map(({ input }, id) => ({
              id,
              fieldLabel: input.fieldLabel || "",
              inputKeys: (input.inputKeys || []).slice(0, 12),
              title: input.title || "",
              steps: (input.steps || "").slice(0, 600),
              primaryPath: (input.primaryPath || "").replace(/\\/g, "/"),
              candidates: input.candidates
                .slice(0, SHORTLIST_CAP)
                .map((property) => ({ property })),
            })),
          }),
        }
      );
      if (!Array.isArray(response.results)) {
        console.warn(
          `[Approve field pick] batch returned no results (size=${batch.length})`
        );
      }
      batch.forEach((pending, id) =>
        pending.resolve(
          acceptFieldShortlistPick(response.results?.[id], pending.input.candidates)
        )
      );
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn(
      `[Approve field pick] batch failed (size=${batch.length}):`,
      error instanceof Error ? error.message : String(error)
    );
    batch.forEach((pending) => pending.resolve(null));
  }
}

export type PickFieldFromShortlistFn = (
  input: LlmPickUnitFieldInput
) => Promise<LlmPickUnitFieldResult | null>;
