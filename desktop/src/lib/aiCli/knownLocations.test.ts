import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { knownLocationCandidates } from "./knownLocations.js";

describe("knownLocationCandidates", () => {
  it("Cursor uses LOCALAPPDATA, not a hardcoded developer home", () => {
    const paths = knownLocationCandidates("cursor-cli", "win32", {
      LOCALAPPDATA: "C:\\Users\\qa\\AppData\\Local",
    });
    assert.ok(paths.some((p) => p.endsWith("cursor-agent\\agent.ps1")));
    assert.ok(!paths.some((p) => /Dell One/i.test(p)));
  });

  it("empty LOCALAPPDATA yields no Windows Cursor paths", () => {
    const paths = knownLocationCandidates("cursor-cli", "win32", {});
    assert.equal(paths.length, 0);
  });

  it("Ollama Windows known dir under LOCALAPPDATA\\Programs\\Ollama", () => {
    const paths = knownLocationCandidates("ollama", "win32", {
      LOCALAPPDATA: "D:\\AppData\\Local",
    });
    assert.ok(paths.some((p) => p.includes("Programs\\Ollama\\ollama.exe")));
  });
});
