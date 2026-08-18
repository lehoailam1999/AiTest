import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compiledAitestArtifactRels,
  emptyAitestParentRels,
} from "../testOutputLayout.js";

describe("staging file path match", () => {
  function matchStagedPath(filePath: string, targetRel: string): boolean {
    const n = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");
    const a = n(filePath);
    const b = n(targetRel);
    if (a === b) return true;
    const aBase = a.split("/").pop() || "";
    const bBase = b.split("/").pop() || "";
    return !!aBase && aBase === bBase && (a.endsWith(b) || b.endsWith(a));
  }

  it("matches exact and suffix paths", () => {
    assert.equal(
      matchStagedPath(
        "AItest/E2ETest/Req/TC/specs/foo.spec.ts",
        "AItest/E2ETest/Req/TC/specs/foo.spec.ts"
      ),
      true
    );
    assert.equal(
      matchStagedPath(
        "AItest/E2ETest/Req/TC/specs/foo.spec.ts",
        "backend/AItest/E2ETest/Req/TC/specs/foo.spec.ts"
      ),
      true
    );
    assert.equal(
      matchStagedPath("specs/foo.spec.ts", "AItest/E2ETest/Req/TC/specs/bar.spec.ts"),
      false
    );
  });
});

describe("delete from staging also removes source AItest paths", () => {
  it("lists compiled artifacts for repo-root AItest TS", () => {
    const rels = compiledAitestArtifactRels(
      "AItest/UnitTest/Order/CreateHandler.test.ts"
    );
    assert.ok(rels.includes("dist/AItest/UnitTest/Order/CreateHandler.test.js"));
    assert.ok(rels.includes("dist/AItest/UnitTest/Order/CreateHandler.test.js.map"));
  });

  it("lists compiled artifacts under a package prefix", () => {
    const rels = compiledAitestArtifactRels(
      "backend/AItest/UnitTest/Order/CreateHandler.test.ts"
    );
    assert.ok(
      rels.includes("backend/dist/AItest/UnitTest/Order/CreateHandler.test.js")
    );
    assert.equal(
      rels.some((p) => p.startsWith("dist/")),
      false
    );
  });

  it("does not invent artifacts for C# sources", () => {
    assert.deepEqual(
      compiledAitestArtifactRels(
        "AItest/UnitTest/Tạo-mới/EvidenceCreateCommandHandlerTests.cs"
      ),
      []
    );
  });

  it("walks empty parents from the file up to AItest", () => {
    assert.deepEqual(
      emptyAitestParentRels(
        "AItest/UnitTest/Tạo-mới-vật-chứng/EvidenceCreateCommandHandlerTests.cs"
      ),
      [
        "AItest/UnitTest/Tạo-mới-vật-chứng",
        "AItest/UnitTest",
        "AItest",
      ]
    );
  });

  it("keeps the package prefix when pruning nested AItest", () => {
    assert.deepEqual(
      emptyAitestParentRels("svc-api/AItest/UnitTest/Todo/x.test.ts"),
      ["svc-api/AItest/UnitTest/Todo", "svc-api/AItest/UnitTest", "svc-api/AItest"]
    );
  });
});
