/**
 * One reader for the persisted `.grounding.json` companion.
 *
 * Approve writes the immutable v2 decision as the authority and embeds its
 * deterministic v1 projection under `legacyV1`. Gen consumers read v1, so every
 * reader must go through here: parsing the file as v1 only would silently reject
 * a perfectly valid decision.
 */
import { APPROVED_GROUNDING_SCHEMA, } from "./approvedGroundingDecision.js";
import { UNIT_APPROVE_DECISION_SCHEMA, projectDecisionToV1Grounding, } from "./unitApproveRpc.js";
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function normalizeGroundingCompanion(parsed) {
    if (!isRecord(parsed))
        return null;
    if (parsed.schema === APPROVED_GROUNDING_SCHEMA) {
        return parsed;
    }
    if (parsed.schema !== UNIT_APPROVE_DECISION_SCHEMA)
        return null;
    const embedded = parsed.legacyV1;
    if (isRecord(embedded) && embedded.schema === APPROVED_GROUNDING_SCHEMA) {
        return embedded;
    }
    try {
        return projectDecisionToV1Grounding(parsed);
    }
    catch {
        return null;
    }
}
export function parseGroundingCompanion(raw) {
    try {
        return normalizeGroundingCompanion(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
