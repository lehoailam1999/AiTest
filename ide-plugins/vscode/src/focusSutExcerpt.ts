/**
 * Phase 3 — Focus primary excerpt on resolved Type.Method when possible.
 */
function lineOfIndex(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findMatchingBraceClose(src: string, openBraceIndex: number): number {
  if (openBraceIndex < 0 || openBraceIndex >= src.length || src[openBraceIndex] !== "{") {
    return -1;
  }
  let depth = 1;
  for (let i = openBraceIndex + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function methodBodyEndLine(src: string, sigStart: number): number | undefined {
  let i = sigStart;
  while (i < src.length && src[i] !== "(") i++;
  if (i >= src.length) return undefined;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  while (i < src.length && /\s/.test(src[i]!)) i++;
  while (i < src.length && src[i] !== "{" && !(src[i] === "=" && src[i + 1] === ">")) {
    if (src[i] === ";") return undefined;
    i++;
    if (i - sigStart > 800) return undefined;
  }
  if (src[i] === "{") {
    const close = findMatchingBraceClose(src, i);
    if (close < 0) return undefined;
    return lineOfIndex(src, close);
  }
  return undefined;
}

function sliceByLines(src: string, startLine: number, endLine: number, pad = 3): string {
  const lines = src.split(/\r?\n/);
  const from = Math.max(1, startLine - pad);
  const to = Math.min(lines.length, endLine + pad);
  return lines.slice(from - 1, to).join("\n");
}

export function focusSutExcerpt(
  source: string,
  codeMarker?: string | null,
  maxChars?: number
): string {
  const body = source || "";
  const lim = maxChars ?? 8000;
  if (!body.trim() || !codeMarker?.includes(".")) {
    return body.length > lim ? body.slice(0, lim) + "\n/* …truncated… */" : body;
  }
  const [typeName, methodName] = codeMarker.split(".").map((s) => s.trim());
  if (!typeName || !methodName) return body;

  const sigRe = new RegExp(
    `(?:^|[\\s{;])(?:public|private|protected|internal|static|async|virtual|override|\\s)+[\\w<>,\\s\\[\\]?]+\\s+${methodName}\\s*\\(`,
    "m"
  );
  const m = sigRe.exec(body);
  if (!m || m.index == null) {
    return body.length > lim ? body.slice(0, lim) + "\n/* …truncated… */" : body;
  }
  const startLine = lineOfIndex(body, m.index);
  const endLine = methodBodyEndLine(body, m.index) ?? startLine + 80;
  let focused = sliceByLines(body, startLine, endLine);
  if (focused.length > lim) focused = focused.slice(0, lim) + "\n/* …truncated… */";
  return focused;
}
