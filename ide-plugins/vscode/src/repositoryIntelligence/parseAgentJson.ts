/**
 * Streamed agent output repeats the same answer as it grows, so the text often
 * holds several concatenated copies of one JSON object. Slicing from the first
 * brace to the last one therefore spans two copies and never parses; the object
 * has to be scanned with balanced braces instead.
 */
const MAX_SCAN_CHARS = 200_000;

/** Index of the brace closing the object that opens at `from`, or -1. */
function matchingBrace(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function extractJsonObjects(raw: string): unknown[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced || raw).slice(0, MAX_SCAN_CHARS);
  const out: unknown[] = [];
  // Each opening brace is tried independently. A copy truncated mid-string
  // would otherwise desynchronise the quote state and hide every later copy.
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "{") continue;
    const end = matchingBrace(text, index);
    if (end < 0) continue;
    try {
      out.push(JSON.parse(text.slice(index, end + 1)));
      index = end;
    } catch {
      // Not a complete object at this position; keep looking.
    }
  }
  return out;
}

/** The richest object the agent emitted, preferring later, more complete copies. */
export function lastJsonObject(raw: string): Record<string, unknown> | null {
  const objects = extractJsonObjects(raw).filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value)
  );
  return objects.length ? objects[objects.length - 1] : null;
}
