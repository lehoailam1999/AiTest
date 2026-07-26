import { resolveSourceScope, resolveSourceTokens } from "../../api";
import type { TestCase } from "../../api/types";
import { buildProjectIndexCached } from "./projectIndex";
import { collectModuleRelatedPaths } from "./relatedFilesFromTc";
import { resolveSeedCandidates } from "./tcSeedResolver";
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

  if (!candidates.length) {
    return {
      primary: null,
      related: [],
      reason: "Không có ứng viên path từ TC",
      usedAi: false,
      candidates: [],
      codeTokens: aiTokens,
    };
  }

  if (input.useAi === false) {
    return {
      primary: candidates[0],
      related: candidates.slice(1, 9),
      reason: seeds[0]?.reason ?? "Heuristic FE",
      usedAi: false,
      candidates,
      codeTokens: aiTokens,
    };
  }

  try {
    const ranked = await resolveSourceScope.run({
      projectId: input.projectId,
      testCaseId: input.testCase.id,
      candidates: candidates.slice(0, 60),
    });
    const prefix = aiTokens.length
      ? `VI→EN: ${aiTokens.slice(0, 6).join(", ")}${aiTokens.length > 6 ? "…" : ""}. `
      : "";
    return {
      primary: ranked.primary || candidates[0],
      related: ranked.related ?? [],
      reason: `${prefix}${ranked.reason || tokenReason || "AI xếp hạng"}`,
      usedAi: true,
      candidates,
      codeTokens: aiTokens,
    };
  } catch {
    return {
      primary: candidates[0],
      related: candidates.slice(1, 9),
      reason:
        aiTokens.length > 0
          ? `Token AI: ${aiTokens.slice(0, 6).join(", ")} · ${seeds[0]?.reason ?? "heuristic"}`
          : seeds[0]?.reason ?? "Heuristic FE (AI không sẵn sàng)",
      usedAi: aiTokens.length > 0,
      candidates,
      codeTokens: aiTokens,
    };
  }
}
