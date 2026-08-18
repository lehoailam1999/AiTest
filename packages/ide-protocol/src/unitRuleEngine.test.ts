/**
 * Phase 3 — Unit Rule Engine SoT smoke tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNIT_PROMPT_RULES_CORE,
  UNIT_RANK_POLICY,
  UNIT_GEN_LIMITS,
  UNIT_CONVENTIONS_CORE,
  estimateTokenCount,
  buildUnitGenPhaseMetrics,
} from "./unitRuleEngine.js";

describe("unitRuleEngine SoT", () => {
  it("exposes prompt rules and rank policy aligned with limits", () => {
    assert.ok(UNIT_PROMPT_RULES_CORE.length >= 5);
    assert.ok(UNIT_PROMPT_RULES_CORE.some((l) => /locked packet/i.test(l)));
    assert.ok(UNIT_PROMPT_RULES_CORE.every((l) => !/FAIL_NEEDS_MARKER/i.test(l)));
    assert.equal(UNIT_RANK_POLICY.maxRelatedFiles, UNIT_GEN_LIMITS.maxRelatedFiles);
    assert.ok(UNIT_RANK_POLICY.retrieveTopKMin <= UNIT_RANK_POLICY.retrieveTopKDefault);
    assert.ok(UNIT_RANK_POLICY.weakClientAppAdminRe.test(
      "src/ClientApp/src/app/admin/audit-log/audit-log.service.ts"
    ));
    assert.ok(UNIT_CONVENTIONS_CORE.includes("Unit test conventions"));
  });

  it("estimates tokens and builds phase metrics", () => {
    assert.equal(estimateTokenCount(""), 0);
    assert.ok(estimateTokenCount("abcd") >= 1);
    const m = buildUnitGenPhaseMetrics({
      cliTimeMs: 1200,
      prompt: "x".repeat(40),
      sutExcerpt: "sut",
      relatedExcerpt: "rel",
      relatedFileCount: 2,
      truncated: true,
    });
    assert.equal(m.cliTimeMs, 1200);
    assert.equal(m.retrievedFiles, 2);
    assert.equal(m.contextSize, 6);
    assert.equal(m.truncated, true);
    assert.ok((m.promptTokens || 0) >= 1);
  });
});
