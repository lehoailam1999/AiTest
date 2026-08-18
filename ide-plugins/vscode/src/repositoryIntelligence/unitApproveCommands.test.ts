import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNIT_APPROVE_REQUEST_SCHEMA,
  UNIT_TC_IR_SCHEMA,
  type UnitApproveResolveParams,
} from "@aitest/ide-protocol";
import { createApproveCliMemo } from "./approveCliMemo";
import { sha256 } from "./hash";
import type {
  RepoDocument,
  RepoDocumentSymbol,
  RepositoryRuntime,
} from "./runtime";
import type { FieldBindingPicker } from "./resolveBindings";
import { requiredBehaviorSignals } from "./behaviorEvidence";
import { resolvePrimary } from "./resolvePrimary";
import { createUnitApproveResolver } from "./unitApproveCommands";
import { buildCursorSymbolPrompt, symbolProposerInput } from "./symbolProposer";

const range = (line: number) => ({
  start: { line, character: 0 },
  end: { line, character: 20 },
});

function symbol(
  name: string,
  kind: number,
  line: number,
  children: RepoDocumentSymbol[] = []
): RepoDocumentSymbol {
  return {
    name,
    kind,
    range: range(line),
    selectionRange: range(line),
    children,
  };
}

function request(constraint?: string): UnitApproveResolveParams {
  return {
    schema: UNIT_APPROVE_REQUEST_SCHEMA,
    requestId: "request-1",
    projectId: "project-1",
    testCaseRevision: {
      testCaseId: "TC-1",
      contentHash: sha256("tc-1"),
    },
    tcIr: {
      schema: UNIT_TC_IR_SCHEMA,
      testCaseId: "TC-1",
      title: "Create evidence description",
      requirement: {
        requirementIds: ["REQ-1"],
        behaviorId: "Evidence.Create",
      },
      module: "Evidence",
      primaryBucket: "VALIDATION_DATA",
      scenario: "POSITIVE",
      categories: [],
      preconditions: [],
      steps: { prepare: [], execute: ["Create evidence"] },
      expected: {
        type: "success",
        description: "Evidence is created",
        observable: "Evidence result",
      },
      testData: {
        target: {
          scope: "field",
          fields: ["moTa"],
          constraint,
        },
        input: { moTa: "sample" },
      },
      readiness: "READY_FOR_GROUNDING",
    },
  };
}

function mockRuntime(options?: {
  noPrimary?: boolean;
  primaryText?: string;
  dtoText?: string;
  testRefs?: boolean;
  onSearchSymbol?: () => void;
}): RepositoryRuntime {
  const primary: RepoDocument = {
    pathRel: "src/EvidenceService.cs",
    language: "csharp",
    text:
      options?.primaryText ??
      "public class EvidenceService {\n  public void Create() {}\n}",
    dirty: false,
    symbols: [symbol("EvidenceService", 4, 0, [symbol("Create", 5, 1)])],
  };
  const dtoText =
    options?.dtoText ??
    'public class EvidenceDto {\n  public string Name { get; set; }\n  [Required]\n  public string Description { get; set; }\n}';
  const dto: RepoDocument = {
    pathRel: "src/EvidenceDto.cs",
    language: "csharp",
    text: dtoText,
    dirty: false,
    symbols: [
      symbol("EvidenceDto", 4, 0, [
        ...(dtoText.includes(" Name ") ? [symbol("Name", 6, 1)] : []),
        symbol("Description", 6, 3),
      ]),
    ],
  };
  const existingTest: RepoDocument = {
    pathRel: "tests/EvidenceServiceTests.cs",
    language: "csharp",
    text: "using Xunit;\npublic class EvidenceServiceTests {\n  [Fact]\n  public void Create_Works() {}\n}",
    dirty: false,
    symbols: [symbol("EvidenceServiceTests", 4, 1, [symbol("Create_Works", 5, 3)])],
  };
  // Real repository file an earlier resolver wrongly stamped into TC markers.
  const unrelated: RepoDocument = {
    pathRel: "src/UserOuScopingService.cs",
    language: "csharp",
    text: "public class UserOuScopingService {\n  public void ValidateAssignableRoles() {}\n}",
    dirty: false,
    symbols: [
      symbol("UserOuScopingService", 4, 0, [symbol("ValidateAssignableRoles", 5, 1)]),
    ],
  };
  const docs = new Map([
    [primary.pathRel.toLowerCase(), primary],
    [dto.pathRel.toLowerCase(), dto],
    [existingTest.pathRel.toLowerCase(), existingTest],
    [unrelated.pathRel.toLowerCase(), unrelated],
  ]);
  return {
    workspaceRoot: () => "C:\\repo",
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    async git(args) {
      return args[0] === "rev-parse" ? "abc123" : "";
    },
    async dirtyDocuments() {
      return [];
    },
    async searchSymbol() {
      options?.onSearchSymbol?.();
      if (options?.noPrimary) return { hits: [], truncated: false };
      return {
        hits: [
          {
            id: "src/EvidenceService.cs:1:0:Create",
            name: "Create",
            kind: "method",
            pathRel: primary.pathRel,
            containerName: "EvidenceService",
            range: {
              start: 1,
              end: 1,
              startCharacter: 0,
              endCharacter: 20,
            },
            score: 1,
          },
        ],
        truncated: false,
      };
    },
    async definition() {
      return { locations: [] };
    },
    async references() {
      if (!options?.testRefs) return { refs: [], truncated: false };
      return {
        refs: [
          { file: existingTest.pathRel, name: "Create", range: { start: 3, end: 3 } },
          { file: primary.pathRel, name: "Create", range: { start: 1, end: 1 } },
        ],
        truncated: false,
      };
    },
    async implementations() {
      return { locations: [], truncated: false };
    },
    async readDocument(pathRel) {
      return docs.get(pathRel.replace(/\\/g, "/").toLowerCase()) || null;
    },
    async findSourceFiles() {
      return [primary.pathRel, dto.pathRel];
    },
  };
}

