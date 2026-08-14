import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  absUnderProject,
  buildIdePlaywrightCommand,
  e2eSpecArgFromCwd,
  e2eSpecPathsMatch,
  e2eSpecWorkCwd,
  findSpecReportForPrimary,
  normalizeE2eSpecPath,
  stripE2eSpecHashSuffix,
} from "./e2eSpecPathMatch";

describe("e2eSpecPathMatch", () => {
  it("normalizes AItest prefix and slashes", () => {
    assert.equal(
      normalizeE2eSpecPath("AItest\\E2ETest\\Req\\TC\\specs\\a.spec.ts"),
      "E2ETest/Req/TC/specs/a.spec.ts"
    );
  });

  it("strips 8-char hash before .spec", () => {
    assert.equal(
      stripE2eSpecHashSuffix("upload.6123e568.spec.ts"),
      "upload.spec.ts"
    );
    assert.equal(stripE2eSpecHashSuffix("upload.spec.ts"), "upload.spec.ts");
  });

  it("matches primary vs report despite hash / prefix drift", () => {
    const primary =
      "AItest/E2ETest/Vat-chung/E2E-Validation-Upload-6123e568/specs/upload.6123e568.spec.ts";
    const report =
      "E2ETest/Vat-chung/E2E-Validation-Upload-6123e568/specs/upload.spec.ts";
    assert.equal(e2eSpecPathsMatch(primary, report), true);
  });

  it("matches by TC folder when leaf names differ", () => {
    const primary =
      "AItest/E2ETest/M/E2E-HappyPath-foo-ba600af6/specs/a.ba600af6.spec.ts";
    const report = "E2ETest/M/E2E-HappyPath-foo-ba600af6/specs/journey.spec.ts";
    assert.equal(e2eSpecPathsMatch(primary, report), true);
  });

  it("sole-TC fallback uses only failing report row", () => {
    const row = findSpecReportForPrimary(
      "AItest/E2ETest/M/T/specs/missing-name.spec.ts",
      [
        {
          specPath: "E2ETest/M/T/specs/other.spec.ts",
          success: false,
          errorExcerpt: "toBeVisible undefined",
        },
      ],
      { soleTcFallback: true }
    );
    assert.ok(row);
    assert.match(row!.errorExcerpt || "", /toBeVisible/);
  });

  it("resolves per-TC playwright cwd and spec arg", () => {
    const spec =
      "AItest/E2ETest/Create-evidence/TC-slug/specs/evidence.spec.ts";
    assert.equal(
      e2eSpecWorkCwd(spec),
      "AItest/E2ETest/Create-evidence/TC-slug"
    );
    assert.equal(e2eSpecArgFromCwd(spec), "specs/evidence.spec.ts");
    assert.equal(
      absUnderProject("D:/Xlab/Forensic/forensic", "test/Forensic.E2E"),
      "D:/Xlab/Forensic/forensic/test/Forensic.E2E"
    );
    assert.deepEqual(
      buildIdePlaywrightCommand({
        packageRootAbs: "D:/Xlab/Forensic/forensic/test/Forensic.E2E",
        specArg: "specs/evidence.spec.ts",
        headed: true,
      }),
      [
        "npx",
        "--prefix",
        "D:/Xlab/Forensic/forensic/test/Forensic.E2E",
        "playwright",
        "test",
        "specs/evidence.spec.ts",
        "--headed",
      ]
    );
  });
});
