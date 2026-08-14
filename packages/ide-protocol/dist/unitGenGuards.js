/**
 * Project-agnostic Unit Gen post/pre guards (Extension + Desktop).
 * Fail-closed on stack mismatch, weak SUT↔TC alignment, and invented validators.
 */
import { codeMatchesPathStem, pathsMatchMarker, } from "./unitPrimaryPrefer.js";
import { expandVietnameseToCodeTokens } from "./viCodeAliases.js";
const STOP = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "when",
    "then",
    "test",
    "case",
    "unit",
    "should",
    "must",
    "user",
    "data",
    "file",
    "true",
    "false",
    "null",
    "void",
    "string",
    "class",
    "public",
    "private",
    "return",
    "import",
    "export",
    "const",
    "async",
    "await",
    "function",
    "namespace",
    "using",
    "system",
    "được",
    "không",
    "của",
    "cho",
    "với",
    "khi",
    "một",
    "các",
    "này",
    "đó",
    "trên",
    "dưới",
]);
/** Action / verb tokens — not domain nouns; also ignored for alias↔path hits. */
const DOMAIN_ACTIONISH = new Set([
    "create",
    "add",
    "new",
    "update",
    "edit",
    "delete",
    "remove",
    "view",
    "get",
    "detail",
    "search",
    "find",
    "query",
    "check",
    "upload",
    "download",
    "save",
    "send",
    "submit",
    "approve",
    "review",
    "login",
    "auth",
    "signin",
    "register",
    "reject",
    "deny",
    "duplicate",
    "unique",
    "exists",
    "invalid",
    "handler",
    "command",
    "service",
    "controller",
    "repository",
    "activate",
    "import",
    "export",
    "input",
    "api",
    "type",
]);
/**
 * TC meta / test-kind values that look like `type: Unit` in Approved MD frontmatter.
 * Must NOT count as SUT `code:` markers (false markers skip unmarked floors).
 */
