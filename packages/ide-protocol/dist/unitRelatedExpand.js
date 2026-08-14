/**
 * Phase 4 — expand related Unit sources after entry SUT is chosen.
 * Prefer Interface / DTO / enum cùng feature; max 4; deny FE/pipe/constant.
 * Validation/authz mode: force-include Command↔DTO↔Validator siblings when present.
 */
import { UNIT_GEN_LIMITS } from "./unitConventions.js";
import { isDeniedUnitRelatedPath } from "./unitLogicLayerFilter.js";
function norm(pathRel) {
    return (pathRel || "").replace(/\\/g, "/");
}
function baseName(pathRel) {
    const p = norm(pathRel);
    return p.split("/").pop() || p;
}
function stemOf(pathRel) {
    return baseName(pathRel).replace(/\.[^.]+$/, "");
}
/** Strip common type suffixes for feature family matching. */
export function featureStem(stem) {
    let s = stem.replace(/^(I)(?=[A-Z])/, "");
    // Compound CQRS suffixes first
    s = s.replace(/(CommandHandler|QueryHandler|CommandValidator|QueryValidator)$/i, "");
    s = s.replace(/(Service|Handler|Controller|Validator|UseCase|Policy|Repository|Manager|Provider|Factory|Builder|Options|Config|Settings|Request|Response|Command|Query|Dto|Dtos|Model|Models|Entity|Entities|Enum|Enums|Type|Types|Interface)$/i, "");
    return s;
}
function pascalParts(name) {
    return (name.match(/[A-Z][a-z0-9]+|[a-z0-9]+/g) || [])
        .map((p) => p.toLowerCase())
        .filter((p) => p.length >= 3);
}
/** Feature keys from entry path (UploadService → upload, …). */
export function entryFeatureKeys(entryPathRel) {
    const stem = stemOf(entryPathRel);
    const family = featureStem(stem);
    const parts = pascalParts(family || stem);
    const out = new Set();
    if (family && family.length >= 4)
        out.add(family.toLowerCase());
    for (const p of parts) {
        if (p.length >= 4)
            out.add(p);
    }
    return [...out];
}
/** True for DTO / Validator / bare Command (validation layer siblings). */
export function isValidationLayerRelatedPath(pathRel) {
    const p = norm(pathRel);
    const stem = stemOf(pathRel);
    if (/(Validator)$/i.test(stem) || /\/validators?\//i.test(p)) {
        return true;
    }
    if (/(Dto|Dtos|Request|Response|Command)$/i.test(stem) &&
        !/Handler/i.test(stem)) {
        return true;
    }
    if (/\/(dto|dtos|contracts?|commands?)\//i.test(p) && !/Handler/i.test(stem)) {
        return true;
    }
    return false;
}
/**
 * Shape bonus for related (not primary): Interface / DTO / enum preferred.
 * Returns 0 when path is not a useful related shape.
 */
