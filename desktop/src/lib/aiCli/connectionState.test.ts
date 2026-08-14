import test from "node:test";
import assert from "node:assert/strict";
import {
  aiCliConnectionState,
  aiCliFailureMessage,
  type AiCliRecoveryState,
} from "./connectionState";
import type { AiCliDetectResult, AiCliStatus } from "./types";

function result(status: AiCliStatus, message: string | null = null): AiCliDetectResult {
  return {
    provider: "cursor-cli",
    name: "Cursor Agent CLI",
    executablePath: status === "READY" ? "C:\\bin\\agent.exe" : null,
    version: status === "READY" ? "1.0.0" : null,
    detectedBy: status === "READY" ? "PATH" : null,
    os: "win32",
    status,
    lastCheckedAt: "2026-08-14T00:00:00.000Z",
    message,
  };
}

test("selected CLI state is checking while detection or recovery runs", () => {
  assert.equal(aiCliConnectionState(undefined, true, "idle"), "checking");
  assert.equal(
    aiCliConnectionState(result("NOT_FOUND"), false, "recovering"),
    "checking"
  );
});

test("a signed-in CLI without a Ready backend record is not reported as needs_auth", () => {
  assert.equal(aiCliConnectionState(result("READY"), false, "idle"), "needs_verify");
  assert.equal(
    aiCliConnectionState(result("NOT_AUTHENTICATED"), false, "idle"),
    "needs_auth"
  );
});

test("selected CLI reports connected only when detection is READY", () => {
  assert.equal(aiCliConnectionState(result("READY"), false, "idle", true), "connected");
  for (const status of ["NOT_FOUND", "FOUND", "INVALID", "ERROR"] as const) {
    assert.equal(aiCliConnectionState(result(status), false, "idle"), "not_installed");
  }
});

test("successful recovery has an explicit recovered state", () => {
  const recovery: AiCliRecoveryState = "recovered";
  assert.equal(aiCliConnectionState(result("READY"), false, recovery, true), "recovered");
});

test("failure message preserves the detector reason", () => {
  assert.equal(
    aiCliFailureMessage(result("INVALID", "CLI path is not a file.")),
    "CLI path is not a file."
  );
});
