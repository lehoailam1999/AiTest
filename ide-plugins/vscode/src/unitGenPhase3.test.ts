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
