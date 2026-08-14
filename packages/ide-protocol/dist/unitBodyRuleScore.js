/**
 * Phase 3 — body-rule scoring for Approve Unit marker write-back.
 * Pure (excerpt in → hits/score out). Desktop reads files via Tauri.
 */
import { UNIT_GEN_LIMITS } from "./unitConventions.js";
import { infraPathDemoteScore, isSignedUrlOrTokenGeneratePath } from "./unitFeatureFolderDiscover.js";
import { isAnemicEntityLikePath, isWeakUnitClientPath, } from "./unitLogicLayerFilter.js";
import { isInterfaceLikePrimaryPath, preferImplementationOverInterface, } from "./unitPrimaryPrefer.js";
import { filterStrongBodyRulePatterns, isWeakBodyRulePattern, } from "./unitProjectIntentRules.js";
export const UNIT_BODY_RULE = {
    /** Cap excerpt chars when scoring (aligned with Gen budget). */
    maxExcerptChars: UNIT_GEN_LIMITS.maxExcerptChars,
    /** How many top path candidates to open for body scoring. */
    topN: 5,
    /** First rule-hit boost. */
    hitBoost: 28,
    /** Extra boost per additional distinct pattern hit. */
    multiHitBoost: 12,
    /** Soft demote when validation intent but path still FE-shaped (defense in depth). */
    feValidationPenalty: 40,
};
function uniq(xs) {
    const seen = new Set();
    const out = [];
    for (const x of xs) {
        const t = String(x || "").trim();
        if (!t)
            continue;
        const k = t.toLowerCase();
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(t);
    }
    return out;
}
function normPath(p) {
    return (p || "").replace(/\\/g, "/").toLowerCase();
}
function isQueryLikePath(pathRel) {
    const p = normPath(pathRel);
    const base = p.split("/").pop() || p;
    // *Query.cs / *QueryHandler.cs / /Queries/ — not *CommandHandler
    return /\/queries?\//i.test(p) || /query(handler)?\.(cs|ts|tsx|js)$/i.test(base);
}
function isServiceOrHandlerPath(pathRel) {
    return /(Service|Handler|UseCase|Manager)\.(cs|ts|tsx|js)$/i.test(pathRel || "");
}
/**
 * Order candidates for body-rule excerpt opens.
 * Body-rule / validate_reject: prefer *Handler/*Service over *Query so
 * bool-check queries do not consume topN while CommandHandlers with
 * throw/BadRequest never get scored.
 */
export function orderCandidatesForBodyRuleOpen(candidates, intent, topN = UNIT_BODY_RULE.topN) {
    if (!candidates.length)
        return [];
    const preferLogic = Boolean(intent?.requiresBodyRule) ||
        intent?.primaryClass === "validate_reject" ||
        intent?.primaryClass === "auto_generate_code" ||
        intent?.primaryClass === "state_enable" ||
        intent?.primaryClass === "search_lookup" ||
        (intent?.classes || []).includes("validate_reject") ||
        (intent?.classes || []).includes("auto_generate_code") ||
        (intent?.classes || []).includes("state_enable") ||
        (intent?.classes || []).includes("search_lookup");
    if (!preferLogic)
        return candidates.slice(0, topN);
    const handlers = [];
    const other = [];
    for (const c of candidates) {
        if (isServiceOrHandlerPath(c.pathRel) && !isQueryLikePath(c.pathRel)) {
            handlers.push(c);
        }
        else {
            other.push(c);
        }
    }
    // Keep relative score order within each bucket
    handlers.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
    other.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
    // Cap opens: body-rule intents get up to 2×topN; soft callers that still open stay at topN
    const openLimit = intent?.requiresBodyRule
        ? Math.max(topN, Math.min(candidates.length, topN * 2))
        : topN;
    return [...handlers, ...other].slice(0, openLimit);
}
function isBareCommandMessagePath(pathRel) {
    const base = (pathRel || "").replace(/\\/g, "/").split("/").pop() || "";
    return /Command\.(cs|ts|tsx|js)$/i.test(base) && !/Handler/i.test(base);
}
/**
 * Portable feature-family key from filename:
 * DigitalFileCreateCommandHandler / DigitalFileCreateCommand / DigitalFileDeleteCommand
 * → "digitalfile"
 */
