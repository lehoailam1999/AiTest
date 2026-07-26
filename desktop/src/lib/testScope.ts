import { normalizeFunctionLabel } from "./normalizeFunctionLabel";

export type TestArtifactKind = "tc" | "unit" | "api" | "integration";

export type ScopeLevel = "system" | "module" | "feature";

export const SCOPE_LABELS: Record<ScopeLevel, string> = {
  system: "Tất cả chức năng trong requirement",
  module: "Một chức năng (module)",
  feature: "Theo chức năng (1 TC)",
};

/** Mô tả ngắn cho màn Sinh TC */
export const SCOPE_HINTS: Record<ScopeLevel, string> = {
  system:
    "Khuyến nghị khi có nhiều file SRS — hệ thống sinh lần lượt từng chức năng (mỗi file một lượt AI).",
  module: "Chỉ sinh TC cho một chủ đề đã chọn — dùng khi bổ sung hoặc khi vào từ bảng Coverage.",
  feature: "Sinh hoặc chỉnh một test case cụ thể (nâng cao).",
};

export const KIND_LABELS: Record<TestArtifactKind, string> = {
  tc: "Test case (Phase 1)",
  unit: "Unit test (Phase 2)",
  api: "API test (Phase 2)",
  integration: "Integration test (Phase 2)",
};

export function parseHubSearchParams(search: URLSearchParams): {
  phase: 1 | 2;
  kind: TestArtifactKind;
  scope: ScopeLevel;
  requirementId?: string;
  module?: string;
  testCaseId?: string;
} {
  const phaseRaw = search.get("phase");
  const kindRaw = search.get("kind");
  const artifact = search.get("artifact");

  let phase: 1 | 2 = phaseRaw === "2" ? 2 : 1;
  let kind: TestArtifactKind = "tc";

  if (phase === 2 || kindRaw === "unit" || kindRaw === "api") {
    phase = 2;
    kind = kindRaw === "api" || artifact === "api" ? "api" : "unit";
  } else if (kindRaw === "tc" || phaseRaw === "1" || search.get("requirementId")) {
    phase = 1;
    kind = "tc";
  }

  const scopeRaw = search.get("scope");
  const moduleRaw = search.get("module") ?? undefined;
  const module = moduleRaw ? normalizeFunctionLabel(moduleRaw) : undefined;
  const scope: ScopeLevel =
    module || scopeRaw === "module"
      ? "module"
      : scopeRaw === "feature"
        ? "feature"
        : "system";
  return {
    phase,
    kind,
    scope,
    requirementId: search.get("requirementId") ?? undefined,
    module,
    testCaseId: search.get("testCaseId") ?? undefined,
  };
}

/** Workspace artifact kind for verify/apply (unit vs api). */
export function workspaceArtifactKind(kind: TestArtifactKind): "unit" | "api" {
  return kind === "api" ? "api" : "unit";
}
