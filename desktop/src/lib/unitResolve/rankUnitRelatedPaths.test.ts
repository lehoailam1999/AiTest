import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { behaviorEvidenceInExcerpt } from "./behaviorEvidenceInExcerpt.js";
import {
  isNoisyUnitRelatedPath,
  mergeUnitRelatedCandidates,
  rankUnitRelatedPaths,
} from "./rankUnitRelatedPaths.js";

describe("rankUnitRelatedPaths", () => {
  it("filters noisy FE/migration paths", () => {
    const ranked = rankUnitRelatedPaths(
      "src/App/Handlers/UpdateHandler.cs",
      [
        "src/App/Dto/EvidenceDto.cs",
        "src/Forensic/ClientApp/src/app/evidence/evidence.component.ts",
        "src/App/Migrations/20260101_init.cs",
      ],
      { preferDtoValidator: true }
    );
    assert.ok(ranked.some((p) => /EvidenceDto/i.test(p)));
    assert.ok(!ranked.some((p) => /ClientApp/i.test(p)));
    assert.ok(!ranked.some((p) => /Migrations/i.test(p)));
  });

  it("merge prefers expanded when enough", () => {
    const merged = mergeUnitRelatedCandidates(
      "src/App/Handlers/UpdateHandler.cs",
      ["src/App/Dto/EvidenceDto.cs", "src/App/Commands/UpdateCommand.cs"],
      ["src/Forensic/ClientApp/noise.ts"],
      { maxRelated: 4, preferDtoValidator: true }
    );
    assert.equal(merged.length, 2);
    assert.ok(!merged.some((p) => /ClientApp/i.test(p)));
  });

  it("isNoisyUnitRelatedPath detects component", () => {
    assert.equal(
      isNoisyUnitRelatedPath("src/foo/bar.component.ts"),
      true
    );
  });
});

describe("behaviorEvidenceInExcerpt", () => {
  it("passes when required constraint in DTO excerpt", () => {
    const r = behaviorEvidenceInExcerpt(
      "primaryBucket: VALIDATION_DATA\ntarget.constraint: required\ntarget.field: SeizureLocation",
      "public class EvidenceDto { [Required] public string SeizureLocation { get; set; } }"
    );
    assert.equal(r.ok, true);
  });

  it("fails when handler lacks validation for required TC", () => {
    const r = behaviorEvidenceInExcerpt(
      "primaryBucket: VALIDATION_DATA\ntarget.constraint: required\ntarget.field: SeizureLocation",
      "public async Task Handle() { await _repo.UpdateAsync(entity); }"
    );
    assert.equal(r.ok, false);
    assert.match(r.skipReason || "", /FAIL_FIELD_UNBOUND|required/);
  });

  it("fails when handler validates a different field only", () => {
    const r = behaviorEvidenceInExcerpt(
      "primaryBucket: VALIDATION_DATA\ntarget.constraint: required\ntarget.property: SeizureLocation",
      "if (string.IsNullOrWhiteSpace(cmd.EvidenceCode)) throw new BadRequestException();"
    );
    assert.equal(r.ok, false);
  });

  it("reports field-specific FEATURE_GAP when MaxLength is absent", () => {
    const r = behaviorEvidenceInExcerpt(
      "primaryBucket: VALIDATION_DATA\n" +
        "target.constraint: maxLength 200\n" +
        "target.field: Mã mục\n" +
        "target.property: ItemCode",
      "public class ItemDto { public string ItemCode { get; set; } }"
    );
    assert.equal(r.ok, false);
    assert.match(r.skipReason || "", /FAIL_FEATURE_GAP/);
    assert.match(r.skipReason || "", /ItemCode.*MaxLength/);
  });

  it("accepts MaxLength only when it belongs to target property", () => {
    const tc =
      "primaryBucket: VALIDATION_DATA\n" +
      "target.constraint: maxLength 200\n" +
      "target.property: ItemCode";
    assert.equal(
      behaviorEvidenceInExcerpt(
        tc,
        "class Dto { [MaxLength(200)] public string Other {get;set;} public string ItemCode {get;set;} }"
      ).ok,
      false
    );
    assert.equal(
      behaviorEvidenceInExcerpt(
        tc,
        "class Dto { [MaxLength(200)] public string ItemCode {get;set;} }"
      ).ok,
      true
    );
  });
});