export function unitFeatureFamilyKey(pathRel) {
    const base = (pathRel || "").replace(/\\/g, "/").split("/").pop() || pathRel;
    const stem = base.replace(/\.[^.]+$/, "");
    return stem
        .replace(/(CommandHandler|QueryHandler|Handler|Command|Query|Service|Controller|Manager)$/i, "")
        .replace(/(Create|Update|Delete|Get|List|Assign|Add|Remove|Upsert|Search|Filter)$/i, "")
        .toLowerCase();
}
/** Prefer Handler/Service; demote bare Command message + Delete* within a family. */
export function unitPrimaryShapeRank(pathRel) {
    const base = (pathRel || "").replace(/\\/g, "/").split("/").pop() || "";
    if (/(Handler|Service)\.(cs|ts|tsx|js)$/i.test(base))
        return 100;
    if (/Delete/i.test(base))
        return 15;
    if (isBareCommandMessagePath(pathRel))
        return 40;
    if (/Query/i.test(base))
        return 30;
    return 50;
}
/**
 * Collapse IFoo↔Foo ties and drop *Query when a *Service scores as high —
 * those are not real SUT ambiguity for Unit Gen write-back.
 * Also collapse same feature-family ties (CreateCommand vs CreateCommandHandler vs Delete).
 */
export function collapseBodyRuleContenders(usable) {
    if (usable.length <= 1)
        return usable;
    const byNorm = new Map(usable.map((c) => [normPath(c.pathRel), c]));
    const preferredOrder = preferImplementationOverInterface(usable.map((c) => c.pathRel));
    let collapsed = preferredOrder
        .map((p) => byNorm.get(normPath(p)))
        .filter((c) => Boolean(c));
    const services = collapsed.filter((c) => isServiceOrHandlerPath(c.pathRel));
    if (services.length) {
        const bestSvcScore = Math.max(...services.map((s) => s.score));
        collapsed = collapsed.filter((c) => {
            if (isQueryLikePath(c.pathRel)) {
                // Query must clearly beat the best service to stay in the race
                return c.score > bestSvcScore + 5;
            }
            if (isAnemicEntityLikePath(c.pathRel)) {
                // DTO/entity never vetoes a competitive Handler/Service primary
                return c.score > bestSvcScore + 10;
            }
            return true;
        });
    }
    // Same feature family (DigitalFile*): keep best-shaped primary, drop siblings
    const byFamily = new Map();
    for (const c of collapsed) {
        const key = unitFeatureFamilyKey(c.pathRel);
        if (!key || key.length < 4)
            continue;
        const list = byFamily.get(key) || [];
        list.push(c);
        byFamily.set(key, list);
    }
    const drop = new Set();
    for (const [, members] of byFamily) {
        if (members.length < 2)
            continue;
        const ranked = [...members].sort((a, b) => unitPrimaryShapeRank(b.pathRel) - unitPrimaryShapeRank(a.pathRel) ||
            b.score - a.score ||
            a.pathRel.localeCompare(b.pathRel));
        const winner = ranked[0];
        for (const m of ranked.slice(1)) {
            // Drop bare Command / Delete when a Handler/Service sibling exists
            if (isServiceOrHandlerPath(winner.pathRel) &&
                (isBareCommandMessagePath(m.pathRel) || /Delete/i.test(m.pathRel))) {
                drop.add(normPath(m.pathRel));
                continue;
            }
            // Near-tie siblings of weaker shape
            if (unitPrimaryShapeRank(winner.pathRel) >
                unitPrimaryShapeRank(m.pathRel) + 20 &&
                Math.abs(winner.score - m.score) <= 8) {
                drop.add(normPath(m.pathRel));
            }
        }
    }
    if (drop.size) {
        collapsed = collapsed.filter((c) => !drop.has(normPath(c.pathRel)));
    }
    collapsed.sort((a, b) => unitPrimaryShapeRank(b.pathRel) - unitPrimaryShapeRank(a.pathRel) ||
        b.score - a.score ||
        a.pathRel.localeCompare(b.pathRel));
    return collapsed.length ? collapsed : usable;
}
/** Clip excerpt for scoring. */
export function clipBodyExcerpt(text, maxChars = UNIT_BODY_RULE.maxExcerptChars) {
    const raw = text || "";
    if (raw.length <= maxChars)
        return raw;
    return raw.slice(0, maxChars);
}
/**
 * Which intent codePatterns appear in the SUT excerpt (case-insensitive).
 * Supports plain tokens and light regex (`(?i)A|B`, `EntityCode`).
 */
