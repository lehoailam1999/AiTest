import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyConfidenceWriteGate,
  confidenceMdWarning,
  mapUnitApproveConfidence,
} from "./unitApproveConfidence.js";

describe("mapUnitApproveConfidence (Layer 2)", () => {
  it("HIGH when strict margin + module gate + strong signal", () => {
    assert.equal(
      mapUnitApproveConfidence({
        score: 200,
        margin: 40,
        ratio: 1.5,
        moduleGated: true,
        hasStrongSignal: true,
        requiresBodyRule: false,
        ruleHitCount: 0,
        source: "index.db",
      }),
      "HIGH"
    );
  });

  it("MEDIUM on soft margin only", () => {
    assert.equal(
      mapUnitApproveConfidence({
        score: 100,
        margin: 10,
        ratio: 1.2,
        moduleGated: true,
        hasStrongSignal: true,
        requiresBodyRule: false,
        ruleHitCount: 0,
        source: "index.db",
      }),
      "MEDIUM"
    );
  });

  it("LOW when ungated or weak signal", () => {
    assert.equal(
      mapUnitApproveConfidence({
        score: 200,
        margin: 50,
        moduleGated: false,
        hasStrongSignal: true,
        requiresBodyRule: false,
        ruleHitCount: 0,
      }),
      "LOW"
    );
    // Weak prefer but gated + strict margin → MEDIUM (still write with warning)
    assert.equal(
      mapUnitApproveConfidence({
        score: 200,
        margin: 50,
        moduleGated: true,
        hasStrongSignal: false,
        requiresBodyRule: false,
        ruleHitCount: 0,
      }),
      "MEDIUM"
    );
  });

  it("LOW when score below min", () => {
    assert.equal(
      mapUnitApproveConfidence({
        score: 40,
        margin: 30,
        moduleGated: true,
        hasStrongSignal: true,
        requiresBodyRule: false,
        ruleHitCount: 0,
      }),
      "LOW"
    );
  });

  it("body-rule miss salvage → MEDIUM at best", () => {
    assert.equal(
      mapUnitApproveConfidence({
        score: 180,
        margin: 30,
        moduleGated: true,
        hasStrongSignal: true,
        requiresBodyRule: true,
        ruleHitCount: 0,
      }),
      "MEDIUM"
    );
  });

  it("LLM shortlist bands by numeric confidence", () => {
    assert.equal(
      mapUnitApproveConfidence({
        score: 80,
        margin: 10,
        moduleGated: false,
        hasStrongSignal: false,
        requiresBodyRule: false,
        ruleHitCount: 0,
        source: "llm-shortlist",
        llmConfidence: 0.95,
      }),
      "HIGH"
    );
    assert.equal(
      mapUnitApproveConfidence({
        score: 80,
        margin: 10,
        moduleGated: false,
        hasStrongSignal: false,
        requiresBodyRule: false,
        ruleHitCount: 0,
        source: "llm-shortlist",
        llmConfidence: 0.75,
      }),
      "MEDIUM"
    );
    assert.equal(
      mapUnitApproveConfidence({
        score: 80,
        margin: 10,
        moduleGated: false,
        hasStrongSignal: false,
        requiresBodyRule: false,
        ruleHitCount: 0,
        source: "llm-shortlist",
        llmConfidence: 0.5,
      }),
      "LOW"
    );
  });

  it("applyConfidenceWriteGate blocks LOW", () => {
    assert.deepEqual(applyConfidenceWriteGate(true, "LOW"), {
      writeBack: false,
      confidence: "LOW",
      skipReason:
        "FAIL_CONFIDENCE_LOW — score/margin/signals below Approve write threshold",
    });
    assert.deepEqual(applyConfidenceWriteGate(true, "MEDIUM"), {
      writeBack: true,
      confidence: "MEDIUM",
    });
    assert.match(confidenceMdWarning("MEDIUM"), /warning=soft-margin/);
  });
});
