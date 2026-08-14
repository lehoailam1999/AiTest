import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiCliNotReadyError,
  assertGenerationAllowed,
  ensureAiCliReady,
  ensureCursorAgentReady,
  ensureTcGenCliReady,
} from "./gate.js";
import { parseAiCliId } from "./registry.js";
import type { AiCliDetectResult, AiCliId, AiCliStatus } from "./types.js";
import type { AiCliLocalState } from "./localStore.js";

function result(
  status: AiCliStatus,
  extra?: Partial<AiCliDetectResult>
): AiCliDetectResult {
  return {
    provider: "cursor-cli",
    name: "Cursor Agent CLI",
    executablePath: status === "READY" ? "C:\\Users\\user\\cursor-agent\\agent.ps1" : null,
    version: status === "READY" ? "1.0.0" : null,
    detectedBy: status === "NOT_FOUND" ? null : "PATH",
    os: "win32",
    status,
    lastCheckedAt: "2026-08-14T00:00:00.000Z",
    message: extra?.message ?? null,
    ...extra,
  };
}

describe("assertGenerationAllowed", () => {
  it("READY with path allows generation", () => {
    assert.doesNotThrow(() => assertGenerationAllowed(result("READY")));
  });

  it("NOT_FOUND blocks generation", () => {
    assert.throws(
      () => assertGenerationAllowed(result("NOT_FOUND")),
      (e: unknown) => {
        assert.ok(e instanceof AiCliNotReadyError);
        assert.match(e.message, /was not found on this machine/i);
        assert.equal(e.result.status, "NOT_FOUND");
        return true;
      }
    );
  });

  it("NOT_AUTHENTICATED blocks generation", () => {
    assert.throws(
      () => assertGenerationAllowed(result("NOT_AUTHENTICATED")),
      /is installed but is not ready for use/i
    );
  });

  it("ERROR blocks generation", () => {
    assert.throws(
      () =>
        assertGenerationAllowed(
          result("ERROR", { message: "timed out", executablePath: "C:\\agent.ps1" })
        ),
      /could not be used/i
    );
  });

  it("INVALID and FOUND block generation", () => {
    assert.throws(() => assertGenerationAllowed(result("INVALID")), /invalid/i);
    assert.throws(() => assertGenerationAllowed(result("FOUND")), /not READY/i);
  });

  it("READY without path blocks", () => {
    assert.throws(
      () => assertGenerationAllowed(result("READY", { executablePath: null })),
      /executable path is missing/i
    );
  });
});

describe("ensureAiCliReady", () => {
  it("returns executablePath when detect is READY", async () => {
    const mem: AiCliLocalState = { manualPaths: {}, lastResults: [] };
    const ready = result("READY");
    const out = await ensureAiCliReady("cursor-cli", {
      detectOne: async () => ready,
      loadState: () => mem,
      saveState: (s) => {
        mem.manualPaths = s.manualPaths;
        mem.lastResults = s.lastResults;
      },
      isDesktop: () => true,
    });
    assert.equal(out.executablePath, ready.executablePath);
    assert.equal(mem.lastResults[0]?.status, "READY");
  });

  it("uses stored manual path when detecting", async () => {
    let seen: string | null | undefined;
    await ensureAiCliReady("gemini-cli", {
      detectOne: async (_id: AiCliId, manual) => {
        seen = manual;
        return result("READY", {
          provider: "gemini-cli",
          name: "Gemini CLI",
          executablePath: manual || "/usr/bin/gemini",
        });
      },
      loadState: () => ({
        manualPaths: { "gemini-cli": "/opt/gemini" },
        lastResults: [],
      }),
      saveState: () => {},
      isDesktop: () => true,
    });
    assert.equal(seen, "/opt/gemini");
  });

  it("ensureCursorAgentReady is cursor-cli", async () => {
    let id: AiCliId | undefined;
    const out = await ensureCursorAgentReady({
      detectOne: async (got) => {
        id = got;
        return result("READY");
      },
      loadState: () => ({ manualPaths: {}, lastResults: [] }),
      saveState: () => {},
      isDesktop: () => true,
    });
    assert.equal(id, "cursor-cli");
    assert.ok(out.executablePath);
  });
});

describe("ensureTcGenCliReady", () => {
  it("skips detect when not Desktop", async () => {
    let called = false;
    const out = await ensureTcGenCliReady("cursor-cli", {
      detectOne: async () => {
        called = true;
        return result("NOT_FOUND");
      },
      loadState: () => ({ manualPaths: {}, lastResults: [] }),
      saveState: () => {},
      isDesktop: () => false,
    });
    assert.equal(out, null);
    assert.equal(called, false);
  });

  it("gates Settings vendor on Desktop", async () => {
    await assert.rejects(
      () =>
        ensureTcGenCliReady("claude-cli", {
          detectOne: async (id) => {
            assert.equal(id, "claude-cli");
            return result("NOT_FOUND", {
              provider: "claude-cli",
              name: "Claude Code CLI",
            });
          },
          loadState: () => ({ manualPaths: {}, lastResults: [] }),
          saveState: () => {},
          isDesktop: () => true,
        }),
      /was not found on this machine/i
    );
  });
});

describe("parseAiCliId", () => {
  it("maps Settings cliType and rejects unknown", () => {
    assert.equal(parseAiCliId("cursor-cli"), "cursor-cli");
    assert.equal(parseAiCliId("Gemini-CLI"), "gemini-cli");
    assert.equal(parseAiCliId("not-a-cli"), null);
  });
});
