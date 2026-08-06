import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickDiscoveredStorageStateRel } from "./pickDiscoveredStorageState.js";
import {
  buildE2EEnvConfig,
  normalizeE2eStorageStateRel,
  playwrightEnvFromConfig,
} from "./env.js";

describe("pickDiscoveredStorageStateRel", () => {
  it("prefers defaultRole valid storage", () => {
    const rel = pickDiscoveredStorageStateRel({
      defaultRole: "admin",
      roles: [
        {
          role: "user",
          storageStateValid: true,
          storageStateRel: "AItest/E2ETest/M/fixtures/storageState-user.json",
        },
        {
          role: "admin",
          storageStateValid: true,
          storageStateRel: "AItest/E2ETest/M/fixtures/storageState-admin.json",
        },
      ],
    });
    assert.equal(rel, "AItest/E2ETest/M/fixtures/storageState-admin.json");
  });

  it("falls back to any valid role", () => {
    const rel = pickDiscoveredStorageStateRel({
      defaultRole: "missing",
      roles: [
        {
          role: "user",
          storageStateValid: true,
          storageStateRel: "AItest/fixtures/storageState.json",
        },
      ],
    });
    assert.equal(rel, "AItest/fixtures/storageState.json");
  });

  it("returns undefined when none valid", () => {
    assert.equal(
      pickDiscoveredStorageStateRel({
        defaultRole: "admin",
        roles: [{ role: "admin", storageStateValid: false }],
      }),
      undefined
    );
  });
});

describe("normalizeE2eStorageStateRel (S3.4)", () => {
  it("maps AItest nested path to TC-relative fixtures", () => {
    assert.equal(
      normalizeE2eStorageStateRel("AItest/E2ETest/M/fixtures/storageState.json"),
      "./fixtures/storageState.json"
    );
  });

  it("keeps already TC-relative path", () => {
    assert.equal(
      normalizeE2eStorageStateRel("./fixtures/storageState.json"),
      "./fixtures/storageState.json"
    );
  });

  it("injects E2E_STORAGE_STATE + E2E_ROLE into playwright env", () => {
    const env = buildE2EEnvConfig({
      targetUrl: "http://localhost:3000",
      storageStateRel: "AItest/E2ETest/M/fixtures/storageState.json",
      role: "admin",
      featurePath: "/admin/rooms",
    });
    const pe = playwrightEnvFromConfig(env);
    assert.equal(pe.E2E_STORAGE_STATE, "./fixtures/storageState.json");
    assert.equal(pe.E2E_ROLE, "admin");
    assert.equal(pe.E2E_FEATURE_PATH, "/admin/rooms");
  });
});