export function relatedShapeBonus(pathRel) {
    const p = norm(pathRel).toLowerCase();
    const base = baseName(pathRel);
    const stem = stemOf(pathRel);
    if (/^i[A-Z]/.test(stem) || /\.interface\./i.test(p) || /\/interfaces?\//i.test(p)) {
        return 45;
    }
    if (/(validator)$/i.test(stem) || /\/validators?\//i.test(p)) {
        return 42;
    }
    if (/(dto|dtos|request|response|contract|model|models)\b/i.test(stem) ||
        /\/(dto|dtos|contracts?|models?)\//i.test(p)) {
        return 38;
    }
    // Bare *Command.cs (not Handler) — CQRS request DTO sibling
    if (/Command\.(cs|ts|js)$/i.test(base) && !/Handler/i.test(stem)) {
        return 36;
    }
    if (/(enum|enums|resourceType|types?)$/i.test(stem) || /\/(enums?|types?)\//i.test(p)) {
        return 32;
    }
    if (/(options|config|settings|constants?)$/i.test(stem)) {
        return 12;
    }
    // Same-feature sibling service/handler — weak related only
    if (/(service|handler|validator|usecase|policy)\./i.test(p) ||
        /(Service|Handler|Validator)\.cs$/i.test(base)) {
        return 8;
    }
    return 0;
}
function dirProximity(entry, candidate) {
    const a = norm(entry);
    const b = norm(candidate);
    const aDir = a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : "";
    const bDir = b.includes("/") ? b.slice(0, b.lastIndexOf("/")) : "";
    if (aDir && aDir === bDir)
        return 40;
    if (aDir && bDir) {
        const aParent = aDir.includes("/") ? aDir.slice(0, aDir.lastIndexOf("/")) : "";
        if (aParent && bDir.startsWith(`${aParent}/`))
            return 18;
    }
    return 0;
}
function featureOverlapScore(pathRel, keys, featureTokens) {
    const low = norm(pathRel).toLowerCase();
    const stem = stemOf(pathRel).toLowerCase();
    let score = 0;
    for (const k of keys) {
        if (k.length < 4)
            continue;
        if (stem.includes(k) || low.includes(k))
            score += 22;
    }
    for (const t of featureTokens) {
        const tl = t.toLowerCase();
        if (tl.length < 4)
            continue;
        if (stem.includes(tl) || low.includes(tl))
            score += 10;
    }
    return score;
}
/**
 * Expand related paths for an entry SUT (portable, no product folders).
 */
export function expandUnitRelatedPaths(opts) {
    const entry = norm(opts.entryPathRel);
    if (!entry)
        return [];
    const max = Math.max(0, Math.min(opts.maxRelated ?? UNIT_GEN_LIMITS.maxRelatedFiles, UNIT_GEN_LIMITS.maxRelatedFiles));
    if (!max)
        return [];
    const keys = entryFeatureKeys(entry);
    const featureTokens = (opts.featureTokens || [])
        .map((t) => String(t || "").trim())
        .filter((t) => t.length >= 4);
    const preferDto = opts.preferDtoValidator === true;
    const scored = [];
    for (const raw of opts.allPaths) {
        const pathRel = norm(raw);
        if (!pathRel || pathRel === entry)
            continue;
        if (pathRel.toLowerCase() === entry.toLowerCase())
            continue;
        if (isDeniedUnitRelatedPath(pathRel))
            continue;
        const shape = relatedShapeBonus(pathRel);
        const feat = featureOverlapScore(pathRel, keys, featureTokens);
        if (shape < 8 && feat < 22)
            continue;
        let score = shape + feat + dirProximity(entry, pathRel);
        if (shape >= 32)
            score += 6;
        const validationLayer = isValidationLayerRelatedPath(pathRel);
        if (preferDto && validationLayer)
            score += 28;
        if (score < 28 && !(preferDto && validationLayer && feat >= 22))
            continue;
        scored.push({ path: pathRel, score, validationLayer });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const out = [];
    const seen = new Set();
    const push = (p) => {
        const k = p.toLowerCase();
        if (seen.has(k))
            return;
        seen.add(k);
        out.push(p);
    };
    // Validation/auth: reserve slots for DTO/Validator/Command first
    if (preferDto) {
        for (const s of scored) {
            if (!s.validationLayer)
                continue;
            push(s.path);
            if (out.length >= Math.min(3, max))
                break;
        }
    }
    for (const s of scored) {
        if (out.length >= max)
            break;
        push(s.path);
    }
    return out;
}
/** Format related paths for Test Data (`related: a, b` or multi-line). */
export function formatRelatedMarkerLines(relatedPaths) {
    const cleaned = relatedPaths.map((p) => norm(p)).filter(Boolean);
    if (!cleaned.length)
        return [];
    if (cleaned.length === 1)
        return [`related: ${cleaned[0]}`];
    return [`related: ${cleaned.join(", ")}`];
}
