/**
 * Pure Unit Gen preflight decisions (Node-testable).
 * Gen is consume-only: require an authoritative IDE Approve decision and its
 * matching MD projection before CLI.
 */
export type UnitGenGateOk = { ok: true; mdPath?: string };
export type UnitGenGateFail = {
  ok: false;
  code:
    | "no_tauri"
    | "no_ide"
    | "no_sync_md"
    | "no_root"
    | "missing_decision"
    | "projection_mismatch"
    | "needs_language"
    | "not_ready";
  message: string;
  cta?: "connect_ide" | "sync_md";
};
export type UnitGenGateResult = UnitGenGateOk | UnitGenGateFail;

/**
 * Mixed C#+TS monorepo without explicit Language → fail-closed (avoid FE latch).
 */
export function decideUnitLanguageGate(input: {
  language: string | null | undefined;
  sourcePaths?: string[] | null;
}): UnitGenGateResult | { ok: true } {
  const lang = (input.language || "").trim();
  if (lang) return { ok: true };
  const paths = input.sourcePaths || [];
  if (!paths.length) return { ok: true };
  const hasCs = paths.some((p) => /\.cs$/i.test(p));
  const hasJsTs = paths.some(
    (p) =>
      /\.(tsx?|jsx?)$/i.test(p) &&
      !/node_modules|\/dist\/|\\dist\\/i.test(p)
  );
  if (hasCs && hasJsTs) {
    return {
      ok: false,
      code: "needs_language",
      message:
        "Repo có cả C# và TS/JS. Chọn Language (C# hoặc TypeScript) trước khi Gen Unit.",
    };
  }
  return { ok: true };
}

export function decideUnitGenGate(input: {
  isTauri: boolean;
  projectRoot: string | null | undefined;
  ideReady: boolean;
  mdPath: string | null;
  tcLabel: string;
  /** The companion `.grounding.json` passed authoritative decision validation. */
  hasAuthoritativeDecision?: boolean;
  /** Precise validation reason for a missing/stale/non-authoritative decision. */
  decisionReason?: string;
  /** MD path/code projections agree with the authoritative decision. */
  projectionsMatch?: boolean;
  hasSourceMarkers?: boolean;
}): UnitGenGateResult {
  if (!input.isTauri) {
    return {
      ok: false,
      code: "no_tauri",
      message: "Cần AITest Desktop (Tauri) + thư mục local project để Gen Unit.",
    };
  }
  const root = (input.projectRoot || "").trim();
  if (!root) {
    return {
      ok: false,
      code: "no_root",
      message: "Chưa gắn source root dự án. Mở Dự án → chọn thư mục SUT.",
    };
  }
  if (!input.ideReady) {
    return {
      ok: false,
      code: "no_ide",
      message:
        "Connect IDE bắt buộc trước Gen Unit. Mở Dự án → Sửa dự án → Connect IDE (Cursor/VS Code + extension AITest).",
      cta: "connect_ide",
    };
  }
  if (!input.mdPath) {
    return {
      ok: false,
      code: "no_sync_md",
      message:
        `Thiếu TC markdown cho «${input.tcLabel}» dưới AItest/test-cases/. ` +
        `Duyệt (Approve) TC trước khi Gen — file MD được ghi khi duyệt.`,
      cta: "sync_md",
    };
  }
  if (input.hasAuthoritativeDecision !== true) {
    return {
      ok: false,
      code: "missing_decision",
      message:
        `${input.decisionReason || "Thiếu quyết định IDE Approve authoritative"} — ` +
        `«${input.tcLabel}». Re-Approve trước khi Gen.`,
      cta: "sync_md",
    };
  }
  if (input.hasSourceMarkers !== true || input.projectionsMatch !== true) {
    return {
      ok: false,
      code: "projection_mismatch",
      message:
        `TC Markdown của «${input.tcLabel}» không khớp primary trong quyết định IDE Approve. ` +
        "Re-Approve để đồng bộ lại projection path/code.",
      cta: "sync_md",
    };
  }
  return { ok: true, mdPath: input.mdPath };
}
