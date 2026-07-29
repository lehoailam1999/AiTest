/**
 * EX5.1 — pickDefaultE2ePreviewPath / toIdePathRel
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pickDefaultE2ePreviewPath,
  toIdePathRel,
} from "../../features/e2e-test/e2eFilePreview";

describe("e2eFilePreview EX5", () => {
  it("prefers spec over page", () => {
    const path = pickDefaultE2ePreviewPath([
      { path: "AItest/E2ETest/Login/pages/login.page.ts", kind: "page" },
      { path: "AItest/E2ETest/Login/specs/login.spec.ts", kind: "spec" },
    ]);
    assert.equal(path, "AItest/E2ETest/Login/specs/login.spec.ts");
  });

  it("falls back to page then first", () => {
    assert.equal(
      pickDefaultE2ePreviewPath([
        { path: "AItest/E2ETest/X/pages/x.page.ts", kind: "page" },
      ]),
      "AItest/E2ETest/X/pages/x.page.ts"
    );
    assert.equal(
      pickDefaultE2ePreviewPath([{ path: "a.ts", kind: "other" }]),
      "a.ts"
    );
    assert.equal(pickDefaultE2ePreviewPath([]), null);
  });

  it("normalizes IDE pathRel", () => {
    assert.equal(toIdePathRel(".\\AItest\\E2ETest\\a.spec.ts"), "AItest/E2ETest/a.spec.ts");
    assert.equal(toIdePathRel("./foo/bar.ts"), "foo/bar.ts");
  });
});
