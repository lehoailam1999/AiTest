/**
 * Unit Approve v2 — IDE Repository Intelligence contract.
 * Desktop sends structured TC IR; IDE returns one immutable decision.
 * Markdown markers are projections only — never authority.
 */
export const UNIT_APPROVE_REQUEST_SCHEMA = "aitest-unit-approve-request-v2";
export const UNIT_APPROVE_RESPONSE_SCHEMA = "aitest-unit-approve-response-v2";
export const UNIT_APPROVE_DECISION_SCHEMA = "aitest-unit-approve-decision-v2";
export const UNIT_TC_IR_SCHEMA = "aitest-unit-tc-ir-v1";
function normPath(value) {
    return String(value || "")
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/+/g, "/");
}
function isSha256(value) {
    return (typeof value === "string" &&
        /^sha256:[a-f0-9]{64}$/i.test(value));
}
/**
 * Validate an immutable Unit Approval decision.
 * For Gen consume-only, pass requireAuthoritative=true.
 */
export function validateUnitApprovalDecision(decision, opts) {
    if (!decision || decision.schema !== UNIT_APPROVE_DECISION_SCHEMA) {
        return { ok: false, code: "INVALID_SCHEMA" };
    }
    if (!isSha256(decision.decisionId) || !isSha256(decision.canonicalHash)) {
        return { ok: false, code: "HASH_MISMATCH" };
    }
    if (!isSha256(decision.testCase?.revisionHash)) {
        return { ok: false, code: "HASH_MISMATCH" };
    }
    if (decision.outcome === "READY" &&
        decision.readiness !== "READY_FOR_CODEGEN") {
        return { ok: false, code: "OUTCOME_MISMATCH" };
    }
    if (decision.outcome !== "READY" &&
        decision.authoritative === true) {
        return { ok: false, code: "NOT_AUTHORITATIVE" };
    }
    if (opts?.requireAuthoritative) {
        if (decision.authoritative !== true || decision.outcome !== "READY") {
            return {
                ok: false,
                code: decision.outcome === "READY" ? "NOT_AUTHORITATIVE" : "NOT_READY",
            };
        }
        if (decision.confidence.band !== "HIGH" &&
            decision.confidence.band !== "MEDIUM") {
            return { ok: false, code: "LOW_CONFIDENCE" };
        }
    }
    if (decision.outcome === "READY" || decision.primary) {
        if (!decision.primary ||
            !normPath(decision.primary.pathRel) ||
            !String(decision.primary.name || "").trim() ||
            !isSha256(decision.primary.fileHash)) {
            return { ok: false, code: "INVALID_PRIMARY" };
        }
    }
    const fileMap = new Map((decision.files || []).map((f) => [normPath(f.pathRel).toLowerCase(), f]));
    for (const f of decision.files || []) {
        if (!isSha256(f.sha256) || !normPath(f.pathRel)) {
            return { ok: false, code: "MISSING_HASH" };
        }
    }
    if (decision.primary) {
        const key = normPath(decision.primary.pathRel).toLowerCase();
        const snap = fileMap.get(key);
        if (!snap || snap.sha256 !== decision.primary.fileHash) {
            return { ok: false, code: "FILE_MANIFEST_GAP" };
        }
    }
    for (const rel of decision.relatedFiles || []) {
        const key = normPath(rel.pathRel).toLowerCase();
        const snap = fileMap.get(key);
        if (!snap || snap.sha256 !== rel.fileHash) {
            return { ok: false, code: "FILE_MANIFEST_GAP" };
        }
    }
    for (const b of decision.fieldBindings || []) {
        const key = normPath(b.owner.pathRel).toLowerCase();
        const snap = fileMap.get(key);
        if (!snap || snap.sha256 !== b.owner.fileHash) {
            return { ok: false, code: "FILE_MANIFEST_GAP" };
        }
    }
    const scope = decision.testCase.ir.testData.target?.scope;
    if (scope === "field" || scope === "multi") {
        const labels = decision.testCase.ir.testData.target?.fields || [];
        const expected = scope === "multi" ? Math.max(2, labels.length) : 1;
        if ((decision.fieldBindings || []).length < expected) {
            if (opts?.requireAuthoritative || decision.outcome === "READY") {
                return { ok: false, code: "INCOMPLETE_BINDINGS" };
            }
        }
    }
    return { ok: true };
}
/**
 * Project UnitApprovalDecision → legacy ApprovedGroundingDecision shape
 * for Gen consumers that still read v1 companions during transition.
 */
export function projectDecisionToV1Grounding(decision) {
    const primary = decision.primary;
    const typeName = primary?.kind === "method" || primary?.kind === "constructor"
        ? primary.containerName || primary.name
        : primary?.name || "";
    const methodName = primary?.kind === "method" || primary?.kind === "constructor"
        ? primary.name
        : undefined;
    const code = methodName ? `${typeName}.${methodName}` : typeName;
    return {
        schema: "aitest-unit-grounding-v1",
        emittedAt: decision.emittedAt,
        testCaseId: decision.testCase.id,
        outcome: decision.outcome,
        authoritative: decision.authoritative,
        primary: {
            pathRel: primary?.pathRel || "",
            code,
            typeName,
            methodName,
            line: primary?.selectionRange.start.line,
            endLine: primary?.selectionRange.end.line,
            contentHash: primary?.fileHash,
        },
        related: decision.relatedFiles.map((f) => ({
            pathRel: f.pathRel,
            contentHash: f.fileHash,
        })),
        deps: decision.relatedFiles.map((f) => f.pathRel),
        confidence: decision.confidence.band,
        freshness: "fresh",
        validateChecks: decision.checks.filter((c) => c.ok).map((c) => c.id),
        source: "ide-repository-intelligence",
        targetScope: decision.testCase.ir.testData.target?.scope,
        targetProperties: decision.fieldBindings.map((b) => ({
            name: b.property,
            ownerType: b.owner.typeName,
            ownerPath: b.owner.pathRel,
        })),
        bindings: decision.fieldBindings.map((b) => ({
            label: b.label,
            property: b.property,
            ownerPath: b.owner.pathRel,
            ownerType: b.owner.typeName,
        })),
        refusalReasons: decision.refusalReasons.map((reason) => ({
            code: reason.code,
            message: reason.message,
        })),
        decisionId: decision.decisionId,
        canonicalHash: decision.canonicalHash,
        repository: decision.repository,
    };
}
/**
 * Build decisionId/canonicalHash over a decision body excluding those two fields.
 * Caller supplies a real SHA-256 implementation (Node crypto / Web Crypto).
 */
export function hashDecisionBody(bodyWithoutIds, sha256) {
    const canonical = JSON.stringify(bodyWithoutIds);
    return sha256(canonical);
}
export const DEFAULT_UNIT_APPROVE_LIMITS = {
    maxSymbolCandidates: 20,
    maxReferences: 20,
    maxImplementations: 12,
    maxRelatedFiles: 8,
    maxExistingTests: 6,
    maxEvidencePerFile: 8,
    maxFileBytes: 32768,
    /**
     * Covers IDE symbol resolve plus two bounded CLI calls: the identifier
     * proposal that bridges business vocabulary to source names, and the field
     * shortlist pick. A cold agent invocation alone can take about a minute.
     */
    deadlineMs: 150_000,
};
