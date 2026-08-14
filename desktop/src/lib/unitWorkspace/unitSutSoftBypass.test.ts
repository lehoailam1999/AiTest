import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSoftBypassUnitSutGate } from "./unitSutSoftBypass.ts";

describe("canSoftBypassUnitSutGate", () => {
  it("requires HIGH confidence or alignment", () => {
    assert.equal(
      canSoftBypassUnitSutGate({
        code: "FAIL_SUT_MISMATCH",
        primaryPath: "src/Foo.cs",
        sourceExcerpt: "class Foo {}",
        tcBlob: "confidence=MEDIUM",
        alignmentScore: 10,
        minAlignment: 50,
        markersMatch: true,
      }),
      false
    );
    assert.equal(
      canSoftBypassUnitSutGate({
        code: "FAIL_FEATURE_GAP",
        primaryPath: "src/Foo.cs",
        sourceExcerpt: "class Foo {}",
        tcBlob: "confidence=HIGH",
        alignmentScore: 10,
        markersMatch: true,
      }),
      true
    );
  });
});
