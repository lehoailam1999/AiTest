import { requirements } from "../api";
import type { RequirementTopic } from "../api/types";
import { normalizeFunctionLabel } from "./normalizeFunctionLabel";

function topicsFromFeatureSources(
  featureRows: {
    sourceType?: string;
    content?: string | null;
    title?: string | null;
    fileName?: string | null;
  }[],
  syncedTopics: RequirementTopic[]
): RequirementTopic[] {
  const byTitle = new Map(
    syncedTopics.map((t) => [normalizeFunctionLabel(t.title).toLowerCase(), t])
  );
  return featureRows.map((s, i) => {
    const title =
      normalizeFunctionLabel(s.title ?? s.fileName ?? "") || `Chức năng ${i + 1}`;
    const key = title.toLowerCase();
    const existing = byTitle.get(key);
    if (existing) return existing;
    return {
      id: `fanout-${i}-${key}`,
      title,
      notes: s.fileName ? `Từ tài liệu: ${s.fileName}` : "",
      items: [],
    };
  });
}

/**
 * Danh sách chủ đề để fan-out 1 job / chức năng khi sinh TC toàn hệ thống.
 * Ưu tiên số file Feature trong requirement (sources) — không chỉ đếm topics (có thể gộp trùng tên).
 */
export async function resolveTopicsForSystemFanOut(
  requirementId: string
): Promise<RequirementTopic[]> {
  const detail = await requirements.get(requirementId);
  const featureRows = (detail.sources ?? []).filter(
    (s) =>
      (s.sourceType === "Feature" || s.sourceType === "feature") &&
      (s.content ?? "").trim()
  );

  const { topics: synced } = await requirements.getTopics(requirementId);
  const list = synced.filter((t) => t.title.trim());

  if (featureRows.length > 1) {
    return topicsFromFeatureSources(featureRows, list);
  }

  if (list.length > 1) return list;

  if ((detail.featureCount ?? 0) > 1 && list.length <= 1) {
    const { topics: retry } = await requirements.getTopics(requirementId);
    const retryList = retry.filter((t) => t.title.trim());
    if (retryList.length > 1) return retryList;
  }

  return list;
}
