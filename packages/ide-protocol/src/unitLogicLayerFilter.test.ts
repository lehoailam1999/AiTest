/**
 * Phase 2 — logic-layer Unit primary filter.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterUnitLogicLayerCandidates,
  filterUnitLogicLayerPaths,
  isAnemicEntityLikePath,
  isBlockedUnitPrimaryPath,
  isDeniedUnitPrimaryPath,
  isPreferredLogicLayerPath,
  isWeakUnitClientPath,
} from "./unitLogicLayerFilter.js";

describe("unitLogicLayerFilter", () => {
  it("isWeakUnitClientPath covers ClientApp and thin upload clients", () => {
    assert.equal(
      isWeakUnitClientPath("src/ClientApp/app/admin/foo.service.ts"),
      true
    );
    assert.equal(isWeakUnitClientPath("src/app/resumable-upload.service.ts"), true);
    assert.equal(isWeakUnitClientPath("src/Infrastructure/Services/UploadService.cs"), false);
    assert.equal(
      isBlockedUnitPrimaryPath("src/app/resumable-upload.service.ts", { paths: [] }),
      true
    );
    assert.equal(
      isBlockedUnitPrimaryPath("src/app/resumable-upload.service.ts", {
        paths: ["src/app/resumable-upload.service.ts"],
      }),
      false
    );
  });

  it("denies FE component / ClientApp / constants / resumable client", () => {
    assert.equal(
      isDeniedUnitPrimaryPath(
        "src/ClientApp/app/evidence/create/evidence-create-modal.component.ts"
      ),
      true
    );
    assert.equal(
      isDeniedUnitPrimaryPath("src/app/shared/constant/co-c-action-type.constant.ts"),
      true
    );
    assert.equal(
      isDeniedUnitPrimaryPath("src/app/resumable-upload.service.ts"),
      true
    );
    assert.equal(isDeniedUnitPrimaryPath("test/Integration/FooTests.cs"), true);
  });

  it("prefers Infrastructure Service / Handler shapes", () => {
    assert.equal(
      isPreferredLogicLayerPath(
        "src/Forensic.Infrastructure/Services/UploadService.cs"
      ),
      true
    );
    assert.equal(
      isPreferredLogicLayerPath(
        "src/Application/Evidence/Commands/CreateEvidenceCommandHandler.cs"
      ),
      true
    );
    assert.equal(
      isDeniedUnitPrimaryPath("src/Forensic.Infrastructure/Services/UploadService.cs"),
      false
    );
    assert.equal(
      isAnemicEntityLikePath("src/Domain/Entities/CabinetCompartment.cs"),
      true
    );
    assert.equal(
      isAnemicEntityLikePath("src/Shared/UploadDtos.cs"),
      true
    );
    assert.equal(
      isPreferredLogicLayerPath("src/Domain/Entities/CabinetCompartment.cs"),
      false
    );
  });

  it("behavior TC drops entity POCO when Handler exists", () => {
    const tc =
      "Chọn ngăn - Disable occupied - Từ chối gán ngăn đã chứa";
    const out = filterUnitLogicLayerCandidates(
      [
        {
          pathRel: "src/Domain/Entities/CabinetCompartment.cs",
          score: 200,
        },
        {
          pathRel:
            "src/Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
          score: 120,
        },
      ],
      { tcText: tc }
    );
    assert.equal(out.length, 1);
    assert.match(out[0]!.pathRel, /EvidenceCreateCommandHandler/);
  });

  it("path list drops denied only", () => {
    const out = filterUnitLogicLayerPaths([
      "src/app/admin/evidence/create/evidence-create-modal.component.ts",
      "src/app/resumable-upload.service.ts",
      "src/Forensic.Infrastructure/Services/UploadService.cs",
      "src/Evidence/Classification/DigitalEvidenceClassificationForm.ts",
    ]);
    assert.deepEqual(out, [
      "src/Forensic.Infrastructure/Services/UploadService.cs",
      "src/Evidence/Classification/DigitalEvidenceClassificationForm.ts",
    ]);
  });

  it("when preferred competitive, drops non-logic survivors", () => {
    const out = filterUnitLogicLayerCandidates([
      {
        pathRel: "src/app/admin/evidence/create/evidence-create-modal.component.ts",
        score: 200,
      },
      { pathRel: "src/app/resumable-upload.service.ts", score: 180 },
      {
        pathRel: "src/Forensic.Infrastructure/Services/UploadService.cs",
        score: 90,
      },
      {
        pathRel: "src/Evidence/Classification/DigitalEvidenceClassificationForm.ts",
        score: 70,
      },
    ]);
    assert.deepEqual(
      out.map((c) => c.pathRel),
      ["src/Forensic.Infrastructure/Services/UploadService.cs"]
    );
  });

  it("keeps strong non-preferred when preferred is weak noise", () => {
    const out = filterUnitLogicLayerCandidates([
      {
        pathRel: "src/Evidence/Classification/DigitalEvidenceClassificationForm.ts",
        score: 100,
      },
      {
        pathRel: "src/Account/AccountCreateCommandHandler.cs",
        score: 20,
      },
    ]);
    assert.ok(out.some((c) => c.pathRel.includes("DigitalEvidenceClassificationForm")));
    assert.ok(out.some((c) => c.pathRel.includes("AccountCreateCommandHandler")));
  });

  it("falls back to non-denied when no preferred logic-layer", () => {
    const out = filterUnitLogicLayerCandidates([
      {
        pathRel: "src/Evidence/Classification/DigitalEvidenceClassificationForm.ts",
        score: 80,
      },
      { pathRel: "src/app/shared/pipes/file-size.pipe.ts", score: 60 },
    ]);
    assert.deepEqual(
      out.map((c) => c.pathRel),
      ["src/Evidence/Classification/DigitalEvidenceClassificationForm.ts"]
    );
  });
});
