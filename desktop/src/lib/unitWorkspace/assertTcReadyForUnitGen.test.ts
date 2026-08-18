/**
 * Gate: no IDE / no Approved TC MD → fail-closed (pure decideUnitGenGate).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideUnitGenGate, decideUnitLanguageGate } from "./unitGenGates.ts";

describe("decideUnitGenGate", () => {
  it("fails without Tauri", () => {
    const r = decideUnitGenGate({
      isTauri: false,
      projectRoot: "D:/x",
      ideReady: true,
      mdPath: "x.md",
      tcLabel: "TC-1",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "no_tauri");
  });

  it("fails without root", () => {
    const r = decideUnitGenGate({
      isTauri: true,
      projectRoot: "  ",
      ideReady: true,
      mdPath: "x.md",
      tcLabel: "TC-1",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "no_root");
  });

  it("fails without IDE — does not proceed to Gen", () => {
    const r = decideUnitGenGate({
      isTauri: true,
      projectRoot: "D:/forensic",
      ideReady: false,
      mdPath: null,
      tcLabel: "TC-1",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "no_ide");
      assert.equal(r.cta, "connect_ide");
    }
  });

  it("fails without Approved TC MD when IDE ready", () => {
    const r = decideUnitGenGate({
      isTauri: true,
      projectRoot: "D:/forensic",
      ideReady: true,
      mdPath: null,
      tcLabel: "TC-LOGIN",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "no_sync_md");
      assert.equal(r.cta, "sync_md");
    }
  });

  it("passes only with authoritative decision and matching projections", () => {
    const r = decideUnitGenGate({
      isTauri: true,
      projectRoot: "D:/forensic",
      ideReady: true,
      mdPath: "AItest/test-cases/m/TC-1.md",
      tcLabel: "TC-1",
      hasAuthoritativeDecision: true,
      hasSourceMarkers: true,
      projectionsMatch: true,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.mdPath, "AItest/test-cases/m/TC-1.md");
  });

  it("fails without an authoritative IDE Approve decision", () => {
    const r = decideUnitGenGate({
      isTauri: true,
      projectRoot: "D:/forensic",
      ideReady: true,
      mdPath: "AItest/test-cases/m/TC-092.md",
      tcLabel: "TC-092",
      hasAuthoritativeDecision: false,
      decisionReason: "IDE Approve outcome FEATURE_GAP",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "missing_decision");
      assert.match(r.message, /FEATURE_GAP/);
    }
  });

  it("fails when MD projections do not match the decision", () => {
    const r = decideUnitGenGate({
      isTauri: true,
      projectRoot: "D:/forensic",
      ideReady: true,
      mdPath: "AItest/test-cases/m/TC-092.md",
      tcLabel: "TC-092",
      hasAuthoritativeDecision: true,
      hasSourceMarkers: true,
      projectionsMatch: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "projection_mismatch");
  });
});

describe("decideUnitLanguageGate", () => {
  it("passes when language is set", () => {
    const r = decideUnitLanguageGate({
      language: "C#",
      sourcePaths: ["a.cs", "b.ts"],
    });
    assert.equal(r.ok, true);
  });

  it("fails on mixed C#+TS when language empty", () => {
    const r = decideUnitLanguageGate({
      language: "",
      sourcePaths: [
        "src/App/Handlers/Foo.cs",
        "ClientApp/src/app/foo.service.ts",
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "needs_language");
      assert.match(r.message, /C#.*TS\/JS/);
    }
  });

  it("passes when only one stack present", () => {
    assert.equal(
      decideUnitLanguageGate({
        language: "",
        sourcePaths: ["src/App/Foo.cs"],
      }).ok,
      true
    );
    assert.equal(
      decideUnitLanguageGate({
        language: null,
        sourcePaths: ["src/foo.ts"],
      }).ok,
      true
    );
  });
});
