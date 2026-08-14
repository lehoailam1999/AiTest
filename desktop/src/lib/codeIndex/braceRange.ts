/**
 * Best-effort brace body end line for lightweight indexers (TS/CS regex parsers).
 * Optional — missing endLine is valid for expression-bodied / abstract members.
 */

export function lineOfIndex(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Index of matching `}` for `{` at openBraceIndex, or -1. */
export function findMatchingBraceClose(src: string, openBraceIndex: number): number {
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

/** Inclusive 1-based end line of brace body starting at `{`, or undefined. */
export function endLineOfBraceBody(
  src: string,
  openBraceIndex: number
): number | undefined {
  const close = findMatchingBraceClose(src, openBraceIndex);
  if (close < 0) return undefined;
  return lineOfIndex(src, close);
}

/**
 * From method/ctor signature start (name or leading modifiers), find `{` after
 * parameter list and return inclusive endLine — or undefined for `=>` / abstract.
 */
export function methodBodyEndLine(src: string, sigStart: number): number | undefined {
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
  // Skip where/constraints lightly until { or =>
  while (i < src.length && src[i] !== "{" && !(src[i] === "=" && src[i + 1] === ">")) {
    // stop at `;` (abstract / interface)
    if (src[i] === ";") return undefined;
    i++;
    if (i - sigStart > 800) return undefined;
  }
  if (src[i] === "{") return endLineOfBraceBody(src, i);
  return undefined;
}
