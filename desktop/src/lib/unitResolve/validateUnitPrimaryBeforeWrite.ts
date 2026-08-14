/**
 * Layer 3 — Validate Unit primary before writeBack.
 * Checks index file, moduleGate, CRUD/verb contradict, symbol in symbolsByFile,
 * optional excerpt presence. Does not change ranking. No product nouns.
 *
 * Freshness (contentHash vs disk) = Layer 4 → `checkIndexFileFreshness`.
 */
import {
  pathContradictsCrudVerb,
  pathContradictsReadGetVerb,
  pathContradictsSearchVerb,
  pathContradictsUploadVerb,
  type UnitIntent,
} from "@aitest/ide-protocol";
import type { CodeIndexSnapshot } from "../codeIndex/types";
import { parseCodeMarker } from "../approvedTcSync/progressiveSeedFromCodeIndex";
import { behaviorEvidenceInExcerpt } from "./behaviorEvidenceInExcerpt";

export type ValidateUnitPrimaryBeforeWriteInput = {
  codeIndex: CodeIndexSnapshot;
  pathRel: string;
  /** `code:` marker — Type or Type.Method */
  code: string | null | undefined;
  moduleGated: boolean;
  intent: UnitIntent;
  shapeBlob: string;
  source?: "index.db" | "path-index" | "llm-shortlist";
  /**
   * When provided (including ""): non-empty required.
   * Omit when no excerpt was opened (soft path without body-rule).
   */
  excerpt?: string | null;
  /** Test Data markers for behavior-in-excerpt (VALIDATION body-rule). */
  testData?: string | null;
};

export type ValidateUnitPrimaryBeforeWriteResult = {
  ok: boolean;
  skipReason?: string;
  /** Passed check ids for notes / MD */
  checks: string[];
};

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveIndexPath(
  snap: CodeIndexSnapshot,
  pathRel: string
): string | null {
  const want = normPath(pathRel);
  if (!want) return null;
  if (snap.files[want]) return want;
  const low = want.toLowerCase();
  for (const k of Object.keys(snap.files || {})) {
    if (normPath(k).toLowerCase() === low) return k;
  }
  return null;
}

function fileStem(pathRel: string): string {
  const base = normPath(pathRel).split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "") || "";
}

/**
 * Fail-closed checks before syncing path:/code: markers.
 */
export function validateUnitPrimaryBeforeWrite(
  input: ValidateUnitPrimaryBeforeWriteInput
): ValidateUnitPrimaryBeforeWriteResult {
  const checks: string[] = [];
  const pathKey = resolveIndexPath(input.codeIndex, input.pathRel);
  if (!pathKey) {
    return {
      ok: false,
      skipReason: "FAIL_VALIDATE — path not in index.db",
      checks,
    };
  }
  checks.push("indexFile");

  if (!input.moduleGated && input.source !== "llm-shortlist") {
    return {
      ok: false,
      skipReason: "FAIL_VALIDATE — moduleGate required before write",
      checks,
    };
  }
  checks.push("moduleGate");

  const shape = input.shapeBlob || "";
  if (
    pathContradictsUploadVerb(pathKey, input.intent, shape) ||
    pathContradictsSearchVerb(pathKey, input.intent, shape) ||
    pathContradictsReadGetVerb(pathKey, input.intent, shape) ||
    pathContradictsCrudVerb(pathKey, input.intent, shape)
  ) {
    return {
      ok: false,
      skipReason: "FAIL_VALIDATE — path contradicts CRUD/op verb",
      checks,
    };
  }
  checks.push("crudVerb");

  const rawCode = String(input.code || "").trim() || fileStem(pathKey);
  const { typeName, methodName } = parseCodeMarker(rawCode);
  if (!typeName) {
    return {
      ok: false,
      skipReason: "FAIL_VALIDATE — empty code marker",
      checks,
    };
  }

  const symbols = input.codeIndex.symbolsByFile[pathKey] || [];
  const typeLow = typeName.toLowerCase();
  const typeInSymbols = symbols.some(
    (s) => s.name.toLowerCase() === typeLow && s.kind !== "method"
  );
  const anyNameHit = symbols.some((s) => s.name.toLowerCase() === typeLow);
  const stemOk = fileStem(pathKey).toLowerCase() === typeLow;

  if (!typeInSymbols && !anyNameHit && !stemOk) {
    return {
      ok: false,
      skipReason: `FAIL_VALIDATE — code «${typeName}» not in symbolsByFile`,
      checks,
    };
  }
  checks.push(typeInSymbols || anyNameHit ? "symbolType" : "symbolStem");

  if (methodName) {
    const mLow = methodName.toLowerCase();
    const methodHit = symbols.some(
      (s) =>
        s.kind === "method" &&
        s.name.toLowerCase() === mLow &&
        (!s.parent || s.parent.toLowerCase() === typeLow)
    );
    // Lightweight snapshots often omit methods — soft pass if type/stem ok
    checks.push(methodHit ? "symbolMethod" : "methodSoft");
  }

  if (input.excerpt !== undefined && input.excerpt !== null) {
    if (!String(input.excerpt).trim()) {
      return {
        ok: false,
        skipReason: "FAIL_VALIDATE — excerpt empty for primary path",
        checks,
      };
    }
    checks.push("excerpt");
    const tcBlob = [input.testData || "", input.shapeBlob || ""].join("\n");
    const beh = behaviorEvidenceInExcerpt(tcBlob, String(input.excerpt));
    if (!beh.ok) {
      return {
        ok: false,
        skipReason: beh.skipReason || "FAIL_VALIDATE — behavior not in excerpt",
        checks: [...checks, "behaviorExcerpt"],
      };
    }
    checks.push("behaviorExcerpt");
  }

  return { ok: true, checks };
}
