/** IT verbs that must not alone count as body-rule hits (Create/Add latch). */
export const UNIT_WEAK_BODY_RULE_PATTERNS = new Set([
    "create",
    "add",
    "insert",
    "update",
    "edit",
    "save",
    "delete",
    "upload",
    "download",
    "get",
    "list",
    "handle",
    // Ultra-common — latch GeneratePresignedUrl* / *Validate* / Exists() everywhere
    "generate",
    "validate",
    "exists",
    "any",
    "isnullorwhitespace",
    "isnullorempty",
    "isempty",
]);
/**
 * Patterns that may score body excerpts but must NOT drive index path-bridge /
 * folder widen (path name substring latch).
 */
export const UNIT_WEAK_PATH_BRIDGE_PATTERNS = new Set([
    "throw",
    "badrequest",
    "argumentexception",
    "validate",
    "exists",
    "any",
    "generate",
    "reject",
    "deny",
    "duplicate",
    "search",
    "filter",
    "where",
    "contains",
    "tolower",
]);
export function isWeakBodyRulePattern(pat) {
    const t = String(pat || "").trim().toLowerCase();
    if (!t || t.length < 3)
        return true;
    return UNIT_WEAK_BODY_RULE_PATTERNS.has(t);
}
export function isWeakPathBridgePattern(pat) {
    const t = String(pat || "").trim().toLowerCase();
    if (!t || t.length < 4)
        return true;
    return UNIT_WEAK_PATH_BRIDGE_PATTERNS.has(t);
}
/** Drop Create/Add/… so soft writeBack cannot latch on verb-only hits. */
export function filterStrongBodyRulePatterns(patterns) {
    const out = [];
    const seen = new Set();
    for (const raw of patterns || []) {
        const p = String(raw || "").trim();
        if (!p || isWeakBodyRulePattern(p))
            continue;
        const k = p.toLowerCase();
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(p);
    }
    return out;
}
/**
 * Soft writeBack must not succeed on generic IT hits alone (P0.1).
 * throw/BadRequest/Create/… without domain phrase/prefer/alias → refuse.
 */
export const UNIT_SOFT_GENERIC_RULE_HITS = new Set([
    ...UNIT_WEAK_BODY_RULE_PATTERNS,
    "throw",
    "badrequest",
    "badrequestalertexception",
    "argumentexception",
    "exception",
    "duplicate",
    "reject",
    "deny",
    // Ultra-common null/empty checks — latch User*/Query handlers cross-domain when ungated
    "isnullorwhitespace",
    "isnullorempty",
    "stringisnullorwhitespace",
    "stringisnullorempty",
    "isempty",
    "isemptyorwhitespace",
]);
export function isSoftGenericRuleHit(hit) {
    const raw = String(hit || "").trim();
    if (!raw)
        return true;
    const t = raw
        .replace(/^\(\?i\)/i, "")
        .split(/[|]/)[0]
        ?.trim()
        .toLowerCase();
    if (!t || t.length < 3)
        return true;
    if (UNIT_SOFT_GENERIC_RULE_HITS.has(t))
        return true;
    return isWeakBodyRulePattern(t);
}
export function hasStrongWriteBackSignal(opts) {
    const rules = opts.ruleHits || [];
    if (rules.some((h) => !isSoftGenericRuleHit(h)))
        return true;
    const softHitPayload = (raw) => {
        const s = String(raw || "").trim();
        if (!s)
            return true;
        const rest = s.includes(":")
            ? s.split(":").slice(1).join(":")
            : s;
        const t = rest.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!t || t.length < 3)
            return true;
        if (isSoftGenericRuleHit(t))
            return true;
        return /^(create|update|delete|add|new|throw|badrequest|exception|handle|handler|save|service|command|query|success|call|misc|soft)$/i.test(t);
    };
    const hits = opts.hits || [];
    if (hits.some((h) => {
        const s = String(h || "");
        if (/^sutMap/i.test(s))
            return true;
        if (/^alias:/i.test(s))
            return !softHitPayload(s);
        if (/^(phrase|prefer|techStem):/i.test(s))
            return !softHitPayload(s);
        return false;
    })) {
        return true;
    }
    const prefer = (opts.preferTokens || [])
        .map((t) => String(t || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ""))
        .filter((t) => t.length >= 4)
        .filter((t) => !/^(create|update|delete|reject|deny|checkcode|check|exists|unique|duplicate|search|validation|trace|input|mock|add|new|code|throw|badrequest|handler|service|command|query|assert|error|success|call|misc|soft)$/i.test(t));
    if (!prefer.length)
        return false;
    const p = (opts.pathRel || "")
        .replace(/\\/g, "/")
        .toLowerCase()
        .replace(/[^a-z0-9/]/g, "");
    return prefer.some((t) => p.includes(t));
}
export function parseUnitProjectIntentRules(raw) {
    if (!raw || typeof raw !== "object")
        return [];
    const intents = raw.intents;
    if (!Array.isArray(intents))
        return [];
    return intents.filter((r) => r && typeof r === "object" && typeof r.id === "string" && r.id.trim());
}
function testCue(reSrc, blob) {
    const src = (reSrc || "").trim();
    if (!src || !blob)
        return false;
    try {
        // Project files often use Python-style (?i) — strip; always use JS `i` flag.
        const body = src.replace(/^\(\?i\)/i, "");
        return new RegExp(body, "i").test(blob);
    }
    catch {
        return blob.toLowerCase().includes(src.toLowerCase());
    }
}
/**
 * Merge matching project intent rules onto portable extractUnitIntent result.
 * Product nouns stay in the project JSON — never in AITest core.
 */
