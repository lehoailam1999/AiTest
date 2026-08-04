import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiConnectionDisplayLabel } from "./aiConnectionLabel.ts";

describe("aiConnectionDisplayLabel", () => {
  it("shows Cursor CLI when cliType is cursor-cli even if provider is openai", () => {
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

  it("defaults to AI CLI when cliType missing", () => {
    assert.equal(
      aiConnectionDisplayLabel({
        provider: "openai",
        backendType: "openai",
        runnerMode: "AI_CLI",
        cliType: null,
      }),
      "AI CLI"
    );
  });
});
