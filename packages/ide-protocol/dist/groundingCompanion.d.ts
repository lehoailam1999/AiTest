/**
 * One reader for the persisted `.grounding.json` companion.
 *
 * Approve writes the immutable v2 decision as the authority and embeds its
 * deterministic v1 projection under `legacyV1`. Gen consumers read v1, so every
 * reader must go through here: parsing the file as v1 only would silently reject
 * a perfectly valid decision.
 */
import { type ApprovedGroundingDecision } from "./approvedGroundingDecision.js";
export declare function normalizeGroundingCompanion(parsed: unknown): ApprovedGroundingDecision | null;
export declare function parseGroundingCompanion(raw: string): ApprovedGroundingDecision | null;
