/**
 * Parse Agent CLI E2E output → files under AItest/E2ETest (path jail).
 */
import { assertSafeAitestTargetRel, UNIT_GEN_LIMITS, type CodegenE2eItem, type CodegenFileDto, type CodegenFileKind } from "@aitest/ide-protocol";

export function classifyE2eFileKind(pathRel: string): CodegenFileKind {
  const p = (pathRel || "").replace(/\\/g, "/").toLowerCase();
  if (p.endsWith(".spec.ts") || p.includes("/specs/")) return "spec";
  if (p.endsWith(".page.ts") || p.includes("/pages/")) return "page";
  if (p.includes("playwright.config")) return "config";
  if (p.includes("/fixtures/") || /storagestate/i.test(p)) return "fixture";
  return "other";
}

export function e2eSharedPagesDir(suggestedSpecPath: string): string {
  const p = (suggestedSpecPath || "").replace(/\\/g, "/");
  const low = p.toLowerCase();
  const idx = low.indexOf("/e2etest/");
  const suite = idx >= 0 ? p.slice(0, idx + "/E2ETest".length) : "AItest/E2ETest";
  return `${suite}/_shared/pages`.replace(/\/+/g, "/");
}

/** Map CLI-relative path onto AItest/E2ETest jail. */
export function jailE2eOutputPath(raw: string, suggestedSpecPath: string): string {
  let p = (raw || "").replace(/\\/g, "/").replace(/^`+|`+$/g, "").trim();
  p = p.replace(/^FILE:\s*/i, "");
  // Strip absolute drive prefix (e.g. D:/Xlab/.../AItest/E2ETest/...)
  p = p.replace(/^[a-zA-Z]:\//, "/");
  p = p.replace(/^\/+/, "");
  // If the CLI returned a full absolute path, trim to AItest/ segment
  const aitestIdx = p.toLowerCase().indexOf("aitest/");
  if (aitestIdx > 0) {
    p = p.slice(aitestIdx);
  }
  // Remove . and .. segments that LLM might produce
  p = p.split("/").filter((s) => s && s !== "." && s !== "..").join("/");
  if (!p) throw new Error("Empty E2E output path");
  if (!/e2etest/i.test(`/${p}/`)) {
    const base = p.split("/").pop() || "file.ts";
    const specDir = (suggestedSpecPath || "AItest/E2ETest/specs/journey.spec.ts").replace(
      /\/[^/]+$/,
      ""
    );
    if (/\.spec\.ts$/i.test(base) || /\/specs\//i.test(p)) {
      p = `${specDir}/${base}`;
    } else if (/\.page\.ts$/i.test(base) || /\/pages\//i.test(p)) {
      p = `${e2eSharedPagesDir(suggestedSpecPath)}/${base}`;
    } else {
      p = `${specDir}/${base}`;
    }
  }
  const safe = assertSafeAitestTargetRel(p);
  if (!/\/e2etest\//i.test(`/${safe}/`)) {
    throw new Error(`Path jail E2E: thiếu segment E2ETest (got ${safe})`);
  }
  return safe;
}

export function parseE2eFilesFromRaw(raw: string, suggestedSpecPath: string): CodegenFileDto[] {
  const text = (raw || "").trim();
  if (!text) return [];

  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const data = JSON.parse(text.slice(start, end + 1)) as {
        files?: Array<{ path?: string; content?: string; kind?: string }>;
      };
      if (Array.isArray(data.files) && data.files.length) {
        const out: CodegenFileDto[] = [];
        for (const item of data.files) {
          const pathRel = String(item.path || "").trim();
          const content = String(item.content || "");
          if (!pathRel || !content.trim()) continue;
          const jailed = jailE2eOutputPath(pathRel, suggestedSpecPath);
          out.push({
            path: jailed,
            content,
            kind: (item.kind as CodegenFileKind) || classifyE2eFileKind(jailed),
          });
        }
        if (out.length) return out;
      }
    }
  } catch {
    /* fall through to FILE: fences */
  }

  const files: CodegenFileDto[] = [];
  const pattern =
    /(?:^|\n)\s*#{1,6}\s*FILE:\s*([^\n`]+)\s*\n\s*```(?:\w+)?\n(.*?)```/gis;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    const pathRel = m[1].trim().replace(/^`+|`+$/g, "");
    const content = (m[2] || "").trim();
    if (!pathRel || !content) continue;
    const jailed = jailE2eOutputPath(pathRel, suggestedSpecPath);
    files.push({ path: jailed, content, kind: classifyE2eFileKind(jailed) });
  }
  if (files.length) return files;

  const fence = text.match(/```(?:[\w.+-]*)\s*\n([\s\S]*?)```/);
  const code = (fence?.[1] || text).trim();
  if (!code) return [];
  const spec = jailE2eOutputPath(suggestedSpecPath || "specs/journey.spec.ts", suggestedSpecPath);
  return [{ path: spec, content: code, kind: "spec" }];
}

