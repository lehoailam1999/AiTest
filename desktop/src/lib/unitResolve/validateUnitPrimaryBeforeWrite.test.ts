import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractUnitIntent } from "@aitest/ide-protocol";
import { snapshotFromPaths } from "./snapshotFromPaths.js";
import { validateUnitPrimaryBeforeWrite } from "./validateUnitPrimaryBeforeWrite.js";

describe("validateUnitPrimaryBeforeWrite (Layer 3)", () => {
  const paths = [
    "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
    "src/App/Commands/Widget/WidgetUpdateCommandHandler.cs",
  ];
  const snap = snapshotFromPaths(paths);
  const intent = extractUnitIntent(
    {
      title: "Tạo mới widget - thành công",
      module: "Tạo mới widget",
      steps: "1. Create",
      expectedResult: "ACCEPT",
      testData: "",
      precondition: "",
    },
    { requirementTitle: "Create widget", projectAliases: {} }
  );
  const shapeBlob = "Create widget\nTạo mới widget\nTạo mới widget - thành công";

  it("passes when path+code in index and CRUD aligned", () => {
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: paths[0]!,
      code: "WidgetCreateCommandHandler",
      moduleGated: true,
      intent,
      shapeBlob,
      source: "index.db",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.checks.includes("indexFile"));
    assert.ok(r.checks.includes("crudVerb"));
    assert.ok(r.checks.includes("symbolType") || r.checks.includes("symbolStem"));
  });

  it("fails when path missing from index", () => {
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: "src/Missing/NoHandler.cs",
      code: "NoHandler",
      moduleGated: true,
      intent,
      shapeBlob,
    });
    assert.equal(r.ok, false);
    assert.match(r.skipReason || "", /path not in index/);
  });

  it("fails when moduleGate missing (non-LLM)", () => {
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: paths[0]!,
      code: "WidgetCreateCommandHandler",
      moduleGated: false,
      intent,
      shapeBlob,
      source: "index.db",
    });
    assert.equal(r.ok, false);
    assert.match(r.skipReason || "", /moduleGate/);
  });

  it("fails when code symbol mismatches file", () => {
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: paths[0]!,
      code: "TotallyInventedHandler",
      moduleGated: true,
      intent,
      shapeBlob,
    });
    assert.equal(r.ok, false);
    assert.match(r.skipReason || "", /not in symbolsByFile/);
  });

  it("fails CRUD contradict — update path for create TC", () => {
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: paths[1]!,
      code: "WidgetUpdateCommandHandler",
      moduleGated: true,
      intent,
      shapeBlob,
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.skipReason || "", /contradict/);
  });

  it("fails empty excerpt when excerpt provided", () => {
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: paths[0]!,
      code: "WidgetCreateCommandHandler",
      moduleGated: true,
      intent,
      shapeBlob,
      excerpt: "   ",
    });
    assert.equal(r.ok, false);
    assert.match(r.skipReason || "", /excerpt empty/);
  });

  it("fails VALIDATION when excerpt lacks required signal", () => {
    const valIntent = extractUnitIntent(
      {
        title: "Update - empty field - reject",
        module: "Update",
        steps: "1. Act",
        expectedResult: "REJECT",
        testData:
          "primaryBucket: VALIDATION_DATA\n" +
          "target.field: Name\n" +
          "target.constraint: required",
        precondition: "",
      },
      { requirementTitle: "Update", projectAliases: {} }
    );
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: paths[0]!,
      code: "WidgetCreateCommandHandler",
      moduleGated: true,
      intent: valIntent,
      shapeBlob,
      excerpt: "public async Task Handle() { await _repo.Save(); }",
      testData:
        "primaryBucket: VALIDATION_DATA\n" +
        "target.field: Name\n" +
        "target.constraint: required",
    });
    assert.equal(r.ok, false);
    assert.match(r.skipReason || "", /required/);
    assert.ok(r.checks.includes("behaviorExcerpt"));
  });

  it("Type.Method soft-passes when method not in lightweight snapshot", () => {
    const r = validateUnitPrimaryBeforeWrite({
      codeIndex: snap,
      pathRel: paths[0]!,
      code: "WidgetCreateCommandHandler.Handle",
      moduleGated: true,
      intent,
      shapeBlob,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.checks.includes("methodSoft"));
  });
});
