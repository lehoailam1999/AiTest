import type { TestCase } from "../../api/types";
import { extractMatchTokens, stripDiacritics } from "./tcSeedResolver";

const PATH_RE =
  /(?:[\w.@-]+\/)+[\w.@-]+\.(?:cs|ts|tsx|js|jsx|py|java|kt|go|rs|vb)\b/gi;

/** Trích đường dẫn file được nhắc trong nội dung TC (steps / data / precondition). */
export function extractPathsMentionedInTc(tc: TestCase): string[] {
  const blob = [tc.steps, tc.expectedResult, tc.precondition ?? "", tc.testData ?? "", tc.title]
    .join("\n");
  const found = blob.match(PATH_RE) ?? [];
  const normed = found.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
  return [...new Set(normed)];
}

function pathMatchesMention(pathRel: string, mention: string): boolean {
  const a = pathRel.replace(/\\/g, "/").toLowerCase();
  const b = mention.replace(/\\/g, "/").toLowerCase();
  return a === b || a.endsWith(`/${b}`) || a.endsWith(b) || b.endsWith(a);
}

/** Map mention trong TC → pathRel thật trong index. */
export function resolveMentionedPaths(
  mentions: string[],
  allPaths: string[]
): string[] {
  const out: string[] = [];
  const normalized = allPaths.map((p) => p.replace(/\\/g, "/"));
  for (const m of mentions) {
    const hit = normalized.find((p) => pathMatchesMention(p, m));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Thu thập file cùng module/folder với seed — đọc local rộng hơn (không lưu DB).
 */
export function collectModuleRelatedPaths(input: {
  seedPathRel: string;
  moduleName?: string | null;
  allPaths: string[];
  maxFiles: number;
}): string[] {
  const seed = input.seedPathRel.replace(/\\/g, "/");
  const seedDir = seed.includes("/") ? seed.slice(0, seed.lastIndexOf("/")) : "";
  const tokens = extractMatchTokens(input.moduleName ?? "");
  const tokenKeys = tokens.map((t) => stripDiacritics(t).toLowerCase()).filter((t) => t.length >= 3);

  const scored: { path: string; score: number }[] = [];
  for (const raw of input.allPaths) {
    const path = raw.replace(/\\/g, "/");
    if (path === seed) continue;
    if (
      /\.(test|spec)\./i.test(path) ||
      /\/(test|tests|spec|__tests__|AItest|UnitTest|IntegrationTest|APITest|E2ETest|ApiTest)\//i.test(
        path
      )
    ) {
      continue;
    }
    let score = 0;
    if (seedDir && path.startsWith(`${seedDir}/`)) score += 40;
    else if (seedDir) {
      const parent = seedDir.includes("/") ? seedDir.slice(0, seedDir.lastIndexOf("/")) : "";
      if (parent && path.startsWith(`${parent}/`)) score += 18;
    }
    const lower = path.toLowerCase();
    for (const t of tokenKeys) {
      if (lower.includes(t)) score += 12;
    }
    if (score > 0) scored.push({ path, score });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, input.maxFiles).map((x) => x.path);
}
