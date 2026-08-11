/**
 * Unit Gen architecture — gates, state machine, timeline, transforms.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNIT_CONVENTIONS_CORE,
  UNIT_GEN_LIMITS,
  UNIT_LAYOUT_RULE,
} from "@aitest/ide-protocol";
import {
  canTransitionUnitJob,
  UNIT_JOB_TRANSITIONS,
} from "./unitJobState.ts";
import { pushTimeline } from "./unitJobEvents.ts";
import type { UnitWorkspaceStatus } from "./types.ts";

describe("unit conventions SoT (protocol)", () => {
  it("exports quantified limits", () => {
    assert.equal(UNIT_GEN_LIMITS.maxRelatedFiles, 4);
    assert.equal(UNIT_GEN_LIMITS.maxExcerptChars, 8000);
    assert.equal(UNIT_GEN_LIMITS.transportRetryMax, 1);
    assert.ok(UNIT_GEN_LIMITS.genTimeoutMs >= 60_000);
  });

  it("CORE mentions Approve MD and layout", () => {
    assert.match(UNIT_CONVENTIONS_CORE, /Approved/i);
    assert.match(UNIT_CONVENTIONS_CORE, /test-cases/);
    assert.ok(UNIT_LAYOUT_RULE.includes("AItest/UnitTest"));
  });
});

describe("unit job state machine", () => {
  it("allows generating → generated / gen_with_gap / gen_failed / discarded", () => {
    assert.equal(canTransitionUnitJob("generating", "generated"), true);
    assert.equal(canTransitionUnitJob("generating", "gen_with_gap"), true);
    assert.equal(canTransitionUnitJob("generating", "gen_failed"), true);
    assert.equal(canTransitionUnitJob("generating", "discarded"), true);
    assert.equal(canTransitionUnitJob("generating", "applied"), false);
  });

  it("gen_failed can retry to generating", () => {
    assert.equal(canTransitionUnitJob("gen_failed", "generating"), true);
  });

  it("every status has a transition table entry", () => {
    const statuses: UnitWorkspaceStatus[] = [
      "draft",
      "generating",
      "generated",
      "gen_with_gap",
      "gen_failed",
      "verifying",
      "pass",
      "fail",
      "applied",
      "discarded",
    ];
    for (const s of statuses) {
      assert.ok(s in UNIT_JOB_TRANSITIONS, `missing ${s}`);
    }
  });
});

describe("unit job timeline", () => {
  it("appends events in order with timestamps", () => {
    let t = pushTimeline([], "job.queued", "via=ide-extension");
    t = pushTimeline(t, "job.gen.started");
    t = pushTimeline(t, "job.transform", "rewriteSutImports");
    t = pushTimeline(t, "job.gen.completed", "AItest/UnitTest/x.test.ts");
    assert.equal(t.length, 4);
    assert.equal(t[0]!.event, "job.queued");
    assert.equal(t[3]!.event, "job.gen.completed");
    for (let i = 1; i < t.length; i++) {
      assert.ok(t[i]!.at >= t[i - 1]!.at);
    }
  });
});
