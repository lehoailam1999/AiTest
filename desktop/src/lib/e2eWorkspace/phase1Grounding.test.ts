import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveFeaturePathFromTc,
  extractAbsolutePaths,
} from "./deriveFeaturePathFromTc.js";
import { e2eFeRankBonus } from "./resolveE2eFeSources.js";
import { buildE2EEnvConfig, playwrightEnvFromConfig } from "./env.js";
import {
  buildGenerateE2eRunBody,
  loadGenerateGroundingProfile,
  resolveFeaturePathSeed,
} from "./generateGrounding.js";
import type { ProfileIo } from "../projectProfile/types.js";

function memoryIo(files: Record<string, string>): ProfileIo {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (_r, p) => files[p.replace(/\\/g, "/")],
    writeFile: async (_r, p, c) => {
      files[p.replace(/\\/g, "/")] = c;
    },
    readFileOptional: async (_r, p) => files[p.replace(/\\/g, "/")] ?? null,
    fileExists: async (_r, p) => p.replace(/\\/g, "/") in files,
  };
}

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

  it("does not invent featurePath from unmatched FE folder alone", () => {
    const p = deriveFeaturePathFromTc({
      title: "Tao moi vat chung de trong ten",
      feFilePaths: [
        "src/app/admin/case-person/update/case-person-update.component.ts",
      ],
    });
    assert.equal(p, undefined);
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

  it("prefers create modal over list shell", async () => {
    const { formSurfaceCandidatePaths } = await import("./resolveE2eFeSources.js");
    const cands = formSurfaceCandidatePaths(
      "src/ClientApp/src/app/admin/evidence/list/evidence.component.html",
      "Tạo mới vật chứng"
    );
    assert.ok(cands.some((p) => /create/i.test(p) && /evidence/i.test(p)));
    assert.ok(
      cands.some((p) =>
        p.endsWith(
          "/admin/evidence/create/evidence-create-modal.component.html"
        )
      ),
      `expected create-modal under evidence/, got: ${cands.slice(0, 3).join(" | ")}`
    );
    assert.ok(
      e2eFeRankBonus(
        "src/ClientApp/src/app/admin/evidence/create/evidence-create-modal.component.html"
      ) >
        e2eFeRankBonus(
          "src/ClientApp/src/app/admin/evidence/list/evidence.component.html"
        )
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

  it("injects E2E_<ROLE>_USERNAME|PASSWORD", () => {
    const env = buildE2EEnvConfig({
      targetUrl: "http://localhost:9000",
      username: "admin",
      password: "admin",
      role: "admin",
      roleCredentials: {
        admin: { username: "admin", password: "admin" },
        user: { username: "user", password: "user" },
      },
    });
    const pe = playwrightEnvFromConfig(env);
    assert.equal(pe.E2E_USERNAME, "admin");
    assert.equal(pe.E2E_ADMIN_USERNAME, "admin");
    assert.equal(pe.E2E_ADMIN_PASSWORD, "admin");
    assert.equal(pe.E2E_USER_USERNAME, "user");
    assert.equal(pe.E2E_USER_PASSWORD, "user");
  });
});

describe("Sprint 2.1 featurePath seed priority", () => {
  it("prefers TC marker over moduleMap", () => {
    const p = resolveFeaturePathSeed({
      testCase: {
        module: "Evidence",
        testData: "path: /tc-path\nauthRole: admin",
      },
      moduleMap: { Evidence: "/module-map-path" },
      phase5FeaturePathHint: "/hint-path",
    });
    assert.equal(p, "/tc-path");
  });

  it("uses moduleMap when TC has no path marker", () => {
    const p = resolveFeaturePathSeed({
      testCase: {
        module: "Evidence",
        testData: "authRole: admin",
      },
      moduleMap: { Evidence: "/module-map-path" },
      phase5FeaturePathHint: "/hint-path",
    });
    assert.equal(p, "/module-map-path");
  });

  it("fuzzy-matches module tokens to moduleMap path segments", () => {
    const p = resolveFeaturePathSeed({
      testCase: {
        module: "Evidence upload",
        testData: "authRole: admin",
      },
      moduleMap: { rooms: "/admin/rooms", evidence: "/admin/evidence" },
    });
    assert.equal(p, "/admin/evidence");
  });
});

describe("Sprint 2.1 projectRules payload", () => {
  it("includes projectRules in run body", () => {
    const body = buildGenerateE2eRunBody({
      projectId: "p1",
      testCaseId: "tc1",
      targetUrl: "http://localhost:4200",
      projectRoot: "D:/sut",
      locatorContract: "data-testid: save-btn",
      projectRules: "# E2E conventions from profile",
    });
    assert.equal(
      (body.projectRules as string) || "",
      "# E2E conventions from profile"
    );
    assert.equal(body.projectRulesSource, "e2e-conventions");
    assert.equal(body.skipAutoInspect, true);
  });

  it("keeps explicit empty projectRules (no meta fallback intent)", () => {
    const body = buildGenerateE2eRunBody({
      projectId: "p1",
      testCaseId: "tc1",
      targetUrl: "http://localhost:4200",
      projectRoot: "D:/sut",
      locatorContract: "data-testid: save-btn",
      projectRules: "",
    });
    assert.equal(body.projectRules, "");
    assert.equal(body.projectRulesSource, "none");
  });
});

describe("Sprint 2.2 load generate grounding profile", () => {
  it("loads profile + conventions excerpt from .ai-test", async () => {
    const io = memoryIo({
      ".ai-test/project.profile.json": JSON.stringify({
        schema: "aitest-project-profile-v1",
        runner: "playwright",
        testRoot: "AItest/E2ETest",
        auth: { strategy: "storageState", storageDir: ".ai-test/auth", roles: [] },
        locatorPolicy: ["testid", "role", "label"],
        moduleMap: { Evidence: "/admin/evidence" },
        reuseRoots: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      ".ai-test/e2e-conventions.md":
        "# E2E conventions\n- Use stable data-cy selectors\n- Avoid fake asserts",
    });
    const loaded = await loadGenerateGroundingProfile("/proj", io);
    assert.equal(loaded.projectProfile?.runner, "playwright");
    assert.equal(
      loaded.projectProfile?.moduleMap?.Evidence,
      "/admin/evidence"
    );
    assert.match(loaded.projectRules, /Use stable data-cy selectors/);
    assert.equal(loaded.meta.profileSource, "project-profile");
    assert.equal(loaded.meta.rulesSource, "e2e-conventions");
    assert.equal(loaded.meta.moduleMapCount, 1);
    assert.ok(loaded.meta.projectRulesChars > 0);
  });

  it("returns null/empty when profile files are absent", async () => {
    const io = memoryIo({});
    const loaded = await loadGenerateGroundingProfile("/proj", io);
    assert.equal(loaded.projectProfile, null);
    assert.equal(loaded.projectRules, "");
    assert.equal(loaded.meta.profileSource, "none");
    assert.equal(loaded.meta.rulesSource, "none");
    assert.equal(loaded.meta.moduleMapCount, 0);
    assert.equal(loaded.meta.projectRulesChars, 0);
  });
});
