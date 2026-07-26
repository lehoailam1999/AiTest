/**
 * P3 contract tests — budget + ClientApp noise filter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClientAppMirrorNoise,
  filterNoisePaths,
  enforceContextBudget,
  IDE_CONTEXT_BUDGET,
  TIER_PRIORITY,
  type RankedFile,
} from "./contextBudget.js";

describe("contextBudget P3", () => {
  it("flags unrelated ClientApp/src/app feature folders as noise", () => {
    const seed = "ClientApp/src/app/forensic/case-record/case.service.ts";
    assert.equal(
      isClientAppMirrorNoise(
        "ClientApp/src/app/admin/users/user.component.ts",
        seed
      ),
      true
    );
    assert.equal(
      isClientAppMirrorNoise(
        "ClientApp/src/app/forensic/case-record/case.model.ts",
        seed
      ),
      false
    );
  });

  it("filterNoisePaths drops deep mirrors", () => {
    const seed = "src/auth/auth.service.ts";
    const paths = [
      "src/auth/user.repository.ts",
      "ClientApp/src/app/admin/x.component.ts",
      "src/auth/auth.types.ts",
    ];
    const kept = filterNoisePaths(paths, seed);
    assert.deepEqual(kept, ["src/auth/user.repository.ts", "src/auth/auth.types.ts"]);
  });

  it("enforceContextBudget keeps primary + ctor, drops overflow", () => {
    const files: RankedFile[] = [
      {
        pathRel: "a.ts",
        role: "primary",
        content: "P".repeat(100),
        tier: "primary",
        rankScore: TIER_PRIORITY.primary,
      },
      {
        pathRel: "ctor.ts",
        role: "dependency",
        content: "C".repeat(100),
        why: "IDE constructor: Repo",
        tier: "ctor",
        rankScore: TIER_PRIORITY.ctor,
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        pathRel: `ov${i}.ts`,
        role: "overview" as const,
        content: "O".repeat(5000),
        tier: "overview" as const,
        rankScore: TIER_PRIORITY.overview - i,
      })),
    ];
    const { files: out, omittedPaths } = enforceContextBudget(files, {
      ...IDE_CONTEXT_BUDGET,
      maxTotalChars: 8_000,
      maxOverviewFiles: 2,
    });
    assert.ok(out.some((f) => f.role === "primary"));
    assert.ok(out.some((f) => f.pathRel === "ctor.ts"));
    assert.ok(omittedPaths.length > 0);
    const total = out.reduce((n, f) => n + f.content.length, 0);
    assert.ok(total <= 8_000 + 50); // small slack for truncate marker
  });
});
