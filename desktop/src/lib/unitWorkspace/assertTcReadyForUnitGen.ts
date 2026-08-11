/**
 * Desktop preflight for Unit Gen (IDE path) — fail-closed gates.
 * Phase 5: IDE + Approved MD + path:/code: markers before CLI.
 */
import {
  hasUnitSourceMarkers,
  isUnitSutResolveSkipped,
  UNIT_GEN_LIMITS,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { isIdeCodegenReady } from "../ideProtocol";
import { isTauri, listSourceFiles, readTextFile } from "../../tauri/bridge";
import { approvedTcMarkdownRelPath } from "../approvedTcSync/approvedTcMarkdown";
import {
  decideUnitGenGate,
  type UnitGenGateResult,
} from "./unitGenGates";

export type { UnitGenGateResult, UnitGenGateOk, UnitGenGateFail } from "./unitGenGates";

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/** Probe Approved TC MD under .ai-test/test-cases/{module}/{code}.md (or walk). */
export async function probeApprovedTcMd(
  projectRoot: string,
  tc: Pick<TestCase, "id" | "testCaseId" | "module">
): Promise<{ path: string; content: string } | null> {
  if (!projectRoot || !isTauri()) return null;
  const codes = [
    (tc.testCaseId || "").trim(),
    (tc.id || "").trim(),
  ].filter(Boolean);
  if (!codes.length) return null;

  const expected = approvedTcMarkdownRelPath(tc);
  try {
    const body = await readTextFile(projectRoot, expected);
    if (body.trim()) {
      return { path: expected.replace(/\\/g, "/"), content: body };
    }
  } catch {
    /* try walk */
  }

  let listed: string[] = [];
  try {
    listed = await listSourceFiles(projectRoot, [".md"]);
  } catch {
    listed = [];
  }
  const want = codes.map((c) => `${c}.md`.toLowerCase());
  for (const rel of listed) {
    const n = norm(rel);
    if (!n.includes(".ai-test/test-cases/")) continue;
    const base = n.split("/").pop() || "";
    if (want.includes(base)) {
      try {
        const content = await readTextFile(projectRoot, rel);
        return { path: rel.replace(/\\/g, "/"), content };
      } catch {
        return { path: rel.replace(/\\/g, "/"), content: "" };
      }
    }
  }
  return null;
}

/**
 * Hard gates before Extension Unit Gen.
 * Order: Desktop Tauri → Connect IDE → Approved TC MD → path:/code: (Phase 5).
 */
export async function assertTcReadyForUnitGen(opts: {
  projectRoot: string | null | undefined;
  tc: Pick<
    TestCase,
    "id" | "testCaseId" | "module" | "title" | "testData"
  >;
}): Promise<UnitGenGateResult> {
  const label = opts.tc.testCaseId || opts.tc.title;
  if (!isTauri()) {
    return decideUnitGenGate({
      isTauri: false,
      projectRoot: opts.projectRoot,
      ideReady: false,
      mdPath: null,
      tcLabel: label,
    });
  }
  const root = (opts.projectRoot || "").trim();
  if (!root) {
    return decideUnitGenGate({
      isTauri: true,
      projectRoot: root,
      ideReady: false,
      mdPath: null,
      tcLabel: label,
    });
  }
  if (!isIdeCodegenReady()) {
    return decideUnitGenGate({
      isTauri: true,
      projectRoot: root,
      ideReady: false,
      mdPath: null,
      tcLabel: label,
    });
  }
  const md = await probeApprovedTcMd(root, opts.tc);
  // MD markers win when present; else fall back to DB Test Data
  const mdHas = hasUnitSourceMarkers(md?.content || "");
  const dbHas = hasUnitSourceMarkers(opts.tc.testData || "");
  const hasMarkers = mdHas || dbHas;
  const markerBlob = mdHas
    ? md?.content || ""
    : [md?.content || "", opts.tc.testData || ""].join("\n");
  const skipped = isUnitSutResolveSkipped(markerBlob) && !hasMarkers;
  return decideUnitGenGate({
    isTauri: true,
    projectRoot: root,
    ideReady: true,
    mdPath: md?.path ?? null,
    tcLabel: label,
    hasSourceMarkers: hasMarkers,
    sutResolveSkipped: skipped,
  });
}

export { UNIT_GEN_LIMITS, decideUnitGenGate };
