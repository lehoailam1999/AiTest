import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slimTcMdForGen } from "./slimTcMdForGen.ts";
import {
  inferDtoCandidatePaths,
  resolveTestDataForGen,
} from "./unitGenPromptPrep.ts";

describe("slimTcMdForGen", () => {
  it("strips Grounding block and ruleHits noise", () => {
    const raw = [
      "# TC-100",
      "path: src/A.cs",
      "code: A",
      "## Grounding",
      "requirement: R",
      "module: M",
      "## Test Data",
      "path: src/A.cs",
      "code: A",
      "// ruleHits=throw+BadRequest",
    ].join("\n");
    const slim = slimTcMdForGen(raw);
    assert.doesNotMatch(slim, /## Grounding/);
    assert.doesNotMatch(slim, /ruleHits=/);
    assert.match(slim, /## Test Data/);
    assert.match(slim, /path: src\/A\.cs/);
  });

  it("strips YAML frontmatter and Meta table", () => {
    const raw = [
      "---",
      "id: uuid-1",
      "testCaseId: TC-001",
      "title: Sample",
      "---",
      "",
      "# Sample",
      "",
      "## Meta",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Code | `TC-001` |",
      "| Module | Storage |",
      "",
      "## Steps",
      "",
      "1. Do thing",
      "",
      "## Expected Result",
      "",
      "Ok",
      "",
      "## Test Data",
      "",
      "path: src/A.cs",
      "code: A",
      "path: src/A.cs",
      "<!-- aitest:approved-tc-artifact — noise -->",
    ].join("\n");
    const slim = slimTcMdForGen(raw);
    assert.doesNotMatch(slim, /^---/m);
    assert.doesNotMatch(slim, /## Meta/);
    assert.doesNotMatch(slim, /aitest:approved-tc-artifact/);
    assert.match(slim, /## Steps/);
    assert.match(slim, /## Expected Result/);
    assert.equal((slim.match(/^path:\s*src\/A\.cs$/gim) || []).length, 1);
  });
});

describe("resolveTestDataForGen", () => {
  it("injects target.property from code-aliases.fields", () => {
    const md = "target.field: Địa điểm thu giữ\nstatus: READY_FOR_CODEGEN";
    const { md: out, resolvedProperty } = resolveTestDataForGen(md, {
      fields: { "Địa điểm thu giữ": ["SeizureLocation"] },
    } as never);
    assert.equal(resolvedProperty, "SeizureLocation");
    assert.match(out, /target\.property:\s*SeizureLocation/);
  });
});

describe("inferDtoCandidatePaths", () => {
  it("infers EvidenceDto from EvidenceUpdateCommandHandler", () => {
    const hits = inferDtoCandidatePaths(
      "src/App/EvidenceUpdateCommandHandler.cs",
      [
        "src/App/EvidenceDocumentDto.cs",
        "src/App/EvidenceDto.cs",
        "src/App/AssignEvidenceDto.cs",
      ]
    );
    assert.ok(hits.some((p) => /EvidenceDto\.cs$/i.test(p)));
  });
});
