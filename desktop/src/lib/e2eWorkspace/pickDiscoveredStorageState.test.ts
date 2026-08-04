import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickDiscoveredStorageStateRel } from "./pickDiscoveredStorageState.js";

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
