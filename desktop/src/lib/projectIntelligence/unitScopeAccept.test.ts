import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAcceptableUnitScopePath,
  pickFirstAcceptableUnitScopePath,
} from "./unitScopeAccept";

describe("unitScopeAccept", () => {
  it("rejects Account command for Evidence TC (alias)", () => {
    const tcText = "Tạo mới vật chứng - mã trùng\nModule: Tạo mới vật chứng";
    const aliases = { "vat chung": ["Evidence"] };
    assert.equal(
      isAcceptableUnitScopePath({
        pathRel: "src/App/Commands/Account/AccountCreateCommand.cs",
        tcText,
        codeAliases: aliases,
      }),
      false
    );
    assert.equal(
      isAcceptableUnitScopePath({
        pathRel: "src/App/Commands/Evidence/EvidenceCreateCommand.cs",
        tcText,
        codeAliases: aliases,
      }),
      true
    );
  });

  it("rejects migration / designer artifacts", () => {
    assert.equal(
      isAcceptableUnitScopePath({
        pathRel: "src/Data/Migrations/20240101_AddX.Designer.cs",
        tcText: "path: src/Evidence/EvidenceService.cs\ncode: EvidenceService",
      }),
      false
    );
  });

  it("picks first domain-ok path", () => {
    const tcText = [
      "Tạo mới vật chứng",
      "path: src/App/Commands/Evidence/EvidenceCreateCommand.cs",
      "code: EvidenceCreateCommand",
    ].join("\n");
    const picked = pickFirstAcceptableUnitScopePath(
      [
        "src/App/Commands/Account/AccountCreateCommand.cs",
        "src/App/Commands/Evidence/EvidenceCreateCommand.cs",
      ],
      { tcText }
    );
    assert.equal(picked, "src/App/Commands/Evidence/EvidenceCreateCommand.cs");
  });
});
