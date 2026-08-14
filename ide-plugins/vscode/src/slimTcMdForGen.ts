/**
 * Phase 3 — Slim Approved TC MD before Gen prompt (drop dupes / noise).
 */
export function slimTcMdForGen(md: string): string {
  let t = md || "";
  t = t.replace(/<!--\s*aitest:grounding-contract[\s\S]*?-->/gi, "");
  t = t.replace(
    /##\s*Grounding[^\n]*\n[\s\S]*?(?=\n##\s|\n---\s*\n|\Z)/gi,
    "\n"
  );
  t = t.replace(/^\s*\/\/\s*ruleHits=.*$/gim, "");
  t = t.replace(/^ruleHits:\s*.*$/gim, "");

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
    out.push(line);
  }
  return out.join("\n").trim();
}
