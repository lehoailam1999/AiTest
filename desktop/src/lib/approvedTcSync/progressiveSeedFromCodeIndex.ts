/**
 * Progressive Unit seed helpers from `.ai-test/index.db` (legacy / fallback).
 * Approve primary path is now `unitResolve` (Query → retrieveUnitSources → rank).
 * Keep preferredSymbol / extractTechIdentifierStems for shared ranking.
 */
import {
  extractUnitIntent,
  filterStrongRankTokens,
  filterUnitLogicLayerCandidates,
  filterUnitLogicLayerPaths,
  isSignedUrlOrTokenGeneratePath,
  isWeakPathBridgePattern,
  matchingProjectAliasTokens,
  pathHitsToken,
  UNIT_INTENT_DEFS,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import type { CodeIndexSnapshot } from "../codeIndex/types";
import { extractMatchTokens } from "../projectIntelligence/tcSeedResolver";
import type { SeedCandidate } from "../projectIntelligence/types";
import type { CodeAliasMap } from "../projectIntelligence/viCodeAliases";
import { isExcludedFromUnitRetrieve, unitPathBonus } from "../retrieval/rankScore";

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * Camel/Pascal stems from TC tech fields (errorKey=fooCodeExists → Foo).
 * Portable — no product dictionaries.
 */
export function extractTechIdentifierStems(raw: string): string[] {
  const text = String(raw || "");
  if (!text.trim()) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]{3,}/g)) {
    const s = m[0];
    const parts = s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/)
      .filter(Boolean);
    for (const p of parts) {
      if (p.length >= 4) out.push(p);
    }
  }
  return uniq(out);
}

export { pathHitsToken };

function symbolHitsToken(
  snap: CodeIndexSnapshot,
  pathRel: string,
  token: string
): string | null {
  const tl = token.toLowerCase();
  for (const s of snap.symbolsByFile[pathRel] || []) {
    const name = s.name.toLowerCase();
    if (tl.length <= 3) {
      // Word-boundary style: Activate must not match vat
      const flat = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/\s+/);
      if (flat.some((p) => p === tl)) return s.name;
      continue;
    }
    if (name === tl || name.includes(tl)) {
      return s.name;
    }
  }
  return null;
}

export type ProgressiveSeedOpts = {
  requirementTitle?: string | null;
  projectAliases?: CodeAliasMap | null;
  limit?: number;
};

/**
 * Rank Code Index files: Module → Function → Title (+ symbol boost).
 */
