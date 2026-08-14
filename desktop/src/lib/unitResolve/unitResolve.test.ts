/**
 * Unit resolve — Query Builder + pipeline smoke (portable Widget fixture).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUnitApproveQuery,
  resolveUnitPrimaryFromIndex,
  snapshotFromPaths,
} from "./index.js";

describe("buildUnitApproveQuery", () => {
  it("maps auto-generate empty-code TC to auto_generate_code + codeFieldCreate", () => {
    const q = buildUnitApproveQuery(
      {
        title: "Create widget - leave code empty - system auto generates",
        module: "Create widget",
        steps: "Leave code empty; save",
        expectedResult: "code auto-generated",
        testData: "trace: AC/auto-code",
      },
      { requirementTitle: "Widget", projectAliases: { widget: ["Widget"] } }
    );
    assert.equal(q.intent.primaryClass, "auto_generate_code");
    assert.equal(q.requiresBodyRule, true);
    assert.equal(q.codeFieldCreate, true);
    assert.ok(q.keywords.some((k) => /Widget/i.test(k)));
    assert.equal(q.plan.testType, "Unit");
  });

  it("VALIDATION_DATA primaryBucket forces requiresBodyRule", () => {
    const q = buildUnitApproveQuery(
      {
        title: "Update - empty field - reject",
        module: "Update feature",
        steps: "1. Act",
        expectedResult: "REJECT",
        testData:
          "primaryBucket: VALIDATION_DATA\n" +
          "trace: VALIDATION_DATA/VAL-1\n" +
          "target.field: Name\n" +
          "target.constraint: required",
      },
      { requirementTitle: "Update evidence" }
    );
    assert.equal(q.requiresBodyRule, true);
    assert.equal(q.intent.requiresBodyRule, true);
  });

  it("validate_reject + tech stem Widget from errorKey", () => {
    const q = buildUnitApproveQuery(
      {
        title: "Create widget - duplicate code - reject",
        module: "Create widget",
        steps: "Input existing code; assert reject",
        expectedResult: "BadRequest",
        testData: "errorKey=widgetCodeExists",
      },
      { projectAliases: { widget: ["Widget"] } }
    );
    assert.equal(q.intent.primaryClass, "validate_reject");
    assert.ok(q.keywords.some((k) => /Widget/i.test(k)));
  });
});

describe("resolveUnitPrimaryFromIndex", () => {
  it("retrieve+rank picks WidgetCreateHandler for auto-generate with alias", async () => {
    const paths = [
      "src/App/Commands/Case/CaseCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Queries/Widget/WidgetCheckCodeQueryHandler.cs",
      "src/App/Commands/Storage/GenerateUploadUrlCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
        public class WidgetCreateCommandHandler {
          void Handle() {
            var userProvidedCode = !string.IsNullOrWhiteSpace(code);
            if (!userProvidedCode) code = "W";
          }
        }`,
      "src/App/Commands/Case/CaseCreateCommandHandler.cs": `
        public class CaseCreateCommandHandler {
          void Handle() {
            var userProvidedCode = !string.IsNullOrWhiteSpace(code);
            if (!userProvidedCode) code = "C";
          }
        }`,
      "src/App/Commands/Storage/GenerateUploadUrlCommandHandler.cs":
        "public class GenerateUploadUrlCommandHandler { void H() { Generate(); } }",
    };
    const query = buildUnitApproveQuery(
      {
        title: "Create widget - leave code empty - auto generate",
        module: "Create widget",
        steps: "empty code; save",
        expectedResult: "generated",
        testData: "input=code=empty",
      },
      { requirementTitle: "Widget", projectAliases: { widget: ["Widget"] } }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /WidgetCreateCommandHandler/);
  });

  it("module gate: Widget TC prefers WidgetCreate over OrderCreate without aliases", async () => {
    const paths = [
      "src/App/Commands/Order/OrderCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
        throw new BadRequestAlertException("dup", "widgetCodeExists");
        _audit.Log("tao moi widget item");
      `,
      "src/App/Commands/Order/OrderCreateCommandHandler.cs": `
        throw new BadRequestAlertException("dup", "orderCodeExists");
        _audit.Log("tao moi order item");
      `,
    };
    const query = buildUnitApproveQuery(
      {
        title: "Create widget - duplicate code - reject",
        module: "Create widget",
        steps: "existing code; save; reject",
        expectedResult: "BadRequest Duplicate",
        testData: "errorKey=widgetCodeExists",
      },
      { requirementTitle: "Widget" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /WidgetCreateCommandHandler/);
    assert.match(r.bodyRuleLog || "", /signals=/);
  });

  it("P0.1: soft writeBack refuses when only throw/Create hits and no domain prefer", async () => {
    const paths = ["src/App/Commands/Foo/FooCreateCommandHandler.cs"];
    const query = buildUnitApproveQuery(
      {
        title: "Call handler - success",
        module: "Create",
        steps: "Call create",
        expectedResult: "OK",
        testData: "trace: soft",
      },
      { requirementTitle: "Misc" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async () =>
        "class FooCreateCommandHandler { void Handle() { throw new BadRequestException(); Create(); } }",
    });
    assert.equal(r.writeBack, false, JSON.stringify(r));
    assert.match(
      r.skipReason || r.bodyRuleLog || "",
      /FAIL_SOFT_NO_DOMAIN|FAIL_SOFT_CROSS_CUTTING|moduleGate|featureFolder|ambiguous|body-rule/i
    );
  });

  it("storage module refuses wrong-family AccountSave via moduleGate (not denylist)", async () => {
    const paths = [
      "src/App/Commands/Account/AccountSaveCommandHandler.cs",
      "src/App/Commands/Storage/AssignSlotCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/App/Commands/Account/AccountSaveCommandHandler.cs":
        "class AccountSaveCommandHandler { void H() { throw new BadRequestException(); Save(); } }",
      "src/App/Commands/Storage/AssignSlotCommandHandler.cs": `
        class AssignSlotCommandHandler {
          bool IsOccupied;
          void H() { if (missing) throw new BadRequestException("compartment"); }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Choose storage location - validate compartment IsOccupied - reject when missing",
        module: "Choose storage location for widget",
        steps: "Missing cabinet or compartment; assert validation",
        expectedResult: "reject when compartment required",
        testData: "trace: VALIDATION/location",
      },
      { requirementTitle: "Widget" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    if (r.writeBack) {
      assert.match(r.seed!.pathRel, /Storage|AssignSlot/i);
      assert.ok(!/AccountSave/i.test(r.seed!.pathRel));
    } else {
      assert.match(
        r.skipReason || "",
        /featureFolder|moduleGate|SOFT_NO_DOMAIN|SOFT_CROSS_CUTTING|ambiguous|body-rule|OP_CONTRADICT/i
      );
    }
  });

  it("storage TC does not latch EvidenceAssignCase — prefers Compartment handler", async () => {
    const paths = [
      "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
      "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/App/Commands/Evidence/EvidenceAssignCompartmentCommandHandler.cs",
      "src/App/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs":
        "class EvidenceAssignCaseCommandHandler { void H() { AssignCase(); CanWriteCase(); } }",
      "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
      "src/App/Commands/Evidence/EvidenceAssignCompartmentCommandHandler.cs": `
        class EvidenceAssignCompartmentCommandHandler {
          void H() { if (IsOccupied || missing) throw new BadRequestException("compartment"); }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title: "Chọn vị trí lưu trữ - ngăn không tồn tại - từ chối",
        module: "Chọn vị trí lưu trữ",
        steps: "Chọn ngăn không tồn tại",
        expectedResult: "Từ chối",
        testData: "trace: VALIDATION/storage",
      },
      {
        requirementTitle: "Tạo mới vật chứng",
        projectAliases: { "vat chung": ["Evidence"] },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /Compartment/i);
    assert.ok(!/AssignCase/i.test(r.seed!.pathRel), JSON.stringify(r.seed));
  });

  it("TC-010 style: authz quyền ghi prefers Assign with CanWrite over bare Create", async () => {
    const paths = [
      "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
      "src/App/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
      "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs": `
        class EvidenceAssignCaseCommandHandler {
          void H() { if (!CanWriteCase(user)) throw new ForbiddenException(); AssignCase(); }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title: "Gán vật chứng - Không có quyền ghi - Từ chối",
        module: "Gán vật chứng vào hồ sơ",
        steps: "User không quyền ghi; gọi Assign; assert Forbidden",
        expectedResult: "Từ chối khi không CanWrite",
        testData: "trace: ACTORS/authz\nlayerHint: authz",
      },
      {
        requirementTitle: "Tạo mới vật chứng",
        projectAliases: { "vat chung": ["Evidence"] },
      }
    );
    assert.ok(
      query.preferTokensStrong.some((t) => /CanWrite|Permission|Authorization/i.test(t)),
      JSON.stringify(query.preferTokensStrong)
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /AssignCase/i);
    assert.ok(!/CreateCommandHandler/i.test(r.seed!.pathRel), JSON.stringify(r.seed));
  });

  it("moduleGate miss fail-closed when tokens miss all paths", async () => {
    const paths = [
      "src/App/Commands/Order/OrderCreateCommandHandler.cs",
    ];
    const query = buildUnitApproveQuery(
      {
        title: "Create widget - success",
        module: "Create widget",
        steps: "save",
        expectedResult: "ok",
        testData: "trace: x",
      },
      { requirementTitle: "Widget" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async () =>
        "class OrderCreateCommandHandler { void H() { Create(); } }",
    });
    assert.equal(r.writeBack, false, JSON.stringify(r));
    assert.match(r.skipReason || "", /moduleGate miss|featureFolder miss/i);
  });

  it("VI create module: CheckCode folder discover locks family (no alias)", async () => {
    const paths = [
      "src/App/Commands/Account/AccountCreateCommandHandler.cs",
      "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/App/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs",
    ];
    const query = buildUnitApproveQuery(
      {
        title: "Tao moi vat chung - DichVuTaoVatChung - Tao thanh cong",
        module: "Tao moi vat chung",
        steps: "1. Mock\n2. Call create\n3. Assert ok",
        expectedResult: "created",
        testData: "trace: FEATURES/create",
      },
      { requirementTitle: "Tao moi vat chung" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) =>
        p.includes("EvidenceCreate")
          ? "class EvidenceCreateCommandHandler { void H() { Create(); } }"
          : p.includes("CheckCode")
            ? "class EvidenceCheckCodeQueryHandler { void H() { CheckCode(); } }"
            : "class AccountCreateCommandHandler { void H() { Create(); } }",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /EvidenceCreate/i);
    assert.ok(!/AccountCreate/i.test(r.seed!.pathRel));
  });

  it("VI reject duplicate: CheckCode title cue discovers Evidence family", async () => {
    const paths = [
      "src/App/Commands/Account/AccountCreateCommandHandler.cs",
      "src/App/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs",
      "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
    ];
    const query = buildUnitApproveQuery(
      {
        title: "Tao moi vat chung - KiemTraMaVatChung - Tu choi khi ma trung",
        module: "Tao moi vat chung",
        steps: "Duplicate code; assert reject",
        expectedResult: "tu choi",
        testData: "trace: VALIDATION/code",
      },
      { requirementTitle: "Tao moi vat chung" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) =>
        p.includes("CheckCode")
          ? "class EvidenceCheckCodeQueryHandler { void H() { if (dup) throw new BadRequestException(); } }"
          : p.includes("EvidenceCreate")
            ? "class EvidenceCreateCommandHandler { void H() { Create(); } }"
            : "class AccountCreateCommandHandler { void H() { Create(); } }",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /Evidence(CheckCode|Create)/i);
  });

  it("Module scopes Widget; Function assign+filter does not latch UserCreate", async () => {
    const paths = [
      "src/App/Commands/User/UserCreateCommandHandler.cs",
      "src/App/Commands/User/UserOrgUnitCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Widget/AssignWidgetToCaseCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/App/Commands/User/UserCreateCommandHandler.cs":
        "class UserCreateCommandHandler { void H() { Create(); } }",
      "src/App/Commands/User/UserOrgUnitCreateCommandHandler.cs":
        "class UserOrgUnitCreateCommandHandler { void H() { Create(); } }",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs":
        "class WidgetCreateCommandHandler { void H() { Create(); } }",
      "src/App/Commands/Widget/AssignWidgetToCaseCommandHandler.cs": `
        class AssignWidgetToCaseCommandHandler {
          void H() {
            var cases = repo.ListJoinedOrManaged(userId);
            return cases;
          }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Assign widget to case - filter by permission - only return joined or managed cases",
        module: "Assign widget to case",
        steps: "Prepare userId and mixed case set; mock repo; assert filter",
        expectedResult: "Only cases user joins or manages",
        testData: "trace: BUSINESS_RULES/BR-7; input=user subset",
      },
      {
        requirementTitle: "Create widget",
        projectAliases: { widget: ["Widget"] },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    // Module gate + demotePersonFamily must leave Widget/Assign on top — never User*
    assert.ok(
      (r.candidatesTop3 || []).every((c) => !/UserCreate|UserOrgUnit/i.test(c.pathRel)),
      JSON.stringify(r)
    );
    const top = r.seed?.pathRel || r.candidatesTop3?.[0]?.pathRel || "";
    assert.match(top, /Widget|AssignWidget/i, JSON.stringify(r));
    if (r.writeBack) {
      assert.match(r.seed!.pathRel, /AssignWidget|Widget/i);
    }
  });

  it("TC-010 style: Module Evidence scope + Function assign/filter → BE handler not User*", async () => {
    const paths = [
      "src/Forensic.Application/Commands/User/UserCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/User/UserOrgUnitCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/CaseRecord/CaseRecordCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/AssignEvidenceToCaseCommandHandler.cs",
      "src/Forensic.Application/Queries/CaseRecord/ListAvailableCaseRecordsQueryHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/User/UserCreateCommandHandler.cs":
        "class UserCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Application/Commands/User/UserOrgUnitCreateCommandHandler.cs":
        "class UserOrgUnitCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Application/Commands/CaseRecord/CaseRecordCreateCommandHandler.cs":
        "class CaseRecordCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Application/Commands/Evidence/AssignEvidenceToCaseCommandHandler.cs": `
        class AssignEvidenceToCaseCommandHandler {
          void H() {
            var cases = repo.ListJoinedOrManaged(userId);
          }
        }`,
      "src/Forensic.Application/Queries/CaseRecord/ListAvailableCaseRecordsQueryHandler.cs": `
        class ListAvailableCaseRecordsQueryHandler {
          void H() { repo.FilterByParticipationOrManagement(userId); }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Gán vật chứng vào hồ sơ vụ án - lọc theo quyền - Chỉ trả vụ án được tham gia hoặc quản lý",
        module: "Gán vật chứng vào hồ sơ vụ án",
        steps: "Mock repo; filter by participation/management; assert",
        expectedResult: "Only joined or managed cases",
        testData: "trace: BUSINESS_RULES/BR-7",
      },
      {
        requirementTitle: "Tạo mới vật chứng",
        projectAliases: {
          "vat chung": ["Evidence"],
          "ho so vu an": ["CaseRecord", "Case"],
        },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    const top = r.seed?.pathRel || r.candidatesTop3?.[0]?.pathRel || "";
    assert.match(top, /AssignEvidence|ListAvailableCaseRecords/i, JSON.stringify(r));
    assert.ok(
      (r.candidatesTop3 || []).every((c) => !/UserCreate|UserOrgUnit/i.test(c.pathRel)),
      JSON.stringify(r)
    );
    assert.ok(!/CaseRecordCreate/i.test(top));
    assert.ok(!/EvidenceCreate/i.test(top), JSON.stringify(r));
    assert.ok(r.notes?.some((n) => /moduleGate|demotePersonFamily/i.test(n)));
    if (r.writeBack) {
      assert.match(r.seed!.pathRel, /AssignEvidence|ListAvailableCaseRecords/i);
    }
  });

  it("CheckCode family: assign/filter Function ranks Assign over EvidenceCreate", async () => {
    const paths = [
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/AssignEvidenceToCaseCommandHandler.cs",
      "src/Forensic.Application/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs",
      "src/Forensic.Application/Queries/CaseRecord/ListAvailableCaseRecordsQueryHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Application/Commands/Evidence/AssignEvidenceToCaseCommandHandler.cs": `
        class AssignEvidenceToCaseCommandHandler {
          void H() {
            var cases = repo.ListJoinedOrManaged(userId).Where(c => c.Filter);
          }
        }`,
      "src/Forensic.Application/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs":
        "class EvidenceCheckCodeQueryHandler { void H() { Exists(); } }",
      "src/Forensic.Application/Queries/CaseRecord/ListAvailableCaseRecordsQueryHandler.cs": `
        class ListAvailableCaseRecordsQueryHandler {
          void H() { repo.FilterByParticipationOrManagement(userId); }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Gán vật chứng vào hồ sơ vụ án - lọc theo quyền - Chỉ trả vụ án được tham gia hoặc quản lý",
        module: "Gán vật chứng vào hồ sơ vụ án",
        steps: "Mock repo; filter by participation/management; assert",
        expectedResult: "Only joined or managed cases",
        testData: "trace: BUSINESS_RULES/BR-7",
      },
      {
        requirementTitle: "Tạo mới vật chứng",
        projectAliases: {
          "vat chung": ["Evidence"],
          "ho so vu an": ["CaseRecord", "Case"],
        },
      }
    );
    assert.ok(
      !query.intent.classes.includes("persist_create"),
      JSON.stringify(query.intent.classes)
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    const top = r.seed?.pathRel || r.candidatesTop3?.[0]?.pathRel || "";
    assert.match(top, /AssignEvidence|ListAvailableCaseRecords/i, JSON.stringify(r));
    assert.ok(!/EvidenceCreate/i.test(top), JSON.stringify(r));
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /AssignEvidence|ListAvailableCaseRecords/i);
  });

  it("TC-059 style: Module Evidence + Function upload/image → PhysicalImage not DocumentCreate", async () => {
    const paths = [
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceDocumentCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidencePhysicalImageCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/DigitalFile/DigitalFileCreateCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceDocumentCreateCommandHandler.cs": `
        class EvidenceDocumentCreateCommandHandler {
          void H() { Create(); throw new BadRequestException("invalid"); }
        }`,
      "src/Forensic.Application/Commands/Evidence/EvidencePhysicalImageCreateCommandHandler.cs": `
        class EvidencePhysicalImageCreateCommandHandler {
          void H() {
            if (!scanner.IsSafe) throw new BadRequestException("infected");
            Upload(image);
          }
        }`,
      "src/Forensic.Application/Commands/DigitalFile/DigitalFileCreateCommandHandler.cs": `
        class DigitalFileCreateCommandHandler {
          void H() { Upload(file); throw new ArgumentException("format"); }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Tải lên hình ảnh vật chứng - Từ chối file chứa mã độc hoặc định dạng không hợp lệ",
        module: "Tải lên hình ảnh vật chứng",
        steps:
          "1. UploadEvidenceImageCommand with invalid png\n2. Mock scanner IsSafe=false\n3. Assert reject",
        expectedResult:
          "Service từ chối upload; lỗi mã độc hoặc định dạng không hợp lệ",
        testData:
          "trace: EXCEPTIONS/Hình ảnh vật chứng mã độc; fileName=evidence.png; scannerResult=infected",
        precondition: "Mock IAntivirusScanner detects infected file",
      },
      {
        requirementTitle: "Tạo mới vật chứng",
        projectAliases: { "vat chung": ["Evidence"] },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    const top = r.seed?.pathRel || r.candidatesTop3?.[0]?.pathRel || "";
    assert.match(
      top,
      /PhysicalImage|DigitalFile/i,
      JSON.stringify(r)
    );
    assert.ok(!/EvidenceDocumentCreate/i.test(top), JSON.stringify(r));
    if (r.writeBack) {
      assert.match(r.seed!.pathRel, /PhysicalImage|DigitalFile/i);
    }
  });

  it("TC-064 style: reject + Image prefer → PhysicalImageCreate even if excerpt has no throw", async () => {
    const paths = [
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/EvidencePhysicalImage/EvidencePhysicalImageDeleteCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceDocumentCreateCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); throw new BadRequestException(\"dup\"); } }",
      "src/Forensic.Application/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs": `
        class EvidencePhysicalImageCreateCommandHandler {
          void Handle() {
            var entity = _mapper.Map(request);
            await _repo.CreateOrUpdateAsync(entity);
          }
        }`,
      "src/Forensic.Application/Commands/EvidencePhysicalImage/EvidencePhysicalImageDeleteCommandHandler.cs":
        "class EvidencePhysicalImageDeleteCommandHandler { void H() { Delete(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceDocumentCreateCommandHandler.cs":
        "class EvidenceDocumentCreateCommandHandler { void H() { Create(); } }",
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Tải lên hình ảnh vật chứng - Tải tệp mã độc hoặc định dạng không hợp lệ - Từ chối",
        module: "Tải lên hình ảnh vật chứng",
        steps: "1. Chuẩn bị tệp mã độc\n2. Gọi đơn vị tải lên\n3. Assert từ chối",
        expectedResult: "Từ chối upload",
        testData: "trace: ERROR_HANDLING/malware",
      },
      { requirementTitle: "Create evidence" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /EvidencePhysicalImageCreateCommandHandler/i);
    assert.ok(!/EvidenceCreateCommandHandler\.cs$/i.test(r.seed!.pathRel));
  });

  it("TC-005 style: upload reject format must not latch DigitalDeviceDelete", async () => {
    const paths = [
      "src/Forensic.Application/Commands/DigitalDevice/DigitalDeviceDeleteCommandHandler.cs",
      "src/Forensic.Application/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/Forensic.Infrastructure/Services/UploadService.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/DigitalDevice/DigitalDeviceDeleteCommandHandler.cs": `
        class DigitalDeviceDeleteCommandHandler {
          void H() { throw new BadRequestAlertException("not found"); Delete(); }
        }`,
      "src/Forensic.Application/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs": `
        class EvidencePhysicalImageCreateCommandHandler {
          void Handle() { await _repo.CreateOrUpdateAsync(entity); }
        }`,
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Infrastructure/Services/UploadService.cs": `
        class UploadService {
          void Init() { if (!allowed.Contains(ext)) throw new ArgumentException("format"); }
        }`,
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Tải lên hình ảnh và tệp kỹ thuật số vật chứng - Từ chối tệp hình ảnh ngoài JPG JPEG PNG WEBP - Không cho phép tải lên",
        module: "Tải lên hình ảnh và tệp kỹ thuật số vật chứng",
        steps:
          "1. Chuẩn bị tệp hình ảnh định dạng ngoài danh sách\n2. Thực hiện tải lên tệp hình ảnh vật chứng",
        expectedResult:
          "REJECT — Hệ thống không cho phép tải lên tệp có định dạng ngoài JPG JPEG PNG WEBP",
        testData: "trace: ERROR_HANDLING/EXC-IMG-FORMAT; dinhDang=ngoài danh sách",
      },
      { requirementTitle: "Create evidence" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    const top = r.seed?.pathRel || r.candidatesTop3?.[0]?.pathRel || "";
    assert.ok(
      !/DigitalDeviceDelete/i.test(top),
      `must not pick Delete: ${JSON.stringify(r)}`
    );
    if (r.writeBack) {
      assert.match(
        r.seed!.pathRel,
        /PhysicalImageCreate|UploadService|EvidenceCreate/i,
        JSON.stringify(r)
      );
    }
  });

  it("TC-054 style: search by case code prefers GetAll Query over AssignCase", async () => {
    const paths = [
      "src/Forensic.Application/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
      "src/Forensic.Application/Queries/CaseRecord/CaseRecordGetAllQueryHandler.cs",
      "src/Forensic.Application/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs": `
        class EvidenceAssignCaseCommandHandler {
          void H() { Assign(caseId); throw new BadRequestAlertException("x"); }
        }`,
      "src/Forensic.Application/Queries/CaseRecord/CaseRecordGetAllQueryHandler.cs": `
        class CaseRecordGetAllQueryHandler {
          void Handle() {
            var searchTerm = request.SearchTerm?.Trim().ToLower();
            return query.Where(x => x.Code.ToLower().Contains(searchTerm));
          }
        }`,
      "src/Forensic.Application/Queries/Evidence/EvidenceCheckCodeQueryHandler.cs":
        "class EvidenceCheckCodeQueryHandler { void H() { Exists(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Gắn hồ sơ vụ án cho vật chứng - Tìm theo mã vụ án - Trả về hồ sơ khớp mã",
        module: "Gắn hồ sơ vụ án cho vật chứng",
        steps:
          "1. Chuẩn bị từ khóa tìm kiếm là mã vụ án hợp lệ\n2. Thực hiện tìm kiếm hồ sơ vụ án theo mã",
        expectedResult:
          "ACCEPT — Backend trả về hồ sơ vụ án khớp theo mã vụ án — (quan sát: truy vấn tìm kiếm)",
        testData: 'trace: BUSINESS_RULES/BR-7; input={"tuKhoa":"MA-VA-001"}',
      },
      {
        requirementTitle: "Create evidence",
        projectAliases: {
          "vat chung": ["Evidence"],
          "ho so vu an": ["CaseRecord", "Case"],
        },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(
      r.seed!.pathRel,
      /CaseRecordGetAllQueryHandler/i,
      JSON.stringify(r)
    );
    assert.ok(!/EvidenceAssignCase/i.test(r.seed!.pathRel));
  });

  it("FAIL_UNGATED: VI create without CheckCode/alias does not soft-latch CasePerson", async () => {
    const paths = [
      "src/App/Commands/CasePerson/CasePersonCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Queries/User/UserGetAllQueryHandler.cs",
    ];
    const query = buildUnitApproveQuery(
      {
        title: "Tao moi vat chung - khoi tao ban ghi - thanh cong",
        module: "Tao moi vat chung",
        steps:
          "Prepare DTO with tenVatChung, hoSoVuAnId, nguoiThuGiu; call create; assert ok",
        expectedResult: "created",
        testData: 'input={tenVatChung:"x", hoSoVuAnId:"HS-1", nguoiThuGiu:"A"}',
        precondition: "Mock case record and person store",
      },
      { requirementTitle: "Tao moi vat chung" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) =>
        p.includes("CasePerson")
          ? "class CasePersonCreateCommandHandler { void H() { Create(); } }"
          : p.includes("UserGetAll")
            ? "class UserGetAllQueryHandler { void H() { if (string.IsNullOrWhiteSpace(x)) {} } }"
            : "class WidgetCreateCommandHandler { void H() { Create(); } }",
    });
    assert.equal(r.writeBack, false, JSON.stringify(r));
    assert.match(r.skipReason || "", /FAIL_UNGATED|moduleGate miss|featureFolder miss/i);
  });

  it("LLM shortlist pick: mock chooses WidgetCreate when ungated", async () => {
    const paths = [
      "src/App/Commands/CasePerson/CasePersonCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Queries/User/UserGetAllQueryHandler.cs",
    ];
    const query = buildUnitApproveQuery(
      {
        title: "Tao moi vat chung - khoi tao - thanh cong",
        module: "Tao moi vat chung",
        steps: "create with hoSoVuAnId",
        expectedResult: "ok",
        testData: "trace: x",
      },
      { requirementTitle: "Tao moi vat chung" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async () => "Create();",
      pickFromShortlist: async (input) => {
        const hit = input.shortlist.find((s) =>
          /WidgetCreate/i.test(s.pathRel)
        );
        if (!hit) return null;
        return {
          pathRel: hit.pathRel,
          code: "WidgetCreateCommandHandler",
          confidence: 0.92,
          source: "mock",
        };
      },
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.equal(r.source, "llm-shortlist");
    assert.match(r.seed!.pathRel, /WidgetCreate/);
  });

  it("LLM pick refuses path not in shortlist", async () => {
    const paths = [
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Order/OrderCreateCommandHandler.cs",
    ];
    const query = buildUnitApproveQuery(
      {
        title: "Tao moi vat chung",
        module: "Tao moi vat chung",
        steps: "create",
        expectedResult: "ok",
        testData: "x",
      },
      { requirementTitle: "Tao moi vat chung" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async () => "Create();",
      pickFromShortlist: async () => ({
        pathRel: "src/App/Commands/Invented/InventedHandler.cs",
        code: "InventedHandler",
        confidence: 0.99,
        source: "mock",
      }),
    });
    assert.equal(r.writeBack, false, JSON.stringify(r));
  });

  it("layerHint dto + sourceSignal promotes DTO primary over CreateHandler", async () => {
    const snap = snapshotFromPaths([
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommand.cs",
      "src/App/Commands/Widget/WidgetAssignCaseCommand.cs",
      "src/App/Dtos/WidgetDto.cs",
    ]);
    const query = buildUnitApproveQuery(
      {
        title: "Widget - Empty name - Reject validation",
        module: "Create widget",
        steps: "1. Call validator with empty Name",
        expectedResult: "Validation fails",
        testData:
          "trace: VALIDATION/Name\nlayerHint: dto\nsourceSignal: WidgetDto.Name Required",
      },
      { requirementTitle: "Widget" }
    );
    const res = await resolveUnitPrimaryFromIndex({
      codeIndex: snap,
      query,
      readExcerpt: async (p) => {
        if (/Handler/.test(p)) {
          return "throw new BadRequestAlertException(\"dup\");";
        }
        if (/WidgetDto/.test(p)) {
          return "[Required]\npublic string Name { get; set; }";
        }
        return "public class X {}";
      },
    });
    assert.equal(res.writeBack, true, res.skipReason || res.bodyRuleLog);
    assert.match(res.seed?.pathRel || "", /WidgetDto\.cs$/);
    assert.ok(
      (res.relatedPaths || []).some((p) => /Handler/.test(p)),
      JSON.stringify(res.relatedPaths)
    );
  });

  it("LLM pick refuses softCrossCutting infra path (signed URL)", async () => {
    const paths = [
      "src/App/Commands/Storage/GenerateUploadUrlCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
    ];
    const query = buildUnitApproveQuery(
      {
        title: "Tao moi vat chung",
        module: "Tao moi vat chung",
        steps: "create",
        expectedResult: "ok",
        testData: "x",
      },
      { requirementTitle: "Tao moi vat chung" }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async () => "Create(); Generate();",
      pickFromShortlist: async (input) => {
        const hit = input.shortlist.find((s) =>
          /GenerateUploadUrl/i.test(s.pathRel)
        );
        if (!hit) return null;
        return {
          pathRel: hit.pathRel,
          code: "GenerateUploadUrlCommandHandler",
          confidence: 0.99,
          source: "mock",
        };
      },
    });
    assert.equal(r.writeBack, false, JSON.stringify(r));
    assert.ok(
      (r.notes || []).some((n) => /FAIL_SOFT_CROSS_CUTTING/i.test(n)),
      JSON.stringify(r.notes)
    );
  });

  it("TC-016 style load/display detail: GetQuery not Create writeBack", async () => {
    const paths = [
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
      "src/Forensic.Application/Queries/Evidence/EvidenceGetQueryHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceUpdateCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { Create(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs":
        "class EvidenceAssignCaseCommandHandler { void H() { Assign(); } }",
      "src/Forensic.Application/Queries/Evidence/EvidenceGetQueryHandler.cs":
        "class EvidenceGetQueryHandler { void H() { return GetById(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceUpdateCommandHandler.cs":
        "class EvidenceUpdateCommandHandler { void H() { Update(); } }",
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Hiển thị và chỉnh sửa chi tiết vật chứng - Tải dữ liệu vật chứng đã lưu - Trả về đầy đủ thông tin đã lưu",
        module: "Hiển thị và chỉnh sửa chi tiết vật chứng",
        steps:
          "1. Chuẩn bị vật chứng đã lưu\n2. Thực hiện lấy chi tiết vật chứng theo định danh đã lưu",
        expectedResult:
          "ACCEPT — Hệ thống trả về đúng các thông tin vật chứng đã lưu trước đó — (quan sát: read)",
        testData:
          "trace: ACCEPTANCE/FEAT-1\nprimaryBucket: ACCEPTANCE\ninput: {\"evidenceId\":\"[Giả định] id\"}",
      },
      {
        requirementTitle: "Update evidence",
        projectAliases: { "vat chung": ["Evidence"], evidence: ["Evidence"] },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /EvidenceGetQueryHandler/i);
    assert.ok(
      !/EvidenceCreateCommandHandler/i.test(r.seed!.pathRel),
      JSON.stringify(r.seed)
    );
  });

  it("CRUD: update+duplicate reject → UpdateHandler not Create (TC-063 style)", async () => {
    const paths = [
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceUpdateCommandHandler.cs",
      "src/Forensic.Application/Commands/Evidence/EvidenceDeleteCommandHandler.cs",
      "src/Forensic.Application/Queries/Evidence/EvidenceGetQueryHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
        "class EvidenceCreateCommandHandler { void H() { throw new BadRequestAlertException(\"Duplicate\"); Create(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceUpdateCommandHandler.cs":
        "class EvidenceUpdateCommandHandler { void H() { throw new BadRequestAlertException(\"Duplicate\"); Update(); } }",
      "src/Forensic.Application/Commands/Evidence/EvidenceDeleteCommandHandler.cs":
        "class EvidenceDeleteCommandHandler { void H() { Delete(); } }",
      "src/Forensic.Application/Queries/Evidence/EvidenceGetQueryHandler.cs":
        "class EvidenceGetQueryHandler { void H() { return GetById(); } }",
    };
    const query = buildUnitApproveQuery(
      {
        title:
          "Cập nhật mã và tên vật chứng - Cập nhật mã trùng mã đã tồn tại - Từ chối",
        module: "Cập nhật mã và tên vật chứng",
        steps:
          "1. Chuẩn bị mã đã tồn tại\n2. Thực hiện cập nhật mã vật chứng thành mã đã tồn tại",
        expectedResult:
          "REJECT — Hệ thống từ chối khi mã trùng — (quan sát: update)",
        testData:
          "trace: BUSINESS_RULES/BR-16\nprimaryBucket: BUSINESS_RULES\ntarget.constraint: unique",
      },
      {
        requirementTitle: "Update evidence",
        projectAliases: { "vat chung": ["Evidence"], evidence: ["Evidence"] },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /EvidenceUpdateCommandHandler/i);
    assert.ok(!/CreateCommandHandler/i.test(r.seed!.pathRel), JSON.stringify(r));
  });

  it("CRUD: create+duplicate reject still prefers CreateHandler", async () => {
    const paths = [
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetUpdateCommandHandler.cs",
    ];
    const bodies: Record<string, string> = {
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs":
        "class WidgetCreateCommandHandler { void H() { throw Duplicate; Create(); } }",
      "src/App/Commands/Widget/WidgetUpdateCommandHandler.cs":
        "class WidgetUpdateCommandHandler { void H() { throw Duplicate; Update(); } }",
    };
    const query = buildUnitApproveQuery(
      {
        title: "Tạo mới widget - Mã trùng - Từ chối",
        module: "Tạo mới widget",
        steps: "Thực hiện tạo mới với mã đã tồn tại",
        expectedResult: "REJECT — từ chối mã trùng — (quan sát: create)",
        testData: "trace: BUSINESS_RULES/BR-1\nprimaryBucket: BUSINESS_RULES",
      },
      {
        requirementTitle: "Create widget",
        projectAliases: { widget: ["Widget"] },
      }
    );
    const r = await resolveUnitPrimaryFromIndex({
      codeIndex: snapshotFromPaths(paths),
      query,
      readExcerpt: async (p) => bodies[p] || "",
    });
    assert.equal(r.writeBack, true, JSON.stringify(r));
    assert.match(r.seed!.pathRel, /WidgetCreateCommandHandler/i);
    assert.ok(
      r.confidence === "HIGH" || r.confidence === "MEDIUM",
      `expected confidence band, got ${r.confidence}`
    );
  });
});

describe("acceptShortlistPick", () => {
  it("accepts in-list path and rejects invented", async () => {
    const { acceptShortlistPick } = await import("./llmPickUnitPrimary.js");
    const list = [
      { pathRel: "src/App/Commands/Widget/WidgetCreateCommandHandler.cs", code: "WidgetCreateCommandHandler" },
      { pathRel: "src/App/Commands/Order/OrderCreateCommandHandler.cs", code: "OrderCreateCommandHandler" },
    ];
    const ok = acceptShortlistPick(
      {
        path: "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
        code: "WidgetCreateCommandHandler",
        confidence: 0.8,
      },
      list
    );
    assert.ok(ok);
    assert.match(ok!.pathRel, /WidgetCreate/);
    const bad = acceptShortlistPick(
      { path: "src/Hack/Evil.cs", code: "Evil", confidence: 0.99 },
      list
    );
    assert.equal(bad, null);
  });
});
