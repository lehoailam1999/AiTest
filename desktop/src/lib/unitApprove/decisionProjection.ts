import {
  projectDecisionToV1Grounding,
  type UnitApprovalDecision,
} from "@aitest/ide-protocol";

export type UnitDecisionProjection = {
  testData: string;
  automationReady: boolean;
  v1Grounding: ReturnType<typeof projectDecisionToV1Grounding>;
  canonicalInput: Readonly<Record<string, unknown>>;
};

/** Verdict markers: always rewritten, every outcome produces them. */
const DECISION_MARKER_RE = /^\s*(?:path|code|related|status|reason)\s*:\s*.*$/i;
/**
 * Markers that only exist once a primary was grounded. A refused run cannot
 * regenerate them, so it must leave the analysis markers untouched instead of
 * stripping the test case down to an empty target.
 */
const GROUNDED_MARKER_RE =
  /^\s*(?:target\.property|target\.properties|sourceSignal|layer|input)\s*:\s*.*$/i;
/** Written by an older projection that rewrote target.field into properties. */
const DEAD_MARKER_RE = /^\s*target\.fieldLabel\s*:\s*.*$/i;

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function canonicalizeInput(
  decision: UnitApprovalDecision
): Readonly<Record<string, unknown>> {
  if (decision.canonicalInput) return decision.canonicalInput;
  const original = decision.testCase.ir.testData.input || {};
  const entries = Object.entries(original);
  if (!entries.length || !decision.fieldBindings.length) return original;
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const keyNorm = normalized(key);
    const binding = decision.fieldBindings.find(
      (item) =>
        normalized(item.label) === keyNorm ||
        normalized(item.property) === keyNorm
    );
    result[binding?.property || key] = value;
  }
  return result;
}

/**
 * `target.field` keeps the business label the analysis wrote, so the resolved
 * source names are reported separately, ordered by the target fields.
 */
function boundProperties(decision: UnitApprovalDecision): string[] {
  const labels = decision.testCase.ir.testData.target?.fields || [];
  const rank = (label: string) => {
    const index = labels.findIndex((item) => normalized(item) === normalized(label));
    return index < 0 ? labels.length : index;
  };
  return [
    ...new Set(
      [...decision.fieldBindings]
        .sort((a, b) => rank(a.label) - rank(b.label))
        .map((binding) => binding.property)
        .filter(Boolean)
    ),
  ];
}

/** A refused run without a primary has nothing verified to project. */
export function emitsSutMarkers(decision: UnitApprovalDecision): boolean {
  return (
    Boolean(decision.primary) &&
    (decision.authoritative || decision.outcome === "FEATURE_GAP")
  );
}

export function renderDecisionGroundingLines(
  decision: UnitApprovalDecision
): string[] {
  const lines: string[] = [];
  if (emitsSutMarkers(decision) && decision.primary) {
    const legacy = projectDecisionToV1Grounding(decision);
    const properties = boundProperties(decision);
    const primaryProperty = properties[0];
    const ownerPath = decision.fieldBindings[0]?.owner.pathRel || "";
    const signals = [
      ...new Set(
        decision.behaviorEvidence.flatMap((item) => item.matchedSignals || [])
      ),
    ];
    lines.push(`path: ${legacy.primary.pathRel}`, `code: ${legacy.primary.code}`);
    if (legacy.related.length) {
      lines.push(`related: ${legacy.related.map((item) => item.pathRel).join(", ")}`);
    }
    if (primaryProperty) {
      lines.push(`target.property: ${primaryProperty}`);
    }
    if (properties.length > 1) {
      lines.push(`target.properties: ${properties.join(", ")}`);
    }
    if (/(dto|model|contract|request|input)/i.test(ownerPath)) {
      lines.push("layer: dto");
    }
    if (signals.includes("required")) {
      lines.push("sourceSignal: Required");
    } else if (signals.includes("maxlength")) {
      lines.push("sourceSignal: MaxLength");
    }
  }
  lines.push(`status: ${decision.readiness}`);
  // Without the refusal text a blocked case looks like an empty projection, so
  // the reviewer cannot tell a resolver gap from a real feature gap.
  if (decision.outcome !== "READY" && decision.refusalReasons.length) {
    lines.push(
      `reason: ${decision.refusalReasons
        .map((item) => item.message.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | ")}`
    );
  }
  return lines;
}

export function projectUnitApprovalDecision(
  decision: UnitApprovalDecision,
  previousTestData?: string | null
): UnitDecisionProjection {
  const grounded = emitsSutMarkers(decision);
  // Renaming input keys through unverified bindings would overwrite the business
  // labels with a guess, and those labels are the only bridge back to the source.
  const canonicalInput = grounded
    ? canonicalizeInput(decision)
    : decision.testCase.ir.testData.input || {};
  const previous = String(previousTestData || "");
  const preserved = previous
    .split(/\r?\n/)
    .filter(
      (line) =>
        !DECISION_MARKER_RE.test(line) &&
        !DEAD_MARKER_RE.test(line) &&
        !(grounded && GROUNDED_MARKER_RE.test(line)) &&
        !/^\s*#\s*sut-resolve:/i.test(line)
    )
    .join("\n")
    .trim();
  const keepsPreviousInput = !grounded && /^\s*input\s*:/im.test(previous);
  const projected = [
    preserved,
    ...renderDecisionGroundingLines(decision),
    ...(!keepsPreviousInput && Object.keys(canonicalInput).length
      ? [`input: ${JSON.stringify(canonicalInput)}`]
      : []),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    testData: projected,
    automationReady:
      decision.authoritative &&
      decision.outcome === "READY" &&
      decision.readiness === "READY_FOR_CODEGEN",
    v1Grounding: projectDecisionToV1Grounding(decision),
    canonicalInput,
  };
}