export function resolveSeedsFromCodeIndex(
  tc: TestCase,
  snap: CodeIndexSnapshot,
  opts?: ProgressiveSeedOpts
): SeedCandidate[] {
  const limit = opts?.limit ?? 8;
  const aliases = opts?.projectAliases;
  const intent = extractUnitIntent(tc, {
    projectAliases: aliases,
    requirementTitle: opts?.requirementTitle,
  });
  const requirementTokens = filterStrongRankTokens(
    extractMatchTokens(opts?.requirementTitle || "", aliases)
  );
  const moduleTokens = filterStrongRankTokens(
    extractMatchTokens(tc.module || "", aliases)
  );
  const titleTokens = filterStrongRankTokens(
    extractMatchTokens(tc.title || "", aliases)
  );
  const bodyTokens = filterStrongRankTokens(
    extractMatchTokens(
      [
        tc.steps,
        tc.expectedResult,
        tc.precondition || "",
        tc.testData || "",
      ].join(" "),
      aliases
    ).filter((t) => t.length >= 4)
  );
  const techStems = filterStrongRankTokens(
    extractTechIdentifierStems(
      [tc.testData || "", tc.expectedResult || "", tc.precondition || ""].join(
        "\n"
      )
    )
  );
  const bodyRuleClassTokens = filterStrongRankTokens(
    uniq(
      UNIT_INTENT_DEFS.filter(
        (d) => d.requiresBodyRule && intent.classes.includes(d.id)
      )
        .flatMap((d) => d.featureTokens)
        .filter((t) => t.length >= 4)
    )
  );
  const classIntentTokens = filterStrongRankTokens(
    uniq(
      (intent.requiresBodyRule && bodyRuleClassTokens.length
        ? bodyRuleClassTokens
        : [...intent.classFeatureTokens, ...intent.codePatterns]
      ).filter((t) => t.length >= 4)
    )
  );
  // Intent path boost: class features + alias domain nouns (Create already filtered).
  const intentTokens = filterStrongRankTokens(
    uniq(
      [...intent.featureTokens, ...intent.codePatterns].filter((t) => t.length >= 4)
    )
  );

  const allPaths = filterUnitLogicLayerPaths(
    Object.keys(snap.files).filter((p) => !isExcludedFromUnitRetrieve(p))
  );
  if (!allPaths.length) return [];

  // Prefer longer / alias tokens for requirement scope (skip weak ≤3 char noise).
  const strongReq = requirementTokens.filter((t) => t.length >= 4);
  const scopeReq = strongReq.length ? strongReq : requirementTokens;

  // Progressive scope (portable): Module (Studio / requirementTitle) locks
  // source-module family first; Function (tc.module) narrows files inside.
  let scoped = allPaths;
  if (scopeReq.length) {
    const reqHit = allPaths.filter((p) =>
      scopeReq.some(
        (t) => pathHitsToken(p, t) || Boolean(symbolHitsToken(snap, p, t))
      )
    );
    if (reqHit.length) {
      scoped = reqHit;
      if (moduleTokens.length) {
        const both = scoped.filter((p) =>
          moduleTokens.some(
            (t) => pathHitsToken(p, t) || Boolean(symbolHitsToken(snap, p, t))
          )
        );
        if (both.length) scoped = both;
      }
    } else if (moduleTokens.length) {
      const modHitAll = allPaths.filter((p) =>
        moduleTokens.some(
          (t) => pathHitsToken(p, t) || Boolean(symbolHitsToken(snap, p, t))
        )
      );
      if (modHitAll.length) scoped = modHitAll;
    }
  } else if (moduleTokens.length) {
    const modHitAll = allPaths.filter((p) =>
      moduleTokens.some(
        (t) => pathHitsToken(p, t) || Boolean(symbolHitsToken(snap, p, t))
      )
    );
    if (modHitAll.length) scoped = modHitAll;
  }

  // Portable widen (any body-rule intent): strong bridge needles only
  // (CheckCode / SearchTerm / IsOccupied / MaxFileSize) — never throw|Generate|Exists.
  const codeFieldFolders = new Set<string>();
  if (intent.requiresBodyRule) {
    const tcBlobNorm = [tc.title, tc.module, tc.steps, tc.expectedResult, tc.testData]
      .filter(Boolean)
      .join("\n")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    const codeFieldCreate =
      intent.primaryClass === "auto_generate_code" ||
      (intent.classes || []).includes("auto_generate_code") ||
      (/tao\s*moi|\bcreate\b|them\s*moi/.test(tcBlobNorm) &&
        /\bma\b|\bcode\b|de\s*trong|tu\s*sinh|empty\s*code/.test(tcBlobNorm));
    const bridgeNeedles = filterStrongRankTokens(
      uniq(
        [
          ...intent.rulePatterns,
          ...intent.classFeatureTokens,
          // Code-field create: widen folders that own CheckCode* (sibling of CreateHandler)
          ...(codeFieldCreate ? ["CheckCode"] : []),
        ].filter((t) => t.length >= 5)
      )
    ).filter((t) => !isWeakPathBridgePattern(t));
    if (bridgeNeedles.length) {
      const bridgePaths = allPaths.filter((p) =>
        bridgeNeedles.some(
          (t) => pathHitsToken(p, t) || Boolean(symbolHitsToken(snap, p, t))
        )
      );
      if (bridgePaths.length) {
        for (const p of bridgePaths.slice(0, 32)) {
          const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
          for (const seg of parts.slice(0, -1)) {
            if (seg.length < 4) continue;
            if (/^(src|app|application|commands|queries|handlers|services|domain|infrastructure)$/i.test(seg)) {
              continue;
            }
            codeFieldFolders.add(seg);
          }
        }
        const folderPaths =
          codeFieldFolders.size === 0
            ? []
            : allPaths.filter((p) =>
                [...codeFieldFolders].some((seg) => pathHitsToken(p, seg))
              );
        scoped = uniq([...scoped, ...bridgePaths, ...folderPaths]);
      }
    }
  }

  // 3) Title / body score within scoped set
  const scored: SeedCandidate[] = [];
  for (const pathRel of scoped) {
    let score = unitPathBonus(pathRel);
    const hits: string[] = [];
    for (const t of requirementTokens) {
      if (pathHitsToken(pathRel, t) || symbolHitsToken(snap, pathRel, t)) {
        score += 40;
        hits.push(t);
      }
    }
    for (const t of moduleTokens) {
      if (pathHitsToken(pathRel, t) || symbolHitsToken(snap, pathRel, t)) {
        score += 28;
        hits.push(t);
      }
    }
    for (const t of titleTokens) {
      const sym = symbolHitsToken(snap, pathRel, t);
      if (sym) {
        score += 22;
        hits.push(sym);
      } else if (pathHitsToken(pathRel, t)) {
        score += 14;
        hits.push(t);
      }
    }
    for (const t of bodyTokens.slice(0, 8)) {
      if (pathHitsToken(pathRel, t) || symbolHitsToken(snap, pathRel, t)) {
        score += 6;
        hits.push(t);
      }
    }
    // errorKey=fooCodeExists / BadRequestAlertException → domain stems from TC text
    for (const t of techStems.slice(0, 10)) {
      if (pathHitsToken(pathRel, t) || symbolHitsToken(snap, pathRel, t)) {
        score += 34;
        hits.push(`tech:${t}`);
      }
    }
    // Class features outrank alias-expanded domain nouns for body-rule TCs.
    const rankIntent = intent.requiresBodyRule
      ? classIntentTokens.slice(0, 12)
      : intentTokens.slice(0, 12);
    for (const t of rankIntent) {
      const sym = symbolHitsToken(snap, pathRel, t);
      if (sym) {
        score += intent.requiresBodyRule ? 36 : 20;
        hits.push(`intent:${sym}`);
      } else if (pathHitsToken(pathRel, t)) {
        score += intent.requiresBodyRule ? 28 : 16;
        hits.push(`intent:${t}`);
      }
    }
    // Project .ai-test/code-aliases.json only — never GENERIC_VI (nhap→Login latch).
    const aliasDomain = filterStrongRankTokens(
      matchingProjectAliasTokens(
        [opts?.requirementTitle, tc.module, tc.title].filter(Boolean).join(" "),
        aliases
      )
    );
    for (const t of aliasDomain.slice(0, 8)) {
      const sym = symbolHitsToken(snap, pathRel, t);
      if (sym) {
        score += 48;
        hits.push(`alias:${sym}`);
      } else if (pathHitsToken(pathRel, t)) {
        score += 40;
        hits.push(`alias:${t}`);
      }
    }
    // create + duplicate/reject → prefer *Create*Handler over Assign/Query/Generate*
    if (intent.requiresBodyRule) {
      const blob = [tc.title, tc.module, tc.steps, tc.expectedResult, tc.testData]
        .filter(Boolean)
        .join("\n")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      const createCue = /tao\s*moi|\bcreate\b|them\s*moi/.test(blob);
      const dupCue =
        /trung\s*(ma|code)|duplicate|ton\s*tai|already\s*exists|ma\s*(da\s*)?(ton\s*tai|trung)/.test(
          blob
        );
      if (createCue && /Create(Command)?Handler/i.test(pathRel)) {
        score += 20;
        hits.push("shape:CreateHandler");
      }
      // CreateHandler under a CheckCode feature folder (code-field domain)
      if (
        /Create(Command)?Handler/i.test(pathRel) &&
        codeFieldFolders.size > 0 &&
        [...codeFieldFolders].some((seg) => pathHitsToken(pathRel, seg))
      ) {
        score += 42;
        hits.push("shape:CheckCodeFolderCreate");
      }
      if (
        createCue &&
        !/(document|attachment|tep\s*(tin|ky)|digital\s*file|file\s*ky|\bimage\b|\bmedia\b)/i.test(
          blob
        ) &&
        /(Document|File|Attachment|Image|Media|Photo|Blob)Create(Command)?Handler/i.test(
          pathRel
        )
      ) {
        score -= 18;
        hits.push("shape:demoteCompoundCreate");
      }
      if (dupCue && /CheckCode/i.test(pathRel)) {
        score += 18;
        hits.push("shape:CheckCode");
      }
      if (dupCue && isSignedUrlOrTokenGeneratePath(pathRel)) {
        score -= 30;
        hits.push("shape:demoteUrlTokenGenerate");
      }
    }
    if (score < 8) continue;
    scored.push({
      pathRel,
      score,
      hits: uniq(hits),
      reason: hits.length
        ? `index.db: ${hits.slice(0, 6).join(", ")}`
        : "index.db path",
    });
  }

  scored.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
  const tcBlob = [tc.title, tc.module, tc.steps, tc.expectedResult, tc.testData]
    .filter(Boolean)
    .join("\n");
  return filterUnitLogicLayerCandidates(scored, { tcText: tcBlob }).slice(0, limit);
}

