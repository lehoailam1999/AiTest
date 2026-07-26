import type { SourceUnderTestHints, UnitStrategyHints } from "../contextPacket/types";

/**
 * Deterministic light analysis of primary source for Prompt Builder.
 * Does not generate tests — only extracts symbols / deps / mock boundaries.
 */
export function analyzeSourceUnderTest(input: {
  pathRel: string;
  content: string;
  language: string;
  testCaseTitle?: string;
}): { sourceUnderTest: SourceUnderTestHints; unitStrategy: UnitStrategyHints; gaps: string[] } {
  const lang = (input.language || "").toLowerCase();
  const content = input.content || "";
  const pathRel = input.pathRel.replace(/\\/g, "/");

  const symbol = guessSymbol(pathRel, content, lang);
  const methods = guessPublicMethods(content, lang);
  const constructorDeps = guessConstructorDeps(content, lang);
  const asyncMethods = methods.filter((m) => isAsyncMethod(content, m, lang));
  const externalCalls = guessExternalCalls(content, lang).slice(0, 12);

  const sourceUnderTest: SourceUnderTestHints = {
    pathRel,
    symbol: symbol || undefined,
    methods: methods.length ? methods.slice(0, 20) : undefined,
    constructorDeps: constructorDeps.length ? constructorDeps : undefined,
    asyncMethods: asyncMethods.length ? asyncMethods : undefined,
    externalCalls: externalCalls.length ? externalCalls : undefined,
  };

  const whatToMock = [...new Set([...constructorDeps, ...externalCalls.map(shortCall)])].slice(0, 12);
  const unitStrategy: UnitStrategyHints = {
    whatToTest: input.testCaseTitle
      ? `Cover Approved TC intent: ${input.testCaseTitle}`
      : symbol
        ? `Unit-test visible surface of ${symbol}`
        : "Unit-test visible public surface of primary source",
    whatToMock: whatToMock.length ? whatToMock : undefined,
    whatNotToMock: symbol ? [`${symbol} itself`, "pure helpers in the same file"] : ["pure helpers in the same file"],
    forbidden: [
      "invent APIs / types not present in primary or related snippets",
      "write test beside production source — host places under AItest/UnitTest/{Module}/",
      "skip Arrange-Act-Assert (or language equivalent)",
    ],
  };

  const gaps: string[] = [];
  if (!symbol) gaps.push("Could not infer class/module symbol from primary file");
  if (methods.length === 0) gaps.push("No public methods inferred — Prompt Builder should use TC steps");
  if (constructorDeps.length === 0 && /inject|depends|repository|service|client/i.test(content)) {
    gaps.push("Possible DI dependencies not fully resolved — mock only what appears in snippets");
  }

  return { sourceUnderTest, unitStrategy, gaps };
}

function shortCall(s: string): string {
  const parts = s.split(".");
  return parts.length > 1 ? parts[0] : s;
}

function guessSymbol(pathRel: string, content: string, lang: string): string {
  const base = pathRel.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  if (lang.includes("python")) {
    const m = content.match(/^class\s+(\w+)/m);
    if (m) return m[1];
    return base;
  }
  if (lang.includes("c#") || lang.includes("csharp") || lang.includes("java") || lang.includes("kotlin")) {
    const m = content.match(/\b(?:public\s+)?(?:sealed\s+|abstract\s+|static\s+)?(?:partial\s+)?class\s+(\w+)/);
    if (m) return m[1];
    const t = content.match(/\b(?:public\s+)?(?:interface|record|struct)\s+(\w+)/);
    if (t) return t[1];
  }
  if (lang.includes("go")) {
    const m = content.match(/type\s+(\w+)\s+struct/);
    if (m) return m[1];
  }
  if (lang.includes("typescript") || lang.includes("javascript") || lang.includes("node")) {
    const m =
      content.match(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/) ||
      content.match(/export\s+(?:async\s+)?function\s+(\w+)/) ||
      content.match(/export\s+const\s+(\w+)\s*=/);
    if (m) return m[1];
  }
  if (/^[A-Z]/.test(base)) return base;
  return base;
}

