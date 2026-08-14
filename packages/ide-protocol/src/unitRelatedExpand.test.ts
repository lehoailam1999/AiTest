/**
 * Phase 4 — related expander after entry SUT.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTcSourceMarkers } from "./unitGenGuards.js";
import {
  entryFeatureKeys,
  expandUnitRelatedPaths,
  formatRelatedMarkerLines,
  relatedShapeBonus,
} from "./unitRelatedExpand.js";

describe("unitRelatedExpand", () => {
  it("entryFeatureKeys strips Service suffix", () => {
    const keys = entryFeatureKeys(
      "src/Forensic.Infrastructure/Services/UploadService.cs"
    );
    assert.ok(keys.includes("upload"), JSON.stringify(keys));
  });

  it("prefers Interface / DTO / enum; denies FE pipe/constant; max 4", () => {
    const related = expandUnitRelatedPaths({
      entryPathRel: "src/Forensic.Infrastructure/Services/UploadService.cs",
      featureTokens: ["Upload", "InitUpload"],
      allPaths: [
        "src/Forensic.Infrastructure/Services/UploadService.cs",
        "src/Forensic.Application/Abstractions/IUploadService.cs",
        "src/Forensic.Application/Dtos/UploadDtos.cs",
        "src/Forensic.Domain/Enums/UploadResourceType.cs",
        "src/Forensic.Application/Dtos/UploadInitRequest.cs",
        "src/app/resumable-upload.service.ts",
        "src/app/shared/pipes/file-size.pipe.ts",
        "src/app/shared/constant/upload.constant.ts",
        "src/Account/AccountService.cs",
      ],
    });
    assert.ok(related.length <= 4, JSON.stringify(related));
    assert.ok(related.some((p) => p.includes("IUploadService")));
    assert.ok(related.some((p) => /UploadDtos|UploadInitRequest/.test(p)));
    assert.ok(related.some((p) => p.includes("UploadResourceType")));
    assert.ok(!related.some((p) => /resumable|pipe|constant|Account/i.test(p)));
  });

  it("relatedShapeBonus ranks interface/dto above sibling service", () => {
    assert.ok(
      relatedShapeBonus("src/App/IUploadService.cs") >
        relatedShapeBonus("src/App/Services/OtherUploadHelper.cs")
    );
  });

  it("formats related marker line", () => {
    assert.deepEqual(
      formatRelatedMarkerLines(["a/IUploadService.cs", "a/UploadDtos.cs"]),
      ["related: a/IUploadService.cs, a/UploadDtos.cs"]
    );
  });

  it("preferDtoValidator reserves Dto before sibling Assign Command", () => {
    const related = expandUnitRelatedPaths({
      entryPathRel: "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      featureTokens: ["Widget", "Create"],
      preferDtoValidator: true,
      allPaths: [
        "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
        "src/App/Commands/Widget/WidgetCreateCommand.cs",
        "src/App/Dtos/WidgetDto.cs",
        "src/App/Commands/Widget/WidgetAssignCaseCommand.cs",
        "src/App/Commands/Widget/WidgetUpdateCommandHandler.cs",
      ],
    });
    assert.ok(
      related.some((p) => /WidgetDto/.test(p)),
      JSON.stringify(related)
    );
    const dtoIdx = related.findIndex((p) => /WidgetDto/.test(p));
    const assignIdx = related.findIndex((p) => /AssignCase/.test(p));
    if (assignIdx >= 0) {
      assert.ok(dtoIdx >= 0 && dtoIdx < assignIdx, JSON.stringify(related));
    }
  });
});
