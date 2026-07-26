/** Tên chức năng từ tên file — đồng bộ logic với BE disambiguate_feature_title */
export function featureTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  const stem = base.replace(/\+/g, " ").replace(/[\s_]+/g, " ").trim();
  return stem || "Chức năng";
}

/** Mỗi file SRS một title duy nhất (thêm tên file nếu trùng stem). */
export function assignFeatureTitles(parts: { fileName: string }[]): string[] {
  const used = new Set<string>();
  return parts.map((part) => {
    const base = featureTitleFromFileName(part.fileName);
    let title = base;
    const key = title.toLowerCase();
    if (used.has(key)) {
      const short = part.fileName.replace(/^.*[/\\]/, "");
      title = `${base} — ${short}`;
    }
    let n = 2;
    while (used.has(title.toLowerCase())) {
      title = `${base} (${n})`;
      n += 1;
    }
    used.add(title.toLowerCase());
    return title;
  });
}
