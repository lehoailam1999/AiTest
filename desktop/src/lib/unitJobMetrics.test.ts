/**
 * Phase U0 — unitJobMetrics (Local FS vs IDE).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearUnitJobMetrics,
  labelContextSource,
  recordUnitJobMetric,
  summarizeUnitJobMetrics,
} from "./unitJobMetrics.ts";

const mem = new Map<string, string>();

beforeEach(() => {
  mem.clear();
  // Minimal localStorage shim for node:test
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => {
      mem.set(k, v);
    },
    removeItem: (k) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  clearUnitJobMetrics();
});

describe("unitJobMetrics U0", () => {
  it("summarizes local-fs vs ide share", () => {
    const pid = "p1";
    recordUnitJobMetric({ projectId: pid, contextSource: "local-fs", ideConnected: false });
    recordUnitJobMetric({ projectId: pid, contextSource: "local-fs", ideConnected: false });
    recordUnitJobMetric({ projectId: pid, contextSource: "ide", ideConnected: true });
    const s = summarizeUnitJobMetrics({ projectId: pid });
    assert.equal(s.total, 3);
    assert.equal(s.localFsPct, 66.7);
    assert.equal(s.idePct, 33.3);
    assert.ok(s.noIdePct >= 66);
  });

  it("scopes by projectId", () => {
    recordUnitJobMetric({ projectId: "a", contextSource: "local-fs" });
    recordUnitJobMetric({ projectId: "b", contextSource: "ide" });
    assert.equal(summarizeUnitJobMetrics({ projectId: "a" }).total, 1);
    assert.equal(summarizeUnitJobMetrics({ projectId: "b" }).idePct, 100);
  });

  it("labels context sources without IDE-first wording", () => {
    assert.equal(labelContextSource("local-fs"), "Local FS");
    assert.match(labelContextSource("agent-ide"), /tuỳ chọn/i);
  });
});
