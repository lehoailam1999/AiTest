/**
 * Phase 3 — body-rule scoring for Approve write-back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractUnitIntent } from "./unitIntentAliases.js";
import {
  applyBodyRuleToCandidate,
  collapseBodyRuleContenders,
  decideBodyRuleWriteBack,
  findBodyRuleHits,
  formatBodyRuleLog,
  functionOpPathShapeAdjust,
  orderCandidatesForBodyRuleOpen,
  pathContradictsSearchVerb,
  pathContradictsUploadVerb,
  pathContradictsReadGetVerb,
  pathContradictsCrudVerb,
  detectUnitCrudVerb,
  crudVerbPathShapeAdjust,
  queryImpliesReadGetDetailIntent,
  readGetIntentPathShapeAdjust,
  uploadIntentPathShapeAdjust,
} from "./unitBodyRuleScore.js";

describe("unitBodyRuleScore", () => {
  it("orderCandidatesForBodyRuleOpen puts Handler before Query", () => {
    const intent = extractUnitIntent({
      title: "Create - duplicate code - reject",
      module: "Create entity",
      expectedResult: "reject duplicate",
    });
    const ordered = orderCandidatesForBodyRuleOpen(
      [
        { pathRel: "src/Queries/FooCheckQuery.cs", score: 80 },
        { pathRel: "src/Queries/FooCheckQueryHandler.cs", score: 78 },
        { pathRel: "src/Commands/FooCreateCommandHandler.cs", score: 50 },
      ],
      intent,
      5
    );
    assert.match(ordered[0]!.pathRel, /FooCreateCommandHandler/);
    assert.ok(ordered.some((c) => /FooCheckQuery\.cs$/.test(c.pathRel)));
  });

  it("finds MaxFileSize / FileSize / ArgumentException in excerpt", () => {
    const excerpt = `
      public async Task InitUploadAsync(UploadInitRequest req) {
        if (req.FileSize > _opts.MaxFileSize)
          throw new ArgumentException("too large");
      }
    `;
    const hits = findBodyRuleHits(excerpt, [
      "MaxFileSize",
      "FileSize",
      "exceed",
      "ArgumentException",
    ]);
    assert.ok(hits.includes("MaxFileSize"));
    assert.ok(hits.includes("FileSize"));
    assert.ok(hits.includes("ArgumentException"));
    assert.ok(!hits.includes("exceed"));
  });

  it("TC-092 style: write-back only when body-rule hits", () => {
    const intent = extractUnitIntent({
      title: "Tải lên tệp - vượt dung lượng - Từ chối",
      module: "Tải lên tệp kỹ thuật số",
      steps: "FileSize > MaxFileSize",
      expectedResult: "ArgumentException",
      precondition: "maxConfig",
    });
    assert.equal(intent.requiresBodyRule, true);

    const uploadExcerpt = `
      class UploadService {
        void InitUploadAsync() {
          if (file.FileSize > MaxFileSize) throw new ArgumentException();
        }
      }
    `;
    const feExcerpt = `export class ResumableUploadService { uploadChunk() {} }`;

    const scored = [
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Infrastructure/Services/UploadService.cs",
          score: 70,
          reason: "intent:Upload",
        },
        uploadExcerpt,
        intent
      ),
      applyBodyRuleToCandidate(
        {
          pathRel: "src/app/resumable-upload.service.ts",
          score: 85,
          reason: "fuzzy",
        },
        feExcerpt,
        intent
      ),
    ];

    const decision = decideBodyRuleWriteBack(scored, intent);
    assert.equal(decision.writeBack, true);
    assert.ok(decision.seed?.pathRel.includes("UploadService"));
    assert.ok(decision.seed!.ruleHits.length >= 1);
    assert.match(formatBodyRuleLog(decision), /writeBack=yes/);
  });

  it("requiresBodyRule blocks write when no pattern hits", () => {
    const intent = extractUnitIntent({
      title: "Upload file too large — reject",
      module: "Upload",
      steps: "exceed size limit",
      expectedResult: "reject",
    });
    const scored = [
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Infrastructure/Services/UploadService.cs",
          score: 90,
          reason: "path",
        },
        "class UploadService { void Init() { /* no size check */ } }",
        intent
      ),
    ];
    const decision = decideBodyRuleWriteBack(scored, intent);
    assert.equal(decision.writeBack, false);
    assert.match(decision.skipReason || "", /body-rule required/i);
  });

  it("without requiresBodyRule allows path-only confident seed", () => {
    const intent = extractUnitIntent({
      title: "Đăng nhập thành công",
      module: "Auth",
      steps: "login",
      expectedResult: "ok",
    });
    assert.equal(intent.requiresBodyRule, false);
    const scored = [
      applyBodyRuleToCandidate(
        { pathRel: "src/Application/Auth/LoginHandler.cs", score: 80, reason: "x" },
        "class LoginHandler {}",
        intent
      ),
    ];
    const decision = decideBodyRuleWriteBack(scored, intent);
    assert.equal(decision.writeBack, true);
  });

  it("TC-055 style: IUpload vs UploadService tie → write UploadService", () => {
    const intent = extractUnitIntent({
      title: "Tải lên hình ảnh vật chứng - Upload định dạng hợp lệ - Thành công",
      module: "Tải lên hình ảnh vật chứng",
      steps: "JPG PNG WEBP",
      expectedResult: "success",
    });
    const scored = [
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Forensic.Infrastructure/Services/IUploadService.cs",
          score: 171,
          reason: "hits=Upload",
        },
        "public interface IUploadService { Task InitUploadAsync(); }",
        intent
      ),
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Forensic.Infrastructure/Services/UploadService.cs",
          score: 171,
          reason: "hits=Upload",
        },
        "public class UploadService { public Task InitUploadAsync() {} }",
        intent
      ),
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Forensic.Application/Queries/GetUploadActivityQuery.cs",
          score: 159,
          reason: "hits=Upload",
        },
        "public class GetUploadActivityQuery {}",
        intent
      ),
    ];
    const decision = decideBodyRuleWriteBack(scored, intent, {
      minScore: 56,
      minMargin: 20,
      minRatio: 1.45,
    });
    assert.equal(decision.writeBack, true, decision.skipReason);
    assert.match(decision.seed!.pathRel, /UploadService\.cs$/);
    assert.ok(!/IUploadService/.test(decision.seed!.pathRel));
  });

  it("collapseBodyRuleContenders drops I* and Query behind Service", () => {
    const collapsed = collapseBodyRuleContenders([
      {
        pathRel: "src/Services/IUploadService.cs",
        score: 171,
        baseScore: 171,
        ruleHits: ["Upload"],
        reason: "x",
      },
      {
        pathRel: "src/Services/UploadService.cs",
        score: 171,
        baseScore: 171,
        ruleHits: ["Upload"],
        reason: "x",
      },
      {
        pathRel: "src/Queries/GetUploadActivityQuery.cs",
        score: 159,
        baseScore: 159,
        ruleHits: ["Upload"],
        reason: "x",
      },
    ]);
    assert.equal(collapsed.length, 1);
    assert.match(collapsed[0]!.pathRel, /UploadService\.cs$/);
  });

  it("TC-041 style: DigitalFile Create/Handler/Delete tie → write Handler", () => {
    const intent = extractUnitIntent({
      title: "Create widget - Checkbox digital - show device block",
      module: "Create widget",
      steps: "Assert checkbox default checked; toggle visibility",
      expectedResult: "device block visible when checked",
      testData: "trace: BR/BR-17",
    });
    const scored = [
      {
        pathRel: "src/App/Commands/DigitalFile/DigitalFileCreateCommand.cs",
        score: 146,
        baseScore: 146,
        ruleHits: ["DigitalFile"],
        reason: "index",
        hits: ["DigitalFile"],
      },
      {
        pathRel:
          "src/App/Commands/DigitalFile/DigitalFileCreateCommandHandler.cs",
        score: 146,
        baseScore: 146,
        ruleHits: ["DigitalFile"],
        reason: "index",
        hits: ["DigitalFile"],
      },
      {
        pathRel: "src/App/Commands/DigitalFile/DigitalFileDeleteCommand.cs",
        score: 146,
        baseScore: 146,
        ruleHits: ["DigitalFile"],
        reason: "index",
        hits: ["DigitalFile"],
      },
    ];
    const collapsed = collapseBodyRuleContenders(scored);
    assert.match(
      collapsed[0]!.pathRel,
      /DigitalFileCreateCommandHandler\.cs$/,
      JSON.stringify(collapsed.map((c) => c.pathRel))
    );
    const decision = decideBodyRuleWriteBack(scored, intent, {
      minScore: 56,
      minMargin: 20,
      minRatio: 1.45,
    });
    assert.equal(decision.writeBack, true, decision.skipReason);
    assert.match(
      decision.seed!.pathRel,
      /DigitalFileCreateCommandHandler\.cs$/
    );
  });

  it("cross-family CreateHandler tie + preferTokens → domain winner (not ambiguous)", () => {
    const intent = extractUnitIntent({
      title: "Create item - duplicate code - reject",
      module: "Create item",
      steps: "code already exists; save; reject",
      expectedResult: "BadRequest Duplicate",
    });
    assert.equal(intent.requiresBodyRule, true);
    const scored = [
      {
        pathRel: "src/Commands/Order/OrderCreateCommandHandler.cs",
        score: 268,
        baseScore: 240,
        ruleHits: ["throw", "BadRequest", "Duplicate"],
        reason: "body",
        hits: [],
      },
      {
        pathRel: "src/Commands/Widget/WidgetCreateCommandHandler.cs",
        score: 268,
        baseScore: 240,
        ruleHits: ["throw", "BadRequest", "Duplicate"],
        reason: "body",
        hits: [],
      },
      {
        pathRel: "src/Commands/Role/RoleCreateCommandHandler.cs",
        score: 256,
        baseScore: 228,
        ruleHits: ["throw", "BadRequest"],
        reason: "body",
        hits: [],
      },
    ];
    const noPrefer = decideBodyRuleWriteBack(scored, intent, {
      minScore: 56,
      minMargin: 20,
      minRatio: 1.45,
    });
    assert.equal(noPrefer.writeBack, false);
    assert.match(noPrefer.skipReason || "", /ambiguous margin|cross-family/);

    const withPrefer = decideBodyRuleWriteBack(scored, intent, {
      minScore: 56,
      minMargin: 20,
      minRatio: 1.45,
      preferTokens: ["Widget"],
    });
    assert.equal(withPrefer.writeBack, true, withPrefer.skipReason);
    assert.match(
      withPrefer.seed!.pathRel,
      /WidgetCreateCommandHandler\.cs$/
    );
  });

  it("TC↔excerpt phrase affinity breaks cross-family tie without aliases", () => {
    const intent = extractUnitIntent({
      title: "Tao moi widget - ma trung - tu choi",
      module: "Tao moi widget",
      steps: "ma da ton tai; luu; assert tu choi",
      expectedResult: "tu choi; loi trung ma widget",
    });
    const widgetExcerpt = `
      throw new BadRequestAlertException("duplicate", "widgetCodeExists");
      _audit.Log($"tao moi widget: {widget.Name}");
    `;
    const orderExcerpt = `
      throw new BadRequestAlertException("duplicate", "orderCodeExists");
      _audit.Log($"tao moi order: {order.Name}");
    `;
    const scored = [
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Commands/Order/OrderCreateCommandHandler.cs",
          score: 200,
        },
        orderExcerpt,
        intent,
        "Tao moi widget - ma trung - tu choi\nloi trung ma widget"
      ),
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Commands/Widget/WidgetCreateCommandHandler.cs",
          score: 200,
        },
        widgetExcerpt,
        intent,
        "Tao moi widget - ma trung - tu choi\nloi trung ma widget"
      ),
    ];
    const decision = decideBodyRuleWriteBack(scored, intent, {
      minScore: 56,
      minMargin: 20,
      minRatio: 1.45,
    });
    assert.equal(decision.writeBack, true, decision.skipReason);
    assert.match(
      decision.seed!.pathRel,
      /WidgetCreateCommandHandler\.cs$/,
      `scores=${scored.map((c) => `${c.pathRel.split("/").pop()}:${c.score}`).join(",")}`
    );
    assert.ok(
      scored.find((c) => /Widget/.test(c.pathRel))!.score >
        scored.find((c) => /Order/.test(c.pathRel))!.score
    );
  });

  it("techStem in excerpt matching TC errorKey boosts affinity", () => {
    const intent = extractUnitIntent({
      title: "Create widget - duplicate - reject",
      module: "Create widget",
      expectedResult: "BadRequest",
      testData: "errorKey=widgetCodeExists",
    });
    const withStem = applyBodyRuleToCandidate(
      { pathRel: "src/Commands/Widget/WidgetCreateCommandHandler.cs", score: 180 },
      `throw new BadRequestAlertException("x", "widgetCodeExists");`,
      intent,
      "Create widget\nerrorKey=widgetCodeExists",
      { preferTokens: ["Widget"] }
    );
    const without = applyBodyRuleToCandidate(
      { pathRel: "src/Commands/Order/OrderCreateCommandHandler.cs", score: 180 },
      `throw new BadRequestAlertException("x", "orderCodeExists");`,
      intent,
      "Create widget\nerrorKey=widgetCodeExists",
      { preferTokens: ["Widget"] }
    );
    assert.ok(withStem.score > without.score);
    assert.ok((withStem.hits || []).some((h) => /techStem:|prefer:/i.test(h)));
  });

  it("cross-family margin OK but weak differential → skip", () => {
    const intent = extractUnitIntent({
      title: "Create item - duplicate code - reject",
      module: "Create item",
      expectedResult: "BadRequest Duplicate",
    });
    const scored = [
      {
        pathRel: "src/Commands/Order/OrderCreateCommandHandler.cs",
        score: 280,
        baseScore: 240,
        ruleHits: ["throw", "BadRequest", "Duplicate"],
        reason: "body",
        hits: [],
      },
      {
        pathRel: "src/Commands/Widget/WidgetCreateCommandHandler.cs",
        score: 258,
        baseScore: 240,
        ruleHits: ["throw", "BadRequest", "Duplicate"],
        reason: "body",
        hits: [],
      },
    ];
    // margin 22 >= 20 but < 36 and no prefer/phrase → fail-closed
    const d = decideBodyRuleWriteBack(scored, intent, {
      minScore: 56,
      minMargin: 20,
      minRatio: 1.45,
    });
    assert.equal(d.writeBack, false);
    assert.match(d.skipReason || "", /cross-family weak differential/);
  });

  it("functionOpPathShapeAdjust boosts Assign and demotes Create", () => {
    const intent = extractUnitIntent({
      title: "Gán item vào case - lọc theo quyền",
      module: "Gán item vào case",
      steps: "filter list",
      expectedResult: "filtered",
    });
    const blob = "gan item loc theo quyen filter";
    const boost = functionOpPathShapeAdjust(
      "src/App/Commands/Item/AssignItemToCaseCommandHandler.cs",
      intent,
      blob
    );
    const demote = functionOpPathShapeAdjust(
      "src/App/Commands/Item/ItemCreateCommandHandler.cs",
      intent,
      blob
    );
    assert.ok(boost > 0, String(boost));
    assert.ok(demote < 0, String(demote));
  });

  it("functionOpPathShapeAdjust storage demotes AssignCase without Storage stem", () => {
    const intent = extractUnitIntent({
      title: "Chọn vị trí lưu trữ - ngăn không tồn tại - từ chối",
      module: "Chọn vị trí lưu trữ",
      steps: "missing compartment",
      expectedResult: "reject",
    });
    const blob = [intent.primaryClass, "chon vi tri luu tru ngan khong ton tai"].join(
      "\n"
    );
    const storageBoost = functionOpPathShapeAdjust(
      "src/App/Commands/Storage/AssignCompartmentCommandHandler.cs",
      intent,
      blob
    );
    const assignDemote = functionOpPathShapeAdjust(
      "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
      intent,
      blob
    );
    assert.ok(storageBoost > 0, String(storageBoost));
    assert.ok(assignDemote < 0, String(assignDemote));
  });

  it("upload intent: Delete path demoted; body-rule cannot writeBack Delete", () => {
    const intent = extractUnitIntent({
      title: "Tải lên hình ảnh - Từ chối định dạng ngoài JPG - Không cho phép",
      module: "Tải lên hình ảnh",
      steps: "upload invalid format",
      expectedResult: "reject",
    });
    const blob = "tai len hinh anh tu choi dinh dang jpg";
    const delAdj = uploadIntentPathShapeAdjust(
      "src/Commands/DigitalDevice/DigitalDeviceDeleteCommandHandler.cs",
      intent,
      blob
    );
    const createAdj = uploadIntentPathShapeAdjust(
      "src/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs",
      intent,
      blob
    );
    assert.ok(delAdj <= -80, String(delAdj));
    assert.ok(createAdj > 0, String(createAdj));
    assert.equal(
      pathContradictsUploadVerb(
        "src/Commands/DigitalDevice/DigitalDeviceDeleteCommandHandler.cs",
        intent,
        blob
      ),
      true
    );
    const scored = [
      applyBodyRuleToCandidate(
        {
          pathRel:
            "src/Commands/DigitalDevice/DigitalDeviceDeleteCommandHandler.cs",
          score: 200,
          reason: "x",
        },
        "throw new BadRequestAlertException(); Delete();",
        intent,
        blob
      ),
      applyBodyRuleToCandidate(
        {
          pathRel:
            "src/Commands/EvidencePhysicalImage/EvidencePhysicalImageCreateCommandHandler.cs",
          score: 90,
          reason: "x",
        },
        "CreateOrUpdateAsync(entity);",
        intent,
        blob
      ),
    ];
    const decision = decideBodyRuleWriteBack(scored, intent, {
      minScore: 56,
      shapeBlob: blob,
    });
    assert.ok(
      !decision.writeBack ||
        !/Delete/i.test(decision.seed?.pathRel || ""),
      JSON.stringify(decision)
    );
  });

  it("search title: Assign demoted; GetAll Query preferred", () => {
    const intent = extractUnitIntent({
      title: "Gắn hồ sơ - Tìm theo mã vụ án - Trả về hồ sơ khớp mã",
      module: "Gắn hồ sơ vụ án",
      steps: "thực hiện tìm kiếm hồ sơ theo mã",
      expectedResult: "trả về hồ sơ khớp",
    });
    const blob =
      "gan ho so tim theo ma vu an tra ve ho so khop thuc hien tim kiem";
    const assignAdj = functionOpPathShapeAdjust(
      "src/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
      intent,
      blob
    );
    const queryAdj = functionOpPathShapeAdjust(
      "src/Queries/CaseRecord/CaseRecordGetAllQueryHandler.cs",
      intent,
      blob
    );
    assert.ok(assignAdj < 0, String(assignAdj));
    assert.ok(queryAdj > 0, String(queryAdj));
    assert.equal(
      pathContradictsSearchVerb(
        "src/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
        intent,
        blob
      ),
      true
    );
  });

  it("read/get-detail title: Create demoted; GetQuery preferred (TC-016 style)", () => {
    const intent = extractUnitIntent({
      title:
        "Hiển thị và chỉnh sửa chi tiết - Tải dữ liệu đã lưu - Trả về đầy đủ thông tin đã lưu",
      module: "Hiển thị và chỉnh sửa chi tiết",
      steps: "Thực hiện lấy chi tiết theo định danh đã lưu",
      expectedResult: "ACCEPT — trả về đúng thông tin đã lưu — (quan sát: read)",
    });
    const blob =
      "hien thi chinh sua chi tiet tai du lieu da luu tra ve day du thong tin lay chi tiet theo dinh danh quan sat read";
    assert.equal(queryImpliesReadGetDetailIntent(intent, blob), true);
    const createAdj = readGetIntentPathShapeAdjust(
      "src/Commands/Entity/EntityCreateCommandHandler.cs",
      intent,
      blob
    );
    const getAdj = readGetIntentPathShapeAdjust(
      "src/Queries/Entity/EntityGetQueryHandler.cs",
      intent,
      blob
    );
    assert.ok(createAdj <= -60, String(createAdj));
    assert.ok(getAdj > 0, String(getAdj));
    assert.equal(
      pathContradictsReadGetVerb(
        "src/Commands/Entity/EntityCreateCommandHandler.cs",
        intent,
        blob
      ),
      true
    );
    const scored = [
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Commands/Entity/EntityCreateCommandHandler.cs",
          score: 200,
        },
        "class EntityCreateCommandHandler { void H() { Create(); } }",
        intent,
        blob
      ),
      applyBodyRuleToCandidate(
        {
          pathRel: "src/Queries/Entity/EntityGetQueryHandler.cs",
          score: 120,
        },
        "class EntityGetQueryHandler { void H() { return entity; } }",
        intent,
        blob
      ),
    ];
    const d = decideBodyRuleWriteBack(scored, intent, {
      minScore: 50,
      shapeBlob: blob,
    });
    assert.equal(d.writeBack, true, JSON.stringify(d));
    assert.match(d.seed!.pathRel, /GetQueryHandler/i);
    assert.ok(!/CreateCommandHandler/i.test(d.seed!.pathRel));
  });

  it("CRUD verb: update+reject demotes Create; boosts Update (portable)", () => {
    const intent = extractUnitIntent({
      title: "Cập nhật mã - Cập nhật mã trùng - Từ chối",
      module: "Cập nhật mã và tên",
      steps: "Thực hiện cập nhật mã thành mã đã tồn tại",
      expectedResult: "REJECT — từ chối mã trùng — (quan sát: update)",
    });
    const blob =
      "cap nhat ma va ten cap nhat ma trung tu choi thuc hien cap nhat quan sat update";
    assert.equal(detectUnitCrudVerb(intent, blob), "update");
    assert.equal(
      pathContradictsCrudVerb(
        "src/App/Commands/Item/ItemCreateCommandHandler.cs",
        intent,
        blob
      ),
      true
    );
    assert.equal(
      pathContradictsCrudVerb(
        "src/App/Commands/Item/ItemUpdateCommandHandler.cs",
        intent,
        blob
      ),
      false
    );
    const createAdj = crudVerbPathShapeAdjust(
      "src/App/Commands/Item/ItemCreateCommandHandler.cs",
      intent,
      blob
    );
    const updateAdj = crudVerbPathShapeAdjust(
      "src/App/Commands/Item/ItemUpdateCommandHandler.cs",
      intent,
      blob
    );
    assert.ok(createAdj < 0, String(createAdj));
    assert.ok(updateAdj > 0, String(updateAdj));
  });

  it("CRUD verb: create+reject keeps Create; demotes Update", () => {
    const intent = extractUnitIntent({
      title: "Tạo mới - Mã trùng - Từ chối",
      module: "Tạo mới bản ghi",
      steps: "Thực hiện tạo mới với mã đã tồn tại",
      expectedResult: "REJECT — từ chối — (quan sát: create)",
    });
    const blob =
      "tao moi ban ghi ma trung tu choi thuc hien tao moi quan sat create";
    assert.equal(detectUnitCrudVerb(intent, blob), "create");
    assert.ok(
      crudVerbPathShapeAdjust(
        "src/App/Commands/Item/ItemCreateCommandHandler.cs",
        intent,
        blob
      ) > 0
    );
    assert.ok(
      crudVerbPathShapeAdjust(
        "src/App/Commands/Item/ItemUpdateCommandHandler.cs",
        intent,
        blob
      ) < 0
    );
  });

  it("CRUD verb: delete demotes Create/Update", () => {
    const intent = extractUnitIntent({
      title: "Xóa bản ghi - Xóa thành công - Đã xóa",
      module: "Xóa bản ghi",
      steps: "Thực hiện xóa bản ghi theo id",
      expectedResult: "ACCEPT — đã xóa — (quan sát: delete)",
    });
    const blob = "xoa ban ghi xoa thanh cong thuc hien xoa quan sat delete";
    assert.equal(detectUnitCrudVerb(intent, blob), "delete");
    assert.ok(
      pathContradictsCrudVerb(
        "src/App/Commands/Item/ItemCreateCommandHandler.cs",
        intent,
        blob
      )
    );
    assert.ok(
      !pathContradictsCrudVerb(
        "src/App/Commands/Item/ItemDeleteCommandHandler.cs",
        intent,
        blob
      )
    );
  });

  it("validate_reject alone does not imply create CRUD verb", () => {
    const intent = extractUnitIntent({
      title: "Kiểm tra - Từ chối khi thiếu mã - Reject",
      module: "Kiểm tra ràng buộc",
      steps: "Thực hiện kiểm tra mã bắt buộc",
      expectedResult: "REJECT — từ chối thiếu mã",
    });
    const blob = "kiem tra tu choi khi thieu ma reject bat buoc";
    // May be validate_reject primary — must not force create verb
    assert.equal(detectUnitCrudVerb(intent, blob), null);
  });
});