const mockFieldPicker: FieldBindingPicker = async ({ labels, candidates }) => {
  const description = candidates.find(
    (candidate) => candidate.property === "Description"
  );
  if (!description || !labels.includes("moTa")) {
    return { picks: [], missing: labels };
  }
  return {
    picks: [
      {
        label: "moTa",
        property: description.property,
        ownerPath: description.ownerPath,
      },
    ],
  };
};

describe("handleUnitApproveResolve", () => {
  it("returns READY and accepts an AI pick only from the source shortlist", async () => {
    const result = await createUnitApproveResolver(mockRuntime(), {
      pickFields: mockFieldPicker,
    })(request());
    assert.equal(result.status, "RESOLVED");
    assert.equal(result.decision?.outcome, "READY");
    assert.equal(result.decision?.authoritative, true);
    assert.equal(result.decision?.fieldBindings[0]?.label, "moTa");
    assert.equal(result.decision?.fieldBindings[0]?.property, "Description");
  });

  it("reuses the field pick of an earlier TC instead of asking the CLI again", async () => {
    const memo = createApproveCliMemo();
    let pickerCalls = 0;
    const resolve = createUnitApproveResolver(mockRuntime(), {
      memo,
      pickFields: async (input) => {
        pickerCalls += 1;
        return mockFieldPicker(input);
      },
    });

    const first = await resolve(request());
    const second = await resolve(request());

    assert.equal(pickerCalls, 1);
    assert.equal(first.decision?.fieldBindings[0]?.property, "Description");
    assert.equal(second.decision?.outcome, "READY");
    assert.equal(second.decision?.fieldBindings[0]?.property, "Description");
  });

  it("rewrites canonical input keys to the bound source properties", async () => {
    const result = await createUnitApproveResolver(mockRuntime(), {
      pickFields: mockFieldPicker,
    })(request());
    assert.deepEqual(result.decision?.canonicalInput, { Description: "sample" });
  });

  it("never maps unrelated multi-field input keys by array position", async () => {
    const params = request();
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  [Required] public string Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        testData: {
          ...params.tcIr.testData,
          input: { tenVatChung: "A", moTa: "sample" },
        },
      },
    });
    assert.deepEqual(result.decision?.canonicalInput, {
      tenVatChung: "A",
      Description: "sample",
    });
  });

  it("canonicalizes input-only aliases without making them readiness gates", async () => {
    const params = request();
    const result = await createUnitApproveResolver(mockRuntime())({
      ...params,
      manualSourceHint: {
        propertyBindings: [
          { label: "moTa", property: "Description" },
          { label: "tenVatChung", property: "Name" },
        ],
      },
      tcIr: {
        ...params.tcIr,
        testData: {
          ...params.tcIr.testData,
          input: { tenVatChung: "A", moTa: "sample", legacyKey: "kept" },
        },
      },
    });
    assert.equal(result.status, "RESOLVED");
    assert.deepEqual(result.decision?.canonicalInput, {
      Name: "A",
      Description: "sample",
      legacyKey: "kept",
    });
  });

  it("reports existing tests that reference the primary symbol", async () => {
    const result = await createUnitApproveResolver(mockRuntime({ testRefs: true }), {
      pickFields: mockFieldPicker,
    })(request());
    assert.equal(result.decision?.existingTests.length, 1);
    assert.equal(
      result.decision?.existingTests[0]?.pathRel,
      "tests/EvidenceServiceTests.cs"
    );
    assert.equal(result.decision?.existingTests[0]?.framework, "xunit");
    assert.equal(
      result.decision?.existingTests[0]?.relationship,
      "references_primary"
    );
  });

  it("returns FEATURE_GAP and retains primary when MaxLength is missing", async () => {
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  public string Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )(request("MaxLength(200)"));
    assert.equal(result.status, "FEATURE_GAP");
    assert.equal(result.decision?.primary?.name, "Create");
    assert.equal(result.decision?.authoritative, false);
  });

  it("accepts declarative Required evidence for a validation-data rejection", async () => {
    const params = request("Bắt buộc; không được để trống");
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  [Required] public string Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        scenario: "NEGATIVE",
        expected: {
          ...params.tcIr.expected,
          description: "REJECT — trường bắt buộc không được để trống",
        },
      },
    });
    assert.equal(result.status, "RESOLVED");
    assert.equal(result.decision?.authoritative, true);
    // A [Required] string also carries the trim rule .NET applies to it.
    assert.deepEqual(
      result.decision?.behaviorEvidence.flatMap((item) => item.matchedSignals),
      ["required", "whitespace"]
    );
  });

  it("does not interpret explicit optionality as a required-field rule", () => {
    const params = request("Không bắt buộc");
    assert.deepEqual(
      requiredBehaviorSignals({
        ...params,
        tcIr: {
          ...params.tcIr,
          expected: {
            ...params.tcIr.expected,
            description:
              "ACCEPT — Không phát sinh lỗi bắt buộc riêng cho trường này",
          },
        },
      }),
      []
    );
  });

  it("does not require field bindings for an aggregate target", async () => {
    const params = request();
    const result = await createUnitApproveResolver(mockRuntime())({
      ...params,
      tcIr: {
        ...params.tcIr,
        testData: {
          target: {
            scope: "aggregate",
            fields: ["businessCollection"],
            constraint: "Return only items belonging to the selected parent",
          },
          input: {},
        },
      },
    });
    assert.equal(result.status, "RESOLVED");
    assert.equal(result.decision?.fieldBindings.length, 0);
    assert.ok(
      !result.decision?.refusalReasons.some((reason) =>
        reason.message.includes("0 of 0")
      )
    );
  });

  it("treats one multi-valued target as one required binding", async () => {
    const params = request();
    const result = await createUnitApproveResolver(mockRuntime(), {
      pickFields: mockFieldPicker,
    })({
      ...params,
      tcIr: {
        ...params.tcIr,
        testData: {
          target: {
            scope: "multi",
            fields: ["moTa"],
            constraint: "Create multiple related records",
          },
          input: { moTa: "sample", Name: "input-only alias" },
        },
      },
    });
    assert.equal(result.status, "RESOLVED");
    assert.equal(result.decision?.outcome, "READY");
    assert.equal(result.decision?.fieldBindings.length, 2);
    assert.ok(
      !result.decision?.refusalReasons.some((reason) =>
        reason.message.includes("required field bindings")
      )
    );
  });

  it("does not use validation evidence from an input-only field", async () => {
    const params = request("MaxLength(200)");
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  [MaxLength(200)] public string Name { get; set; }\n  public string Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        testData: {
          ...params.tcIr.testData,
          input: { moTa: "sample", Name: "input-only" },
        },
      },
    });
    assert.equal(result.status, "FEATURE_GAP");
    assert.match(
      result.decision?.refusalReasons[0]?.message || "",
      /maxlength/i
    );
  });

  it("does not accept Required on a non-nullable value type", async () => {
    const params = request("Bắt buộc; không được để trống");
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  [Required] public DateTime Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        scenario: "NEGATIVE",
        expected: {
          ...params.tcIr.expected,
          description: "REJECT — trường bắt buộc không được để trống",
        },
      },
    });
    assert.equal(result.status, "FEATURE_GAP");
    assert.match(result.decision?.refusalReasons[0]?.message || "", /required/i);
  });

  it("accepts Required on a string as whitespace-only rejection", async () => {
    // .NET trims strings in RequiredAttribute, so this DTO does reject "   ".
    const params = request(
      "Bắt buộc; không được để trống; không được nhập toàn khoảng trắng"
    );
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  [Required] public string Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        scenario: "NEGATIVE",
        expected: {
          ...params.tcIr.expected,
          description:
            "REJECT — từ chối tạo mới do trường bắt buộc và không được toàn khoảng trắng",
        },
      },
    });
    assert.equal(result.status, "RESOLVED");
    assert.equal(result.decision?.outcome, "READY");
    assert.ok(
      result.decision?.behaviorEvidence.some((item) =>
        item.matchedSignals.includes("whitespace")
      )
    );
  });

  it("does not read whitespace rejection into Required with AllowEmptyStrings", async () => {
    const params = request("Bắt buộc; không được nhập toàn khoảng trắng");
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  [Required(AllowEmptyStrings = true)] public string Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        scenario: "NEGATIVE",
        expected: {
          ...params.tcIr.expected,
          description: "REJECT — không được toàn khoảng trắng",
        },
      },
    });
    assert.equal(result.status, "FEATURE_GAP");
    assert.match(
      result.decision?.refusalReasons[0]?.message || "",
      /whitespace/i
    );
  });

  it("does not read whitespace rejection into Required on a value type", async () => {
    const params = request("Bắt buộc; không được nhập toàn khoảng trắng");
    const result = await createUnitApproveResolver(
      mockRuntime({
        dtoText:
          "public class EvidenceDto {\n  [Required] public DateTime Description { get; set; }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        scenario: "NEGATIVE",
        expected: {
          ...params.tcIr.expected,
          description: "REJECT — không được toàn khoảng trắng",
        },
      },
    });
    assert.equal(result.status, "FEATURE_GAP");
  });

  it("requires executable default-value evidence", async () => {
    const params = request("Mặc định lấy thời gian hiện tại");
    const result = await createUnitApproveResolver(mockRuntime(), {
      pickFields: mockFieldPicker,
    })({
      ...params,
      tcIr: {
        ...params.tcIr,
        expected: {
          ...params.tcIr.expected,
          description: "ACCEPT — tự động gán thời gian hiện tại",
        },
      },
    });
    assert.equal(result.status, "FEATURE_GAP");
    assert.match(result.decision?.refusalReasons[0]?.message || "", /default/i);
  });

  it("does not treat a state-mutating if branch as rejection evidence", async () => {
    const params = request("Không được phép chọn ngăn đã được sử dụng");
    const result = await createUnitApproveResolver(
      mockRuntime({
        primaryText:
          "public class EvidenceService {\n  public void Create() {\n    if (Description != null) Description = Description.Trim();\n  }\n}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        scenario: "INVALID_STATE",
        expected: {
          ...params.tcIr.expected,
          description: "REJECT — không được phép ghi đè trạng thái đã sử dụng",
        },
      },
    });
    assert.equal(result.status, "FEATURE_GAP");
    assert.match(result.decision?.refusalReasons[0]?.message || "", /reject/i);
  });

  it("accepts a narrowed query as evidence for an excluded-row rule", async () => {
    const params = request("Chỉ hiển thị các bản ghi người dùng được tham gia");
    const result = await createUnitApproveResolver(
      mockRuntime({
        primaryText:
          "public class EvidenceService {\n" +
          "  public void Create() {\n" +
          "    var query = _repo.QueryHelper().ApplyEvidenceReadScope(userId, permissions);\n" +
          "    query = query.Filter(c => c.Description.Contains(term));\n" +
          "  }\n" +
          "}",
      }),
      { pickFields: mockFieldPicker }
    )({
      ...params,
      tcIr: {
        ...params.tcIr,
        scenario: "NEGATIVE",
        expected: {
          ...params.tcIr.expected,
          description: "REJECT — bản ghi ngoài phạm vi không nằm trong danh sách",
          observable: "query",
        },
      },
    });
    // The handler narrows the result set instead of throwing, so requiring
    // reject evidence used to report a gap against an implemented rule.
    assert.equal(result.decision?.outcome, "READY");
    assert.ok(
      result.decision?.behaviorEvidence.some((item) =>
        item.matchedSignals?.includes("filter")
      )
    );
  });

  it("does not bind an ambiguous duplicate property by first match", async () => {
    const extra: RepoDocument = {
      pathRel: "src/OtherDto.cs",
      language: "csharp",
      text: "public class OtherDto {\n  public string Description { get; set; }\n}",
      dirty: false,
      symbols: [symbol("OtherDto", 4, 0, [symbol("Description", 6, 1)])],
    };
    const base = mockRuntime();
    const runtime: RepositoryRuntime = {
      ...base,
      async findSourceFiles() {
        return ["src/EvidenceService.cs", "src/EvidenceDto.cs", extra.pathRel];
      },
      async readDocument(pathRel, maxBytes) {
        if (pathRel.replace(/\\/g, "/").toLowerCase() === extra.pathRel.toLowerCase()) {
          return extra;
        }
        return base.readDocument(pathRel, maxBytes ?? 32768);
      },
    };
    const result = await createUnitApproveResolver(runtime, {
      pickFields: async ({ labels }) => ({ picks: [], missing: labels }),
    })({
      ...request(),
      manualSourceHint: {
        propertyBindings: [{ label: "moTa", property: "Description" }],
      },
    });
    assert.equal(result.status, "FEATURE_GAP");
    assert.equal(result.decision?.fieldBindings.length, 0);
  });

  it("rejects a property invented outside the source shortlist", async () => {
    const result = await createUnitApproveResolver(mockRuntime(), {
      pickFields: async () => ({
        picks: [
          {
            label: "moTa",
            property: "InventedDescription",
            ownerPath: "src/EvidenceDto.cs",
          },
        ],
      }),
    })(request());
    assert.equal(result.status, "NOT_READY");
    assert.equal(result.decision?.fieldBindings.length, 0);
    assert.equal(result.decision?.authoritative, false);
  });

  it("calls a label the source cannot hold a feature gap, keeping the primary", async () => {
    const result = await createUnitApproveResolver(mockRuntime(), {
      pickFields: async ({ labels }) => ({ picks: [], missing: labels }),
    })(request());
    assert.equal(result.status, "FEATURE_GAP");
    assert.equal(result.decision?.primary?.name, "Create");
    assert.equal(result.decision?.refusalReasons[0]?.code, "FEATURE_GAP");
    assert.match(
      result.decision?.refusalReasons[0]?.message || "",
      /no property for moTa/
    );
  });

  it("records a failed binding step as retryable instead of failing silently", async () => {
    const result = await createUnitApproveResolver(mockRuntime(), {
      pickFields: async () => ({ picks: [], error: "agent timed out" }),
    })(request());
    assert.equal(result.status, "NOT_READY");
    assert.equal(result.decision?.refusalReasons[0]?.code, "INCOMPLETE_BINDINGS");
    assert.equal(result.decision?.refusalReasons[0]?.retryable, true);
    const check = result.decision?.checks.find((c) => c.id === "field-binding-pick");
    assert.equal(check?.ok, false);
    assert.match(check?.detail || "", /agent timed out/);
  });

  it("returns NOT_READY when no primary can be resolved", async () => {
    const result = await createUnitApproveResolver(mockRuntime({ noPrimary: true }))(
      request()
    );
    assert.equal(result.status, "NOT_READY");
    assert.equal(result.decision?.primary, null);
  });

  it("returns STALE when the expected workspace differs", async () => {
    const params = {
      ...request(),
      expectedRepository: { workspaceId: sha256("another-workspace") },
    };
    const result = await createUnitApproveResolver(mockRuntime())(params);
    assert.equal(result.status, "STALE");
    assert.equal(result.reasons[0]?.code, "WORKSPACE_MISMATCH");
  });
});

