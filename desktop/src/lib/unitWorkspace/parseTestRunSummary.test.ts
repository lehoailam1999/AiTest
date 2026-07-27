/**
 * Unit tests for parseTestRunSummary (Jest / Vitest / pytest / dotnet / Go logs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDurationMs,
  parseTestRunSummary,
} from "./parseTestRunSummary.js";

describe("parseTestRunSummary", () => {
  it("parses Jest Tests line", () => {
    const s = parseTestRunSummary({
      framework: "jest",
      stages: [
        {
          stage: "test",
          success: false,
          command: "npx jest",
          exitCode: 1,
          durationMs: 2400,
          logExcerpt: "Tests:       1 failed, 2 passed, 3 total\n",
        },
      ],
    });
    assert.equal(s.passed, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.total, 3);
    assert.equal(s.hasCounts, true);
    assert.equal(s.runnerLabel, "Jest");
  });

  it("parses pytest summary", () => {
    const s = parseTestRunSummary({
      framework: "pytest",
      stages: [
        {
          stage: "test",
          success: true,
          command: "pytest",
          exitCode: 0,
          durationMs: 1100,
          logExcerpt: "===== 2 passed, 1 skipped in 1.10s =====\n",
        },
      ],
    });
    assert.equal(s.passed, 2);
    assert.equal(s.skipped, 1);
    assert.equal(s.failed, 0);
    assert.equal(s.runnerLabel, "pytest");
  });

  it("parses vitest line", () => {
    const s = parseTestRunSummary({
      framework: "vitest",
      stages: [
        {
          stage: "test",
          success: false,
          command: "npx vitest run",
          exitCode: 1,
          durationMs: 800,
          logExcerpt: "Tests  2 passed | 1 failed\n",
        },
      ],
    });
    assert.equal(s.passed, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.runnerLabel, "Vitest");
  });

  it("formatDurationMs", () => {
    assert.equal(formatDurationMs(400), "400ms");
    assert.equal(formatDurationMs(1500), "1.5s");
  });
});
