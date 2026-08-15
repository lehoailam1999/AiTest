/**
 * Feature-folder discover from index bridge hits (portable).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractUnitIntent } from "./unitIntentAliases.js";
import {
  discoverFeatureFoldersFromIndex,
  filterCandidatesByFeatureFolders,
  featureFolderSegmentFromPath,
  infraPathDemoteScore,
  isInfraCrossCuttingPath,
  pathSegmentTokens,
  softCrossCuttingDenied,
} from "./unitFeatureFolderDiscover.js";

describe("unitFeatureFolderDiscover", () => {
  it("pathSegmentTokens drops Commands/Queries weak folders", () => {
    const toks = pathSegmentTokens(
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs"
    );
    assert.ok(toks.some((t) => /Widget/i.test(t)));
    assert.ok(!toks.some((t) => /^Commands$/i.test(t)));
  });

  it("CheckCode bridge discovers Widget folder", () => {
    const index = {
      files: {
        "src/App/Queries/Widget/WidgetCheckCodeQuery.cs": {},
        "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs": {},
        "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": {},
        "src/App/Services/ImageProcessingService.cs": {},
      },
      symbolsByFile: {
        "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs": [
          { name: "WidgetCheckCodeQueryHandler" },
        ],
        "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": [
          { name: "WidgetCreateCommandHandler" },
        ],
      },
      symbolIndex: {
        widgetcheckcodequeryhandler: [
          "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs",
        ],
      },
    };
    const intent = extractUnitIntent({
      title: "Create widget - check duplicate code - reject",
      module: "Create widget",
      expectedResult: "reject duplicate",
    });
    const hit = discoverFeatureFoldersFromIndex(index, null, {
      intent,
      titleTokens: ["CheckCode", "duplicate"],
      bridgeNeedles: ["CheckCode"],
    });
    assert.ok(hit.bridgePaths.some((p) => /CheckCode/i.test(p)));
    assert.ok(
      hit.featureTokens.some((t) => /Widget/i.test(t)),
      JSON.stringify(hit)
    );
  });

  it("IsOccupied bridge discovers Storage folder", () => {
    const index = {
      files: {
        "src/App/Commands/Storage/AssignSlotCommandHandler.cs": {},
        "src/App/Services/ImageProcessingService.cs": {},
        "src/App/Services/AuthenticationService.cs": {},
      },
      symbolsByFile: {
        "src/App/Commands/Storage/AssignSlotCommandHandler.cs": [
          { name: "AssignSlotCommandHandler" },
          { name: "IsOccupied" },
        ],
      },
      symbolIndex: {
        isoccupied: ["src/App/Commands/Storage/AssignSlotCommandHandler.cs"],
      },
    };
    const intent = extractUnitIntent({
      title: "Filter empty slots - enable only empty",
      module: "Create widget",
      steps: "enable empty disable occupied",
      expectedResult: "empty enabled",
    });
    const hit = discoverFeatureFoldersFromIndex(index, null, {
      intent,
      bridgeNeedles: ["IsOccupied"],
    });
    assert.ok(hit.featureTokens.some((t) => /Storage/i.test(t)), JSON.stringify(hit));
    assert.ok(hit.bridgePaths.some((p) => /AssignSlot/i.test(p)));
  });

  it("filterCandidatesByFeatureFolders keeps domain handlers", () => {
    const { candidates, filtered } = filterCandidatesByFeatureFolders(
      [
        { pathRel: "src/Services/ImageProcessingService.cs" },
        { pathRel: "src/Commands/Widget/WidgetCreateCommandHandler.cs" },
      ],
      ["Widget"]
    );
    assert.equal(filtered, true);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0]!.pathRel, /WidgetCreate/);
  });

  it("infra demote scores Auth/Mail and signed-URL generators on behavior intent", () => {
    const intent = extractUnitIntent({
      title: "reject duplicate",
      module: "Create",
      expectedResult: "reject",
    });
    assert.ok(isInfraCrossCuttingPath("src/Services/AuthenticationService.cs"));
    assert.ok(
      isInfraCrossCuttingPath(
        "src/Commands/Storage/GenerateUploadUrlCommandHandler.cs"
      )
    );
    assert.ok(infraPathDemoteScore("src/Services/MailService.cs", intent) >= 40);
    assert.equal(
      infraPathDemoteScore("src/Commands/Widget/WidgetCreateCommandHandler.cs", intent),
      0
    );
  });

  it("softCrossCuttingDenied refuses Auth/Mail unless module hits stem", () => {
    assert.equal(
      softCrossCuttingDenied(
        "src/App/Services/AuthenticationService.cs",
        ["Widget", "Storage"]
      ),
      true
    );
    assert.equal(
      softCrossCuttingDenied(
        "src/App/Services/AuthenticationService.cs",
        ["Authentication"]
      ),
      false
    );
    assert.equal(
      softCrossCuttingDenied("src/App/Services/MailService.cs", ["Widget"]),
      true
    );
    assert.equal(
      softCrossCuttingDenied(
        "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
        []
      ),
      false
    );
  });

  it("dossier cue (hồ sơ vụ án) discovers Assign*Case* folder — not Agent", () => {
    const index = {
      files: {
        "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs": {},
        "src/App/Commands/Agent/AssignAgentFileCommandHandler.cs": {},
        "src/App/Commands/CasePerson/CasePersonCreateCommandHandler.cs": {},
      },
      symbolsByFile: {
        "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs": [
          { name: "EvidenceAssignCaseCommandHandler" },
        ],
        "src/App/Commands/Agent/AssignAgentFileCommandHandler.cs": [
          { name: "AssignAgentFileCommandHandler" },
        ],
      },
      symbolIndex: {
        evidenceassigncasecommandhandler: [
          "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
        ],
      },
    };
    const hit = discoverFeatureFoldersFromIndex(index, null, {
      titleTokens: ["Gán", "hồ", "sơ", "vụ", "án", "vật", "chứng"],
    });
    assert.ok(
      hit.bridgePaths.some((p) => /AssignCase/i.test(p)),
      JSON.stringify(hit.bridgePaths)
    );
    assert.ok(
      hit.featureTokens.some((t) => /Evidence/i.test(t)),
      JSON.stringify(hit)
    );
    assert.ok(
      !hit.featureTokens.some((t) => /^Agent$/i.test(t)),
      JSON.stringify(hit.featureTokens)
    );
  });

  it("featureFolderSegmentFromPath reads Commands/X folder", () => {
    assert.equal(
      featureFolderSegmentFromPath(
        "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs"
      ),
      "Evidence"
    );
  });

  it("Person cue discovers CasePerson folder", () => {
    const index = {
      files: {
        "src/App/Commands/CasePerson/CasePersonCreateCommandHandler.cs": {},
        "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs": {},
      },
      symbolsByFile: {
        "src/App/Commands/CasePerson/CasePersonCreateCommandHandler.cs": [
          { name: "CasePersonCreateCommandHandler" },
        ],
      },
      symbolIndex: {
        casepersoncreatecommandhandler: [
          "src/App/Commands/CasePerson/CasePersonCreateCommandHandler.cs",
        ],
      },
    };
    const hit = discoverFeatureFoldersFromIndex(index, null, {
      titleTokens: ["Khai", "báo", "người", "sở", "hữu", "vật", "chứng"],
    });
    assert.ok(
      hit.featureTokens.some((t) => /Person/i.test(t)),
      JSON.stringify(hit)
    );
  });

  it("hình ảnh cue discovers Image/Upload folders from index shapes", () => {
    const index = {
      files: {
        "src/App/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs":
          {},
        "src/Infrastructure/Services/UploadService.cs": {},
        "src/App/Commands/CasePerson/CasePersonCreateCommandHandler.cs": {},
      },
      symbolsByFile: {
        "src/Infrastructure/Services/UploadService.cs": [
          { name: "InitUploadAsync" },
        ],
        "src/App/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs":
          [{ name: "EvidencePhysicalImageCreateCommandHandler" }],
      },
      symbolIndex: {
        inituploadasync: ["src/Infrastructure/Services/UploadService.cs"],
        evidencephysicalimagecreatecommandhandler: [
          "src/App/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs",
        ],
      },
    };
    const hit = discoverFeatureFoldersFromIndex(index, null, {
      titleTokens: [
        "Tải lên hình ảnh vật chứng",
        "Tạo mới vật chứng",
        "tai",
        "len",
        "hinh",
        "anh",
      ],
    });
    assert.ok(
      hit.featureTokens.some((t) => /Image|Upload|Physical/i.test(t)),
      JSON.stringify(hit)
    );
    assert.ok(
      !hit.featureTokens.some((t) => /^CasePerson$/i.test(t)),
      JSON.stringify(hit.featureTokens)
    );
  });
});