function guessPublicMethods(content: string, lang: string): string[] {
  const out = new Set<string>();
  if (lang.includes("python")) {
    for (const m of content.matchAll(/^\s{0,4}(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(/gm)) {
      if (!m[1].startsWith("_")) out.add(m[1]);
    }
  } else if (lang.includes("c#") || lang.includes("csharp")) {
    for (const m of content.matchAll(
      /public\s+(?:async\s+)?(?:static\s+)?(?:virtual\s+|override\s+)?[\w<>,\[\]\s.]+\s+(\w+)\s*\(/g
    )) {
      if (m[1] !== "if" && m[1] !== "for" && m[1] !== "while") out.add(m[1]);
    }
  } else if (lang.includes("java") || lang.includes("kotlin")) {
    for (const m of content.matchAll(
      /public\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>,\[\]\s.]+\s+(\w+)\s*\(/g
    )) {
      out.add(m[1]);
    }
  } else if (lang.includes("go")) {
    for (const m of content.matchAll(/func\s+\([^)]+\)\s+([A-Z]\w*)\s*\(/g)) {
      out.add(m[1]);
    }
    for (const m of content.matchAll(/func\s+([A-Z]\w*)\s*\(/g)) {
      out.add(m[1]);
    }
  } else {
    for (const m of content.matchAll(
      /(?:public\s+|export\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>,\s.|]+)?\s*\{/g
    )) {
      const name = m[1];
      if (
        name &&
        !["if", "for", "while", "switch", "catch", "constructor"].includes(name) &&
        !name.startsWith("_")
      ) {
        out.add(name);
      }
    }
  }
  return [...out];
}

function guessConstructorDeps(content: string, lang: string): string[] {
  const out: string[] = [];
  if (lang.includes("c#") || lang.includes("csharp")) {
    const ctor = content.match(
      /(?:public|private|protected|internal)\s+\w+\s*\(([^)]*)\)\s*(?::\s*base\([^)]*\))?\s*\{/
    );
    if (ctor) {
      for (const part of ctor[1].split(",")) {
        const t = part.trim().match(/([\w.<>]+)\s+\w+\s*$/);
        if (t) out.push(stripGenerics(t[1]));
      }
    }
  } else if (lang.includes("typescript") || lang.includes("javascript")) {
    const ctor = content.match(/constructor\s*\(([^)]*)\)/);
    if (ctor) {
      for (const part of ctor[1].split(",")) {
        const t = part.trim().match(/(?:private|public|protected|readonly)\s+(?:readonly\s+)?(\w+)\s*:\s*([\w.<>]+)/);
        if (t) out.push(stripGenerics(t[2]));
        else {
          const u = part.trim().match(/(\w+)\s*:\s*([\w.<>]+)/);
          if (u) out.push(stripGenerics(u[2]));
        }
      }
    }
    for (const m of content.matchAll(/@Inject(?:able)?\(?[^)]*\)?\s*(?:private|public|protected)?\s*(?:readonly\s+)?(\w+)\s*:\s*([\w.<>]+)/g)) {
      out.push(stripGenerics(m[2]));
    }
  } else if (lang.includes("python")) {
    const init = content.match(/def\s+__init__\s*\(self\s*,([^)]*)\)/);
    if (init) {
      for (const part of init[1].split(",")) {
        const t = part.trim().match(/(\w+)\s*:\s*([\w.\[\]]+)/);
        if (t && t[1] !== "self") out.push(t[2]);
      }
    }
  } else if (lang.includes("java") || lang.includes("kotlin")) {
    const ctor = content.match(/(?:public|protected)\s+\w+\s*\(([^)]*)\)\s*(?:throws[^{]*)?\{/);
    if (ctor) {
      for (const part of ctor[1].split(",")) {
        const t = part.trim().match(/([\w.<>]+)\s+\w+\s*$/);
        if (t) out.push(stripGenerics(t[1]));
      }
    }
  } else if (lang.includes("go")) {
    const m = content.match(/func\s+New\w*\s*\(([^)]*)\)/);
    if (m) {
      for (const part of m[1].split(",")) {
        const t = part.trim().match(/\w+\s+([\w.*]+)/);
        if (t) out.push(t[1].replace(/^\*/, ""));
      }
    }
  }
  return [...new Set(out)].filter((d) => d && d !== "string" && d !== "int" && d !== "bool");
}

