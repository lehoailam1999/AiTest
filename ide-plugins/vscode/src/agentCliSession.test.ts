/**
 * Phase 2 — Agent CLI session reuse (bin/cwd cache).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  agentCliSessionCount,
  clearAllAgentCliSessions,
  closeAgentCliSession,
  getAgentCliSession,
  openAgentCliSession,
} from "./agentCliSession.ts";

describe("agentCliSession", () => {
  beforeEach(() => clearAllAgentCliSessions());

  it("opens session with cached bin and closes", () => {
    const s = openAgentCliSession("/tmp/sut-project");
    assert.ok(s.id.startsWith("acli-"));
    assert.equal(s.workspaceRoot, "/tmp/sut-project");
    assert.ok(s.bin.length > 0);
    assert.equal(agentCliSessionCount(), 1);
    assert.equal(getAgentCliSession(s.id)?.id, s.id);
    const closed = closeAgentCliSession(s.id);
    assert.equal(closed.ok, true);
    assert.equal(agentCliSessionCount(), 0);
  });

  it("rejects empty workspace", () => {
    assert.throws(() => openAgentCliSession("  "));
  });
});