describe("resolvePrimary", () => {
  const limits = {
    maxSymbolCandidates: 8,
    maxImplementations: 5,
    maxFileBytes: 32768,
  };

  it("skips the workspace symbol sweep when the hint resolves exactly", async () => {
    let searches = 0;
    const params: UnitApproveResolveParams = {
      ...request(),
      manualSourceHint: { pathRel: "src/EvidenceService.cs", symbol: "Create" },
    };
    const result = await resolvePrimary(
      params,
      mockRuntime({ onSearchSymbol: () => (searches += 1) }),
      limits
    );
    assert.equal(searches, 0);
    assert.equal(result.ambiguous, false);
    assert.equal(result.primary?.name, "Create");
    assert.equal(result.primary?.pathRel, "src/EvidenceService.cs");
  });

  it("ignores a stale marker that points at an E2E fixture", async () => {
    let searches = 0;
    const params: UnitApproveResolveParams = {
      ...request(),
      manualSourceHint: {
        pathRel: "test/Forensic.E2E/support/fixtures/role.fixture.ts",
        symbol: "buildRoleArtifactDir",
      },
    };
    const result = await resolvePrimary(
      params,
      mockRuntime({ onSearchSymbol: () => (searches += 1) }),
      limits
    );
    assert.ok(searches > 0);
    assert.equal(result.primary?.pathRel, "src/EvidenceService.cs");
  });

  it("does not let an unrelated source marker outrank repository evidence", async () => {
    const params: UnitApproveResolveParams = {
      ...request(),
      manualSourceHint: {
        pathRel: "src/UserOuScopingService.cs",
        symbol: "ValidateAssignableRoles",
      },
    };
    const result = await resolvePrimary(params, mockRuntime(), limits);
    assert.equal(result.primary?.pathRel, "src/EvidenceService.cs");
    assert.equal(result.primary?.name, "Create");
  });

  it("still sweeps the workspace when the hint symbol is absent", async () => {
    let searches = 0;
    const params: UnitApproveResolveParams = {
      ...request(),
      manualSourceHint: { pathRel: "src/EvidenceService.cs", symbol: "Missing" },
    };
    const result = await resolvePrimary(
      params,
      mockRuntime({ onSearchSymbol: () => (searches += 1) }),
      limits
    );
    assert.ok(searches > 0);
    assert.equal(result.primary?.name, "Create");
  });

  it("does not elect an unrelated fuzzy symbol as the primary", async () => {
    const base = mockRuntime();
    const unrelated: RepoDocument = {
      pathRel: "src/Configuration/AppSettingsStartup.cs",
      language: "csharp",
      text:
        "public static class AppSettingsConfiguration { public static void AddAppSettingsModule() {} }",
      dirty: false,
      symbols: [
        symbol("AppSettingsConfiguration", 4, 0, [
          symbol("AddAppSettingsModule", 5, 0),
        ]),
      ],
    };
    const runtime: RepositoryRuntime = {
      ...base,
      async searchSymbol() {
        return {
          hits: [
            {
              id: `${unrelated.pathRel}:0:0:AddAppSettingsModule`,
              name: "AddAppSettingsModule",
              kind: "method",
              pathRel: unrelated.pathRel,
              containerName: "AppSettingsConfiguration",
              range: { start: 0, end: 0 },
              score: 1,
            },
          ],
          truncated: false,
        };
      },
      async readDocument(pathRel) {
        if (pathRel.replace(/\\/g, "/").toLowerCase() === unrelated.pathRel.toLowerCase()) {
          return unrelated;
        }
        return base.readDocument(pathRel, 32768);
      },
    };
    const result = await resolvePrimary(request(), runtime, limits);
    assert.equal(result.primary, null);
    assert.equal(result.ambiguous, false);
  });

  it("verifies proposed identifiers even when fuzzy queries flood the pool", async () => {
    const base = mockRuntime();
    const handler: RepoDocument = {
      pathRel: "src/Application/Commands/EvidenceCreateCommandHandler.cs",
      language: "csharp",
      text:
        "public class EvidenceCreateCommandHandler { public void Handle(EvidenceCreateCommand command) {} }",
      dirty: false,
      symbols: [
        symbol("EvidenceCreateCommandHandler", 4, 0, [symbol("Handle", 5, 0)]),
      ],
    };
    let handlerQueries = 0;
    const runtime: RepositoryRuntime = {
      ...base,
      async searchSymbol(query) {
        if (query.toLowerCase() === "evidencecreatecommandhandler") {
          handlerQueries += 1;
          return {
            hits: [
              {
                id: `${handler.pathRel}:0:0:EvidenceCreateCommandHandler`,
                name: "EvidenceCreateCommandHandler",
                kind: "class",
                pathRel: handler.pathRel,
                range: { start: 0, end: 0 },
                score: 0.4,
              },
            ],
            truncated: false,
          };
        }
        // A fuzzy provider answers every business term with unrelated symbols.
        return {
          hits: Array.from({ length: 8 }, (_unused, index) => ({
            id: `src/Configuration/AppSettingsStartup.cs:${query}:${index}`,
            name: `AddAppSettingsModule${index}`,
            kind: "method" as const,
            pathRel: "src/Configuration/AppSettingsStartup.cs",
            range: { start: index, end: index },
            score: 1,
          })),
          truncated: false,
        };
      },
      async readDocument(pathRel, maxBytes) {
        if (pathRel.replace(/\\/g, "/").toLowerCase() === handler.pathRel.toLowerCase()) {
          return handler;
        }
        return base.readDocument(pathRel, maxBytes ?? 32768);
      },
    };
    const result = await resolvePrimary(request(), runtime, limits, {
      remainingMs: 100_000,
      proposeSymbols: async () => ({
        symbols: ["EvidenceCreateCommandHandler", "Handle"],
        paths: [],
      }),
    });
    assert.ok(handlerQueries > 0);
    assert.deepEqual(result.proposal.verifiedSymbols, [
      "EvidenceCreateCommandHandler",
    ]);
    assert.equal(result.primary?.name, "EvidenceCreateCommandHandler");
  });

  it("offers a harvested query handler to Cursor without electing it itself", async () => {
    const base = mockRuntime();
    const handler: RepoDocument = {
      pathRel: "src/Application/Queries/StorageRoomGetAllQueryHandler.cs",
      language: "csharp",
      text:
        "public class StorageRoomGetAllQueryHandler { public void Handle(StorageRoomGetAllQuery query) {} }",
      dirty: false,
      symbols: [
        symbol("StorageRoomGetAllQueryHandler", 4, 0, [symbol("Handle", 5, 0)]),
      ],
    };
    const seen: string[] = [];
    let offered: string[] = [];
    const runtime: RepositoryRuntime = {
      ...base,
      async searchSymbol(query) {
        seen.push(query);
        if (/getallqueryhandler|queryhandler/i.test(query)) {
          return {
            hits: [
              {
                id: `${handler.pathRel}:0:0:StorageRoomGetAllQueryHandler`,
                name: "StorageRoomGetAllQueryHandler",
                kind: "class",
                pathRel: handler.pathRel,
                range: { start: 0, end: 0 },
                score: 0.4,
              },
            ],
            truncated: false,
          };
        }
        return { hits: [], truncated: false };
      },
      async readDocument(pathRel, maxBytes) {
        if (
          pathRel.replace(/\\/g, "/").toLowerCase() ===
          handler.pathRel.toLowerCase()
        ) {
          return handler;
        }
        return base.readDocument(pathRel, maxBytes ?? 32768);
      },
    };
    const params = request();
    const result = await resolvePrimary(
      {
        ...params,
        tcIr: {
          ...params.tcIr,
          title: "Truy vấn danh sách phòng lưu trữ theo từ khóa không tồn tại",
          expected: {
            ...params.tcIr.expected,
            description:
              "Kết quả là danh sách phòng lưu trữ rỗng (quan sát: query)",
          },
          testData: {
            target: { scope: "aggregate", fields: ["phongLuuTru"] },
            input: { tuKhoaTimKiemPhongLuuTru: "không tồn tại" },
          },
        },
      },
      runtime,
      limits,
      {
        remainingMs: 100_000,
        proposeSymbols: async (input) => {
          offered = input.existingCandidates.map((item) => item.name);
          return {
            symbols: ["SearchStorageRoomsQueryHandler", "Handle"],
            paths: ["src/Invented/SearchStorageRoomsQueryHandler.cs"],
          };
        },
      }
    );
    assert.ok(seen.some((query) => /getallqueryhandler/i.test(query)));
    assert.ok(seen.some((query) => /phongLuuTru|tuKhoaTimKiemPhongLuuTru/i.test(query)));
    assert.deepEqual(result.proposal.verifiedSymbols, []);
    assert.ok(offered.includes("StorageRoomGetAllQueryHandler"));
    // Being a query handler is a shape shared by every list feature in the repo.
    // With the proposal unverified, nothing ties this handler to this test case,
    // so electing it would ground the case against an arbitrary module.
    assert.equal(result.primary, null);
  });

  it("does not let a bare Handle proposal corroborate an unrelated method", async () => {
    const base = mockRuntime();
    const unrelated: RepoDocument = {
      pathRel: "src/Other/OtherCommandHandler.cs",
      language: "csharp",
      text: "public class OtherCommandHandler { public void Handle() {} }",
      dirty: false,
      symbols: [symbol("OtherCommandHandler", 4, 0, [symbol("Handle", 5, 0)])],
    };
    const runtime: RepositoryRuntime = {
      ...base,
      async searchSymbol(query) {
        if (query.toLowerCase() === "handle") {
          return {
            hits: [
              {
                id: `${unrelated.pathRel}:5:0:Handle`,
                name: "Handle",
                kind: "method",
                pathRel: unrelated.pathRel,
                containerName: "OtherCommandHandler",
                range: { start: 5, end: 5 },
                score: 1,
              },
            ],
            truncated: false,
          };
        }
        return { hits: [], truncated: false };
      },
      async readDocument(pathRel, maxBytes) {
        if (
          pathRel.replace(/\\/g, "/").toLowerCase() ===
          unrelated.pathRel.toLowerCase()
        ) {
          return unrelated;
        }
        return base.readDocument(pathRel, maxBytes ?? 32768);
      },
    };
    const result = await resolvePrimary(request(), runtime, limits, {
      remainingMs: 100_000,
      proposeSymbols: async () => ({ symbols: ["Handle"], paths: [] }),
    });
    assert.notEqual(result.primary?.name, "Handle");
    assert.deepEqual(result.proposal.verifiedSymbols, []);
  });

  it("grounds a non-English list intent to a repository-verified query handler", async () => {
    const base = mockRuntime();
    const handler: RepoDocument = {
      pathRel: "src/Application/Queries/StorageRoomGetAllQueryHandler.cs",
      language: "csharp",
      text:
        "public class StorageRoomGetAllQueryHandler { public void Handle(StorageRoomGetAllQuery query) {} }",
      dirty: false,
      symbols: [
        symbol("StorageRoomGetAllQueryHandler", 4, 0, [
          symbol("Handle", 5, 0),
        ]),
      ],
    };
    const runtime: RepositoryRuntime = {
      ...base,
      async searchSymbol(query) {
        if (query.toLowerCase() === "storageroomgetallqueryhandler") {
          return {
            hits: [
              {
                id: `${handler.pathRel}:0:0:StorageRoomGetAllQueryHandler`,
                name: "StorageRoomGetAllQueryHandler",
                kind: "class",
                pathRel: handler.pathRel,
                range: { start: 0, end: 0 },
                score: 0.4,
              },
            ],
            truncated: false,
          };
        }
        return { hits: [], truncated: false };
      },
      async readDocument(pathRel, maxBytes) {
        if (
          pathRel.replace(/\\/g, "/").toLowerCase() ===
          handler.pathRel.toLowerCase()
        ) {
          return handler;
        }
        return base.readDocument(pathRel, maxBytes ?? 32768);
      },
    };
    const params = request();
    const result = await resolvePrimary(
      {
        ...params,
        tcIr: {
          ...params.tcIr,
          title:
            "Truy vấn danh sách phòng lưu trữ theo từ khóa không tồn tại",
          expected: {
            ...params.tcIr.expected,
            description:
              "Kết quả là danh sách phòng lưu trữ rỗng (quan sát: query)",
          },
          testData: {
            target: {
              scope: "aggregate",
              fields: ["phongLuuTru"],
            },
            input: { tuKhoa: "không tồn tại" },
          },
        },
      },
      runtime,
      limits,
      {
        remainingMs: 100_000,
        proposeSymbols: async () => ({
          symbols: ["StorageRoomGetAllQueryHandler"],
          paths: [handler.pathRel],
        }),
      }
    );
    assert.equal(result.primary?.name, "StorageRoomGetAllQueryHandler");
    assert.deepEqual(result.proposal.verifiedSymbols, [
      "StorageRoomGetAllQueryHandler",
    ]);
  });

  it("follows the proposal order when a handler and its command both exist", async () => {
    const base = mockRuntime();
    const docs: RepoDocument[] = [
      {
        pathRel: "src/Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
        language: "csharp",
        text: "public class EvidenceCreateCommandHandler { public void Handle() {} }",
        dirty: false,
        symbols: [symbol("EvidenceCreateCommandHandler", 4, 0, [symbol("Handle", 5, 1)])],
      },
      {
        pathRel: "src/Application/Commands/Evidence/EvidenceCreateCommand.cs",
        language: "csharp",
        text: "public class EvidenceCreateCommand { public string Name { get; set; } }",
        dirty: false,
        symbols: [symbol("EvidenceCreateCommand", 4, 0)],
      },
    ];
    const runtime: RepositoryRuntime = {
      ...base,
      async searchSymbol(query) {
        const doc = docs.find(
          (item) =>
            item.symbols[0].name.toLowerCase() === query.toLowerCase()
        );
        if (!doc) return { hits: [], truncated: false };
        return {
          hits: [
            {
              id: `${doc.pathRel}:0:0:${doc.symbols[0].name}`,
              name: doc.symbols[0].name,
              kind: "class",
              pathRel: doc.pathRel,
              range: { start: 0, end: 0 },
              score: 1,
            },
          ],
          truncated: false,
        };
      },
      async readDocument(pathRel, maxBytes) {
        const doc = docs.find(
          (item) =>
            item.pathRel.toLowerCase() === pathRel.replace(/\\/g, "/").toLowerCase()
        );
        return doc ?? base.readDocument(pathRel, maxBytes ?? 32768);
      },
    };
    const result = await resolvePrimary(request(), runtime, limits, {
      remainingMs: 100_000,
      proposeSymbols: async () => ({
        symbols: ["EvidenceCreateCommandHandler", "EvidenceCreateCommand"],
        paths: docs.map((item) => item.pathRel),
      }),
    });
    // Both names are confirmed and both files sit in the same logic layer, so
    // scoring them alike used to report ambiguity for every well-answered case.
    assert.equal(result.primary?.name, "EvidenceCreateCommandHandler");
    assert.equal(result.ambiguous, false);
  });

  it("asks Cursor to pick from harvested repository candidates", () => {
    const prompt = buildCursorSymbolPrompt(
      symbolProposerInput(request(), 10_000, [
        {
          name: "StorageRoomGetAllQueryHandler",
          pathRel: "src/Application/Queries/StorageRoomGetAllQueryHandler.cs",
        },
      ])
    );
    assert.match(prompt, /StorageRoomGetAllQueryHandler/);
    assert.match(prompt, /Select only from these repository-backed candidates/);
    assert.match(prompt, /Do not propose bare entry methods/);
    assert.doesNotMatch(prompt, /Guess broadly/);
    // Searching on top of an index-derived shortlist is what burned the timeout.
    assert.match(prompt, /Do not search or read repository files/);
  });

  it("allows one bounded search only when no shortlist was harvested", () => {
    const prompt = buildCursorSymbolPrompt(symbolProposerInput(request(), 10_000));
    assert.match(prompt, /use one bounded repository search/);
    assert.doesNotMatch(prompt, /Do not search or read repository files/);
  });
});
