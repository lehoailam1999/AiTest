import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertTcReadyForE2eGen,
  enrichTestDataWithAuthRole,
  enrichTestDataWithFeaturePath,
  hasActionableStep,
  hasAuthRoleMarker,
  hasPathMarker,
  hasTestDataSeed,
  isLoginOrPublicTc,
  isUsableFeaturePath,
  mergeTcWithAuthRole,
  mergeTcWithInferredFeaturePath,
} from "./assertTcReadyForE2eGen.js";

describe("assertTcReadyForE2eGen", () => {
  it("exempts login TC", () => {
    assert.equal(isLoginOrPublicTc({ title: "Đăng nhập admin" }), true);
    assert.doesNotThrow(() =>
      assertTcReadyForE2eGen({ title: "Đăng nhập admin", steps: "Nhập user" })
    );
  });

  it("requires path marker for feature TC", () => {
    assert.equal(hasPathMarker({ testData: "authRole: admin" }), false);
    assert.equal(hasPathMarker({ testData: "path: /storage/rooms" }), true);
    assert.throws(
      () =>
        assertTcReadyForE2eGen({
          title: "Tạo phòng",
          steps: "Kiểm tra màn hình",
          testData: "authRole: admin",
        }),
      /Thiếu Context/
    );
  });

  it("passes when path + actionable step", () => {
    assert.equal(
      hasActionableStep({
        steps: "1. Nhấn nút Tạo mới\n2. Điền tên phòng Room-A",
      }),
      true
    );
    assert.doesNotThrow(() =>
      assertTcReadyForE2eGen({
        title: "Tạo phòng kho",
        testData: "path: /storage/rooms\nauthRole: admin",
        steps: "1. Nhấn nút Tạo mới\n2. Điền tên phòng Room-A",
      })
    );
  });

  it("passes when path + testData seed", () => {
    assert.equal(
      hasTestDataSeed({
        testData: "path: /rooms\nroomName: Kho A",
      }),
      true
    );
    assert.doesNotThrow(() =>
      assertTcReadyForE2eGen({
        title: "Chọn phòng",
        testData: "path: /rooms\nroomName: Kho A",
        steps: "Kiểm tra danh sách",
      })
    );
  });

  it("rejects vague-only steps without seed", () => {
    assert.throws(
      () =>
        assertTcReadyForE2eGen({
          title: "Xem danh sách",
          testData: "path: /rooms",
          steps: "1. Kiểm tra màn hình\n2. Verify kết quả",
        }),
      /step hành động/
    );
  });

  it("allows inferred featurePath from FE when allowInferredPath", () => {
    assert.doesNotThrow(() =>
      assertTcReadyForE2eGen(
        {
          title: "Tạo phòng",
          testData: "authRole: admin",
          steps: "1. Nhấn nút Tạo mới\n2. Điền tên phòng Room-A",
        },
        {
          inferredFeaturePath: "/storage/rooms",
          allowInferredPath: true,
        }
      )
    );
  });

  it("does not allow inferred path without allowInferredPath flag", () => {
    assert.throws(
      () =>
        assertTcReadyForE2eGen(
          {
            title: "Tạo phòng",
            steps: "1. Nhấn nút Tạo mới",
            testData: "authRole: admin",
          },
          { inferredFeaturePath: "/storage/rooms", allowInferredPath: false }
        ),
      /Thiếu Context/
    );
  });

  it("enrichTestDataWithFeaturePath appends only when path missing", () => {
    const enriched = enrichTestDataWithFeaturePath(
      "authRole: admin",
      "/evidence/create",
      "fe-source"
    );
    assert.match(enriched, /featurePath: \/evidence\/create/);
    assert.match(enriched, /auto-enriched from fe-source/);
    assert.equal(hasPathMarker({ testData: enriched }), true);
    const unchanged = enrichTestDataWithFeaturePath(
      "path: /rooms",
      "/evidence/create"
    );
    assert.equal(unchanged, "path: /rooms");
  });

  it("rejects path: [Thiếu Context] placeholder", () => {
    assert.equal(isUsableFeaturePath("/[Thiếu Context]"), false);
    assert.equal(isUsableFeaturePath("[Thiếu Context]"), false);
    assert.equal(isUsableFeaturePath("/admin/storage-room"), true);
    assert.equal(isUsableFeaturePath("/BR-4"), false);
    assert.equal(isUsableFeaturePath("/FR-12"), false);
    assert.equal(
      hasPathMarker({ testData: "path: [Thiếu Context]\nauthRole: admin" }),
      false
    );
  });

  it("enrich replaces path: [Thiếu Context] with real featurePath", () => {
    const enriched = enrichTestDataWithFeaturePath(
      "path: [Thiếu Context]\nauthRole: admin\ntrace: BR/1",
      "/admin/evidence",
      "route-catalog"
    );
    assert.doesNotMatch(enriched, /Thiếu Context/);
    assert.match(enriched, /featurePath: \/admin\/evidence/);
    assert.match(enriched, /authRole: admin/);
    assert.equal(hasPathMarker({ testData: enriched }), true);
  });

  it("passes when expectedResult field is set (no path in testData)", () => {
    assert.doesNotThrow(() =>
      assertTcReadyForE2eGen(
        {
          title: "Xem danh sách phòng",
          testData: "authRole: admin",
          steps: "1. Kiểm tra màn hình",
          expectedResult: "Hiển thị danh sách phòng đầy đủ",
        },
        {
          inferredFeaturePath: "/storage/rooms",
          allowInferredPath: true,
        }
      )
    );
  });

  it("passes with inferred path only (allowInferredPath)", () => {
    assert.doesNotThrow(() =>
      assertTcReadyForE2eGen(
        {
          title: "Tạo vật chứng",
          module: "Evidence",
          steps: "1. Nhấn Tạo mới",
          expectedResult: "Tạo thành công",
          testData: "authRole: admin",
        },
        {
          inferredFeaturePath: "/admin/evidence",
          allowInferredPath: true,
        }
      )
    );
  });

  it("enrichTestDataWithAuthRole appends when missing", () => {
    assert.equal(hasAuthRoleMarker({ testData: "path: /rooms" }), false);
    const enriched = enrichTestDataWithAuthRole(
      "path: /rooms",
      "admin",
      "project-default"
    );
    assert.match(enriched, /authRole: admin/);
    assert.match(enriched, /auto-enriched role from project-default/);
    assert.equal(hasAuthRoleMarker({ testData: enriched }), true);
    const merged = mergeTcWithAuthRole(
      { testData: "path: /rooms" },
      "Staff",
      "analysis"
    );
    assert.match(merged.testData || "", /authRole: Staff/);
    const unchanged = mergeTcWithAuthRole(
      { testData: "authRole: admin\npath: /x" },
      "Staff"
    );
    assert.match(unchanged.testData || "", /authRole: admin/);
    assert.doesNotMatch(unchanged.testData || "", /Staff/);
  });

  it("mergeTcWithInferredFeaturePath strips placeholder even when path already marked unusable", () => {
    const merged = mergeTcWithInferredFeaturePath(
      { testData: "path: [Thiếu Context]\nauthRole: admin" },
      undefined
    );
    assert.doesNotMatch(merged.testData || "", /Thiếu Context/);
    assert.match(merged.testData || "", /authRole: admin/);
  });
});

describe("enforceExecutionGateFailure", () => {
  it("does not wrap ContextMissing", async () => {
    const { enforceExecutionGateFailure } = await import("./executionGate.js");
    const msg =
      "ContextMissing: [Thiếu Context] cần bổ sung E2E_STORAGE_ROOM_NAME";
    assert.equal(enforceExecutionGateFailure(msg), msg);
    assert.ok(
      enforceExecutionGateFailure("timeout waiting").includes("ExecutionGateFailed")
    );
  });

  it("does not wrap No tests found / Unexpected token (syntax crash)", async () => {
    const { enforceExecutionGateFailure } = await import("./executionGate.js");
    const noTests = "Error: No tests found.\nMake sure that arguments are regular expressions";
    assert.equal(enforceExecutionGateFailure(noTests), noTests);
    const syntax = "Error: Unexpected token (61:2)";
    assert.equal(enforceExecutionGateFailure(syntax), syntax);
  });
});
