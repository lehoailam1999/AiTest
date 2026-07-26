/**
 * Round-0: caret boost only. Full IDE search runs via retrieveViaIdeCommands (P10).
 */
import type {
  BusinessIntent,
  ConfidenceReport,
  RetrievedFile,
} from "@aitest/ide-protocol";

export function buildRound0Retrieval(input: {
  intent: BusinessIntent;
  focus?: { file: string; symbol: string; method?: string } | null;
}): { retrieved: RetrievedFile[]; confidence: ConfidenceReport } {
  const retrieved: RetrievedFile[] = [];
  const candidates: ConfidenceReport["candidates"] = [];

  if (input.focus?.file) {
    const symbol = input.focus.method
      ? `${input.focus.symbol}.${input.focus.method}`
      : input.focus.symbol;
    const score = 0.88;
    retrieved.push({
      path: input.focus.file,
      role: "caret-boost",
      symbolIds: [symbol],
      score,
    });
    candidates.push({
      symbol,
      path: input.focus.file,
      score,
      rationale: "Caret / focus hiện tại trong IDE (boost)",
    });
  }

  for (const hint of input.intent.searchHints.slice(0, 4)) {
    if (candidates.some((c) => c.symbol === hint)) continue;
    candidates.push({
      symbol: hint,
      path: "(pending IDE search)",
      score: hint.toLowerCase().includes("service") ? 0.55 : 0.45,
      rationale: "Gợi ý intent — chờ searchSymbol (P10)",
    });
  }

  const overall =
    candidates.length > 0 ? Math.max(...candidates.map((c) => c.score)) : 0.35;

  // Round-0 alone is enough only with strong caret boost; search fills the rest
  const enough = overall >= 0.85 && retrieved.length > 0 && input.intent.searchHints.length === 0;
  const missingHints: string[] = [];
  if (input.intent.searchHints.length > 0) {
    missingHints.push("Chạy IDE search theo searchHints (Tiếp tục lấy context)");
  }
  if (!input.focus?.file) {
    missingHints.push("Đặt caret vào Service/Handler hoặc Connect IDE + search");
  }
  if (overall < 0.8) {
    missingHints.push("Độ tin cậy chưa đủ");
  }

  return {
    retrieved,
    confidence: {
      candidates: candidates.sort((a, b) => b.score - a.score),
      overall,
      enough,
      missingHints,
    },
  };
}