function slice(s: string, max: number): string {
  const t = s || "";
  if (t.length <= max) return t;
  return t.slice(0, max) + "\n/* …truncated… */";
}

export function buildE2eAgentPrompt(opts: {
  item: CodegenE2eItem;
  conventions: string;
  suggestedSpecPath: string;
}): string {
  const item = opts.item;
  const parts: string[] = [
    "You are generating Playwright TypeScript E2E tests for the open workspace (SUT).",
    "Write Spec + POM only. Do not invent AbsolutePath, roles, or locators not in the packet.",
    "Output ### FILE: <repo-relative-path> then a ts fence for each file.",
    "Hard requirements: every test.step must be on its own await line; never chain steps on one line.",
    "Hard requirements: if the UI shows VN datetime like HH:mm dd/MM/yyyy, do not use new Date(raw). Parse manually into Date(year, month - 1, day, hour, minute) and assert parsed.getTime() is not NaN before comparing.",
    "Hard requirements: keep canonical layout: spec under {Requirement}/{TC}/specs, shared POM under {Requirement}/_shared/pages, config under {Requirement}/{TC}/playwright.config.ts. Do not duplicate equivalent files across multiple folders for one TC run.",
    "",
    "## Project rules / e2e-conventions",
    slice(opts.conventions, UNIT_GEN_LIMITS.maxConventionsChars),
    "",
    "## Request",
    `Title: ${item.title}`,
    `Code: ${item.testCaseId}`,
    item.module ? `Module: ${item.module}` : "",
    item.requirementTitle ? `Requirement: ${item.requirementTitle}` : "",
    `Suggested spec: ${opts.suggestedSpecPath}`,
    item.featurePath ? `featurePath: ${item.featurePath}` : "",
    item.authRole ? `authRole: ${item.authRole}` : "",
    item.storageStateRel ? `storageStateRel: ${item.storageStateRel}` : "",
    "",
    "## Approved TC",
    item.testData ? `testData:\n${slice(item.testData, 4000)}` : "",
    item.steps ? `steps:\n${slice(item.steps, 4000)}` : "",
    item.expectedOutcome ? `expected:\n${slice(item.expectedOutcome, 2000)}` : "",
    item.executionContext ? `executionContext:\n${slice(item.executionContext, 1500)}` : "",
    "",
  ];
  if (item.sourceCode?.trim()) {
    parts.push(
      `## FE primary${item.sourceFileName ? ` (${item.sourceFileName})` : ""}`,
      "```",
      slice(item.sourceCode, UNIT_GEN_LIMITS.maxExcerptChars),
      "```",
      ""
    );
  }
  for (const rel of (item.relatedSources || []).slice(0, 4)) {
    if (!rel?.content?.trim()) continue;
    parts.push(
      `## FE related (${rel.path})`,
      "```",
      slice(rel.content, Math.floor(UNIT_GEN_LIMITS.maxExcerptChars * 0.5)),
      "```",
      ""
    );
  }
  if (item.locatorContract?.trim()) {
    parts.push("## locatorContract", slice(item.locatorContract, 4000), "");
  }
  if (item.pomScaffold?.trim()) {
    parts.push("## pomScaffold (method contract only)", slice(item.pomScaffold, 3000), "");
  }
  for (const f of (item.existingFiles || []).slice(0, 4)) {
    parts.push(`## Existing ${f.path}`, "```", slice(f.content || "", 3000), "```", "");
  }
  return parts.filter((l) => l !== undefined && l !== "").join("\n");
}