const TC_META_KIND_CODES = new Set([
    "unit",
    "api",
    "e2e",
    "integration",
    "performance",
    "security",
    "manual",
    "automated",
]);
/** Extract path:/code:/related: markers from TC text (project-agnostic hints). */
export function extractTcSourceMarkers(text) {
    const paths = [];
    const codes = [];
    const related = [];
    const pathRe = /(?:^|\n)\s*(?:path|file|source)\s*[:=]\s*([^\s\n]+)/gi;
    // Do NOT treat bare `type:` as SUT marker — Approved MD uses `type: Unit|API|…`
    // for test kind. Symbol markers: code: / class: / symbol: / sut: only.
    const codeRe = /(?:^|\n)\s*(?:code|class|symbol|sut)\s*[:=]\s*([A-Za-z_][\w.]*)/gi;
    const relatedRe = /(?:^|\n)\s*related\s*[:=]\s*(.+)$/gim;
    let m;
    while ((m = pathRe.exec(text || ""))) {
        const p = m[1].replace(/^[`"'[]+|[`"'\]]+$/g, "").replace(/\\/g, "/");
        if (p)
            paths.push(p);
    }
    while ((m = codeRe.exec(text || ""))) {
        const c = m[1];
        if (!c)
            continue;
        if (TC_META_KIND_CODES.has(c.toLowerCase()))
            continue;
        codes.push(c);
    }
    while ((m = relatedRe.exec(text || ""))) {
        const chunk = (m[1] || "").trim();
        if (!chunk)
            continue;
        for (const part of chunk.split(/[,;]+/)) {
            const p = part
                .trim()
                .replace(/^[`"'[]+|[`"'\]]+$/g, "")
                .replace(/\\/g, "/");
            if (p && !related.includes(p))
                related.push(p);
        }
    }
    return { paths, codes, related };
}
/**
 * Phase 5 — Gen requires both path: and code: (from Approve write-back or manual).
 */
export function hasUnitSourceMarkers(text) {
    const m = extractTcSourceMarkers(text || "");
    return m.paths.length > 0 && m.codes.length > 0;
}
/** Approve fail-closed skip note without usable markers. */
export function isUnitSutResolveSkipped(text) {
    return /^\s*#\s*sut-resolve:\s*skipped\b/im.test(text || "");
}
/** Significant tokens for alignment (paths, PascalCase, words ≥4). */
export function significantTokens(text) {
    const bag = new Set();
    const raw = text || "";
    // Full PascalCase identifiers (keep compound — OrganizationUnit stays distinctive)
    for (const m of raw.matchAll(/[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*/g)) {
        const full = m[0].toLowerCase();
        if (full.length >= 4 && !STOP.has(full))
            bag.add(full);
    }
    // Split PascalCase parts (CreateEvidence → create, evidence) — apply STOP
    // so OrganizationUnit does not leak weak `unit` into alignment.
    for (const m of raw.matchAll(/[A-Z][a-z0-9]+/g)) {
        const t = m[0].toLowerCase();
        if (t.length >= 4 && !STOP.has(t))
            bag.add(t);
    }
    for (const m of raw.matchAll(/[A-Za-z][\w.-]{2,}/g)) {
        const t = m[0].toLowerCase().replace(/\.(ts|tsx|js|jsx|cs|py|go|java|kt)$/i, "");
        if (t.length >= 4 && t.length <= 48 && !STOP.has(t))
            bag.add(t);
    }
    for (const m of raw.matchAll(/[\p{L}]{4,40}/gu)) {
        const t = m[0].toLowerCase();
        if (!STOP.has(t))
            bag.add(t);
    }
    // path segments
    for (const seg of raw.replace(/\\/g, "/").split(/[/\s]+/)) {
        const t = seg.toLowerCase().replace(/\.[a-z0-9]+$/i, "");
        if (t.length >= 4 && t.length <= 40 && !STOP.has(t))
            bag.add(t);
    }
    return [...bag].slice(0, 120);
}
export function sutTcAlignmentScore(opts) {
    const markers = extractTcSourceMarkers(opts.tcText);
    let markersHit = 0;
    const pathNorm = (opts.primaryPath || "").replace(/\\/g, "/").toLowerCase();
    const primaryPath = opts.primaryPath || "";
    for (const p of markers.paths) {
        // Exact marker match — IFoo.cs must not score for path: Foo.cs
        if (pathsMatchMarker(primaryPath, p))
            markersHit += 3;
    }
    for (const c of markers.codes) {
        if (codeMatchesPathStem(c, primaryPath) ||
            new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(opts.sourceExcerpt || "")) {
            markersHit += 2;
        }
    }
    const expandedRaw = expandVietnameseToCodeTokens(opts.tcText, opts.codeAliases);
    const expanded = [];
    for (const t of expandedRaw) {
        const low = t.toLowerCase();
        if (low.length >= 4 && !STOP.has(low) && !DOMAIN_ACTIONISH.has(low)) {
            expanded.push(low);
        }
        for (const part of t.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/)) {
            const p = part.toLowerCase();
            if (p.length >= 4 && !STOP.has(p) && !DOMAIN_ACTIONISH.has(p)) {
                expanded.push(p);
            }
        }
    }
    let aliasPathHits = 0;
    for (const t of expanded) {
        // Weak IT tokens (`unit`, `create`) must not substring-match OrganizationUnit*Create*
        if (t.length < 5)
            continue;
        if (STOP.has(t) || DOMAIN_ACTIONISH.has(t))
            continue;
        if (pathNorm.includes(t))
            aliasPathHits += 1;
    }
    const tcUniq = [...new Set([...significantTokens(opts.tcText), ...expanded])];
    const sut = significantTokens(`${opts.primaryPath}\n${(opts.sourceExcerpt || "").slice(0, 6000)}`);
    const sutSet = new Set(sut);
    // Exact token overlap only — substring matching inflated scores
    // (e.g. random Angular *.service.ts vs unrelated Vietnamese TCs).
    const shared = tcUniq.filter((t) => sutSet.has(t));
    // Drop IT verbs / stop / short noise from overlap score (keep in shared for debug).
    const uniqStrong = [...new Set(shared)].filter((t) => t.length >= 5 &&
        !STOP.has(t) &&
        !DOMAIN_ACTIONISH.has(t) &&
        !["name", "code", "entity", "success", "result", "value", "item", "list", "dto"].includes(t));
    // markers dominate so path:+code: (markersHit≈5) clears hard floor 50 alone.
    // alias↔path hits help VI titles; token overlap is secondary.
    const score = markersHit * 10 +
        Math.min(6, aliasPathHits * 3) +
        Math.min(12, uniqStrong.length);
    return { score, shared: uniqStrong.slice(0, 12), markersHit };
}
/**
 * Minimum alignment to accept a resolved SUT (fail-closed below this).
 * With path:/code: markers, a low bar is OK (markers already weigh heavily).
 * Without markers, require stronger token overlap — otherwise weak words like
 * "file" / "form" latch onto unrelated admin modules (e.g. digital-file vs evidence upload).
 */
export const UNIT_SUT_ALIGN_MIN = 2;
/** Stricter floor when TC has no path:/code:/file:/sut: markers. */
export const UNIT_SUT_ALIGN_MIN_NO_MARKER = 6;
export function unitSutAlignMin(markersHit) {
    return markersHit > 0 ? UNIT_SUT_ALIGN_MIN : UNIT_SUT_ALIGN_MIN_NO_MARKER;
}
export function isSutAlignedEnough(opts) {
    return opts.score >= unitSutAlignMin(opts.markersHit);
}
/**
 * Domain nouns expected from TC (aliases + markers), excluding IT verbs.
 * e.g. "vật chứng" + aliases → ["evidence"].
 */
export function expectedDomainTokensFromTc(tcText, codeAliases) {
    const bag = new Set();
    const markers = extractTcSourceMarkers(tcText || "");
    for (const t of expandVietnameseToCodeTokens(tcText || "", codeAliases)) {
        const low = t.toLowerCase();
        if (low.length < 4 || DOMAIN_ACTIONISH.has(low) || STOP.has(low))
            continue;
        bag.add(low);
        for (const part of t.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/)) {
            const p = part.toLowerCase();
            if (p.length >= 4 && !DOMAIN_ACTIONISH.has(p) && !STOP.has(p))
                bag.add(p);
        }
    }
    for (const c of markers.codes) {
        const parts = c.match(/[A-Z][a-z0-9]*/g) || [];
        const head = parts[0]?.toLowerCase();
        if (head && head.length >= 4 && !DOMAIN_ACTIONISH.has(head))
            bag.add(head);
    }
    for (const p of markers.paths) {
        const norm = p.replace(/\\/g, "/");
        const m = norm.match(/\/(?:commands|handlers|controllers|services|domain)\/([^/]+)\//i);
        if (m?.[1] && m[1].length >= 3)
            bag.add(m[1].toLowerCase());
        const base = norm.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
        const parts = base.match(/[A-Z][a-z0-9]*/g) || [];
        const head = parts[0]?.toLowerCase();
        if (head && head.length >= 4 && !DOMAIN_ACTIONISH.has(head))
            bag.add(head);
    }
    return [...bag].slice(0, 16);
}
/**
 * Domain hints from a SUT path: Commands/{Domain}/ or basename prefix
 * (AccountCreateCommandHandler → account).
 */
export function extractPathDomainHints(primaryPath) {
    const norm = (primaryPath || "").replace(/\\/g, "/");
    const bag = new Set();
    const folder = norm.match(/\/(?:commands|handlers|controllers|services|domain|features|modules)\/([^/]+)\//i);
    if (folder?.[1] && folder[1].length >= 3)
        bag.add(folder[1].toLowerCase());
    const base = norm.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
    const parts = base.match(/[A-Z][a-z0-9]*/g) || [];
    const head = parts[0];
    if (head && head.length >= 4 && !DOMAIN_ACTIONISH.has(head.toLowerCase())) {
        bag.add(head.toLowerCase());
    }
    return [...bag];
}
/**
 * True when TC aliases/markers imply domain D1 but path is clearly D2 (e.g. Evidence vs Account).
 */
export function sutDomainConflict(opts) {
    const expected = expectedDomainTokensFromTc(opts.tcText, opts.codeAliases);
    const pathDomains = extractPathDomainHints(opts.primaryPath);
    if (!expected.length || !opts.primaryPath?.trim()) {
        return { conflict: false, expected, pathDomains };
    }
    const pathNorm = opts.primaryPath.replace(/\\/g, "/").toLowerCase();
    if (expected.some((e) => pathNorm.includes(e))) {
        return { conflict: false, expected, pathDomains };
    }
    const expectedSet = new Set(expected);
    const foreign = pathDomains.filter((d) => d.length >= 4 && !expectedSet.has(d));
    return {
        conflict: foreign.length > 0,
        expected,
        pathDomains,
    };
}
/** Packet/path usable only when aligned AND not a domain conflict. */
export function isPacketSutAcceptable(opts) {
    if (sutDomainConflict({
        tcText: opts.tcText,
        primaryPath: opts.primaryPath,
        codeAliases: opts.codeAliases,
    }).conflict) {
        return false;
    }
    return isSutAlignedEnough(sutTcAlignmentScore({
        tcText: opts.tcText,
        primaryPath: opts.primaryPath,
        sourceExcerpt: opts.sourceExcerpt,
        codeAliases: opts.codeAliases,
    }));
}
/** Extra stop-words for disk path ranking (not for TC↔SUT token overlap). */
export const PATH_RANK_STOP = new Set([
    ...STOP,
    "form",
    "service",
    "update",
    "create",
    "edit",
    "admin",
    "client",
    "clientapp",
    "image",
    "images",
    "list",
    "detail",
    "modal",
    "component",
    "page",
    "module",
    "feature",
    "features",
    "trace",
    "input",
    "output",
    "mock",
    "assert",
]);
export function detectCodeStack(code) {
    const c = code || "";
    if (/^\s*using\s+[\w.]+;/m.test(c) ||
        /\bnamespace\s+[\w.]+/.test(c) ||
        /\[Fact\]|\[Theory\]|Xunit|NUnit|MSTest/.test(c) ||
        /\bpublic\s+(sealed\s+)?class\s+\w+/.test(c)) {
        return "csharp";
    }
    if (/\bdescribe\s*\(|\bit\s*\(|\btest\s*\(|from\s+['"]@angular|from\s+['"]@nestjs|vitest|jest/.test(c) ||
        /\bimport\s+.+\s+from\s+['"]/.test(c)) {
        if (/\brequire\s*\(|module\.exports/.test(c) && !/\bimport\s+/.test(c)) {
            return "javascript";
        }
        return "typescript";
    }
    if (/\bdef\s+\w+\(|\bimport\s+\w+|pytest|unittest/.test(c))
        return "python";
    if (/\bpackage\s+\w+|@Test\b|org\.junit/.test(c))
        return "java";
    if (/\bfunc\s+\w+\(|package\s+\w+/.test(c) && /\.go\b/.test(c))
        return "go";
    return "unknown";
}
export function stackForPath(relPath) {
    const ext = (relPath.split(".").pop() || "").toLowerCase();
    if (ext === "cs")
        return "csharp";
    if (ext === "ts" || ext === "tsx")
        return "typescript";
    if (ext === "js" || ext === "jsx")
        return "javascript";
    if (ext === "py")
        return "python";
    if (ext === "java" || ext === "kt")
        return "java";
    if (ext === "go")
        return "go";
    return "any";
}
export function assertStackMatchesPath(relPath, code) {
    const want = stackForPath(relPath);
    if (want === "any")
        return;
    const got = detectCodeStack(code);
    if (got === "unknown") {
        // weak signal — still catch obvious cross-stack
        if (want === "csharp" && /describe\s*\(|import\s+\{/.test(code)) {
            throw new Error(`Stack mismatch: path ${relPath} is C# but content looks TypeScript/Jest`);
        }
        if ((want === "typescript" || want === "javascript") &&
            /^\s*using\s+[\w.]+;/m.test(code)) {
            throw new Error(`Stack mismatch: path ${relPath} is JS/TS but content looks C#`);
        }
        return;
    }
    if (got !== want) {
        // js/ts soft alias
        if ((want === "typescript" && got === "javascript") ||
            (want === "javascript" && got === "typescript")) {
            return;
        }
        throw new Error(`Stack mismatch: path expects ${want} (${relPath}) but generated ${got}`);
    }
}
/**
 * Heuristics for invented production rules inside the test file.
 * Project-agnostic — flags local BR/validator/hardcoded allow-lists not imported from SUT.
 */
export function findInventedRuleSmells(code, sutExcerpt) {
    const smells = [];
    const sut = sutExcerpt || "";
    const c = code || "";
    if (/\bclass\s+Br\d+\w*/i.test(c) && !/\bclass\s+Br\d+/i.test(sut)) {
        smells.push("Local Br* validator class invented in test (not in SUT)");
    }
    if (/\b(?:AllowedExtensions|AllowedMimeTypes|ValidExtensions)\s*=\s*new\s*(?:\[|List|HashSet)/i.test(c) &&
        !/AllowedExtensions|AllowedMimeTypes|ValidExtensions/i.test(sut)) {
        smells.push("Hardcoded AllowedExtensions/Mime list in test — use production constant/rule");
    }
    if (/\b(?:MAX_LENGTH|MaxLength)\s*=\s*\d{2,4}\b/.test(c) &&
        !/\[MaxLength\s*\(|MaxLength\s*=|StringLength\s*\(/.test(sut) &&
        /Assert[\s\S]{0,120}\.Length/.test(c)) {
        smells.push("Invented MaxLength constant + Length assert — ground on production attribute/rule");
    }
    if (/Assert\.(True|False|Equal)\([^)]{0,80}Length\s*[><=]+\s*\d{2,4}/.test(c) &&
        !/MaxLength|StringLength|LengthAttribute|@Size|@Length|maxLength|max:\s*\d/i.test(sut)) {
        smells.push("Length threshold assert without matching production constraint in SUT excerpt");
    }
    return smells;
}
export function assertUnitGenQuality(opts) {
    assertStackMatchesPath(opts.relPath, opts.code);
    const align = sutTcAlignmentScore({
        tcText: opts.tcText,
        primaryPath: opts.primaryPath,
        sourceExcerpt: opts.sutExcerpt,
    });
    // Post-gen: generated test must still reference SUT path or shared tokens
    const codeTokens = significantTokens(opts.code);
    const sutName = (opts.primaryPath.split("/").pop() || "")
        .replace(/\.[^.]+$/, "")
        .toLowerCase();
    const mentionsSut = opts.code.replace(/\\/g, "/").includes(opts.primaryPath.replace(/\\/g, "/")) ||
        (sutName.length >= 3 && opts.code.toLowerCase().includes(sutName)) ||
        align.shared.some((t) => codeTokens.includes(t));
    const postMin = unitSutAlignMin(align.markersHit) + 2;
    if (!mentionsSut && align.score < postMin) {
        throw new Error(`Generated test does not ground on resolved SUT «${opts.primaryPath}» (alignment=${align.score})`);
    }
    const smells = findInventedRuleSmells(opts.code, opts.sutExcerpt);
    if (smells.length) {
        throw new Error(`Invented production rules in test: ${smells.join("; ")}`);
    }
}
/** Map C# usings / common APIs → NuGet packages for AItest.UnitTests.csproj. */
export const CSHARP_USING_TO_PACKAGE = {
    fluentassertions: "FluentAssertions",
    "microsoft.entityframeworkcore.sqlite": "Microsoft.EntityFrameworkCore.Sqlite",
    "microsoft.entityframeworkcore.inmemory": "Microsoft.EntityFrameworkCore.InMemory",
    "microsoft.entityframeworkcore": "Microsoft.EntityFrameworkCore",
    "microsoft.aspnetcore.mvc.testing": "Microsoft.AspNetCore.Mvc.Testing",
    "microsoft.aspnetcore.httpmocks": "Microsoft.AspNetCore.Http",
    "microsoft.extensions.dependencyinjection": "Microsoft.Extensions.DependencyInjection",
    "microsoft.extensions.logging.abstractions": "Microsoft.Extensions.Logging.Abstractions",
    moq: "Moq",
    nsubstitute: "NSubstitute",
    autofixture: "AutoFixture",
    bogus: "Bogus",
};
export function detectCsharpPackagesFromTestCode(code) {
    const found = new Set();
    const c = code || "";
    for (const m of c.matchAll(/^\s*using\s+([\w.]+)\s*;/gm)) {
        const ns = m[1].toLowerCase();
        for (const [prefix, pkg] of Object.entries(CSHARP_USING_TO_PACKAGE)) {
            if (ns === prefix || ns.startsWith(prefix + "."))
                found.add(pkg);
        }
    }
    if (/\bFluentAssertions\b|\.Should\(\)/.test(c))
        found.add("FluentAssertions");
    if (/\bUseSqlite\b|SqliteConnection|SqliteInMemory/.test(c)) {
        found.add("Microsoft.EntityFrameworkCore.Sqlite");
    }
    if (/\bUseInMemoryDatabase\b/.test(c)) {
        found.add("Microsoft.EntityFrameworkCore.InMemory");
    }
    if (/\bWebApplicationFactory\b/.test(c)) {
        found.add("Microsoft.AspNetCore.Mvc.Testing");
    }
    return [...found];
}
