import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_CLI_LOCAL_KEY,
  loadAiCliLocalState,
  mergeManualPath,
  saveAiCliLocalState,
  type StorageLike,
} from "./localStore.js";

function mem(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("aiCli localStore", () => {
  it("round-trips manual path without backend fields", () => {
    const s = mem();
    saveAiCliLocalState(
      {
        manualPaths: { "cursor-cli": "C:\\tools\\agent.exe" },
        lastResults: [],
      },
      s
    );
    const loaded = loadAiCliLocalState(s);
    assert.equal(loaded.manualPaths["cursor-cli"], "C:\\tools\\agent.exe");
    assert.ok(s.data[AI_CLI_LOCAL_KEY]);
    assert.equal(s.data[AI_CLI_LOCAL_KEY].includes("password"), false);
  });

  it("mergeManualPath clears when null", () => {
    const st = mergeManualPath(
      { manualPaths: { "gemini-cli": "/usr/bin/gemini" }, lastResults: [] },
      "gemini-cli",
      null
    );
    assert.equal(st.manualPaths["gemini-cli"], undefined);
  });

  it("corrupt JSON yields empty state", () => {
    const s = mem();
    s.setItem(AI_CLI_LOCAL_KEY, "{not json");
    const loaded = loadAiCliLocalState(s);
    assert.deepEqual(loaded.manualPaths, {});
    assert.deepEqual(loaded.lastResults, []);
  });
});
