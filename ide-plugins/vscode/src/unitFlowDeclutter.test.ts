/**
 * Unit flow declutter — packet trust + repair prompt + profile knobs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasUnitSourceMarkers,
  primaryMatchesMarkers,
} from "@aitest/ide-protocol";
import { buildUnitPrompt } from "./cursorAgentCliEngine";
import { toRepoRelativePath } from "./unitGenParse";

describe("unit flow declutter — Extension verify-only", () => {
  it("markers still required before Gen", () => {
    assert.equal(
      hasUnitSourceMarkers(
        "path: src/Services/UploadService.cs\ncode: UploadService"
      ),
      true
    );
  });

  it("packet I* still mismatches implementation markers", () => {
    assert.equal(
      primaryMatchesMarkers("src/Services/IUploadService.cs", {
        paths: ["src/Services/UploadService.cs"],
        codes: ["UploadService"],
      }),
      false
    );
  });

  it("buildUnitPrompt includes repairContext + existingFiles", () => {
    const { prompt } = buildUnitPrompt({
      item: {
        testCaseId: "TC-001",
        title: "Create succeeds",
        repairContext: "CompileError: missing using X",
        existingFiles: [
          {
            path: "AItest/UnitTest/Foo/FooTests.cs",
            content: "public class FooTests {}",
            kind: "unit",
          },
        ],
      },
      projectRules: "",
      conventions: "# conventions",
      tcMd: "path: src/Foo.cs\ncode: Foo",
      tcMdPath: ".ai-test/test-cases/m/TC-001.md",
      primaryPath: "src/Foo.cs",
      source: "public class Foo {}",
      suggestedPath: "AItest/UnitTest/Foo/FooTests.cs",
      gatePassed: true,
    });
    assert.match(prompt, /Repair context/i);
    assert.match(prompt, /CompileError: missing using X/);
    assert.match(prompt, /Existing test file/i);
    assert.match(prompt, /FooTests/);
    assert.match(prompt, /only allowed primary SUT/i);
  });

  it("toRepoRelativePath stays portable", () => {
    assert.equal(
      toRepoRelativePath("D:/repo", "D:/repo/src/A.cs"),
      "src/A.cs"
    );
  });
});