/** Prefer exported class / primary symbol for code: marker. */
export function preferredSymbolFromCodeIndex(
  snap: CodeIndexSnapshot,
  pathRel: string,
  preferTokens: string[] = []
): string | null {
  const symbols = snap.symbolsByFile[pathRel] || [];
  if (!symbols.length) return null;

  const implScore = (s: {
    name: string;
    kind: string;
    exported?: boolean;
  }): number => {
    const n = s.name || "";
    if (/CommandHandler$|QueryHandler$/i.test(n)) return 100;
    if (/Handler$/i.test(n)) return 90;
    if (/Service$|UseCase$/i.test(n)) return 80;
    if (s.kind === "interface" || /^I[A-Z]/.test(n)) return 10;
    if (/(Command|Query|Dto|Request|Response)$/i.test(n) && !/Handler/i.test(n))
      return 20;
    if (s.kind === "class" && s.exported) return 55;
    if (s.kind === "class") return 45;
    if (s.kind === "function" && s.exported) return 40;
    return 30;
  };

  const prefer = preferTokens.map((t) => t.toLowerCase()).filter(Boolean);
  for (const t of prefer) {
    const matches = symbols.filter(
      (s) =>
        (s.kind === "class" || s.kind === "function" || s.kind === "interface") &&
        (s.name.toLowerCase() === t || s.name.toLowerCase().includes(t))
    );
    if (matches.length) {
      matches.sort((a, b) => implScore(b) - implScore(a));
      return matches[0]!.name;
    }
  }
  const ranked = [...symbols].sort((a, b) => implScore(b) - implScore(a));
  return ranked[0]?.name || null;
}
