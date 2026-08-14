/**
 * P0 — prefer implementation over I* interface; exact marker/code match.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codeMatchesPathStem,
  isInterfaceLikePrimaryPath,
  pathsMatchMarker,
  preferImplementationOverInterface,
  primaryMatchesMarkers,
  promoteImplementationPrimary,
  stemOfPath,
} from "./unitPrimaryPrefer.js";

describe("unitPrimaryPrefer", () => {
  it("detects I* interface stems", () => {
    assert.equal(
      isInterfaceLikePrimaryPath(
        "src/Forensic.Infrastructure/Services/IUploadService.cs"
      ),
      true
    );
    assert.equal(
      isInterfaceLikePrimaryPath(
        "src/Forensic.Infrastructure/Services/UploadService.cs"
      ),
      false
    );
    assert.equal(isInterfaceLikePrimaryPath("src/app/id.service.ts"), false);
  });

  it("pathsMatchMarker: Foo.cs does not match IFoo.cs via endsWith", () => {
    assert.equal(
      pathsMatchMarker(
        "src/Services/IUploadService.cs",
        "src/Services/UploadService.cs"
      ),
      false
    );
    assert.equal(
      pathsMatchMarker(
        "src/Services/UploadService.cs",
        "src/Services/UploadService.cs"
      ),
      true
    );
    assert.equal(
      pathsMatchMarker(
        "src/Services/UploadService.cs",
        "UploadService.cs"
      ),
      true
    );
  });

  it("codeMatchesPathStem: UploadService matches impl not IUploadService", () => {
    assert.equal(
      codeMatchesPathStem(
        "UploadService",
        "src/Services/UploadService.cs"
      ),
      true
    );
    assert.equal(
      codeMatchesPathStem(
        "UploadService",
        "src/Services/IUploadService.cs"
      ),
      false
    );
    assert.equal(
      codeMatchesPathStem("IUploadService", "src/Services/IUploadService.cs"),
      true
    );
  });

  it("preferImplementationOverInterface promotes concrete service", () => {
    const out = preferImplementationOverInterface([
      "src/Services/IUploadService.cs",
      "src/Services/UploadService.cs",
      "src/Dto/UploadDtos.cs",
    ]);
    assert.ok(out.some((p) => /UploadService\.cs$/i.test(p) && !/IUpload/.test(p)));
    assert.ok(!out.some((p) => /IUploadService\.cs$/i.test(p)));
  });

  it("promoteImplementationPrimary swaps I* when sibling exists", () => {
    assert.equal(
      promoteImplementationPrimary("src/Services/IUploadService.cs", [
        "src/Services/IUploadService.cs",
        "src/Services/UploadService.cs",
      ]),
      "src/Services/UploadService.cs"
    );
    assert.equal(
      stemOfPath("src/a/Foo.cs"),
      "Foo"
    );
  });

  it("primaryMatchesMarkers uses exact helpers", () => {
    assert.equal(
      primaryMatchesMarkers("src/Services/IUploadService.cs", {
        paths: ["src/Services/UploadService.cs"],
        codes: ["UploadService"],
      }),
      false
    );
    assert.equal(
      primaryMatchesMarkers("src/Services/UploadService.cs", {
        paths: ["src/Services/UploadService.cs"],
        codes: ["UploadService"],
      }),
      true
    );
  });
});