export function findBodyRuleHits(excerpt, codePatterns) {
    const text = excerpt || "";
    if (!text || !codePatterns?.length)
        return [];
    const hits = [];
    for (const pat of codePatterns) {
        const p = String(pat || "").trim();
        if (p.length < 3)
            continue;
        if (isWeakBodyRulePattern(p))
            continue;
        try {
            const asRe = /^\(\?i\)/.test(p) || /[|\\[\]()+*?{}]/.test(p);
            if (asRe) {
                const src = p.replace(/^\(\?i\)/, "");
                if (new RegExp(src, "i").test(text))
                    hits.push(p);
            }
            else {
                const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                // Strong IT types may be prefixes (BadRequestAlertException).
                // Short verbs keep identifier boundary (avoid Generate⊂GeneratePresigned).
                const allowPascalPrefix = p.length >= 8 ||
                    /^(BadRequest|CheckCode|ArgumentException|AlreadyExists|MaxFileSize|SearchTerm)/i.test(p);
                const re = allowPascalPrefix
                    ? new RegExp(`(?<![A-Za-z0-9_])${escaped}`, "i")
                    : new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i");
                if (re.test(text))
                    hits.push(p);
            }
        }
        catch {
            if (text.toLowerCase().includes(p.toLowerCase()))
                hits.push(p);
        }
    }
    return uniq(hits);
}
export function bodyRuleScoreBoost(hitCount) {
    if (hitCount <= 0)
        return 0;
    return (UNIT_BODY_RULE.hitBoost + (hitCount - 1) * UNIT_BODY_RULE.multiHitBoost);
}
function looksLikeFeShell(pathRel) {
    const p = (pathRel || "").replace(/\\/g, "/").toLowerCase();
    return (isWeakUnitClientPath(pathRel) ||
        /\.component\.(ts|tsx|js)$/.test(p));
}
/**
 * True when TC Function/title/steps imply file/image upload (not bare Module «tạo mới»).
 */
