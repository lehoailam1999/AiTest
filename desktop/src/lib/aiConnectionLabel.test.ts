import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiConnectionDisplayLabel } from "./aiConnectionLabel.ts";

describe("aiConnectionDisplayLabel", () => {
  it("shows Cursor CLI when cliType is cursor-cli", () => {
    assert.equal(
      aiConnectionDisplayLabel({
        cliType: "cursor-cli",
      }),
      "Cursor CLI"
    );
  });

  it("defaults to AI CLI when cliType missing", () => {
    assert.equal(
      aiConnectionDisplayLabel({
        cliType: null,
      }),
      "AI CLI"
    );
  });

  it("shows Antigravity CLI when cliType is antigravity-cli", () => {
    assert.equal(
      aiConnectionDisplayLabel({
        cliType: "antigravity-cli",
      }),
      "Antigravity CLI"
    );
  });
});
