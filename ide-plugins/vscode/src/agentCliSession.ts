/**
 * Phase 2 — reusable Cursor Agent CLI session (workspace + binary cache).
 * Each generate() is still a oneshot spawn (CLI contract), but bin/cwd/env
 * are resolved once per session and shared across TCs in a batch / Desktop job.
 *
 * Prefer Desktop-resolved `agentExecutable` over a bare `agent` command name.
 */
import { existsSync } from "node:fs";
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

function normBin(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Use Desktop path when it is a real file; otherwise fall back to local resolve. */
export function pickAgentBinary(explicit?: string | null): string {
  const t = (explicit || "").trim();
  if (t) {
    if (!existsSync(t)) {
      throw new Error(`AI CLI executable not found: ${t}`);
    }
    return t;
  }
  return resolveAgentBinary();
}

export function openAgentCliSession(
  workspaceRoot: string,
  agentExecutable?: string | null
): AgentCliSession {
  const root = (workspaceRoot || "").trim();
  if (!root) throw new Error("openAgentCliSession: workspaceRoot required");
  const bin = pickAgentBinary(agentExecutable);
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

/**
 * Reuse sessionId when the cached bin matches Desktop's resolved path.
 * Otherwise open a session on the resolved executable (do not spawn a bare name).
 */
export function bindAgentCliSession(opts: {
  workspaceRoot: string;
  sessionId?: string | null;
  agentExecutable?: string | null;
}): { session: AgentCliSession; ephemeral: boolean } {
  const want = (opts.agentExecutable || "").trim();
  let session = opts.sessionId ? getAgentCliSession(opts.sessionId) : null;
  if (session && want && normBin(session.bin) !== normBin(want)) {
    session = null;
  }
  if (session) return { session, ephemeral: false };
  return {
    session: openAgentCliSession(opts.workspaceRoot, want || undefined),
    ephemeral: true,
  };
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