export function queryImpliesUploadIntent(intent, shapeBlob) {
    const uploadClasses = new Set([
        "upload",
        "upload_resource",
        "upload_size_limit",
    ]);
    if ((intent.primaryClass && uploadClasses.has(intent.primaryClass)) ||
        (intent.classes || []).some((c) => uploadClasses.has(c))) {
        return true;
    }
    const blob = String(shapeBlob || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    return /tai\s*len|\bupload\b|hinh\s*anh|\bimage\b|\bmedia\b|\bphoto\b|\bmagic\s*bytes\b|\bantivirus\b|\bscanner\b/.test(blob);
}
/**
 * Upload / image-file TCs — boost Upload|Image|Physical*|DigitalFile* paths;
 * demote generic *DocumentCreate* and plain Create handlers without upload shape.
 */
export function uploadIntentPathShapeAdjust(pathRel, intent, shapeBlob) {
    if (!queryImpliesUploadIntent(intent, shapeBlob))
        return 0;
    const blob = String(shapeBlob || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const p = (pathRel || "").replace(/\\/g, "/");
    let adj = 0;
    if (/(Upload|PhysicalImage|DigitalFile|Image|Media|Photo|FileSignature|Antivirus|Scanner|InitUpload)/i.test(p)) {
        adj += 38;
    }
    if (/Create(Command)?Handler/i.test(p) &&
        !/(Upload|Image|Physical|Digital|Media|Photo|File|Attachment)/i.test(p)) {
        adj -= 30;
    }
    if (/DocumentCreate/i.test(p) &&
        /hinh\s*anh|\bimage\b|\bphoto\b|\bmedia\b|\bscanner\b|\bmagic\s*bytes\b/.test(blob) &&
        !/(document|tep\s*tin|file\s*ky|attachment)/.test(blob)) {
        adj -= 44;
    }
    return adj;
}
/** Strip diacritics for portable VI/IT cue matching. */
function shapeBlobNorm(shapeBlob) {
    return String(shapeBlob || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}
/**
 * Storage / compartment / occupied state — stronger than assign/filter when both cue.
 * Portable IT: Compartment|Storage|Slot|IsOccupied (no product nouns).
 */
export function queryImpliesStorageStateIntent(intent, shapeBlob) {
    if (intent.primaryClass === "state_enable" ||
        (intent.classes || []).includes("state_enable")) {
        return true;
    }
    const blob = shapeBlobNorm(shapeBlob);
    return (/\bcompartment\b|\boccupied\b|\bisoccupied\b|\bstorage\b|\bslot\b/.test(blob) ||
        /ngan(\s+(luu|trong|da|chua|slot))?|luu\s*tru|vi\s*tri\s*(luu|storage)|chon\s*vi\s*tri/.test(blob));
}
/**
 * Authz / permission / CanWrite — Function/Title cues (not bare Module create).
 */
export function queryImpliesAuthzIntent(intent, shapeBlob) {
    const blob = shapeBlobNorm(shapeBlob);
    return (/phan\s*quyen|khong\s*quyen|quyen\s*ghi|\bpermission\b|\bauthorize\b|\bauthorization\b|\bcanwrite\b|\bforbidden\b|\bdenied\b|khong\s*(duoc\s*)?(ghi|sua|tao)/.test(blob) ||
        (intent.featureTokens || []).some((t) => /CanWrite|Permission|Authorization|Authorize/i.test(t)));
}
/**
 * True when Function/Title/steps imply assign / filter / list (not bare Module create).
 * Portable VI/IT cues — score only; not a hard moduleGate.
 * Does not fire when storage/compartment state is the stronger op.
 */
export function queryImpliesAssignFilterIntent(intent, shapeBlob) {
    if (queryImpliesStorageStateIntent(intent, shapeBlob))
        return false;
    if (intent.primaryClass === "filter_list" ||
        (intent.classes || []).includes("filter_list")) {
        return true;
    }
    const blob = shapeBlobNorm(shapeBlob);
    // \bgan\b = gán (assign); do not match ngăn (ngan) — storage handled above
    return /(?:^|[^a-z])gan(?:[^a-z]|$)|assign|attach|\blink\b|loc\s+|bo\s*loc|\bfilter\b|list\s*available|danh\s*sach/.test(blob);
}
/**
 * Op tokens from Function/Title that must hit path/symbol for soft writeBack.
 * Portable IT stems only.
 */
export function extractOpPreferTokens(intent, shapeBlob) {
    const out = [];
    if (queryImpliesStorageStateIntent(intent, shapeBlob)) {
        out.push("Storage", "Compartment", "Slot", "Occupied", "IsOccupied", "Location");
    }
    if (queryImpliesAuthzIntent(intent, shapeBlob)) {
        out.push("CanWrite", "Permission", "Authorization", "Authorize", "Deny");
    }
    if (queryImpliesAssignFilterIntent(intent, shapeBlob)) {
        out.push("Assign", "Attach", "Link", "Filter");
    }
    if (queryImpliesUploadIntent(intent, shapeBlob)) {
        out.push("Upload", "Image", "Physical", "Digital", "Media");
    }
    for (const t of intent.classFeatureTokens || []) {
        if (/IsOccupied|Occupied|CanWrite|Permission|Assign|Upload|Filter|Compartment|Storage/i.test(t)) {
            out.push(t);
        }
    }
    return uniq(out);
}
/**
 * Soft writeBack refuse when op tokens from Title/Function miss the candidate path
 * (e.g. storage/compartment TC latching AssignCase with no Storage/Compartment hit).
 */
export function pathContradictsOpPreferTokens(pathRel, opTokens) {
    const ops = (opTokens || []).filter((t) => String(t || "").trim().length >= 4);
    if (!ops.length)
        return false;
    const p = (pathRel || "").replace(/\\/g, "/");
    const hit = ops.some((t) => {
        const tl = t.toLowerCase();
        return p.toLowerCase().includes(tl);
    });
    return !hit;
}
/**
 * Assign / Filter / List / Storage / Authz op shape adjust.
 * Boost matching Handler shapes; demote conflicting Create/Assign in same family.
 * No product nouns.
 */
export function functionOpPathShapeAdjust(pathRel, intent, shapeBlob) {
    const p = (pathRel || "").replace(/\\/g, "/");
    let adj = 0;
    if (queryImpliesStorageStateIntent(intent, shapeBlob)) {
        if (/(Storage|Compartment|Slot|Occupied|IsOccupied|Cabinet|Location)/i.test(p)) {
            adj += 48;
        }
        // AssignCase without storage/compartment stem — common wrong latch
        if (/(Assign|Attach|Link)(Case|To)?/i.test(p) &&
            !/(Storage|Compartment|Slot|Occupied|Location)/i.test(p)) {
            adj -= 50;
        }
        if (/Create(Command)?Handler/i.test(p) &&
            !/(Storage|Compartment|Slot|Occupied|Location)/i.test(p)) {
            adj -= 40;
        }
        return adj;
    }
    if (queryImpliesAuthzIntent(intent, shapeBlob)) {
        if (/(CanWrite|Permission|Authorize|Authorization|Authz|AccessControl|Deny|Forbid)/i.test(p)) {
            adj += 44;
        }
        // Prefer handlers that often embed authz checks (Assign*) over bare Create
        if (/Assign/i.test(p) && /Handler/i.test(p))
            adj += 18;
        if (/Create(Command)?Handler/i.test(p) &&
            !/(CanWrite|Permission|Authorize|Auth)/i.test(p)) {
            adj -= 28;
        }
        return adj;
    }
    if (!queryImpliesAssignFilterIntent(intent, shapeBlob))
        return 0;
    if (/(Assign|Attach|Link|Filter|ListAvailable|List\w*QueryHandler)/i.test(p)) {
        adj += 42;
    }
    if (/Create(Command)?Handler/i.test(p) &&
        !/(Assign|Attach|Link|Filter|List)/i.test(p)) {
        adj -= 36;
    }
    return adj;
}
/**
 * Portable shape adjust for validate_reject / auto_generate_code + create cues.
 * Boost Create*Handler; demote signed-URL generators and compound *DocumentCreate*.
 * No product nouns.
 */
export function validateRejectPathShapeAdjust(pathRel, intent, tcBlob) {
    const uploadAdj = uploadIntentPathShapeAdjust(pathRel, intent, tcBlob);
    if (queryImpliesUploadIntent(intent, tcBlob)) {
        return uploadAdj;
    }
    // Assign/filter adjust is applied via functionOpPathShapeAdjust in rankHitToSeed
    if (queryImpliesAssignFilterIntent(intent, tcBlob)) {
        return 0;
    }
    const isReject = intent.primaryClass === "validate_reject" ||
        (intent.classes || []).includes("validate_reject");
    const isAutoCode = intent.primaryClass === "auto_generate_code" ||
        (intent.classes || []).includes("auto_generate_code");
    if (!isReject && !isAutoCode)
        return 0;
    const blob = String(tcBlob || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    if (!blob)
        return 0;
    const createCue = /tao\s*moi|\bcreate\b|them\s*moi|\badd\b/.test(blob);
    const dupCue = /trung\s*(ma|code)|duplicate|ton\s*tai|already\s*exists|ma\s*(da\s*)?(ton\s*tai|trung)|code\s*exists/.test(blob);
    const p = (pathRel || "").replace(/\\/g, "/");
    let adj = 0;
    if (createCue && /Create(Command)?Handler/i.test(p))
        adj += 24;
    // create / duplicate-reject — demote Update/Delete as primary
    if (createCue &&
        /(Update|Delete)(Command)?Handler/i.test(p) &&
        !/Create/i.test(p)) {
        adj -= 28;
    }
    // Plain entity create — demote compound *Document/File/Attachment*Create*
    if (createCue &&
        !/(document|attachment|tep\s*(tin|ky)|digital\s*file|file\s*ky|\bimage\b|\bmedia\b)/i.test(blob) &&
        /(Document|File|Attachment|Image|Media|Photo|Blob)Create(Command)?Handler/i.test(p)) {
        adj -= 20;
    }
    if ((dupCue || isAutoCode) && isSignedUrlOrTokenGeneratePath(p))
        adj -= 36;
    if (dupCue && /CheckCode/i.test(p) && /Query/i.test(p) && !/Create/i.test(p)) {
        adj -= 10;
    }
    if (isAutoCode && /CheckCode/i.test(p) && /Query/i.test(p)) {
        adj -= 12;
    }
    return adj;
}
/**
 * Re-score one path candidate with body-rule hits from its excerpt.
 */
/** Patterns used for body-rule hit detection (never bare Upload/Create/Add). */
export function bodyRulePatternsForIntent(intent) {
    const raw = intent.rulePatterns?.length
        ? intent.rulePatterns
        : intent.requiresBodyRule
            ? (intent.codePatterns || []).filter((p) => !/^(upload|initupload|download)$/i.test(p))
            : intent.codePatterns || [];
    return filterStrongBodyRulePatterns(raw);
}
/** Portable stopwords — not product nouns. */
const TC_AFFINITY_STOP = new Set([
    "the",
    "and",
    "for",
    "with",
    "when",
    "from",
    "that",
    "this",
    "into",
    "then",
    "than",
    "have",
    "has",
    "was",
    "are",
    "were",
    "been",
    "will",
    "can",
    "not",
    "but",
    "all",
    "any",
    "via",
    "per",
    "trace",
    "input",
    "output",
    "mock",
    "assert",
    "step",
    "steps",
    "test",
    "data",
    "type",
    "unit",
    "true",
    "false",
    "null",
    "void",
    "async",
    "await",
    "return",
    "throw",
    "class",
    "public",
    "private",
    "string",
    "system",
    "he",
    "thong",
    "toan",
    "va",
    "cua",
    "cac",
    "la",
    "duoc",
    "khi",
    "cho",
    "voi",
    "trong",
    "tren",
    "mot",
    "nay",
    "kia",
    "theo",
    "de",
    "da",
    "se",
    "dang",
    "rat",
    "nhu",
    "lai",
    "ve",
    "tai",
    "sau",
    "truoc",
    "nhung",
    "hoac",
    "neu",
    "hay",
    "len",
    "xuong",
    "goi",
    "kiem",
    "tra",
    "bo",
    "phan",
    "ket",
    "qua",
    "loi",
    "ngoai",
    "le",
]);
function stripAffinityText(s) {
    return String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase();
}
/**
 * Phrases from TC title/module/expected for excerpt affinity.
 * Portable: any language tokens present in both TC and SUT strings/comments.
 */
export function extractTcAffinityPhrases(tcBlob) {
    const ascii = stripAffinityText(tcBlob || "");
    if (!ascii)
        return [];
    const words = ascii
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !TC_AFFINITY_STOP.has(w));
    const out = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w.length >= 5)
            out.push(w);
        if (i + 1 < words.length) {
            const bi = `${w} ${words[i + 1]}`;
            if (bi.replace(/\s/g, "").length >= 6)
                out.push(bi);
        }
        if (i + 2 < words.length) {
            const tri = `${w} ${words[i + 1]} ${words[i + 2]}`;
            if (tri.replace(/\s/g, "").length >= 9)
                out.push(tri);
        }
    }
    return uniq(out).slice(0, 48);
}
/**
 * Boost when SUT excerpt/path shares phrases, preferTokens, or tech stems with the TC.
 * Breaks cross-family CreateHandler ties without product aliases.
 */
export function extractExcerptTechStems(excerpt) {
    const text = excerpt || "";
    if (!text)
        return [];
    const out = [];
    for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]{2,}(?:Code|Exists|Duplicate|Unique|Handler|Service)?)\b/g)) {
        const s = m[1] || "";
        if (s.length >= 4)
            out.push(s);
    }
    for (const m of text.matchAll(/\b([a-z][a-zA-Z0-9]{4,}(?:Code|Exists|Duplicate))\b/g)) {
        const s = m[1] || "";
        if (s.length >= 5)
            out.push(s);
    }
    return uniq(out).slice(0, 32);
}
export function tcExcerptAffinityBoost(excerpt, tcBlob, opts) {
    const phrases = extractTcAffinityPhrases(tcBlob);
    const ex = stripAffinityText(excerpt || "");
    const pathLow = stripAffinityText(opts?.pathRel || "").replace(/[^a-z0-9/]/g, "");
    const tcLow = stripAffinityText(tcBlob || "");
    const hits = [];
    let boost = 0;
    if (phrases.length && ex) {
        const phraseHits = [];
        for (const p of phrases) {
            if (ex.includes(p))
                phraseHits.push(p);
        }
        phraseHits.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length);
        for (const h of phraseHits.slice(0, 8)) {
            hits.push(h);
            const n = h.split(/\s+/).length;
            if (n >= 3)
                boost += 24;
            else if (n === 2)
                boost += 20;
            else if (h.length >= 8)
                boost += 10;
            else
                boost += 6;
        }
    }
    // preferTokens ↔ path / excerpt (portable domain nudge)
    for (const raw of (opts?.preferTokens || []).slice(0, 12)) {
        const t = String(raw || "")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
        if (t.length < 4)
            continue;
        if (/^(create|update|delete|reject|deny|checkcode|validation|trace|input|mock)$/i.test(t)) {
            continue;
        }
        if (pathLow.includes(t) || (ex && ex.replace(/[^a-z0-9]/g, "").includes(t))) {
            hits.push(`prefer:${raw}`);
            boost += 14;
        }
    }
    // Tech stems from excerpt that also appear in TC blob (errorKey / identifier)
    if (ex && tcLow) {
        const stems = extractExcerptTechStems(excerpt);
        const tcCompact = tcLow.replace(/[^a-z0-9]/g, "");
        for (const stem of stems.slice(0, 16)) {
            const s = stem.toLowerCase();
            if (s.length < 6)
                continue;
            if (tcCompact.includes(s) || tcLow.includes(s)) {
                hits.push(`techStem:${stem}`);
                boost += 12;
            }
        }
    }
    if (!hits.length)
        return { boost: 0, hits: [] };
    return { boost: Math.min(boost, 72), hits: uniq(hits).slice(0, 8) };
}
export function applyBodyRuleToCandidate(cand, excerpt, intent, tcBlob, opts) {
    const ruleHits = findBodyRuleHits(excerpt, bodyRulePatternsForIntent(intent));
    let score = cand.score + bodyRuleScoreBoost(ruleHits.length);
    score -= infraPathDemoteScore(cand.pathRel, intent);
    score += validateRejectPathShapeAdjust(cand.pathRel, intent, tcBlob);
    const affinity = tcExcerptAffinityBoost(excerpt, tcBlob, {
        preferTokens: opts?.preferTokens,
        pathRel: cand.pathRel,
    });
    score += affinity.boost;
    if (intent.requiresBodyRule &&
        looksLikeFeShell(cand.pathRel) &&
        ruleHits.length === 0) {
        score -= UNIT_BODY_RULE.feValidationPenalty;
    }
    const hitNote = ruleHits.length > 0 ? ` bodyRule:${ruleHits.slice(0, 4).join("+")}` : "";
    const affNote = affinity.hits.length > 0
        ? ` tcPhrase:${affinity.hits.slice(0, 3).join("+")}`
        : "";
    return {
        ...cand,
        baseScore: cand.score,
        score,
        ruleHits,
        reason: `${cand.reason || "seed"}${hitNote}${affNote}`.trim(),
        hits: uniq([
            ...(cand.hits || []),
            ...ruleHits.map((h) => `rule:${h}`),
            ...affinity.hits.map((h) => h.startsWith("prefer:") || h.startsWith("techStem:")
                ? h
                : `phrase:${h}`),
        ]),
    };
}
/** Count how many prefer tokens hit the path (portable domain nudge). */
export function countPreferTokenHits(pathRel, preferTokens) {
    const tokens = (preferTokens || [])
        .map((t) => String(t || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ""))
        .filter((t) => t.length >= 3);
    if (!tokens.length)
        return 0;
    const p = normPath(pathRel).replace(/[^a-z0-9/]/g, "");
    let n = 0;
    for (const t of tokens) {
        if (p.includes(t))
            n += 1;
    }
    return n;
}
function affinitySignalCount(c) {
    return (c.hits || []).filter((h) => /^(phrase:|prefer:|techStem:)/i.test(String(h || ""))).length;
}
function crossFamilyDifferentialOk(best, second, preferTokens, margin, minMargin) {
    const preferDiff = countPreferTokenHits(best.pathRel, preferTokens) -
        countPreferTokenHits(second.pathRel, preferTokens);
    const affDiff = affinitySignalCount(best) - affinitySignalCount(second);
    const strongMargin = margin >= Math.max(minMargin * 1.5, 36);
    return preferDiff > 0 || affDiff > 0 || strongMargin;
}
/**
 * Fail-closed pick after body-rule rescoring.
 * When intent.requiresBodyRule → best must have ≥1 ruleHits.
 */
