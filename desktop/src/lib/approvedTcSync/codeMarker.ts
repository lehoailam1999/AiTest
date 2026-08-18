/** Parse a projected `code:` marker — `Type` or `Type.Method`. */
export function parseCodeMarker(code: string): {
  typeName: string;
  methodName?: string;
} {
  const raw = String(code || "").trim();
  if (!raw) return { typeName: "" };
  const match =
    /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  return match
    ? { typeName: match[1]!, methodName: match[2]! }
    : { typeName: raw };
}
