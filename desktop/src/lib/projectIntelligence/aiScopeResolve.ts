import { resolveSourceScope, resolveSourceTokens } from "../../api";
import type { TestCase } from "../../api/types";
import { buildProjectIndexCached } from "./projectIndex";
import { collectModuleRelatedPaths } from "./relatedFilesFromTc";
import { resolveSeedCandidates } from "./tcSeedResolver";
import {
  isAcceptableUnitScopePath,
  pickFirstAcceptableUnitScopePath,
  tcBlobForUnitScope,
} from "./unitScopeAccept";
import type { CodeAliasMap } from "./viCodeAliases";

/**
 * FE lọc ứng viên → AI xếp hạng path (không gửi nội dung file).
 *
 * Khi bật AI: map TC VI → token EN/code trước, rồi lọc path, rồi xếp hạng.
 * Fallback heuristic nếu AI lỗi / chưa Ready.
 */
export async function resolveScopeWithAi(input: {
  projectId: string;
  testCase: TestCase;
  allSourcePaths: string[];
  codeAliases?: CodeAliasMap | null;
  useAi?: boolean;
}): Promise<{
  primary: string | null;
  related: string[];
  reason: string;
  usedAi: boolean;
  candidates: string[];
  codeTokens?: string[];
}> {
  const index = buildProjectIndexCached(
    input.projectId,
    input.allSourcePaths.map((p) => p.replace(/\\/g, "/"))
  );

  let aiTokens: string[] = [];
  let tokenReason = "";
  if (input.useAi !== false) {
    try {
      const mapped = await resolveSourceTokens.run({
        projectId: input.projectId,
        testCaseId: input.testCase.id,
      });
      aiTokens = mapped.tokens ?? [];
      tokenReason = mapped.reason || "";
    } catch {
      aiTokens = [];
    }
  }

  const seeds = resolveSeedCandidates(input.testCase, index, {
    limit: 30,
    projectAliases: input.codeAliases,
    extraCodeTokens: aiTokens,
  });
  const moduleExtra = collectModuleRelatedPaths({
    seedPathRel: seeds[0]?.pathRel ?? "",
    moduleName: input.testCase.module,
    allPaths: input.allSourcePaths,
    maxFiles: 30,
  });

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    const p = s.pathRel.replace(/\\/g, "/");
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  }
  for (const p0 of moduleExtra) {
    const p = p0.replace(/\\/g, "/");
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  }

  // Token AI khớp path chưa nằm trong seed (vd. Evidence* khi module là tiếng Việt)
  if (aiTokens.length) {
    const lowerTokens = aiTokens.map((t) => t.toLowerCase());
    for (const raw of input.allSourcePaths) {
      const p = raw.replace(/\\/g, "/");
      if (seen.has(p)) continue;
      const pl = p.toLowerCase();
      if (lowerTokens.some((t) => t.length >= 3 && pl.includes(t))) {
        seen.add(p);
        candidates.push(p);
        if (candidates.length >= 60) break;
      }
    }
  }

  const tcText = tcBlobForUnitScope(input.testCase);
  const acceptOpts = { tcText, codeAliases: input.codeAliases };
  const filtered = candidates.filter((p) =>
    isAcceptableUnitScopePath({ pathRel: p, ...acceptOpts })
  );

  if (!filtered.length) {
    return {
      primary: null,
      related: [],
      reason: candidates.length
        ? "Ứng viên path lệch domain / không phải Unit SUT"
        : "Không có ứng viên path từ TC",
      usedAi: false,
      candidates: filtered,
      codeTokens: aiTokens,
    };
  }

  if (input.useAi === false) {
    return {
      primary: filtered[0],
      related: filtered.slice(1, 9),
      reason: seeds[0]?.reason ?? "Heuristic FE",
      usedAi: false,
      candidates: filtered,
      codeTokens: aiTokens,
    };
  }

  try {
    const ranked = await resolveSourceScope.run({
      projectId: input.projectId,
      testCaseId: input.testCase.id,
      candidates: filtered.slice(0, 60),
    });
    const prefix = aiTokens.length
      ? `VI→EN: ${aiTokens.slice(0, 6).join(", ")}${aiTokens.length > 6 ? "…" : ""}. `
      : "";
    const aiPrimary = (ranked.primary || "").replace(/\\/g, "/") || null;
    const primary =
      (aiPrimary &&
      isAcceptableUnitScopePath({ pathRel: aiPrimary, ...acceptOpts })
        ? aiPrimary
        : null) ||
      pickFirstAcceptableUnitScopePath(
        [aiPrimary, ...(ranked.related || []), ...filtered].filter(Boolean) as string[],
        acceptOpts
      );
    const related = (ranked.related ?? [])
      .map((p) => p.replace(/\\/g, "/"))
      .filter(
        (p) =>
          p !== primary && isAcceptableUnitScopePath({ pathRel: p, ...acceptOpts })
      );
    return {
      primary,
      related: related.length ? related : filtered.filter((p) => p !== primary).slice(0, 8),
      reason: primary
        ? `${prefix}${ranked.reason || tokenReason || "AI xếp hạng"}`
        : "AI xếp hạng · bỏ primary lệch domain",
      usedAi: true,
      candidates: filtered,
      codeTokens: aiTokens,
    };
  } catch {
    return {
      primary: filtered[0],
      related: filtered.slice(1, 9),
      reason:
        aiTokens.length > 0
          ? `Token AI: ${aiTokens.slice(0, 6).join(", ")} · ${seeds[0]?.reason ?? "heuristic"}`
          : seeds[0]?.reason ?? "Heuristic FE (AI không sẵn sàng)",
      usedAi: aiTokens.length > 0,
      candidates: filtered,
      codeTokens: aiTokens,
    };
  }
}
