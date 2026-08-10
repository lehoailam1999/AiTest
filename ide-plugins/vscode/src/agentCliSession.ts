/**
 * Phase 2 — reusable Cursor Agent CLI session (workspace + binary cache).
 * Each generate() is still a oneshot spawn (CLI contract), but bin/cwd/env
 * are resolved once per session and shared across TCs in a batch / Desktop job.
 */
import { resolveAgentBinary, runCursorAgentOneshotWithBin } from "./cursorAgentCliEngine";

export type AgentCliSession = {
  id: string;
  workspaceRoot: string;
  bin: string;
  openedAt: number;
  generateCount: number;
  run: (
    prompt: string,
    timeoutMs: number,
    onLine?: (s: string) => void
  ) => Promise<string>;
  close: () => void;
};

const sessions = new Map<string, AgentCliSession>();

function newSessionId(): string {
  return `acli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function openAgentCliSession(workspaceRoot: string): AgentCliSession {
  const root = (workspaceRoot || "").trim();
  if (!root) throw new Error("openAgentCliSession: workspaceRoot required");
  const bin = resolveAgentBinary();
  const id = newSessionId();
  const session: AgentCliSession = {
    id,
    workspaceRoot: root,
    bin,
    openedAt: Date.now(),
    generateCount: 0,
    async run(prompt, timeoutMs, onLine) {
      session.generateCount += 1;
      return runCursorAgentOneshotWithBin(
        session.bin,
        prompt,
        session.workspaceRoot,
        timeoutMs,
        onLine
      );
    },
    close() {
      sessions.delete(id);
    },
  };
  sessions.set(id, session);
  return session;
}

export function getAgentCliSession(sessionId: string): AgentCliSession | null {
  return sessions.get(sessionId) || null;
}

export function closeAgentCliSession(sessionId: string): {
  ok: boolean;
  generateCount?: number;
} {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false };
  const n = s.generateCount;
  s.close();
  return { ok: true, generateCount: n };
}

/** Test helper */
export function agentCliSessionCount(): number {
  return sessions.size;
}

export function clearAllAgentCliSessions(): void {
  for (const s of [...sessions.values()]) s.close();
  sessions.clear();
}
