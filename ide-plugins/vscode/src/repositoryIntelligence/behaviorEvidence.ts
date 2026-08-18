import type {
  BehaviorEvidence,
  FieldBindingDecision,
  UnitApproveResolveParams,
} from "@aitest/ide-protocol";
import { sha256 } from "./hash";
import type { RepoDocument } from "./runtime";

export type BehaviorSignal =
  | "maxlength"
  | "required"
  | "whitespace"
  | "format"
  | "default"
  | "filter"
  | "reject"
  | "throw"
  | "guard";

const SIGNAL_PATTERNS: Readonly<Record<BehaviorSignal, RegExp>> = {
  maxlength: /\b(MaxLength|StringLength|MaximumLength|max(?:imum)?Length)\b/i,
  required: /\b(Required|NotNull|NotEmpty|ArgumentNullException)\b/i,
  whitespace: /\b(IsNullOrWhiteSpace|IsNullOrEmpty|Trim\s*\(\s*\))\b/i,
  format:
    /\b(RegularExpression|TryParseExact|ParseExact|MatchesFormat|FormatValidator)\b/i,
  default:
    /(?:\?\?=?|=\s*(?:new\s+)?(?:DateTime\.(?:Now|UtcNow|Today)|Date\.now\s*\(\s*\))|\b(?:SetDefault|WithDefault)\b)/i,
  // A rule that excludes rows from a result set is implemented by narrowing the
  // query, not by throwing, so predicates and read-scope helpers are its only
  // possible evidence.
  filter:
    /(?:\b(?:Where|Filter|Any|All|Contains|Intersect|Except)|\w*Scope|\.filter|\.some|\.includes)\s*\(/i,
  reject:
    /\b(throw\s+new|ThrowIf|raise\s+|return\s+(?:BadRequest|Conflict|NotFound|Forbid|Problem|Fail|Error|false|null)|Validation(?:Exception|Failure|Result)|InvalidOperationException)\b/i,
  throw: /\b(throw\s+new|ThrowIf|raise\s+)\b/i,
  guard:
    /\b(if|else\s+if|switch|when|ThrowIf|Guard\.|Ensure\.|return\s+(?:BadRequest|Conflict|NotFound|Forbid|Problem|Fail|Error)|Validation(?:Exception|Failure|Result)|InvalidOperationException)\b/,
};

const REJECTION_SCENARIOS = new Set([
  "NEGATIVE",
  "DUPLICATE",
  "NOT_FOUND",
  "INVALID_STATE",
  "AUTHORIZATION",
  "DEPENDENCY_FAILURE",
]);

export function requiredBehaviorSignals(
  params: UnitApproveResolveParams
): BehaviorSignal[] {
  const text = [
    params.tcIr.testData.target?.constraint,
    params.tcIr.testData.target?.boundary,
    params.tcIr.expected.description,
    params.tcIr.expected.observable,
  ]
    .filter(Boolean)
    .join(" ");
  // Remove explicit optionality before looking for the word "required".
  // Business TCs commonly describe a positive case as "không bắt buộc" or
  // "no required-field error"; matching the nested word used to invert those
  // cases into a FEATURE_GAP.
  const requiredIntentText = text
    .replace(/\b(?:not\s+required|optional|no\s+required(?:-field)?\s+error)\b/gi, " ")
    .replace(
      /\bkhông\s+(?:(?:phát\s+sinh|có)\s+(?:lỗi|ràng\s+buộc|quy\s+tắc)?\s*)?bắt\s+buộc\b/gi,
      " "
    );
  const signals: BehaviorSignal[] = [];
  if (/max(?:imum)?\s*length|maxlength|stringlength|độ dài tối đa/i.test(text)) {
    signals.push("maxlength");
  }
  if (
    params.tcIr.scenario === "NULL" ||
    /\brequired\b|not\s*null|bắt\s+buộc|không\s+được\s+null/i.test(
      requiredIntentText
    )
  ) {
    signals.push("required");
  }
  if (
    params.tcIr.scenario === "BLANK" ||
    /white\s*space|blank|khoảng trắng/i.test(text)
  ) {
    signals.push("whitespace");
  }
  if (
    /\bformat\b|định dạng|(?:dd|MM|yyyy)[./-](?:dd|MM|yyyy)/i.test(text)
  ) {
    signals.push("format");
  }
  if (/\bdefault\b|mặc định|tự động (?:gán|lấy|điền)|thời gian hiện tại/i.test(text)) {
    signals.push("default");
  }
  if (/throw|exception|raises?|ném lỗi/i.test(text)) signals.push("throw");
  // A test case that expects a rejection is only groundable when the source
  // actually decides to reject. Without a guard tied to the bound property the
  // rule does not exist yet, and Approve must report a feature gap instead of
  // letting codegen assert behaviour that was never implemented.
  const declarativeValidation =
    params.tcIr.primaryBucket === "VALIDATION_DATA" &&
    signals.some((signal) =>
      signal === "required" ||
      signal === "maxlength" ||
      signal === "whitespace" ||
      signal === "format"
    );
  // A read that must exclude rows the caller may not see is satisfied by the
  // query being narrowed. Demanding throw/BadRequest evidence for it reports a
  // feature gap against a rule the repository does implement, as a filter.
  const queryObservable = /\b(query|read|list)\b/i.test(
    `${params.tcIr.expected.observable || ""} ${params.tcIr.expected.type || ""}`
  );
  if (
    !declarativeValidation &&
    (REJECTION_SCENARIOS.has(params.tcIr.scenario) ||
      /\breject\b|từ chối|không được phép|not allowed|forbidden/i.test(text))
  ) {
    signals.push(queryObservable ? "filter" : "reject");
  }
  return [...new Set(signals)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceKind(line: string): BehaviorEvidence["kind"] {
  if (SIGNAL_PATTERNS.throw.test(line)) return "throw";
  return SIGNAL_PATTERNS.guard.test(line) ||
    SIGNAL_PATTERNS.reject.test(line) ||
    SIGNAL_PATTERNS.filter.test(line)
    ? "branch"
    : "validation";
}

function ineffectiveRequiredEvidence(quote: string): boolean {
  // C#'s [Required] cannot reject a missing value for non-nullable value
  // types: model binding supplies default(T). Treating it as an effective
  // guard made DateTime/int/bool TCs READY without executable validation.
  return /\[\s*Required(?:Attribute)?(?:\s*\([^)]*\))?\s*\][\s\S]{0,160}\b(?:public|internal|protected|private)\s+(?:DateTime|DateOnly|TimeOnly|Guid|bool|byte|sbyte|short|ushort|int|uint|long|ulong|float|double|decimal)\s+\w+/i.test(
    quote
  );
}

/**
 * .NET's RequiredAttribute trims strings unless AllowEmptyStrings is set, so
 * `[Required] string X` already rejects a whitespace-only value. Demanding a
 * separate IsNullOrWhiteSpace call reported a feature gap against a rule the
 * DTO does enforce.
 */
function impliesWhitespaceRejection(quote: string): boolean {
  const match =
    /\[\s*Required(?:Attribute)?(?:\s*\(([^)]*)\))?\s*\][\s\S]{0,160}\b(?:public|internal|protected|private)\s+string\??\s+\w+/i.exec(
      quote
    );
  if (!match) return false;
  return !/AllowEmptyStrings\s*=\s*true/i.test(match[1] || "");
}

export function extractBehaviorEvidence(
  params: UnitApproveResolveParams,
  bindings: readonly FieldBindingDecision[],
  documents: ReadonlyMap<string, RepoDocument>,
  maxEvidencePerFile: number
): BehaviorEvidence[] {
  const evidence: BehaviorEvidence[] = [];
  const perFile = new Map<string, number>();
  const seen = new Set<string>();
  const targetLabels = params.tcIr.testData.target?.fields || [];
  const targetBindings = bindings.filter((binding) =>
    targetLabels.some(
      (label) =>
        label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() ===
        binding.label
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
    )
  );

  for (const binding of targetBindings) {
    const propertyPattern = new RegExp(`\\b${escapeRegExp(binding.property)}\\b`, "i");
    // A read-scope helper narrows a whole entity, so it names the type it
    // restricts rather than the single property bound to the target label.
    const ownerType = (binding.owner.typeName || "").replace(
      /(?:Dto|Entity|Model|Record)$/i,
      ""
    );
    const ownerTypePattern =
      ownerType.length >= 4
        ? new RegExp(`\\b\\w*${escapeRegExp(ownerType)}\\w*\\b`, "i")
        : null;
    const ownerKey = binding.owner.pathRel.replace(/\\/g, "/").toLowerCase();
    for (const doc of documents.values()) {
      const key = doc.pathRel.replace(/\\/g, "/").toLowerCase();
      const lines = doc.text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if ((perFile.get(key) || 0) >= maxEvidencePerFile) break;
        const line = lines[index];
        const signals = (Object.keys(SIGNAL_PATTERNS) as BehaviorSignal[]).filter((signal) =>
          SIGNAL_PATTERNS[signal].test(line)
        );
        if (!signals.length) continue;

        let start = index;
        let end = index;
        let tied = propertyPattern.test(line);
        if (!tied && signals.includes("filter") && ownerTypePattern) {
          tied = ownerTypePattern.test(line);
        }
        if (
          !tied &&
          (signals.includes("reject") ||
            signals.includes("throw") ||
            signals.includes("filter"))
        ) {
          for (let previous = index - 1; previous >= Math.max(0, index - 8); previous--) {
            if (propertyPattern.test(lines[previous])) {
              tied = true;
              start = previous;
              break;
            }
          }
        }
        if (!tied && key === ownerKey && index < binding.owner.range.end.line) {
          const nearbyEnd = Math.min(lines.length - 1, index + 6);
          for (let next = index + 1; next <= nearbyEnd; next++) {
            if (propertyPattern.test(lines[next])) {
              tied = true;
              end = next;
              break;
            }
            if (/[;{}]/.test(lines[next])) break;
          }
        }
        if (!tied) continue;
        const quote = lines.slice(start, end + 1).join("\n").trim().slice(0, 800);
        const effectiveSignals = signals.filter(
          (signal) => signal !== "required" || !ineffectiveRequiredEvidence(quote)
        );
        if (!effectiveSignals.length) continue;
        const matchedSignals = [
          ...new Set<BehaviorSignal>([
            ...effectiveSignals,
            ...(effectiveSignals.includes("required") &&
            impliesWhitespaceRejection(quote)
              ? (["whitespace"] as BehaviorSignal[])
              : []),
          ]),
        ];
        const dedupe = `${key}:${start}:${quote}`;
        if (!quote || seen.has(dedupe)) continue;
        seen.add(dedupe);
        perFile.set(key, (perFile.get(key) || 0) + 1);
        evidence.push({
          behaviorId: params.tcIr.requirement.behaviorId,
          observable: params.tcIr.expected.observable,
          kind: evidenceKind(quote),
          pathRel: doc.pathRel,
          fileHash: sha256(doc.text),
          range: {
            start: { line: start, character: 0 },
            end: { line: end, character: lines[end]?.length || 0 },
          },
          quote,
          quoteHash: sha256(quote),
          matchedSignals,
        });
      }
    }
  }
  return evidence;
}