export function applyProjectIntentRules(base, rules, opts) {
    const blob = [opts.title, opts.module, opts.steps, opts.expectedResult]
        .filter(Boolean)
        .join("\n");
    const matched = [];
    for (const r of rules || []) {
        if (testCue(r.whenTitleOrStepsMatch, blob))
            matched.push(r);
    }
    if (!matched.length) {
        return { intent: base, matchedIds: [] };
    }
    const scope = opts.unitScope || "backend";
    let scopeRefuse;
    const rulePatterns = [...(base.rulePatterns || [])];
    const codePatterns = [...(base.codePatterns || [])];
    const classes = [...base.classes];
    let requiresBodyRule = base.requiresBodyRule;
    let uiOnly = base.uiOnly;
    let preferSutMapKey;
    for (const r of matched) {
        const action = r.scopeAction?.[scope] ||
            (scope === "backend" || scope === "frontend" || scope === "any"
                ? r.scopeAction?.[scope]
                : undefined);
        if (action === "FAIL_FEATURE_GAP") {
            scopeRefuse = "FAIL_FEATURE_GAP";
            uiOnly = true;
        }
        const body = (r.requiredBodyPatterns || [])
            .map((p) => String(p || "").trim())
            .filter(Boolean);
        if (body.length) {
            requiresBodyRule = true;
            // Patterns may be regex — keep as-is for findBodyRuleHits (escaped later).
            // Prefer last path segment of regex as display token when simple.
            for (const b of body) {
                const simple = b.replace(/^\(\?i\)/, "").replace(/[\\|()?.*+^$[\]{}]/g, " ").trim();
                const token = simple.split(/\s+/).find((t) => t.length >= 4) || b;
                if (token && !isWeakBodyRulePattern(token)) {
                    rulePatterns.push(token);
                    codePatterns.push(token);
                }
                else if (!isWeakBodyRulePattern(b)) {
                    rulePatterns.push(b);
                }
            }
        }
        if (r.preferSutMapKey?.trim())
            preferSutMapKey = r.preferSutMapKey.trim();
        // Project ids are free-form — map known portable ids onto UnitIntentClass when possible
        if (r.id === "ui_master_create" || r.id.startsWith("ui_")) {
            if (!classes.includes("ui_master_create"))
                classes.push("ui_master_create");
            uiOnly = true;
        }
        if (r.id === "upload_size_limit" && !classes.includes("upload_size_limit")) {
            classes.push("upload_size_limit");
        }
        if (r.id === "auto_generate_code" &&
            !classes.includes("auto_generate_code")) {
            classes.push("auto_generate_code");
        }
        if (r.id === "duplicate_reject" &&
            !classes.includes("validate_reject")) {
            classes.push("validate_reject");
        }
    }
    const intent = {
        ...base,
        classes: [...new Set(classes)],
        primaryClass: base.primaryClass,
        uiOnly,
        codePatterns: [...new Set(codePatterns)],
        rulePatterns: filterStrongBodyRulePatterns([...new Set(rulePatterns)]),
        featureTokens: base.featureTokens,
        classFeatureTokens: base.classFeatureTokens,
        requiresBodyRule,
    };
    // Recompute primary after class merge (prefer ui / validate)
    if (intent.uiOnly) {
        intent.primaryClass = "ui_master_create";
    }
    else if (intent.classes.includes("upload_size_limit")) {
        intent.primaryClass = "upload_size_limit";
    }
    else if (intent.classes.includes("validate_reject")) {
        intent.primaryClass = "validate_reject";
    }
    else if (intent.classes.includes("auto_generate_code")) {
        intent.primaryClass = "auto_generate_code";
    }
    else if (intent.classes.includes("state_enable")) {
        intent.primaryClass = "state_enable";
    }
    return {
        intent,
        matchedIds: matched.map((m) => m.id),
        preferSutMapKey,
        scopeRefuse,
    };
}
/**
 * Resolve sutMap pin — keys may be intent id, module phrase, or title cue.
 * Values = repo-relative primary path (portable per project).
 */
export function resolveSutMapPin(sutMap, opts) {
    if (!sutMap || typeof sutMap !== "object")
        return null;
    const keys = [];
    if (opts.preferSutMapKey)
        keys.push(opts.preferSutMapKey);
    for (const id of opts.matchedIntentIds || [])
        keys.push(id);
    if (opts.module?.trim())
        keys.push(opts.module.trim());
    if (opts.title?.trim())
        keys.push(opts.title.trim());
    for (const k of keys) {
        const hit = sutMap[k];
        if (hit?.trim())
            return hit.replace(/\\/g, "/").trim();
    }
    // Soft: substring key match on module/title
    const blob = `${opts.module || ""} ${opts.title || ""}`.toLowerCase();
    for (const [k, v] of Object.entries(sutMap)) {
        if (!k?.trim() || !v?.trim())
            continue;
        if (blob.includes(k.toLowerCase()))
            return v.replace(/\\/g, "/").trim();
    }
    return null;
}
