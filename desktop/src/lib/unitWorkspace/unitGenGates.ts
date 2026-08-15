/**
 * Pure Unit Gen preflight decisions (Node-testable).
 * Phase 5: after IDE + Approved MD, require path:+code: before CLI.
 */
import { isUnitTcBlockedForGen } from "./parseUnitTcMarkers.ts";
export type UnitGenGateOk = { ok: true; mdPath?: string };
export type UnitGenGateFail = {
  ok: false;
  code:
    | "no_tauri"
    | "no_ide"
    | "no_sync_md"
    | "no_root"
    | "needs_marker"
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
        "FAIL_NEEDS_LANGUAGE — repo có cả C# và TS/JS. Chọn Language (C# hoặc TypeScript) trước khi Gen Unit để map đúng source.",
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
  /**
   * Phase 5 — when false, block Gen (missing path:/code:).
   * Omit / undefined → skip marker check (legacy callers).
   */
  hasSourceMarkers?: boolean;
  /** Approve wrote sut-resolve skipped without markers. */
  sutResolveSkipped?: boolean;
  /** Test Data + MD blob for NOT_READY / VALIDATION IR gate. */
  markerBlob?: string | null;
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
        `Thiếu TC markdown cho «${input.tcLabel}» dưới .ai-test/test-cases/. ` +
        `Duyệt (Approve) TC trước khi Gen — file MD được ghi khi duyệt.`,
      cta: "sync_md",
    };
  }
  // Preserve precise IR / Approve refusal before collapsing to missing markers.
  const block = isUnitTcBlockedForGen(input.markerBlob);
  if (block.blocked) {
    return {
      ok: false,
      code: "not_ready",
      message: `${block.reason} — «${input.tcLabel}». Sửa TC IR / Re-gen / Re-Approve trước khi Gen.`,
      cta: "sync_md",
    };
  }
  const skipCode = String(input.markerBlob || "").match(
    /(?:sut-resolve\s+skipped|FAIL)[^ \n:—]*[:\s—-]+.*?\b(FAIL_FIELD_UNBOUND|FAIL_OP_CONTRADICT|FAIL_FEATURE_GAP)\b/i
  )?.[1] ||
    String(input.markerBlob || "").match(
      /\b(FAIL_FIELD_UNBOUND|FAIL_OP_CONTRADICT|FAIL_FEATURE_GAP)\b/i
    )?.[1];
  if (input.sutResolveSkipped && skipCode) {
    return {
      ok: false,
      code: "not_ready",
      message:
        `${skipCode.toUpperCase()} — Approve đã từ chối writeBack cho «${input.tcLabel}». ` +
        `Sửa aliases/intent hoặc BE behavior rồi Re-Approve.`,
      cta: "sync_md",
    };
  }

  // Phase 5: truly missing markers, or unclassified Approve skip-note
  if (
    input.hasSourceMarkers === false ||
    (input.sutResolveSkipped === true && input.hasSourceMarkers !== true)
  ) {
    return {
      ok: false,
      code: "needs_marker",
      message:
        `FAIL_NEEDS_MARKER — «${input.tcLabel}» chưa có path: + code: đáng tin. ` +
        `Approve lại (Connect IDE + index) hoặc thêm path:/code: thủ công vào Test Data, rồi Gen.`,
      cta: "sync_md",
    };
  }
  return { ok: true, mdPath: input.mdPath };
}
