import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveFeaturePathFromTc,
  extractAbsolutePaths,
} from "./deriveFeaturePathFromTc.js";
import { e2eFeRankBonus } from "./resolveE2eFeSources.js";
import { buildE2EEnvConfig, playwrightEnvFromConfig } from "./env.js";

describe("deriveFeaturePathFromTc", () => {
  it("reads path marker from testData", () => {
    const p = deriveFeaturePathFromTc({
      testData: "path: /evidence\nauthRole: admin",
    });
    assert.equal(p, "/evidence");
  });

  it("picks route matching TC tokens", () => {
    const p = deriveFeaturePathFromTc({
      title: "Upload vật chứng evidence",
      routes: ["/login", "/evidence", "/admin/users"],
    });
    assert.equal(p, "/evidence");
  });

  it("ignores auth routes alone", () => {
    const p = deriveFeaturePathFromTc({
      title: "Login",
      routes: ["/login", "/signin"],
    });
    assert.equal(p, undefined);
  });

  it("extracts path from Spec Feature entry comment", () => {
    const p = deriveFeaturePathFromTc({
      title: "Hoàn tất tạo vật chứng",
      specSource:
        "// Feature entry: /admin/evidence (FE app.routes admin + admin.routes evidence)\n" +
        "await pom.gotoFeature();",
    });
    assert.equal(p, "/admin/evidence");
  });

  it("composes /admin/evidence from FE file path + routes", () => {
    const p = deriveFeaturePathFromTc({
      title: "Vật chứng evidence list",
      feSource: `
        path: 'admin',
        path: 'evidence',
        path: 'user-management',
      `,
      feFilePaths: [
        "src/ClientApp/src/app/admin/evidence/list/evidence.component.ts",
      ],
    });
    assert.equal(p, "/admin/evidence");
  });
});

describe("extractAbsolutePaths", () => {
  it("finds E2E_FEATURE_PATH || /admin/evidence", () => {
    const paths = extractAbsolutePaths(
      "1. Feature entry — Chọn tính năng (E2E_FEATURE_PATH || /admin/evidence)"
    );
    assert.ok(paths.includes("/admin/evidence"));
  });
});

describe("e2eFeRankBonus", () => {
  it("prefers component html over controller", () => {
    assert.ok(
      e2eFeRankBonus("src/ClientApp/evidence.component.html") >
        e2eFeRankBonus("src/Forensic/Controllers/EvidenceController.cs")
    );
  });
});

describe("E2E_FEATURE_PATH env", () => {
  it("injects featurePath", () => {
    const env = buildE2EEnvConfig({
      targetUrl: "http://localhost:9000",
      featurePath: "/evidence",
    });
    const pe = playwrightEnvFromConfig(env);
    assert.equal(pe.E2E_FEATURE_PATH, "/evidence");
  });
});
