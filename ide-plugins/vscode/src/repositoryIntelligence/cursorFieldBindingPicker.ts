import {
  resolveAgentBinary,
  runCursorAgentOneshotWithBin,
} from "../cursorAgentCliEngine";
import { lastJsonObject } from "./parseAgentJson";
import type {
  FieldBindingPick,
  FieldBindingPicker,
  FieldBindingPickResult,
} from "./resolveBindings";

function parseResult(raw: string): {
  picks: FieldBindingPick[];
  missing: string[];
} {
  const parsed = lastJsonObject(raw);
  if (!parsed) return { picks: [], missing: [] };
  const mappings = Array.isArray(parsed.mappings) ? parsed.mappings : [];
  const picks = mappings.flatMap((item): FieldBindingPick[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (
      typeof value.label !== "string" ||
      typeof value.property !== "string" ||
      typeof value.ownerPath !== "string"
    ) {
      return [];
    }
    return [
      {
        label: value.label,
        property: value.property,
        ownerPath: value.ownerPath.replace(/\\/g, "/"),
      },
    ];
  });
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : []).filter(
    (item): item is string => typeof item === "string"
  );
  return { picks, missing };
}

export const pickFieldBindingsWithCursor: FieldBindingPicker = async (
  input
): Promise<FieldBindingPickResult> => {
  if (!input.labels.length || !input.candidates.length) {
    return { picks: [], missing: [] };
  }
  const root = (await import("./vscodeRuntime")).vscodeRepositoryRuntime.workspaceRoot();
  if (!root) return { picks: [], error: "no workspace folder" };
  let engine: string;
  try {
    engine = resolveAgentBinary();
  } catch (error) {
    return {
      picks: [],
      error: `agent CLI not resolvable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const timeoutMs = Math.min(
    60_000,
    Math.max(4_000, input.timeoutMs ?? 20_000)
  );

  const prompt = [
    "You map business test-data labels to source-code properties.",
    "Choose only from CANDIDATES. Never invent or rename a property/path.",
    "Use the test case meaning, module, expected result, constraint, display",
    "names and owner types. Labels are usually a non-English wording of the",
    "same concept the property name states in English.",
    "Split camelCase labels into words and translate their business meaning",
    "before comparing them with candidate property names.",
    // Omitting on ambiguity is what left labels unbound while the right property
    // sat in the shortlist: a best single choice is reviewable, silence is not.
    "For every label pick the single best candidate; only when no candidate",
    "could hold that data, list the label under \"missing\" instead.",
    "Do not search or read repository files: CANDIDATES already come from the",
    "IDE symbol index and are the only permitted answers.",
    'Return JSON only: {"mappings":[{"label":"...","property":"...","ownerPath":"..."}],"missing":["..."]}',
    "",
    `TEST_CASE_TITLE: ${input.testCaseTitle}`,
    `MODULE: ${input.module}`,
    `EXPECTED: ${input.expected}`,
    `CONSTRAINT: ${input.constraint || ""}`,
    `LABELS: ${JSON.stringify(input.labels)}`,
    `INPUT_KEYS: ${JSON.stringify(input.inputKeys)}`,
    `CANDIDATES: ${JSON.stringify(input.candidates)}`,
  ].join("\n");

  try {
    const raw = await runCursorAgentOneshotWithBin(
      engine,
      prompt,
      root,
      timeoutMs
    );
    const { picks, missing } = parseResult(raw);
    return {
      picks,
      missing,
      engine,
      error:
        picks.length || missing.length
          ? undefined
          : `agent returned no usable mapping (${
              raw.trim().slice(0, 200) || "empty output"
            })`,
    };
  } catch (error) {
    // Approval remains fail-closed, but the reason must survive into the decision.
    return {
      picks: [],
      engine,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
