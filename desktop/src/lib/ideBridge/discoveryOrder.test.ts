import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  discoveryStartedAtMs,
  sortIdeDiscoveriesByNewest,
} from "./discoveryOrder.js";

describe("sortIdeDiscoveriesByNewest", () => {
  it("orders by startedAt descending", () => {
    const sorted = sortIdeDiscoveriesByNewest([
      { port: 50159, startedAt: "2026-08-15T10:00:00.000Z" },
      { port: 64681, startedAt: "2026-08-15T12:00:00.000Z" },
      { port: 55451, startedAt: "2026-08-15T11:00:00.000Z" },
    ]);
    assert.deepEqual(
      sorted.map((d) => d.port),
      [64681, 55451, 50159]
    );
  });

  it("uses higher port when startedAt ties", () => {
    const sorted = sortIdeDiscoveriesByNewest([
      { port: 100, startedAt: "2026-08-15T12:00:00.000Z" },
      { port: 200, startedAt: "2026-08-15T12:00:00.000Z" },
    ]);
    assert.equal(sorted[0]?.port, 200);
  });

  it("treats missing startedAt as oldest", () => {
    assert.equal(discoveryStartedAtMs({ startedAt: "" }), 0);
    const sorted = sortIdeDiscoveriesByNewest([
      { port: 1, startedAt: "" },
      { port: 2, startedAt: "2026-08-15T12:00:00.000Z" },
    ]);
    assert.equal(sorted[0]?.port, 2);
  });
});
