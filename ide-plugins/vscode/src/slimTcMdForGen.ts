/**
 * Phase 3 — Slim Approved TC MD before Gen prompt (drop dupes / noise).
 * Keep scenario SoT (Precondition / Steps / Expected / Test Data markers).
 * Drop YAML frontmatter + Meta table; keep one compact testCaseId line from frontmatter.
 */
export function slimTcMdForGen(md: string): string {
  let t = md || "";
  const identity: string[] = [];
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n*/m);
  if (fm?.[1]) {
    const pick = (key: string) => {
      const m = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
      return (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
    };
    const id = pick("testCaseId");
    const title = pick("title");
    if (id) identity.push(`testCaseId: ${id}`);
    if (title) identity.push(`title: ${title}`);
  }
  // YAML frontmatter
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/m, "");
  t = t.replace(/<!--\s*aitest:[\s\S]*?-->/gi, "");
  t = t.replace(
    /##\s*Grounding[^\n]*\n[\s\S]*?(?=\n##\s|\n---\s*\n|\Z)/gi,
    "\n"
  );
  // Meta table block (Field | Value)
  t = t.replace(/##\s*Meta[^\n]*\n+(?:\|[^\n]*\n)*/gi, "\n");
  t = t.replace(/^\s*\/\/\s*ruleHits=.*$/gim, "");
  t = t.replace(/^ruleHits:\s*.*$/gim, "");
  // Auto-enrich / confidence noise lines in Test Data
  t = t.replace(/^\s*\/\/\s*aitest:.*$/gim, "");
  t = t.replace(/^\s*<!--\s*aitest:.*$/gim, "");

  const lines = t.split("\n");
  const out: string[] = [];
  let inTestData = false;
  const seenStandalone = new Set<string>();
  for (const line of lines) {
    if (/^##\s*Test\s*Data/i.test(line)) {
      inTestData = true;
      out.push(line);
      continue;
    }
    if (/^##\s/.test(line) && inTestData) inTestData = false;
    if (!inTestData && /^(path|code|related|contract):\s*/i.test(line)) {
      const key = line.trim().toLowerCase();
      if (seenStandalone.has(key)) continue;
      seenStandalone.add(key);
    }
    // Inside Test Data: keep first path/code/related; drop duplicate marker lines
    if (inTestData && /^(path|code|related):\s*/i.test(line)) {
      const kind = (line.match(/^(path|code|related):/i)?.[1] || "").toLowerCase();
      const kindKey = `testdata:${kind}`;
      if (seenStandalone.has(kindKey)) continue;
      seenStandalone.add(kindKey);
    }
    out.push(line);
  }
  let body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (identity.length) {
    const missing = identity.filter((line) => {
      const key = line.split(":")[0]!.toLowerCase();
      return !new RegExp(`^${key}:\\s*\\S`, "im").test(body);
    });
    if (missing.length) body = `${missing.join("\n")}\n\n${body}`.trim();
  }
  return body;
}
