/**
 * Phase 2 — Agent CLI session reuse (bin/cwd cache).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agentCliSessionCount,
  bindAgentCliSession,
  clearAllAgentCliSessions,
  closeAgentCliSession,
  getAgentCliSession,
  openAgentCliSession,
  pickAgentBinary,
} from "./agentCliSession.ts";

const existingFile = fileURLToPath(new URL("./agentCliSession.ts", import.meta.url));

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

  it("uses Desktop-resolved executable when the file exists", () => {
    const s = openAgentCliSession("/tmp/sut-project", existingFile);
    assert.equal(s.bin, existingFile);
  });

  it("rejects a missing explicit executable", () => {
    assert.throws(
      () => openAgentCliSession("/tmp/sut-project", "/no/such/cursor-agent.exe"),
      /AI CLI executable not found/
    );
  });

  it("bindAgentCliSession does not reuse a session with a different bin", () => {
    const first = openAgentCliSession("/tmp/sut-project", existingFile);
    const bound = bindAgentCliSession({
      workspaceRoot: "/tmp/sut-project",
      sessionId: first.id,
      agentExecutable: existingFile,
    });
    assert.equal(bound.ephemeral, false);
    assert.equal(bound.session.id, first.id);
    assert.throws(
      () =>
        bindAgentCliSession({
          workspaceRoot: "/tmp/sut-project",
          sessionId: first.id,
          agentExecutable: "/no/such/other-agent.exe",
        }),
      /AI CLI executable not found/
    );
    assert.equal(pickAgentBinary(existingFile), existingFile);
  });
});
