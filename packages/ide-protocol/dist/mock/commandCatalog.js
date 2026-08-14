/**
 * In-memory catalog for mock IDE Command Layer (P10).
 * Bounded results only — mirrors plugin hard caps.
 */
import { IdeCommandLimits } from "../constants.js";
function makeId(s) {
    return `${s.pathRel}:${s.line}:${s.character}:${s.name}`;
}
function parseSymbolId(id) {
    const m = id.match(/^(.+):(\d+):(\d+):(.+)$/);
    if (!m)
        return null;
    return {
        pathRel: m[1],
        line: Number(m[2]),
        character: Number(m[3]),
        name: m[4],
    };
}
export function defaultMockFiles() {
    return [
        {
            pathRel: "src/auth/auth.service.ts",
            content: [
                "import { UserRepository } from './user.repository';",
                "",
                "export class AuthService {",
                "  constructor(private users: UserRepository) {}",
                "  async login(email: string, password: string) {",
                "    const user = await this.users.findByEmail(email);",
                "    return { token: 't' };",
                "  }",
                "}",
                "",
            ].join("\n"),
        },
        {
            pathRel: "src/auth/user.repository.ts",
            content: [
                "export class UserRepository {",
                "  findByEmail(email: string) {",
                "    return { email };",
                "  }",
                "}",
                "",
            ].join("\n"),
        },
        {
            pathRel: "src/evidence/evidence.service.ts",
            content: [
                "export class EvidenceService {",
                "  create(payload: { title: string }) {",
                "    return { id: '1', ...payload };",
                "  }",
                "}",
                "",
            ].join("\n"),
        },
    ];
}
export function defaultMockSymbols() {
    return [
        {
            name: "AuthService",
            kind: "class",
            pathRel: "src/auth/auth.service.ts",
            line: 2,
            character: 13,
            endLine: 8,
        },
        {
            name: "login",
            kind: "method",
            pathRel: "src/auth/auth.service.ts",
            line: 4,
            character: 8,
            endLine: 7,
            containerName: "AuthService",
        },
        {
            name: "UserRepository",
            kind: "class",
            pathRel: "src/auth/user.repository.ts",
            line: 0,
            character: 13,
            endLine: 4,
        },
        {
            name: "findByEmail",
            kind: "method",
            pathRel: "src/auth/user.repository.ts",
            line: 1,
            character: 2,
            endLine: 3,
            containerName: "UserRepository",
        },
        {
            name: "EvidenceService",
            kind: "class",
            pathRel: "src/evidence/evidence.service.ts",
            line: 0,
            character: 13,
            endLine: 4,
        },
        {
            name: "create",
            kind: "method",
            pathRel: "src/evidence/evidence.service.ts",
            line: 1,
            character: 2,
            endLine: 3,
            containerName: "EvidenceService",
        },
    ];
}
function clampMax(n, hard) {
    if (n == null || !Number.isFinite(n) || n <= 0)
        return hard;
    return Math.min(Math.floor(n), hard);
}
export function mockSearchSymbol(symbols, params) {
    const q = (params.query || "").trim().toLowerCase();
    const max = clampMax(params.maxResults, IdeCommandLimits.searchSymbolMaxResults);
    let filtered = symbols.filter((s) => s.name.toLowerCase().includes(q));
    if (params.kinds?.length) {
        const set = new Set(params.kinds);
        filtered = filtered.filter((s) => set.has(s.kind));
    }
    const truncated = filtered.length > max;
    const hits = filtered.slice(0, max).map((s) => ({
        id: makeId(s),
        name: s.name,
        kind: s.kind,
        pathRel: s.pathRel,
        containerName: s.containerName,
        range: {
            start: s.line,
            end: s.endLine,
            startCharacter: s.character,
            endCharacter: s.character + s.name.length,
        },
        score: s.name.toLowerCase() === q ? 1 : 0.8,
    }));
    return { hits, truncated };
}
export function mockSearchText(files, params) {
    const q = params.query || "";
    const max = clampMax(params.maxResults, IdeCommandLimits.searchTextMaxResults);
    const maxBytes = clampMax(params.maxBytesPerHit, IdeCommandLimits.searchTextMaxBytesPerHit);
    const hits = [];
    const matchesGlob = (pathRel, glob) => {
        if (!glob)
            return true;
        const ext = glob.match(/\.\w[\w.]*/g);
        if (ext?.length)
            return ext.some((e) => pathRel.toLowerCase().endsWith(e.toLowerCase()));
        return pathRel.toLowerCase().includes(glob.replace(/\*/g, "").toLowerCase());
    };
    for (const f of files) {
        if (!matchesGlob(f.pathRel, params.glob))
            continue;
        const lines = f.content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const idx = lines[i].indexOf(q);
            if (idx < 0)
                continue;
            let preview = lines[i].trim();
            if (preview.length > maxBytes)
                preview = preview.slice(0, maxBytes);
            hits.push({ pathRel: f.pathRel, line: i, character: idx, preview });
            if (hits.length > max)
                break;
        }
        if (hits.length > max)
            break;
    }
    const truncated = hits.length > max;
    return { hits: hits.slice(0, max), truncated };
}
function resolvePosition(symbols, params) {
    if (params.symbolId) {
        const parsed = parseSymbolId(params.symbolId);
        if (parsed)
            return parsed;
    }
    if (params.pathRel != null && params.line != null) {
        return {
            pathRel: params.pathRel,
            line: params.line,
            character: params.character ?? 0,
        };
    }
    return symbols[0]
        ? {
            pathRel: symbols[0].pathRel,
            line: symbols[0].line,
            character: symbols[0].character,
            name: symbols[0].name,
        }
        : null;
}
export function mockGoToDefinition(symbols, params) {
    const pos = resolvePosition(symbols, params);
    if (!pos)
        return { locations: [] };
    const hit = symbols.find((s) => s.pathRel === pos.pathRel &&
        s.line === pos.line &&
        (pos.name ? s.name === pos.name : true)) || symbols.find((s) => s.name === pos.name);
    if (!hit) {
        return {
            locations: [
                {
                    pathRel: pos.pathRel,
                    range: { start: pos.line, end: pos.line, startCharacter: pos.character },
                    name: pos.name,
                },
            ],
        };
    }
    return {
        locations: [
            {
                pathRel: hit.pathRel,
                range: {
                    start: hit.line,
                    end: hit.endLine,
                    startCharacter: hit.character,
                    endCharacter: hit.character + hit.name.length,
                },
                name: hit.name,
            },
        ],
    };
}
export function mockFindReferences(symbols, files, params) {
    const max = clampMax(params.maxResults, IdeCommandLimits.findReferencesMaxResults);
    const pos = resolvePosition(symbols, params);
    const name = pos?.name ||
        symbols.find((s) => s.pathRel === pos?.pathRel && s.line === pos?.line)?.name ||
        "AuthService";
    const refs = [];
    for (const f of files) {
        const lines = f.content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const idx = lines[i].indexOf(name);
            if (idx < 0)
                continue;
            refs.push({
                file: f.pathRel,
                name,
                range: { start: i, end: i, startCharacter: idx, endCharacter: idx + name.length },
            });
            if (refs.length > max)
                break;
        }
        if (refs.length > max)
            break;
    }
    const truncated = refs.length > max;
    return { refs: refs.slice(0, max), truncated };
}
export function mockFindImplementations(symbols, params) {
    const def = mockGoToDefinition(symbols, params);
    const max = clampMax(params.maxResults, IdeCommandLimits.findImplementationsMaxResults);
    const locs = def.locations.slice(0, max);
    return { locations: locs, truncated: def.locations.length > max };
}
export function mockReadFile(files, params) {
    const file = files.find((f) => f.pathRel.replace(/\\/g, "/") === params.pathRel.replace(/\\/g, "/"));
    if (!file) {
        return {
            pathRel: params.pathRel,
            content: "",
            startLine: 0,
            endLine: 0,
            truncated: false,
            totalLines: 0,
        };
    }
    const lines = file.content.split(/\r?\n/);
    const maxBytes = clampMax(params.maxBytes, IdeCommandLimits.readFileMaxBytes);
    const start = Math.max(0, params.startLine ?? 0);
    let end = params.endLine ?? Math.min(lines.length - 1, start + IdeCommandLimits.readFileMaxLines - 1);
    end = Math.min(end, lines.length - 1, start + IdeCommandLimits.readFileMaxLines - 1);
    let content = lines.slice(start, end + 1).join("\n");
    let truncated = end < lines.length - 1 || (params.startLine ?? 0) > 0;
    if (content.length > maxBytes) {
        content = content.slice(0, maxBytes);
        truncated = true;
    }
    return {
        pathRel: file.pathRel,
        content,
        startLine: start,
        endLine: end,
        truncated,
        totalLines: lines.length,
    };
}
