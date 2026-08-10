/**
 * Extension disk resolve must honor Phase 2/4 SoT (no FE primary / related).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expandUnitRelatedPaths,
  filterUnitLogicLayerCandidates,
  isBlockedUnitPrimaryPath,
} from "@aitest/ide-protocol";

describe("unitGenRelatedSources Phase 2/4 alignment", () => {
  it("Phase 2 blocks resumable/component primary without path: marker", () => {
    assert.equal(
      isBlockedUnitPrimaryPath("src/app/resumable-upload.service.ts", { paths: [] }),
      true
    );
    assert.equal(
      isBlockedUnitPrimaryPath(
        "src/ClientApp/app/evidence/create/evidence-create-modal.component.ts",
        { paths: [] }
      ),
      true
    );
    assert.equal(
      isBlockedUnitPrimaryPath("src/Infrastructure/Services/UploadService.cs", {
        paths: [],
      }),
      false
    );
  });

  it("Phase 2 filter keeps UploadService over FE when competitive", () => {
    const out = filterUnitLogicLayerCandidates([
      {
        pathRel: "src/app/resumable-upload.service.ts",
        score: 200,
      },
      {
        pathRel: "src/Infrastructure/Services/UploadService.cs",
        score: 90,
      },
      {
        pathRel: "src/app/upload-modal.component.ts",
        score: 180,
      },
    ]);
    assert.deepEqual(
      out.map((c) => c.pathRel),
      ["src/Infrastructure/Services/UploadService.cs"]
    );
  });

  it("Phase 4 related prefers IUpload/DTO/enum not FE pipe", () => {
    const related = expandUnitRelatedPaths({
      entryPathRel: "src/Infrastructure/Services/UploadService.cs",
      featureTokens: ["Upload"],
      allPaths: [
        "src/Infrastructure/Services/UploadService.cs",
        "src/Application/IUploadService.cs",
        "src/Application/UploadDtos.cs",
        "src/Domain/UploadResourceType.cs",
        "src/app/shared/pipes/file-size.pipe.ts",
        "src/app/resumable-upload.service.ts",
      ],
    });
    assert.ok(related.some((p) => p.includes("IUploadService")));
    assert.ok(related.some((p) => /UploadDtos|UploadResourceType/.test(p)));
    assert.ok(!related.some((p) => /pipe|resumable/i.test(p)));
  });
});
