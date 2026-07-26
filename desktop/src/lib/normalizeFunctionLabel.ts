/** Gộp nhãn chức năng — 'Tạo+mới' và 'Tạo mới' cùng một tên hiển thị. */
export function normalizeFunctionLabel(raw: string | null | undefined): string {
  let t = (raw ?? "").trim();
  if (!t) return "";
  t = t.replace(/\+/g, " ");
  try {
    t = decodeURIComponent(t);
  } catch {
    /* giữ chuỗi sau bước + → space */
  }
  t = t.replace(/[\s_]+/g, " ").trim();
  return t;
}

export function functionMergeKey(display: string, unmoduledLabel: string): string {
  if (display === unmoduledLabel) return unmoduledLabel;
  const n = normalizeFunctionLabel(display);
  return n ? n.toLowerCase() : unmoduledLabel;
}
