/**
 * Mirror of api strip_code_fences — drop CLI narration before real source.
 * Defense-in-depth when writing Unit/E2E staging files on Desktop.
 */

const FENCE_RE =
  /```(?:csharp|cs|typescript|tsx|javascript|js|python|py|go|rust|java|kotlin|[\w+-]*)?\s*\n?([\s\S]*?)```/gi;

const OPEN_FENCE_RE =
  /```(?:csharp|cs|typescript|tsx|javascript|js|python|py|go|rust|java|kotlin|[\w+-]*)?\s*\n?/i;

const CODE_LINE_START =
  /^(?:\/\/\/?\s*<reference|import\s|export\s|const\s|let\s|var\s|function\s|class\s|interface\s|type\s|enum\s|describe\s*\(|it\s*\(|test\s*\(|package\s|using\s|from\s+\S+\s+import|def\s|async\s+def\s|@\w+|#!\/|"use strict"|'use strict')/m;

function dropLeadingNarration(text: string): string {
  const t = (text || "").trim();
  if (!t) return t;
  const m = CODE_LINE_START.exec(t);
  if (!m || m.index === 0) return t;
  const head = t.slice(0, m.index);
  if (head.length < 24) return t;
  if (/[A-Za-zÀ-ỹ]{2,}\s+[A-Za-zÀ-ỹ]{2,}/.test(head) || head.includes("```")) {
    return t.slice(m.index).trim();
  }
  return t;
}

export function stripCodeFences(raw: string): string {
  let text = (raw || "").trim();
  if (!text) return text;

  const bodies: string[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const body = (m[1] || "").trim();
    if (body) bodies.push(body);
  }
  if (bodies.length) {
    const best = bodies.reduce((a, b) => (b.length > a.length ? b : a));
    return dropLeadingNarration(best);
  }

  const open = OPEN_FENCE_RE.exec(text);
  if (open && open.index != null) {
    let body = text.slice(open.index + open[0].length);
    const end = body.lastIndexOf("```");
    if (end >= 0) body = body.slice(0, end);
    body = body.trim();
    if (body) return dropLeadingNarration(body);
  }

  if (text.startsWith("```")) {
    text = text.replace(/^```[\w+-]*\s*\n?/, "");
    const end = text.lastIndexOf("```");
    if (end >= 0) text = text.slice(0, end);
    return dropLeadingNarration(text.trim());
  }

  return dropLeadingNarration(text);
}
