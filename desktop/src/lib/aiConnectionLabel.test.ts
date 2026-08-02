import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiConnectionDisplayLabel } from "./aiConnectionLabel.ts";

describe("aiConnectionDisplayLabel", () => {
  it("shows Cursor CLI when runner is AI_CLI even if provider is openai", () => {
    assert.equal(
      aiConnectionDisplayLabel({
        provider: "openai",
        backendType: "openai",
        runnerMode: "AI_CLI",
        cliType: "cursor-cli",
      }),
      "Cursor CLI"
    );
  });

  it("falls back to Direct API provider when not CLI", () => {
    assert.equal(
      aiConnectionDisplayLabel({
        provider: "openai",
        backendType: "openai",
        runnerMode: "API_DIRECT",
        cliType: null,
      }),
      "openai"
    );
  });
});
