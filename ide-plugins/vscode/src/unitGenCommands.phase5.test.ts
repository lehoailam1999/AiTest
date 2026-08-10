/**
 * Phase 5 + P0 Gen helpers (markers required; relative path; no I* latch).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasUnitSourceMarkers,
  isBlockedUnitPrimaryPath,
  primaryMatchesMarkers,
} from "@aitest/ide-protocol";
import { toRepoRelativePath } from "./unitGenParse";

describe("unitGenCommands Phase 5", () => {
  it("hasUnitSourceMarkers gates Gen readiness", () => {
    assert.equal(
      hasUnitSourceMarkers(
        "path: src/Infrastructure/Services/UploadService.cs\ncode: UploadService"
      ),
      true
    );
    assert.equal(
      hasUnitSourceMarkers("# sut-resolve: skipped — no confident match"),
      false
    );
  });

  it("blocked FE primary without path: override", () => {
    assert.equal(
      isBlockedUnitPrimaryPath("src/app/resumable-upload.service.ts", {
        paths: [],
      }),
      true
    );
    assert.equal(
      isBlockedUnitPrimaryPath("src/app/resumable-upload.service.ts", {
        paths: ["src/app/resumable-upload.service.ts"],
      }),
      false
    );
  });

  it("P0: packet IUploadService does not match UploadService markers", () => {
    assert.equal(
      primaryMatchesMarkers(
        "src/Forensic.Infrastructure/Services/IUploadService.cs",
        {
          paths: ["src/Forensic.Infrastructure/Services/UploadService.cs"],
          codes: ["UploadService"],
        }
      ),
      false
    );
    assert.equal(
      primaryMatchesMarkers(
        "src/Forensic.Infrastructure/Services/UploadService.cs",
        {
          paths: ["src/Forensic.Infrastructure/Services/UploadService.cs"],
          codes: ["UploadService"],
        }
      ),
      true
    );
  });

  it("P0: toRepoRelativePath strips absolute workspace prefix", () => {
    const root = "D:/Xlab/Forensic/forensic";
    assert.equal(
      toRepoRelativePath(
        root,
        "D:/Xlab/Forensic/forensic/src/Services/UploadService.cs"
      ),
      "src/Services/UploadService.cs"
    );
    assert.equal(
      toRepoRelativePath(root, "src/Services/UploadService.cs"),
      "src/Services/UploadService.cs"
    );
  });
});
