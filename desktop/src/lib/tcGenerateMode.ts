/** API job mode — append giữ TC cũ; replace xoá Draft trong phạm vi rồi sinh mới */
export type TcGenerateMode = "append" | "replace";

export type TcGenerateModeOption = {
  value: TcGenerateMode;
  label: string;
  hint: string;
  recommended?: boolean;
};

export const TC_GENERATE_MODE_OPTIONS: TcGenerateModeOption[] = [
  {
    value: "append",
    label: "Thêm TC mới",
    hint: "Giữ mọi TC hiện có (kể cả đã duyệt). AI chỉ thêm bản nháp mới, trùng tiêu đề/bước sẽ bỏ qua.",
    recommended: true,
  },
  {
    value: "replace",
    label: "Làm mới bản nháp",
    hint: "Xóa TC đang ở trạng thái Nháp trong phạm vi bạn chọn, rồi sinh lại. TC đã Submit / Approved không bị xóa.",
  },
];

export function tcGenerateModeLabel(mode: TcGenerateMode): string {
  return TC_GENERATE_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

export function tcGenerateModeSummary(
  mode: TcGenerateMode,
  draftCount: number | null,
  scopeLabel: string
): string {
  if (mode === "append") {
    return draftCount != null && draftCount > 0
      ? `Thêm TC mới (hiện có ${draftCount} nháp trong phạm vi)`
      : "Thêm TC mới";
  }
  if (draftCount === 0) return "Làm mới bản nháp (không có nháp để xóa)";
  if (draftCount != null && draftCount > 0) {
    return `Làm mới bản nháp — sẽ xóa ${draftCount} TC nháp (${scopeLabel})`;
  }
  return "Làm mới bản nháp";
}
