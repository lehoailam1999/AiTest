import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestCase } from "../../api/types";
import { buildProjectIndex } from "../projectIntelligence/projectIndex.js";
import {
  enrichTcTestDataFromIndex,
  enrichTcTestDataFromIndexAsync,
  enrichTestDataWithUnitMarkers,
  pickConfidentUnitSeed,
  stripAutoEnrichedMarkers,
  symbolCodeFromPathRel,
  toRepoRelativePath,
  UNIT_AUTO_MARKER,
} from "./enrichUnitMarkersFromIndex.js";
import { snapshotFromPaths } from "../unitResolve/snapshotFromPaths.js";

function sample(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "p1",
    testCaseId: "TC-043",
    title: "Phân loại vật chứng kỹ thuật số - Checked mặc định",
    module: "Phân loại vật chứng kỹ thuật số",
    type: "Unit",
    priority: "High",
    severity: "Major",
    steps: "Arrange Act Assert checkbox",
    expectedResult: "Checked",
    testData: "trace: FEATURES/FR-3.2.14",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "Pending",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("enrichUnitMarkersFromIndex", () => {
  it("normalizes absolute path and PascalCase code symbol", () => {
    assert.equal(
      toRepoRelativePath(
        "D:/Xlab/Forensic/forensic/src/app/resumable-upload.service.ts",
        "D:/Xlab/Forensic/forensic"
      ),
      "src/app/resumable-upload.service.ts"
    );
    assert.equal(
      symbolCodeFromPathRel("src/app/resumable-upload.service.ts"),
      "ResumableUploadService"
    );
  });

  it("pickConfidentUnitSeed requires score + margin", () => {
    assert.equal(pickConfidentUnitSeed([]), null);
    assert.equal(
      pickConfidentUnitSeed([{ pathRel: "a.ts", score: 40, reason: "x" }]),
      null
    );
    const alone = pickConfidentUnitSeed([
      {
        pathRel: "src/Evidence/DigitalEvidenceForm.ts",
        score: UNIT_AUTO_MARKER.minScore,
        reason: "ok",
      },
    ]);
    assert.ok(alone);
    assert.equal(
      pickConfidentUnitSeed([
        { pathRel: "a.ts", score: 60, reason: "a" },
        { pathRel: "b.ts", score: 55, reason: "b" },
      ]),
      null
    );
  });

  it("does not overwrite manual path:/code:", () => {
    const r = enrichTestDataWithUnitMarkers("path: src/A.ts\ncode: A", {
      pathRel: "src/B.ts",
      score: 99,
      reason: "x",
    });
    assert.equal(r.enriched, false);
    assert.match(r.testData, /path: src\/A\.ts/);
  });

  it("replaces prior auto-enriched markers", () => {
    const prev = [
      "trace: x",
      "path: D:/bad/resumable-upload.service.ts",
      "code: resumable-upload.service",
      "# auto-enriched from ProjectFileIndex (score=188)",
    ].join("\n");
    assert.match(stripAutoEnrichedMarkers(prev), /^trace: x$/);
  });

  it("rejects weak seeds without inventing feature-specific blocks", () => {
    const tc = sample({
      testCaseId: "TC-076",
      title: "Upload image - reject invalid",
      module: "Upload images",
      steps: "Mock scanner returns bad",
      expectedResult: "Reject upload",
      testData: "trace: FEATURES/upload",
    });
    const index = buildProjectIndex([
      "src/ClientApp/app/resumable-upload.service.ts",
      "src/App/Services/UploadService.cs",
    ]);
    const hit = enrichTcTestDataFromIndex(tc, index, {
      requirementTitle: "Evidence",
      projectRoot: "/proj",
    });
    // Either no marker (fail-closed) or a confident logic-layer hit — never absolute/wrong invent
    if (hit.enriched) {
      assert.match(hit.testData, /path:\s*src\//);
      assert.ok(!/Designer|Migrations/i.test(hit.testData));
    } else {
      assert.match(hit.testData, /sut-resolve:\s*skipped/i);
    }
  });

  it("appends markers from confident index seed", () => {
    const index = buildProjectIndex([
      "src/Evidence/Classification/DigitalEvidenceClassificationForm.ts",
      "src/Account/AccountCreateCommandHandler.cs",
      "src/util.ts",
    ]);
    const hit = enrichTcTestDataFromIndex(sample(), index, {
      requirementTitle: "Phân loại vật chứng kỹ thuật số",
      projectAliases: {
        "vat chung ky thuat so": ["DigitalEvidence", "Classification"],
        "phan loai": ["Classification", "DigitalEvidence"],
      },
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(hit.testData, /path:\s*src\/Evidence\/Classification\/DigitalEvidence/);
    assert.match(hit.testData, /code:\s*DigitalEvidenceClassificationForm/);
    assert.match(hit.testData, /auto-enriched/);
  });

  it("sync fail-closes size-limit TC without body excerpt", () => {
    const tc = sample({
      testCaseId: "TC-092",
      title: "Tải lên tệp - vượt dung lượng - Từ chối",
      module: "Tải lên tệp kỹ thuật số",
      steps: "FileSize > MaxFileSize",
      expectedResult: "ArgumentException",
      precondition: "maxConfig",
      testData: "trace: NFR",
    });
    const index = buildProjectIndex([
      "src/Infrastructure/Services/UploadService.cs",
      "src/app/resumable-upload.service.ts",
    ]);
    const hit = enrichTcTestDataFromIndex(tc, index, {
      requirementTitle: "Upload",
      projectRoot: "/proj",
    });
    assert.equal(hit.enriched, false);
    assert.match(hit.testData, /body-rule required/i);
  });

  it("async body-rule writes UploadService when excerpt has MaxFileSize", async () => {
    const tc = sample({
      testCaseId: "TC-092",
      title: "Tải lên tệp - vượt dung lượng - Từ chối",
      module: "Tải lên tệp kỹ thuật số",
      steps: "FileSize > MaxFileSize",
      expectedResult: "ArgumentException",
      precondition: "maxConfig",
      testData: "trace: NFR",
    });
    const index = buildProjectIndex([
      "src/Infrastructure/Services/UploadService.cs",
      "src/Application/Abstractions/IUploadService.cs",
      "src/Shared/UploadDtos.cs",
      "src/Domain/Enums/UploadResourceType.cs",
      "src/app/shared/pipes/file-size.pipe.ts",
    ]);
    const bodies: Record<string, string> = {
      "src/Infrastructure/Services/UploadService.cs": `
        public class UploadService {
          public void InitUploadAsync(long FileSize, long MaxFileSize) {
            if (FileSize > MaxFileSize) throw new ArgumentException("too large");
          }
        }
      `,
      "src/Shared/UploadDtos.cs": `public record UploadInitRequest(long FileSize);`,
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Upload",
      projectRoot: "/proj",
      readExcerpt: async (p) => bodies[p] || null,
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(hit.testData, /path:\s*src\/Infrastructure\/Services\/UploadService\.cs/);
    assert.match(hit.testData, /code:\s*UploadService/);
    assert.ok(hit.ruleHits?.includes("MaxFileSize"));
    assert.match(hit.bodyRuleLog || "", /writeBack=yes/);
    assert.match(hit.testData, /related:\s*.*IUploadService/);
    assert.ok((hit.relatedPaths || []).length <= 4);
    assert.ok(!(hit.relatedPaths || []).some((p) => p.includes(".pipe.")));
  });

  it("async body-rule skips when excerpt lacks size patterns", async () => {
    const tc = sample({
      testCaseId: "TC-092",
      title: "Upload file too large — reject",
      module: "Upload",
      steps: "exceed size limit",
      expectedResult: "BadRequest",
      testData: "trace: NFR",
    });
    const index = buildProjectIndex([
      "src/Infrastructure/Services/UploadService.cs",
    ]);
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Upload",
      readExcerpt: async () =>
        "public class UploadService { public void Init() { /* noop */ } }",
    });
    assert.equal(hit.enriched, false);
    assert.match(hit.testData, /body-rule required|no pattern hits/i);
    assert.equal(hit.writeBack, false);
  });

  it("TC-018 style: empty code auto-generate writes CreateHandler with domain alias", async () => {
    const tc = sample({
      testCaseId: "TC-018",
      title: "Create widget - leave code empty - system auto generates code",
      module: "Create widget",
      steps: "Leave code empty; fill required; save; assert generated code",
      expectedResult: "Save ok; code auto-generated",
      testData: "trace: AC/auto-code; input=code=empty",
    });
    const index = buildProjectIndex([
      "src/App/Commands/Case/CaseCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommand.cs",
      "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs",
      "src/App/Queries/Case/CaseCheckCodeQueryHandler.cs",
      "src/App/Commands/Agent/AssignAgentFileCommand.cs",
    ]);
    const bodies: Record<string, string> = {
      "src/App/Commands/Case/CaseCreateCommandHandler.cs": `
        public class CaseCreateCommandHandler {
          public void Handle() {
            var userProvidedCode = !string.IsNullOrWhiteSpace(code);
            if (!userProvidedCode) { code = "C_" + id; }
          }
        }`,
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
        public class WidgetCreateCommandHandler {
          public void Handle() {
            var userProvidedCode = !string.IsNullOrWhiteSpace(code);
            if (!userProvidedCode) { code = "W_" + id; }
          }
        }`,
      "src/App/Commands/Agent/AssignAgentFileCommand.cs":
        "public class AssignAgentFileCommand { /* Auto-generate note */ }",
    };
    const paths = [
      "src/App/Commands/Case/CaseCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommand.cs",
      "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs",
      "src/App/Queries/Case/CaseCheckCodeQueryHandler.cs",
      "src/App/Commands/Agent/AssignAgentFileCommand.cs",
    ];
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Widget",
      projectRoot: "/proj",
      projectAliases: { widget: ["Widget"] },
      codeIndex: snapshotFromPaths(paths),
      readExcerpt: async (p) => bodies[p] || "class X {}",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(
      hit.testData,
      /path:\s*src\/App\/Commands\/Widget\/WidgetCreateCommandHandler\.cs/
    );
    assert.match(hit.testData, /code:\s*WidgetCreateCommandHandler/);
    assert.ok(!/AssignAgentFile|CaseCreate/i.test(
      (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) || ""
    ));
  });

  it("TC-019 style: duplicate-code reject must not latch Generate*Url helpers", async () => {
    const tc = sample({
      testCaseId: "TC-019",
      title: "Tạo mới - mã đã tồn tại - từ chối",
      module: "Tạo mới widget",
      steps:
        "1. Nhập mã đã có\n2. Gọi tạo mới\n3. Assert BadRequestAlertException",
      expectedResult: "Từ chối; mã đã tồn tại trong hệ thống",
      testData: "trace: BR/BR-6|Không trùng mã; exception=BadRequestAlertException",
    });
    const index = buildProjectIndex([
      "src/App/Commands/Storage/GenerateUploadUrlCommandHandler.cs",
      "src/App/Commands/Account/AccountCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommand.cs",
      "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs",
    ]);
    const bodies: Record<string, string> = {
      "src/App/Commands/Storage/GenerateUploadUrlCommandHandler.cs": `
        public class GenerateUploadUrlCommandHandler {
          public void Handle() {
            Validate();
            if (Exists()) throw new BadRequestAlertException("x");
            Generate();
          }
        }`,
      "src/App/Commands/Account/AccountCreateCommandHandler.cs":
        'public class AccountCreateCommandHandler { void Handle() { throw new BadRequestAlertException("a"); } }',
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
        public class WidgetCreateCommandHandler {
          public void Handle(string code) {
            if (CheckCode(code)) throw new BadRequestAlertException("code exists");
          }
        }`,
      "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs":
        "public class WidgetCheckCodeQueryHandler { public bool Handle() { return Duplicate(); } }",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Widget",
      projectRoot: "/proj",
      projectAliases: { widget: ["Widget"], "vat chung": ["Widget"] },
      readExcerpt: async (p) => bodies[p] || "class X {}",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(
      hit.testData,
      /path:\s*src\/App\/Commands\/Widget\/WidgetCreateCommandHandler\.cs/
    );
    assert.match(hit.testData, /code:\s*WidgetCreateCommandHandler/);
    assert.ok(
      !/GenerateUploadUrl|GeneratePresigned|AccountCreate/i.test(
        (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) ||
          ""
      )
    );
    assert.ok(!hit.ruleHits?.some((h) => /^(Generate|Exists|Validate)$/i.test(h)));
  });

  it("duplicate reject prefers CreateCommandHandler over Check* Query", async () => {
    const tc = sample({
      testCaseId: "TC-DUP",
      title: "Create widget - check duplicate code - reject",
      module: "Create widget",
      steps:
        "1. Input existing code\n2. Mock duplicate true\n3. Call create\n4. Assert error",
      expectedResult: "Reject create; duplicate code not allowed",
      precondition: "Code already exists",
      testData: "trace: VALIDATION/code",
    });
    const index = buildProjectIndex([
      "src/App/Queries/Other/OtherCheckCodeQuery.cs",
      "src/App/Queries/Other/OtherCheckCodeQueryHandler.cs",
      "src/App/Queries/Widget/WidgetCheckCodeQuery.cs",
      "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Other/OtherCreateCommandHandler.cs",
    ]);
    const bodies: Record<string, string> = {
      "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs":
        "public class WidgetCheckCodeQueryHandler { public bool Handle() { return rows.Any(); } }",
      "src/App/Queries/Other/OtherCheckCodeQueryHandler.cs":
        "public class OtherCheckCodeQueryHandler { public bool Handle() { return rows.Any(); } }",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
        public class WidgetCreateCommandHandler {
          public void Handle(string code) {
            if (existing.Any()) throw new BadRequestAlertException("code exists");
          }
        }`,
      "src/App/Commands/Other/OtherCreateCommandHandler.cs":
        "public class OtherCreateCommandHandler { public void Handle() { Save(); } }",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Widget",
      projectRoot: "/proj",
      projectAliases: { widget: ["Widget"] },
      readExcerpt: async (p) => bodies[p] || "class X {}",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(
      hit.testData,
      /path:\s*src\/App\/Commands\/Widget\/WidgetCreateCommandHandler\.cs/
    );
    assert.match(hit.testData, /code:\s*WidgetCreateCommandHandler/);
    assert.ok(hit.ruleHits?.some((h) => /BadRequest|throw/i.test(h)));
    assert.ok(!/sut-resolve:\s*skipped/i.test(hit.testData));
    const primaryLine =
      (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) ||
      "";
    assert.ok(!/CheckCode/i.test(primaryLine), primaryLine);
  });

  it("TC-039 style: alias domain keeps CreateHandler; refuses Image/Auth/Mail latch", async () => {
    const tc = sample({
      testCaseId: "TC-039",
      title: "Create widget - Name validator - reject empty/whitespace/255",
      module: "Create widget",
      steps: "Call name validator for empty, spaces, 256 chars",
      expectedResult: "Each case invalid; required; max 255",
      testData: "trace: VALIDATION/Name",
    });
    const index = buildProjectIndex([
      "src/App/Services/ImageProcessingService.cs",
      "src/App/Services/AuthenticationService.cs",
      "src/App/Services/MailService.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Other/OtherCreateCommandHandler.cs",
    ]);
    const bodies: Record<string, string> = {
      "src/App/Services/ImageProcessingService.cs":
        "public class ImageProcessingService { void V() { Validate(); throw new Exception(); } }",
      "src/App/Services/AuthenticationService.cs":
        "public class AuthenticationService { void V() { throw new Exception(); } }",
      "src/App/Services/MailService.cs":
        "public class MailService { void V() { throw new Exception(); } }",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs":
        'public class WidgetCreateCommandHandler { void Handle() { if (string.IsNullOrWhiteSpace(name)) throw new BadRequestAlertException("name"); } }',
      "src/App/Commands/Other/OtherCreateCommandHandler.cs":
        "public class OtherCreateCommandHandler { void Handle() { Save(); } }",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Widget",
      projectRoot: "/proj",
      projectAliases: { widget: ["Widget"] },
      enrichProfile: {
        scope: "backend",
        minAlignment: 50,
        domainGuards: [
          {
            whenModuleMatches: "(?i)widget",
            allowPathContains: ["Widget"],
            denyPathContains: ["ImageProcessing", "Authentication", "Mail"],
          },
        ],
        sutMap: {},
        intentRules: [],
        intentRulesFile: ".ai-test/unit-intent-rules.json",
        codeAliasesFile: ".ai-test/code-aliases.json",
        allowDiskReresolve: false,
      },
      readExcerpt: async (p) => bodies[p] || "class X {}",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(
      hit.testData,
      /path:\s*src\/App\/Commands\/Widget\/WidgetCreateCommandHandler\.cs/
    );
    assert.ok(!/ImageProcessing|Authentication|Mail/i.test(
      (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) || ""
    ));
  });

  it("TC-041 style: DigitalFile family tie writes Handler path/code", async () => {
    const tc = sample({
      testCaseId: "TC-041",
      title: "Create widget - Checkbox digital - show device block",
      module: "Create widget",
      steps: "Assert checkbox default checked; toggle visibility blocks",
      expectedResult: "device block visible when checked",
      precondition: "checkbox default checked",
      testData: "trace: BR/BR-17",
    });
    const index = buildProjectIndex([
      "src/App/Commands/DigitalFile/DigitalFileCreateCommand.cs",
      "src/App/Commands/DigitalFile/DigitalFileCreateCommandHandler.cs",
      "src/App/Commands/DigitalFile/DigitalFileDeleteCommand.cs",
    ]);
    const bodies: Record<string, string> = {
      "src/App/Commands/DigitalFile/DigitalFileCreateCommand.cs":
        "public class DigitalFileCreateCommand { public string DigitalFile { get; set; } }",
      "src/App/Commands/DigitalFile/DigitalFileCreateCommandHandler.cs":
        "public class DigitalFileCreateCommandHandler { void Handle() { var DigitalFile = true; } }",
      "src/App/Commands/DigitalFile/DigitalFileDeleteCommand.cs":
        "public class DigitalFileDeleteCommand { public string DigitalFile { get; set; } }",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Widget",
      projectRoot: "/proj",
      projectAliases: { widget: ["Widget", "DigitalFile"] },
      enrichProfile: {
        scope: "backend",
        minAlignment: 50,
        domainGuards: [],
        sutMap: {},
        intentRules: [],
        intentRulesFile: ".ai-test/unit-intent-rules.json",
        codeAliasesFile: ".ai-test/code-aliases.json",
        allowDiskReresolve: false,
      },
      readExcerpt: async (p) => bodies[p] || "class X {}",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(
      hit.testData,
      /path:\s*src\/App\/Commands\/DigitalFile\/DigitalFileCreateCommandHandler\.cs/
    );
    assert.match(hit.testData, /code:\s*DigitalFileCreateCommandHandler/);
    assert.ok(!/sut-resolve:\s*skipped/i.test(hit.testData));
  });

  it("TC-043 style: search_lookup writes lookup Handler via SearchTerm bridge (no product pins)", async () => {
    const tc = sample({
      testCaseId: "TC-043",
      title:
        "Create widget - Search related contacts fuzzy - case insensitive and allow create",
      module: "Create widget",
      steps:
        "1. Search by name with mixed case\n2. Assert Contains ToLower match\n3. Search missing name\n4. Assert allow create new",
      expectedResult: "Fuzzy case-insensitive list; allow create when missing",
      precondition: "Mock contact list",
      testData: "trace: BR/BR-16",
    });
    const paths = [
      "src/App/Queries/Contact/ContactSearchQuery.cs",
      "src/App/Queries/Contact/ContactSearchQueryHandler.cs",
      "src/App/Commands/Contact/ContactCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Services/ImageProcessingService.cs",
    ];
    const index = buildProjectIndex(paths);
    const now = "2026-01-01T00:00:00Z";
    const codeIndex = {
      meta: {
        schema: "aitest-code-index-v1" as const,
        createdAt: now,
        updatedAt: now,
        fileCount: paths.length,
        symbolCount: 5,
        edgeCount: 0,
        parser: "lightweight-ts-js-cs-v1",
      },
      files: Object.fromEntries(
        paths.map((p) => [
          p,
          {
            pathRel: p,
            language: "cs",
            contentHash: "x",
            byteSize: 1,
            symbolCount: 1,
            importCount: 0,
            indexedAt: now,
          },
        ])
      ),
      symbolsByFile: {
        "src/App/Queries/Contact/ContactSearchQuery.cs": [
          { name: "ContactSearchQuery", kind: "class" as const, line: 1, exported: true },
          { name: "SearchTerm", kind: "variable" as const, line: 3, exported: true },
        ],
        "src/App/Queries/Contact/ContactSearchQueryHandler.cs": [
          {
            name: "ContactSearchQueryHandler",
            kind: "class" as const,
            line: 1,
            exported: true,
          },
          { name: "Handle", kind: "method" as const, line: 5, exported: true },
        ],
        "src/App/Commands/Contact/ContactCreateCommandHandler.cs": [
          {
            name: "ContactCreateCommandHandler",
            kind: "class" as const,
            line: 1,
            exported: true,
          },
        ],
      },
      importsByFile: {},
      exportsByFile: {},
      symbolIndex: {
        searchterm: ["src/App/Queries/Contact/ContactSearchQuery.cs"],
        contactsearchqueryhandler: [
          "src/App/Queries/Contact/ContactSearchQueryHandler.cs",
        ],
      },
      dependencyGraph: {},
    };
    const bodies: Record<string, string> = {
      "src/App/Queries/Contact/ContactSearchQuery.cs":
        "public class ContactSearchQuery { public string SearchTerm { get; set; } }",
      "src/App/Queries/Contact/ContactSearchQueryHandler.cs": `
        public class ContactSearchQueryHandler {
          public Task Handle(ContactSearchQuery request) {
            var term = (request.SearchTerm ?? "").Trim().ToLower();
            return rows.Where(p => p.Name.ToLower().Contains(term));
          }
        }`,
      "src/App/Commands/Contact/ContactCreateCommandHandler.cs":
        "public class ContactCreateCommandHandler { void Handle() { Save(); } }",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs":
        "public class WidgetCreateCommandHandler { void Handle() { Save(); } }",
      "src/App/Services/ImageProcessingService.cs":
        "public class ImageProcessingService { void V() { Validate(); throw new Exception(); } }",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Create widget",
      projectRoot: "/proj",
      codeIndex,
      enrichProfile: {
        scope: "backend",
        minAlignment: 50,
        domainGuards: [],
        sutMap: {},
        intentRules: [],
        intentRulesFile: ".ai-test/unit-intent-rules.json",
        codeAliasesFile: ".ai-test/code-aliases.json",
        allowDiskReresolve: false,
      },
      readExcerpt: async (p) => bodies[p] || "class X {}",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(
      hit.testData,
      /path:\s*src\/App\/Queries\/Contact\/ContactSearchQueryHandler\.cs/
    );
    assert.match(hit.testData, /code:\s*ContactSearchQueryHandler/);
    assert.ok(!/sut-resolve:\s*skipped/i.test(hit.testData));
    assert.ok(!/ImageProcessing/i.test(
      (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) || ""
    ));
  });

  it("soft Approve (no body-rule): upload success writes path (not skip)", async () => {
    const tc = sample({
      testCaseId: "TC-055",
      title: "Upload image - valid format - success",
      module: "Upload image",
      steps: "JPG PNG WEBP upload",
      expectedResult: "Success",
      testData: "trace: FEATURES/FR-24",
    });
    const index = buildProjectIndex([
      "src/Infrastructure/Services/IUploadService.cs",
      "src/Infrastructure/Services/UploadService.cs",
      "src/Application/Queries/GetUploadActivityQuery.cs",
    ]);
    const bodies: Record<string, string> = {
      "src/Infrastructure/Services/UploadService.cs":
        "public class UploadService { public Task InitUploadAsync() {} }",
      "src/Infrastructure/Services/IUploadService.cs":
        "public interface IUploadService { Task InitUploadAsync(); }",
      "src/Application/Queries/GetUploadActivityQuery.cs":
        "public class GetUploadActivityQuery {}",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Upload",
      projectRoot: "/proj",
      enrichProfile: {
        scope: "backend",
        minAlignment: 50,
        domainGuards: [],
        sutMap: {},
        intentRules: [],
        intentRulesFile: ".ai-test/unit-intent-rules.json",
        codeAliasesFile: ".ai-test/code-aliases.json",
        allowDiskReresolve: false,
      },
      readExcerpt: async (p) => bodies[p] || "class X {}",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(hit.testData, /path:\s*src\//);
    assert.match(hit.testData, /code:\s*\w+/);
    assert.ok(!/sut-resolve:\s*skipped/i.test(hit.testData));
    assert.match(hit.testData, /UploadService/);
    assert.ok(!/^path:.*IUploadService/m.test(hit.testData));
  });

  it("empty profile + no aliases: module/title picks WidgetCreate over CaseCreate", async () => {
    const tc = sample({
      testCaseId: "TC-EMPTY-CFG",
      title: "Create widget - leave code empty - auto generate",
      module: "Create widget",
      steps: "Leave code empty; save",
      expectedResult: "code auto-generated",
      testData: "trace: AC/auto-code; input=code=empty",
    });
    const paths = [
      "src/App/Commands/Case/CaseCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
    ];
    const index = buildProjectIndex(paths);
    const bodies: Record<string, string> = {
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
        public class WidgetCreateCommandHandler {
          void Handle() {
            var userProvidedCode = !string.IsNullOrWhiteSpace(code);
            if (!userProvidedCode) code = "W";
            _audit.Log("tao moi widget");
          }
        }`,
      "src/App/Commands/Case/CaseCreateCommandHandler.cs": `
        public class CaseCreateCommandHandler {
          void Handle() {
            var userProvidedCode = !string.IsNullOrWhiteSpace(code);
            if (!userProvidedCode) code = "C";
            _audit.Log("tao moi case");
          }
        }`,
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Widget",
      projectRoot: "/proj",
      projectAliases: {},
      enrichProfile: {
        scope: "backend",
        minAlignment: 50,
        domainGuards: [],
        sutMap: {},
        intentRules: [],
        intentRulesFile: ".ai-test/unit-intent-rules.json",
        codeAliasesFile: ".ai-test/code-aliases.json",
        allowDiskReresolve: false,
      },
      codeIndex: snapshotFromPaths(paths),
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(hit.enriched, true, JSON.stringify(hit));
    assert.match(
      hit.testData,
      /path:\s*src\/App\/Commands\/Widget\/WidgetCreateCommandHandler\.cs/
    );
    assert.match(hit.testData, /code:\s*WidgetCreateCommandHandler/);
    assert.ok(!/CaseCreate/i.test(
      (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) || ""
    ));
  });

  it("P0.1 soft writeBack refuses generic throw/BadRequest without domain prefer", async () => {
    const tc = sample({
      testCaseId: "TC-SOFT-1",
      title: "Call handler - success",
      module: "Create",
      steps: "Call create",
      expectedResult: "OK",
      testData: "trace: soft",
    });
    const index = buildProjectIndex([
      "src/App/Commands/Foo/FooCreateCommandHandler.cs",
    ]);
    const bodies: Record<string, string> = {
      "src/App/Commands/Foo/FooCreateCommandHandler.cs":
        "class FooCreateCommandHandler { void Handle() { throw new BadRequestException(); Create(); } }",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Misc",
      projectRoot: "/proj",
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(hit.enriched, false, JSON.stringify(hit));
    assert.match(
      hit.skipReason || hit.testData || "",
      /FAIL_SOFT_NO_DOMAIN|FAIL_SOFT_CROSS_CUTTING|moduleGate|featureFolder|no confident|ambiguous/i
    );
  });

  it("storage module soft path refuses AccountSave via moduleGate (not denylist)", async () => {
    const tc = sample({
      testCaseId: "TC-STOR-1",
      title:
        "Choose storage location - validate compartment IsOccupied - reject when missing",
      module: "Choose storage location for widget",
      steps: "Missing cabinet; assert validation",
      expectedResult: "reject",
      testData: "trace: VALIDATION",
    });
    const paths = [
      "src/App/Commands/Account/AccountSaveCommandHandler.cs",
      "src/App/Commands/Storage/AssignSlotCommandHandler.cs",
    ];
    const index = buildProjectIndex(paths);
    const bodies: Record<string, string> = {
      "src/App/Commands/Account/AccountSaveCommandHandler.cs":
        "class AccountSaveCommandHandler { void H() { throw new Exception(); Save(); } }",
      "src/App/Commands/Storage/AssignSlotCommandHandler.cs":
        "class AssignSlotCommandHandler { bool IsOccupied; void H() { throw new BadRequestException(); } }",
    };
    const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
      requirementTitle: "Widget",
      projectRoot: "/proj",
      projectAliases: {},
      codeIndex: snapshotFromPaths(paths),
      readExcerpt: async (p) => bodies[p] || "",
    });
    const pathLine =
      (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) ||
      "";
    assert.ok(
      !/AccountSave/i.test(pathLine),
      `must not latch AccountSave: ${JSON.stringify(hit)}`
    );
  });
});
