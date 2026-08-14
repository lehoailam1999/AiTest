import test from "node:test";
import assert from "node:assert/strict";
import { getAiCliSetupGuide } from "./setupGuides";

test("supported CLIs expose safe guided setup without credentials", () => {
  const cursor = getAiCliSetupGuide("cursor-cli");
  assert.match(cursor.installCommand.win32 ?? "", /cursor\.com/);
  assert.equal(cursor.loginCommand, "agent login");

  const claude = getAiCliSetupGuide("claude-cli");
  assert.equal(claude.loginCommand, "claude auth login");

  const ollama = getAiCliSetupGuide("ollama");
  assert.equal(ollama.loginCommand, null);
  assert.match(ollama.loginNote, /không cần đăng nhập/i);
});