export function decideBodyRuleWriteBack(scored, intent, opts) {
    const minScore = opts?.minScore ?? 56;
    const minMargin = opts?.minMargin ?? 20;
    const minRatio = opts?.minRatio ?? 1.45;
    const prefer = opts?.preferTokens;
    const sorted = [...scored].sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
    const top3 = sorted.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        baseScore: c.baseScore,
        ruleHits: c.ruleHits,
    }));
    const formatTop = () => top3
        .map((c) => `${c.pathRel.split("/").pop()}(${c.score},hits=${c.ruleHits.join("|") || "0"})`)
        .join(", ");
    if (!sorted.length) {
        return {
            writeBack: false,
            seed: null,
            skipReason: "no candidates after logic-layer filter",
            candidatesTop3: [],
        };
    }
    let usable = sorted;
    if (intent.requiresBodyRule) {
        usable = sorted.filter((c) => c.ruleHits.length >= 1);
        // auto_generate_code: require empty-code assign shape (not random IsNullOr* alone)
        if (intent.primaryClass === "auto_generate_code" ||
            (intent.classes || []).includes("auto_generate_code")) {
            const strong = usable.filter((c) => c.ruleHits.some((h) => /userProvidedCode/i.test(h)));
            if (strong.length)
                usable = strong;
        }
        if (!usable.length) {
            return {
                writeBack: false,
                seed: null,
                skipReason: `body-rule required but no pattern hits; top3: ${formatTop()}`,
                candidatesTop3: top3,
            };
        }
    }
    // IUploadService vs UploadService (same score) is not ambiguity — prefer impl;
    // GetUploadActivityQuery should not veto UploadService write-back.
    usable = collapseBodyRuleContenders(usable);
    const best = usable[0];
    if (!best || best.score < minScore) {
        return {
            writeBack: false,
            seed: null,
            skipReason: `body-rule score below min (${best?.score ?? 0}<${minScore}); top3: ${formatTop()}`,
            candidatesTop3: top3,
        };
    }
    const second = usable[1];
    if (second) {
        const margin = best.score - second.score;
        const ratioOk = best.score >= second.score * minRatio;
        const famBest = unitFeatureFamilyKey(best.pathRel);
        const famSecond = unitFeatureFamilyKey(second.pathRel);
        const sameFamily = Boolean(famBest && famBest === famSecond);
        const crossFamily = Boolean(famBest && famSecond && !sameFamily);
        const pickByPrefer = () => {
            if (!prefer?.length)
                return null;
            const ranked = [...usable].sort((a, b) => countPreferTokenHits(b.pathRel, prefer) -
                countPreferTokenHits(a.pathRel, prefer) ||
                affinitySignalCount(b) - affinitySignalCount(a) ||
                unitPrimaryShapeRank(b.pathRel) - unitPrimaryShapeRank(a.pathRel) ||
                b.score - a.score ||
                a.pathRel.localeCompare(b.pathRel));
            const pick = ranked[0];
            const runner = ranked[1];
            const pickHits = countPreferTokenHits(pick.pathRel, prefer);
            const runnerHits = runner
                ? countPreferTokenHits(runner.pathRel, prefer)
                : 0;
            const affPick = affinitySignalCount(pick);
            const affRun = runner ? affinitySignalCount(runner) : 0;
            if (pickHits > 0 && pickHits > runnerHits)
                return pick;
            if (affPick > affRun)
                return pick;
            return null;
        };
        if (margin < minMargin && !ratioOk) {
            // Last resort: interface vs impl same family still in list
            if (isInterfaceLikePrimaryPath(best.pathRel) !==
                isInterfaceLikePrimaryPath(second.pathRel) &&
                margin === 0) {
                const seed = isInterfaceLikePrimaryPath(best.pathRel) ? second : best;
                return {
                    writeBack: true,
                    seed,
                    candidatesTop3: top3,
                };
            }
            // Same feature family after progressive Req (e.g. DigitalFile Create/Handler/Delete)
            // is not real ambiguity — pick best shape.
            if (sameFamily) {
                const pick = unitPrimaryShapeRank(best.pathRel) >=
                    unitPrimaryShapeRank(second.pathRel)
                    ? best
                    : second;
                return {
                    writeBack: true,
                    seed: pick,
                    candidatesTop3: top3,
                };
            }
            // Soft: clear #1 with strictly more body-rule hits (e.g. Create vs DocumentCreate)
            if (margin >= 8 && best.ruleHits.length > second.ruleHits.length) {
                return {
                    writeBack: true,
                    seed: best,
                    candidatesTop3: top3,
                };
            }
            const preferPick = pickByPrefer();
            if (preferPick) {
                return {
                    writeBack: true,
                    seed: preferPick,
                    candidatesTop3: top3,
                };
            }
            return {
                writeBack: false,
                seed: null,
                skipReason: `body-rule ambiguous margin; top3: ${formatTop()}`,
                candidatesTop3: top3,
            };
        }
        // Margin OK but different families: require prefer/affinity differential or strong margin
        if (crossFamily &&
            !crossFamilyDifferentialOk(best, second, prefer, margin, minMargin)) {
            const preferPick = pickByPrefer();
            if (preferPick) {
                return {
                    writeBack: true,
                    seed: preferPick,
                    candidatesTop3: top3,
                };
            }
            return {
                writeBack: false,
                seed: null,
                skipReason: `body-rule cross-family weak differential; top3: ${formatTop()}`,
                candidatesTop3: top3,
            };
        }
    }
    return {
        writeBack: true,
        seed: best,
        candidatesTop3: top3,
    };
}
/** Compact log line for Activity / Grounding (P3.2). */
export function formatBodyRuleLog(decision, extra) {
    const top = decision.candidatesTop3
        .map((c) => `${c.pathRel}:${c.score}[${c.ruleHits.join("+") || "-"}]`)
        .join("; ");
    const seedHits = decision.seed?.hits || [];
    const signals = uniq(seedHits
        .map((h) => String(h).split(":")[0] || "")
        .filter((s) => /^(alias|prefer|phrase|tech|techStem|rule|sutMap)$/i.test(s)));
    const bits = [];
    if (extra?.intentClass?.trim())
        bits.push(`intent=${extra.intentClass.trim()}`);
    if (extra?.matchedIntentIds?.length) {
        bits.push(`projectIntents=${extra.matchedIntentIds.join("|")}`);
    }
    if (extra?.domainGuard?.trim())
        bits.push(`domainGuard=${extra.domainGuard.trim()}`);
    if (extra?.softSignalOk === false)
        bits.push("softSignal=no");
    if (extra?.softSignalOk === true)
        bits.push("softSignal=yes");
    if (signals.length)
        bits.push(`signals=${signals.join("|")}`);
    const extraNote = bits.length ? ` ${bits.join(" ")}` : "";
    return `candidatesTop3=${top || "-"} writeBack=${decision.writeBack ? "yes" : "no"}${decision.seed
        ? ` score=${decision.seed.score} ruleHits=${decision.seed.ruleHits.join(",") || "-"}${extraNote}`
        : decision.skipReason
            ? ` skip=${decision.skipReason}${extraNote}`
            : extraNote}`;
}
