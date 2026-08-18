import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  serializeUnitSourceGroundingContract,
  unitGroundingContractRelPath,
  type UnitSourceGroundingContract,
} from "./unitSourceGroundingContract";

describe("Unit grounding persistence boundary", () => {
  it("places the immutable decision beside its TC Markdown projection", () => {
    assert.equal(
      unitGroundingContractRelPath(
        "AItest/test-cases/UnitTest/foo/TC-001.md"
      ),
      "AItest/test-cases/UnitTest/foo/TC-001.grounding.json"
    );
  });

  it("serializes without deriving or altering grounding fields", () => {
    const contract = {
      schema: "aitest-unit-grounding-v1",
      source: "ide-repository-intelligence",
      authoritative: true,
      primary: { pathRel: "src/Foo.cs", code: "Foo.Handle" },
    } as UnitSourceGroundingContract;
    assert.deepEqual(
      JSON.parse(serializeUnitSourceGroundingContract(contract)),
      contract
    );
  });
});
