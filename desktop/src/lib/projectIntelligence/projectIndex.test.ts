import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildProjectIndex,
  findByToken,
  stemLookupTokens,
} from "./projectIndex.js";

describe("projectIndex byToken", () => {
  it("indexes PascalCase stem parts for fast lookup", () => {
    const index = buildProjectIndex([
      "src/Evidence/CreateEvidenceCommandHandler.cs",
      "src/Account/AccountCreateCommandHandler.cs",
      "docs/readme.md",
    ]);
    assert.ok(index.byToken.size > 0);
    const evidence = findByToken(index, "Evidence");
    assert.ok(evidence.some((f) => f.pathRel.includes("CreateEvidence")));
    const create = findByToken(index, "Create");
    assert.ok(create.length >= 2);
    assert.deepEqual(
      stemLookupTokens("DigitalEvidenceClassificationForm").includes("digital"),
      true
    );
  });

  it("skips generic folder tokens like src/services", () => {
    const index = buildProjectIndex(["src/services/EvidenceService.ts"]);
    assert.equal(findByToken(index, "src").length, 0);
    assert.equal(findByToken(index, "services").length, 0);
    assert.ok(findByToken(index, "Evidence").length >= 1);
  });
});
