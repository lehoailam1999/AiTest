/**
 * Single source-grounding decision shared by Approve, Desktop Gen and IDE Gen.
 * Product-neutral; paths/properties must come from the indexed candidate packet.
 */
export const APPROVED_GROUNDING_SCHEMA = "aitest-unit-grounding-v1";
/**
 * A decision is only authoritative when the resolver itself reported that it
 * grounded a primary against a repository it had verified as fresh.
 */
export const REQUIRED_GROUNDING_CHECKS = [
    "primary",
    "repository-fresh",
];
/**
 * Content hashes travel in two spellings: the IDE emits `sha256:<hex>` while
 * re-hashing on the consumer side yields bare hex. Compare them by digest only.
 */
export function normalizeContentHash(value) {
    return String(value || "")
        .trim()
        .replace(/^sha256:/i, "")
        .toLowerCase();
}
export function sameContentHash(a, b) {
    const left = normalizeContentHash(a);
    const right = normalizeContentHash(b);
    return Boolean(left) && left === right;
}
function normPath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}
function markerCodeMatches(code, markers) {
    const actual = String(code || "").trim().toLowerCase();
    return markers.some((raw) => {
        const marker = String(raw || "").trim().toLowerCase();
        return (marker === actual ||
            actual.startsWith(`${marker}.`) ||
            marker.startsWith(`${actual}.`));
    });
}
/**
 * Pure authority validation. Runtime hash equality is checked by the packet
 * materializer after reading source; this validates the persisted decision.
 */
export function validateApprovedGroundingDecision(decision, markers) {
    if (!decision || decision.schema !== APPROVED_GROUNDING_SCHEMA) {
        return { ok: false, code: "INVALID_SCHEMA" };
    }
    if (decision.authoritative !== true) {
        return { ok: false, code: "NOT_AUTHORITATIVE" };
    }
    if (decision.outcome && decision.outcome !== "READY") {
        return { ok: false, code: "NOT_READY" };
    }
    if (!normPath(decision.primary?.pathRel) ||
        !String(decision.primary?.code || "").trim() ||
        !String(decision.primary?.typeName || "").trim()) {
        return { ok: false, code: "INVALID_PRIMARY" };
    }
    if (!String(decision.primary.contentHash || "").trim()) {
        return { ok: false, code: "MISSING_HASH" };
    }
    if (decision.confidence !== "HIGH" &&
        decision.confidence !== "MEDIUM") {
        return { ok: false, code: "LOW_CONFIDENCE" };
    }
    if (decision.freshness !== "fresh" &&
        decision.freshness !== "skipped") {
        return { ok: false, code: "STALE_DECISION" };
    }
    // Checks are the ids IDE Repository Intelligence passed during Approve.
    const checks = new Set(decision.validateChecks || []);
    for (const required of REQUIRED_GROUNDING_CHECKS) {
        if (!checks.has(required)) {
            return { ok: false, code: "MISSING_CHECKS" };
        }
    }
    if (decision.targetScope === "field" || decision.targetScope === "multi") {
        const bindings = decision.bindings || [];
        const props = decision.targetProperties || [];
        const expected = decision.targetScope === "multi" ? 2 : 1;
        if (bindings.length < expected &&
            props.filter((p) => p.name && p.ownerPath).length < expected) {
            return { ok: false, code: "INCOMPLETE_BINDINGS" };
        }
    }
    if (markers) {
        const paths = markers.paths || [];
        const codes = markers.codes || [];
        const primary = normPath(decision.primary.pathRel).toLowerCase();
        if ((paths.length &&
            !paths.some((p) => normPath(p).toLowerCase() === primary)) ||
            (codes.length && !markerCodeMatches(decision.primary.code, codes))) {
            return { ok: false, code: "MARKER_MISMATCH" };
        }
    }
    return { ok: true };
}