function stripGenerics(t: string): string {
  return t.replace(/<[^>]+>/g, "").replace(/\[\]/g, "").trim();
}

function isAsyncMethod(content: string, name: string, lang: string): boolean {
  if (lang.includes("python")) {
    return new RegExp(`async\\s+def\\s+${name}\\s*\\(`).test(content);
  }
  if (lang.includes("c#") || lang.includes("csharp")) {
    return new RegExp(`async\\s+[\\w<>,\\[\\]\\s.]+\\s+${name}\\s*\\(`).test(content);
  }
  return new RegExp(`async\\s+(?:function\\s+)?${name}\\s*\\(`).test(content) ||
    new RegExp(`${name}\\s*\\([^)]*\\)\\s*:\\s*Promise`).test(content);
}

function guessExternalCalls(content: string, lang: string): string[] {
  const out = new Set<string>();
  if (lang.includes("python")) {
    for (const m of content.matchAll(/\bself\.(\w+)\.(\w+)\s*\(/g)) {
      out.add(`${m[1]}.${m[2]}`);
    }
  } else {
    for (const m of content.matchAll(/\b(?:this|_)\.(\w+)\.(\w+)\s*\(/g)) {
      out.add(`${m[1]}.${m[2]}`);
    }
    for (const m of content.matchAll(/\b([A-Z]\w+)\.(\w+)\s*\(/g)) {
      if (!["Console", "Math", "String", "Array", "Object", "JSON"].includes(m[1])) {
        out.add(`${m[1]}.${m[2]}`);
      }
    }
  }
  return [...out];
}

/** Pick nearby existing tests as style samples (paths only — caller reads content). */
export function findNearbyTestSamples(input: {
  seedPathRel: string;
  allPaths: string[];
  testFilePattern?: string;
  max: number;
}): string[] {
  const seed = input.seedPathRel.replace(/\\/g, "/");
  const seedDir = seed.includes("/") ? seed.slice(0, seed.lastIndexOf("/")) : "";
  const stem = seed.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const isTest = (p: string) =>
    /\.(test|spec)\./i.test(p) ||
    /\/(test|tests|__tests__)\//i.test(p) ||
    /Tests?\.(cs|java|kt|go|py|rs)$/i.test(p) ||
    /^test_/i.test(p.split("/").pop() || "");

  const scored: { path: string; score: number }[] = [];
  for (const raw of input.allPaths) {
    const p = raw.replace(/\\/g, "/");
    if (p === seed || !isTest(p)) continue;
    let score = 0;
    if (seedDir && p.startsWith(seedDir + "/")) score += 5;
    if (stem && p.toLowerCase().includes(stem.toLowerCase())) score += 8;
    if (input.testFilePattern && patternLooseMatch(p, input.testFilePattern)) score += 2;
    if (score > 0) scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, input.max).map((s) => s.path);
}

function patternLooseMatch(path: string, pattern: string): boolean {
  // "*.spec.ts" → ends with .spec.ts; "test_*.py" → basename starts with test_
  const base = path.split("/").pop() || "";
  if (pattern.startsWith("*") && pattern.includes(".")) {
    const suf = pattern.replace(/^\*/, "");
    return base.endsWith(suf.replace("*", ""));
  }
  if (pattern.startsWith("test_") && pattern.endsWith(".py")) {
    return /^test_.+\.py$/i.test(base);
  }
  if (pattern.endsWith("Tests.cs")) {
    return /Tests\.cs$/i.test(base);
  }
  return false;
}
