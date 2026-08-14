import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectAiCli, detectSupportedAiClis } from "./detect.js";
import { isAiCliReady } from "./types.js";
import type { AiCliProbe, AiCliVersionOut } from "./types.js";

function probe(opts: {
  files?: string[];
  which?: Record<string, string | null>;
  version?: (exe: string) => AiCliVersionOut | Promise<AiCliVersionOut>;
}): AiCliProbe {
  const files = new Set((opts.files ?? []).map((p) => p.replace(/\\/g, "/").toLowerCase()));
  return {
    isFile(abs) {
      return files.has(abs.replace(/\\/g, "/").toLowerCase());
    },
    which(name) {
      if (!opts.which) return null;
      return opts.which[name] ?? null;
    },
    async runVersion(exe) {
      if (opts.version) return opts.version(exe);
      return { exitCode: 0, stdout: "1.2.3\n", stderr: "" };
    },
  };
}

const now = () => new Date("2026-08-14T00:00:00.000Z");

describe("detectAiCli", () => {
  it("NOT_FOUND when missing everywhere", async () => {
    const r = await detectAiCli("gemini-cli", {
      probe: probe({}),
      platform: "win32",
      env: {},
      now,
    });
    assert.equal(r.status, "NOT_FOUND");
    assert.equal(r.executablePath, null);
    assert.equal(isAiCliReady(r.status), false);
    assert.match(r.message ?? "", /not found/i);
  });

  it("PATH hit → READY with version", async () => {
    const exe = "C:\\Tools\\gemini.exe";
    const r = await detectAiCli("gemini-cli", {
      probe: probe({
        files: [exe],
        which: { "gemini.exe": exe, gemini: exe },
      }),
      platform: "win32",
      env: {},
      now,
    });
    assert.equal(r.status, "READY");
    assert.equal(r.detectedBy, "PATH");
    assert.equal(r.executablePath, exe);
    assert.equal(r.version, "1.2.3");
    assert.equal(isAiCliReady(r.status), true);
  });

  it("known location when not on PATH (Cursor LOCALAPPDATA)", async () => {
    const exe = "C:\\Users\\qa\\AppData\\Local\\cursor-agent\\agent.ps1";
    const r = await detectAiCli("cursor-cli", {
      probe: probe({ files: [exe] }),
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\qa\\AppData\\Local" },
      now,
    });
    assert.equal(r.status, "READY");
    assert.equal(r.detectedBy, "known-location");
    assert.equal(r.executablePath, exe);
  });

  it("manual path wins over PATH", async () => {
    const manual = "/opt/custom/claude";
    const pathHit = "/usr/bin/claude";
    const r = await detectAiCli("claude-cli", {
      probe: probe({
        files: [manual, pathHit],
        which: { claude: pathHit },
      }),
      platform: "linux",
      env: {},
      manualPath: manual,
      now,
    });
    assert.equal(r.detectedBy, "manual");
    assert.equal(r.executablePath, manual);
    assert.equal(r.status, "READY");
  });

  it("INVALID when manual path is not a file", async () => {
    const r = await detectAiCli("claude-cli", {
      probe: probe({ files: [] }),
      platform: "darwin",
      env: {},
      manualPath: "/no/such/claude",
      now,
    });
    assert.equal(r.status, "INVALID");
    assert.equal(r.detectedBy, "manual");
    assert.equal(isAiCliReady(r.status), false);
  });

  it("env AITEST_AGENT_PATH (Cursor) before PATH", async () => {
    const envPath = "/opt/cursor/agent";
    const pathHit = "/usr/bin/agent";
    const r = await detectAiCli("cursor-cli", {
      probe: probe({
        files: [envPath, pathHit],
        which: { agent: pathHit },
      }),
      platform: "linux",
      env: { AITEST_AGENT_PATH: envPath },
      now,
    });
    assert.equal(r.detectedBy, "env");
    assert.equal(r.executablePath, envPath);
  });

  it("INVALID when version exits non-zero", async () => {
    const exe = "/usr/bin/agy";
    const r = await detectAiCli("antigravity-cli", {
      probe: probe({
        files: [exe],
        which: { agy: exe },
        version: () => ({ exitCode: 2, stdout: "", stderr: "bad" }),
      }),
      platform: "linux",
      env: {},
      now,
    });
    assert.equal(r.status, "INVALID");
    assert.equal(isAiCliReady(r.status), false);
  });

  it("ERROR on version timeout", async () => {
    const exe = "/usr/bin/ollama";
    const r = await detectAiCli("ollama", {
      probe: probe({
        files: [exe],
        which: { ollama: exe },
        version: () => ({
          exitCode: -1,
          stdout: "",
          stderr: "",
          error: "Version check timed out.",
        }),
      }),
      platform: "linux",
      env: {},
      now,
    });
    assert.equal(r.status, "ERROR");
    assert.match(r.message ?? "", /timed out/i);
  });

  it("ERROR on permission denied", async () => {
    const exe = "/usr/bin/gemini";
    const r = await detectAiCli("gemini-cli", {
      probe: probe({
        files: [exe],
        which: { gemini: exe },
        version: () => ({
          exitCode: -1,
          stdout: "",
          stderr: "",
          error: "permission denied",
        }),
      }),
      platform: "linux",
      env: {},
      now,
    });
    assert.equal(r.status, "ERROR");
  });

  it("FOUND when skipVersion", async () => {
    const exe = "/usr/bin/gemini";
    const r = await detectAiCli("gemini-cli", {
      probe: probe({ files: [exe], which: { gemini: exe } }),
      platform: "linux",
      env: {},
      skipVersion: true,
      now,
    });
    assert.equal(r.status, "FOUND");
    assert.equal(isAiCliReady(r.status), false);
  });

  it("custom-script NOT_FOUND without manual path", async () => {
    const r = await detectAiCli("custom-script", {
      probe: probe({}),
      platform: "win32",
      env: {},
      now,
    });
    assert.equal(r.status, "NOT_FOUND");
    assert.match(r.message ?? "", /manual/i);
  });

  it("detectSupportedAiClis scans five vendors, not custom-script", async () => {
    const list = await detectSupportedAiClis({
      probe: probe({}),
      platform: "linux",
      env: {},
      now,
    });
    assert.equal(list.length, 5);
    assert.ok(list.every((x) => x.status === "NOT_FOUND"));
    assert.ok(!list.some((x) => x.provider === "custom-script"));
  });

  it("unix known location ~/.local/bin from HOME", async () => {
    const exe = "/home/qa/.local/bin/gemini";
    const r = await detectAiCli("gemini-cli", {
      probe: probe({ files: [exe] }),
      platform: "linux",
      env: { HOME: "/home/qa" },
      now,
    });
    assert.equal(r.status, "READY");
    assert.equal(r.detectedBy, "known-location");
    assert.equal(r.executablePath, exe);
  });
});
