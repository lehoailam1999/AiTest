/**
 * VI ↔ Latin code token expansion (project-agnostic).
 * Defaults: src/defaults/vi-it-aliases.json (IT verbs only).
 * Domain nouns → SUT `.ai-test/code-aliases.json`.
 * Index stems → expandTokensFromIndex when indexPaths provided.
 */
import viItDefaults from "./defaults/vi-it-aliases.json" with { type: "json" };
import { expandTokensFromIndex, filterTokensHittingPaths, } from "./expandTokensFromIndex.js";
const VI_IT_DEFAULTS = viItDefaults;
/** IT verbs/actions — loaded from defaults JSON (override via SUT code-aliases). */
export const GENERIC_VI_WORD_ALIASES = {
    ...VI_IT_DEFAULTS.words,
};
/** Portable IT phrases — domain phrases belong on SUT code-aliases.json. */
export const GENERIC_VI_PHRASE_ALIASES = {
    ...VI_IT_DEFAULTS.phrases,
};
function stripDiacriticsLocal(s) {
    return s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D");
}
export function normalizeAliasKey(raw) {
    return stripDiacriticsLocal(raw)
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export function mergeCodeAliasMaps(projectAliases) {
    const phrases = { ...GENERIC_VI_PHRASE_ALIASES };
    const words = { ...GENERIC_VI_WORD_ALIASES };
    if (projectAliases) {
        for (const [k, vals] of Object.entries(projectAliases)) {
            const key = normalizeAliasKey(k);
            if (!key || !Array.isArray(vals) || !vals.length)
                continue;
            const cleaned = vals.map((v) => String(v).trim()).filter(Boolean);
            if (key.includes(" ")) {
                phrases[key] = [...new Set([...(phrases[key] ?? []), ...cleaned])];
            }
            else {
                words[key] = [...new Set([...(words[key] ?? []), ...cleaned])];
            }
        }
    }
    return { phrases, words };
}
export function expandVietnameseToCodeTokens(raw, projectAliases) {
    const ascii = normalizeAliasKey(raw);
    if (!ascii)
        return [];
    const { phrases, words } = mergeCodeAliasMaps(projectAliases);
    const out = [];
    for (const [phrase, aliases] of Object.entries(phrases)) {
        if (ascii.includes(phrase))
            out.push(...aliases);
    }
    for (const w of ascii.split(" ").filter(Boolean)) {
        const al = words[w];
        if (al)
            out.push(...al);
    }
    const en = [...new Set(out.filter((x) => /^[A-Za-z]/.test(x)))];
    if (en.length >= 2) {
        out.push(en.slice(0, 3).join(""));
        out.push([...en.slice(0, 3)].reverse().join(""));
    }
    return [...new Set(out)];
}
function uniqTokens(xs) {
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
/**
 * Unified expansion: VI defaults + project aliases + optional index stems.
 * Index is SoT — bootstrap tokens that miss all paths are dropped when indexPaths set.
 */
export function expandCodeMatchTokens(raw, opts) {
    const paths = (opts?.indexPaths || []).filter(Boolean);
    const bootstrap = expandVietnameseToCodeTokens(raw, opts?.projectAliases);
    const indexDerived = paths.length
        ? expandTokensFromIndex(raw, paths)
        : [];
    if (!paths.length) {
        return uniqTokens([...bootstrap, ...indexDerived]);
    }
    const filterBootstrap = opts?.indexFilterBootstrap !== false;
    const bootstrapFiltered = filterBootstrap
        ? filterTokensHittingPaths(bootstrap, paths)
        : bootstrap;
    return uniqTokens([...bootstrapFiltered, ...indexDerived]);
}
/**
 * Domain tokens from **project** `.ai-test/code-aliases.json` only
 * (not generic IT verbs). Used to keep Approve body-rule from latching
 * unrelated *Service with throw/Validate.
 */
export function matchingProjectAliasTokens(raw, projectAliases) {
    if (!projectAliases || typeof projectAliases !== "object")
        return [];
    const ascii = normalizeAliasKey(raw);
    if (!ascii)
        return [];
    const out = [];
    for (const [k, vals] of Object.entries(projectAliases)) {
        const key = normalizeAliasKey(k);
        if (!key || !Array.isArray(vals) || !vals.length)
            continue;
        if (!ascii.includes(key))
            continue;
        for (const v of vals) {
            const t = String(v || "").trim();
            if (t.length >= 4)
                out.push(t);
        }
    }
    return [...new Set(out)];
}
