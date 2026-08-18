/**
 * Desktop preflight for Unit Gen (IDE path) — fail-closed gates.
 * Phase 5: IDE + Approved MD + path:/code: markers before CLI.
 */
import {
  AI_TEST_CASES_DIR,
  extractTcSourceMarkers,
  hasUnitSourceMarkers,
  LEGACY_AI_TEST_CASES_DIR,
  UNIT_GEN_LIMITS,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { isIdeCodegenReady } from "../ideProtocol";
import { isTauri, listSourceFiles, readTextFile } from "../../tauri/bridge";
import { approvedTcMarkdownRelPath } from "../approvedTcSync/approvedTcMarkdown";
import { unitGroundingContractRelPath } from "../approvedTcSync/unitSourceGroundingContract";
import {
  isUnitGroundingFastPathEligible,
  parseUnitSourceGroundingContract,
} from "./groundingFastPath";
import {
  decideUnitGenGate,
  type UnitGenGateResult,
} from "./unitGenGates";

export type { UnitGenGateResult, UnitGenGateOk, UnitGenGateFail } from "./unitGenGates";

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/** Probe canonical `AItest/test-cases`, then legacy `.ai-test/test-cases`. */
export async function probeApprovedTcMd(
  projectRoot: string,
  tc: Pick<TestCase, "id" | "testCaseId" | "module" | "type">
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
    /* try legacy exact path, then walk */
  }

  const legacyExpected = expected.replace(
    new RegExp(`^${AI_TEST_CASES_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    LEGACY_AI_TEST_CASES_DIR
  );
  if (legacyExpected !== expected) {
    try {
      const body = await readTextFile(projectRoot, legacyExpected);
      if (body.trim()) {
        return {
          path: legacyExpected.replace(/\\/g, "/"),
          content: body,
        };
      }
    } catch {
      /* try walk */
    }
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
    if (
      !n.includes(`${AI_TEST_CASES_DIR.toLowerCase()}/`) &&
      !n.includes(`${LEGACY_AI_TEST_CASES_DIR.toLowerCase()}/`)
    ) {
      continue;
    }
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
    "id" | "testCaseId" | "module" | "title" | "testData" | "type"
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
  const mdContent = md?.content || "";
  const hasMarkers = hasUnitSourceMarkers(mdContent);
  const markers = extractTcSourceMarkers(mdContent);
  let contract: ReturnType<typeof parseUnitSourceGroundingContract> = null;
  if (md?.path) {
    try {
      const raw = await readTextFile(root, unitGroundingContractRelPath(md.path));
      contract = parseUnitSourceGroundingContract(raw);
    } catch {
      contract = null;
    }
  }
  const authoritative = Boolean(contract?.authoritative);
  const projectionsMatch = isUnitGroundingFastPathEligible(contract, markers);
  // The Approve refusal is the only text that tells the user what to fix.
  const refusal = contract?.refusalReasons?.[0];
  const decisionReason = !contract
    ? "Thiếu hoặc sai schema companion .grounding.json"
    : !contract.authoritative
      ? `IDE Approve ${contract.outcome || "NOT_READY"}` +
        (refusal ? `: ${refusal.code} — ${refusal.message}` : "")
      : !projectionsMatch
        ? "Quyết định IDE Approve không khớp projection path/code trong TC Markdown"
        : undefined;
  return decideUnitGenGate({
    isTauri: true,
    projectRoot: root,
    ideReady: true,
    mdPath: md?.path ?? null,
    tcLabel: label,
    hasSourceMarkers: hasMarkers,
    hasAuthoritativeDecision: authoritative,
    projectionsMatch,
    decisionReason,
  });
}

export { UNIT_GEN_LIMITS, decideUnitGenGate };
