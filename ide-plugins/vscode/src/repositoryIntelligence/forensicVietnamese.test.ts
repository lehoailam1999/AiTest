import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNIT_APPROVE_REQUEST_SCHEMA,
  UNIT_TC_IR_SCHEMA,
  type UnitApproveResolveParams,
} from "@aitest/ide-protocol";
import { sha256 } from "./hash";
import { createUnitApproveResolver } from "./unitApproveCommands";
import type { SymbolProposer } from "./symbolProposer";
import type {
  RepoDocument,
  RepoDocumentSymbol,
  RepositoryRuntime,
} from "./runtime";

const range = (line: number) => ({
  start: { line, character: 0 },
  end: { line, character: 40 },
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

/** TC-014: reject assigning evidence to an already occupied compartment. */
function vietnameseRequest(): UnitApproveResolveParams {
  return {
    schema: UNIT_APPROVE_REQUEST_SCHEMA,
    requestId: "request-tc-014",
    projectId: "forensic",
    testCaseRevision: { testCaseId: "TC-014", contentHash: sha256("tc-014") },
    tcIr: {
      schema: UNIT_TC_IR_SCHEMA,
      testCaseId: "TC-014",
      title:
        "Nhập mô tả chi tiết vật chứng - Chọn ngăn lưu trữ đã chứa vật chứng - Từ chối gán vị trí",
      requirement: {
        title: "Tạo vật chứng",
        requirementIds: ["BR-13"],
        behaviorId: "BR-13-B01",
      },
      module: "Nhập mô tả chi tiết vật chứng",
      primaryBucket: "BUSINESS_RULES",
      scenario: "NEGATIVE",
      categories: ["Unit"],
      preconditions: ["Tồn tại ngăn lưu trữ đã chứa vật chứng khác"],
      steps: {
        prepare: [],
        execute: ["Gọi nghiệp vụ tạo mới vật chứng với ngăn đã chứa vật chứng"],
      },
      expected: {
        type: "value",
        description: "REJECT — Yêu cầu gán vào ngăn đã chứa vật chứng bị từ chối",
        observable: "REJECT",
      },
      testData: {
        target: {
          scope: "field",
          fields: ["nganLuuTru"],
          constraint: "Chỉ ngăn trống được phép sử dụng",
        },
        input: { tenVatChung: "Vật chứng kiểm thử", nganLuuTru: "Ngăn A1-02" },
      },
      readiness: "READY_FOR_GROUNDING",
    },
  };
}

/** TC-011: the description field must reject input beyond 2000 characters. */
function descriptionLengthRequest(): UnitApproveResolveParams {
  const base = vietnameseRequest();
  return {
    ...base,
    requestId: "request-tc-011",
    testCaseRevision: { testCaseId: "TC-011", contentHash: sha256("tc-011") },
    tcIr: {
      ...base.tcIr,
      testCaseId: "TC-011",
      title: "Nhập mô tả chi tiết vật chứng - Mô tả vượt 2000 ký tự - Từ chối dữ liệu",
      primaryBucket: "VALIDATION_DATA",
      scenario: "BOUNDARY",
      expected: {
        type: "value",
        description: "REJECT — Mô tả dài 2001 ký tự bị từ chối",
        observable: "REJECT",
      },
      testData: {
        target: {
          scope: "field",
          fields: ["moTa"],
          constraint: "Tối đa 2000 ký tự",
          boundary: "2000/2001",
        },
        input: { tenVatChung: "Vật chứng kiểm thử", moTa: "chuỗi 2001 ký tự" },
      },
    },
  };
}

/**
 * Mirrors the Forensic layout: production handler plus a large existing test
 * suite whose method names fuzzy-match Vietnamese words.
 */
function forensicRuntime(options?: { emptyIndex?: boolean }): RepositoryRuntime {
  const handler: RepoDocument = {
    pathRel: "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
    language: "csharp",
    text: [
      "public class EvidenceCreateCommandHandler {",
      "  public async Task<long> Handle(EvidenceCreateCommand request) {",
      "    var compartment = await _db.CabinetCompartments.FindAsync(request.SelectedCompartmentId);",
      "    compartment.IsOccupied = true;",
      "    return evidence.Id;",
      "  }",
      "}",
    ].join("\n"),
    dirty: false,
    symbols: [
      symbol("EvidenceCreateCommandHandler", 4, 0, [symbol("Handle", 5, 1)]),
    ],
  };
  // The handler names the command; only the command names the DTO that declares
  // the fields, so reaching Description takes two hops.
  const command: RepoDocument = {
    pathRel: "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommand.cs",
    language: "csharp",
    text: [
      "public class EvidenceCreateCommand : IRequest<Evidence> {",
      "  public EvidenceDto EvidenceDto { get; set; }",
      "  public long? SelectedCompartmentId { get; set; }",
      "}",
    ].join("\n"),
    dirty: false,
    symbols: [
      symbol("EvidenceCreateCommand", 4, 0, [
        symbol("EvidenceDto", 6, 1),
        symbol("SelectedCompartmentId", 6, 2),
      ]),
    ],
  };
  const dto: RepoDocument = {
    pathRel: "src/Forensic.Dto/EvidenceDto.cs",
    language: "csharp",
    text: [
      "public class EvidenceDto {",
      "  [Required]",
      "  public string Name { get; set; }",
      "  public string? Description { get; set; }",
      "  public long? SelectedCompartmentId { get; set; }",
      "}",
    ].join("\n"),
    dirty: false,
    symbols: [
      symbol("EvidenceDto", 4, 0, [
        symbol("Name", 6, 2),
        symbol("Description", 6, 3),
        symbol("SelectedCompartmentId", 6, 4),
      ]),
    ],
  };
  // The symbol that Vietnamese terms accidentally matched in production.
  const decoy: RepoDocument = {
    pathRel: "test/Forensic.Test/Unit/Commands/CasePerson/CasePersonHandlersTest.cs",
    language: "csharp",
    text: "public class CasePersonHandlersTest {\n  public void BulkSave_ShouldKeepItemsUnchanged() {}\n}",
    dirty: false,
    symbols: [
      symbol("CasePersonHandlersTest", 4, 0, [
        symbol("BulkSave_ShouldKeepItemsUnchanged", 5, 1),
      ]),
    ],
  };
  const docs = new Map(
    [handler, command, dto, decoy].map((doc) => [doc.pathRel.toLowerCase(), doc])
  );

  return {
    workspaceRoot: () => "D:\\Xlab\\Forensic\\forensic",
    now: () => new Date("2026-08-17T00:00:00.000Z"),
    async git(args) {
      return args[0] === "rev-parse" ? "645f4e5" : "";
    },
    async dirtyDocuments() {
      return [];
    },
    async searchSymbol(query) {
      if (options?.emptyIndex) return { hits: [], truncated: false };
      const normalized = query.toLowerCase();
      for (const type of [command, dto]) {
        const name = type.symbols[0].name;
        if (normalized === name.toLowerCase()) {
          return {
            hits: [
              {
                id: `${type.pathRel}:0:0:${name}`,
                name,
                kind: "class",
                pathRel: type.pathRel,
                range: { start: 0, end: 0, startCharacter: 0, endCharacter: 40 },
                score: 1,
              },
            ],
            truncated: false,
          };
        }
      }
      // Vietnamese words only ever reach the fuzzy decoy match.
      if (/ch[uứ]ng|v[aậ]t|nh[aậ]p|t[aạ]o|ng[aă]n|b[rR]-13/.test(query)) {
        return {
          hits: [
            {
              id: `${decoy.pathRel}:1:0:BulkSave_ShouldKeepItemsUnchanged`,
              name: "BulkSave_ShouldKeepItemsUnchanged",
              kind: "method",
              pathRel: decoy.pathRel,
              containerName: "CasePersonHandlersTest",
              range: { start: 1, end: 1, startCharacter: 0, endCharacter: 40 },
              score: 0.25,
            },
          ],
          truncated: false,
        };
      }
      if (normalized === "evidencecreatecommandhandler" || normalized === "handle") {
        return {
          hits: [
            {
              id: `${handler.pathRel}:1:0:Handle`,
              name: "Handle",
              kind: "method",
              pathRel: handler.pathRel,
              containerName: "EvidenceCreateCommandHandler",
              range: { start: 1, end: 1, startCharacter: 0, endCharacter: 40 },
              score: normalized === "handle" ? 1 : 0.7,
            },
          ],
          truncated: false,
        };
      }
      return { hits: [], truncated: false };
    },
    async definition() {
      return { locations: [] };
    },
    async references() {
      return { refs: [], truncated: false };
    },
    async implementations() {
      return { locations: [], truncated: false };
    },
    async readDocument(pathRel) {
      return docs.get(pathRel.replace(/\\/g, "/").toLowerCase()) || null;
    },
    async findSourceFiles() {
      return [handler.pathRel, dto.pathRel];
    },
  };
}

const proposeForensicSymbols: SymbolProposer = async (input) => {
  assert.match(input.title, /vật chứng/);
  return {
    symbols: ["EvidenceCreateCommandHandler", "Handle"],
    paths: [
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
    ],
  };
};

describe("Vietnamese TC against an English codebase", () => {
  it("discovers the production handler from source text before calling Cursor", async () => {
    let proposerCalled = false;
    const runtime: RepositoryRuntime = {
      ...forensicRuntime(),
      async searchText(query) {
        return query === "Tạo vật chứng"
          ? {
              hits: [
                {
                  pathRel:
                    "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
                  line: 4,
                  preview: 'Log("Tạo vật chứng")',
                },
              ],
              truncated: false,
            }
          : { hits: [], truncated: false };
      },
    };
    const result = await createUnitApproveResolver(runtime, {
      proposeSymbols: async () => {
        proposerCalled = true;
        return { symbols: [], paths: [] };
      },
    })(vietnameseRequest());

    assert.equal(result.decision?.primary?.name, "Handle");
    assert.equal(proposerCalled, false);
    const discovery = result.decision?.checks.find(
      (item) => item.id === "source-discovery"
    );
    assert.equal(discovery?.ok, true);
    const proposal = result.decision?.checks.find(
      (item) => item.id === "symbol-proposal"
    );
    assert.match(proposal?.detail || "", /not needed/);
  });

  it("never resolves an existing test method as the primary subject", async () => {
    const result = await createUnitApproveResolver(forensicRuntime())(
      vietnameseRequest()
    );
    assert.notEqual(
      result.decision?.primary?.name,
      "BulkSave_ShouldKeepItemsUnchanged"
    );
    assert.ok(!result.decision?.primary?.pathRel.startsWith("test/"));
  });

  it("reaches the production handler through proposed identifiers", async () => {
    const result = await createUnitApproveResolver(forensicRuntime(), {
      proposeSymbols: proposeForensicSymbols,
    })(vietnameseRequest());
    assert.equal(result.decision?.primary?.name, "Handle");
    assert.equal(
      result.decision?.primary?.pathRel,
      "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs"
    );
  });

  it("keeps that primary while refusing a behaviour the source lacks", async () => {
    const result = await createUnitApproveResolver(forensicRuntime(), {
      proposeSymbols: proposeForensicSymbols,
      pickFields: async ({ candidates }) => {
        const compartment = candidates.find(
          (candidate) => candidate.property === "SelectedCompartmentId"
        );
        return compartment
          ? {
              picks: [
                {
                  label: "nganLuuTru",
                  property: compartment.property,
                  ownerPath: compartment.ownerPath,
                },
              ],
            }
          : { picks: [] };
      },
    })(vietnameseRequest());

    assert.equal(result.status, "FEATURE_GAP");
    assert.equal(result.decision?.outcome, "FEATURE_GAP");
    assert.equal(result.decision?.authoritative, false);
    assert.equal(result.decision?.primary?.name, "Handle");
    assert.equal(result.decision?.fieldBindings[0]?.property, "SelectedCompartmentId");
    assert.match(
      result.decision?.refusalReasons[0]?.message || "",
      /No source evidence/
    );
  });

  it("records why the bridge produced nothing instead of failing silently", async () => {
    const result = await createUnitApproveResolver(forensicRuntime(), {
      proposeSymbols: async () => ({
        symbols: [],
        paths: [],
        engine: "agent.ps1",
        error: "AI CLI timed out after 30000ms",
      }),
    })(vietnameseRequest());

    const check = result.decision?.checks.find(
      (item) => item.id === "symbol-proposal"
    );
    assert.equal(check?.ok, false);
    assert.match(check?.detail || "", /agent\.ps1/);
    assert.match(check?.detail || "", /timed out/);
  });

  it("reports a source marker it refused to follow", async () => {
    const request = {
      ...vietnameseRequest(),
      manualSourceHint: {
        pathRel: "src/Forensic/Services/IUserOuScopingService.cs",
        symbol: "ValidateAssignableRoles",
      },
    };
    const result = await createUnitApproveResolver(forensicRuntime(), {
      proposeSymbols: proposeForensicSymbols,
    })(request);

    const marker = result.decision?.checks.find(
      (item) => item.id === "source-marker"
    );
    assert.equal(marker?.ok, false);
    assert.match(marker?.detail || "", /ignored/);
    // The stale marker must not be searched for, nor become the subject.
    assert.equal(result.decision?.primary?.name, "Handle");
  });

  it("reaches the DTO two type hops away so moTa can bind", async () => {
    const base = forensicRuntime();
    const runtime: RepositoryRuntime = {
      ...base,
      async implementations() {
        return {
          locations: [
            "EvidenceUpdateCommandHandler.cs",
            "EvidenceDeleteCommandHandler.cs",
            "EvidenceAssignCommandHandler.cs",
            "EvidenceArchiveCommandHandler.cs",
            "EvidenceRestoreCommandHandler.cs",
          ].map((file, index) => ({
            pathRel: `src/Forensic.Application/Commands/Evidence/${file}`,
            line: index,
            character: 0,
          })),
          truncated: false,
        };
      },
    };
    const result = await createUnitApproveResolver(runtime, {
      proposeSymbols: proposeForensicSymbols,
      pickFields: async ({ candidates, labels }) => {
        const property = candidates.find((item) => item.property === "Description");
        return property && labels.includes("moTa")
          ? {
              picks: [
                {
                  label: "moTa",
                  property: property.property,
                  ownerPath: property.ownerPath,
                },
              ],
            }
          : { picks: [] };
      },
    })(descriptionLengthRequest());

    assert.equal(result.decision?.fieldBindings[0]?.property, "Description");
    assert.equal(
      result.decision?.fieldBindings[0]?.owner.pathRel,
      "src/Forensic.Dto/EvidenceDto.cs"
    );
  });

  it("calls an empty symbol index a retryable environment problem", async () => {
    const result = await createUnitApproveResolver(forensicRuntime({ emptyIndex: true }), {
      proposeSymbols: proposeForensicSymbols,
    })(vietnameseRequest());

    assert.equal(result.status, "NOT_READY");
    const index = result.decision?.checks.find((item) => item.id === "symbol-index");
    assert.equal(index?.ok, false);
    assert.match(index?.detail || "", /0 hits/);
    assert.match(index?.detail || "", /retried/);
    const reason = result.decision?.refusalReasons[0];
    assert.equal(reason?.code, "NO_PRIMARY");
    assert.equal(reason?.retryable, true);
    assert.match(reason?.message || "", /still loading/);
  });

  it("prefers a query handler over configuration when the TC is a list/query", async () => {
    const queryHandler: RepoDocument = {
      pathRel: "src/Application/Queries/StorageRoom/StorageRoomGetAllQueryHandler.cs",
      language: "csharp",
      text: [
        "public class StorageRoomGetAllQueryHandler {",
        "  public async Task<Page> Handle(StorageRoomGetAllQuery request) {",
        "    return rooms.Where(r => r.Status == StorageRoomStatus.Active);",
        "  }",
        "}",
      ].join("\n"),
      dirty: false,
      symbols: [
        symbol("StorageRoomGetAllQueryHandler", 4, 0, [symbol("Handle", 5, 1)]),
      ],
    };
    const startup: RepoDocument = {
      pathRel: "src/Host/Configuration/AppSettingsStartup.cs",
      language: "csharp",
      text: "public static class AppSettingsConfiguration { public static void AddAppSettingsModule() {} }",
      dirty: false,
      symbols: [
        symbol("AppSettingsConfiguration", 4, 0, [symbol("AddAppSettingsModule", 5, 0)]),
      ],
    };
    const base = forensicRuntime();
    const runtime: RepositoryRuntime = {
      ...base,
      async searchSymbol(query) {
        const normalized = query.toLowerCase();
        if (normalized.includes("queryhandler") || normalized.includes("getall") || normalized === "handle") {
          return {
            hits: [
              {
                id: `${queryHandler.pathRel}:0:0:StorageRoomGetAllQueryHandler`,
                name: "StorageRoomGetAllQueryHandler",
                kind: "class",
                pathRel: queryHandler.pathRel,
                range: { start: 0, end: 0, startCharacter: 0, endCharacter: 40 },
                score: 0.4,
              },
            ],
            truncated: false,
          };
        }
        return {
          hits: [
            {
              id: `${startup.pathRel}:0:0:AddAppSettingsModule`,
              name: "AddAppSettingsModule",
              kind: "method",
              pathRel: startup.pathRel,
              containerName: "AppSettingsConfiguration",
              range: { start: 0, end: 0, startCharacter: 0, endCharacter: 40 },
              score: 1,
            },
          ],
          truncated: false,
        };
      },
      async readDocument(pathRel) {
        const key = pathRel.replace(/\\/g, "/").toLowerCase();
        if (key === queryHandler.pathRel.toLowerCase()) return queryHandler;
        if (key === startup.pathRel.toLowerCase()) return startup;
        return base.readDocument(pathRel, 32768);
      },
    };
    const request = vietnameseRequest();
    const result = await createUnitApproveResolver(runtime, {
      proposeSymbols: async () => ({
        symbols: ["StorageRoomGetAllQueryHandler"],
        paths: [queryHandler.pathRel],
      }),
    })({
      ...request,
      requestId: "request-tc-034",
      testCaseRevision: { testCaseId: "TC-034", contentHash: sha256("tc-034") },
      tcIr: {
        ...request.tcIr,
        testCaseId: "TC-034",
        title:
          "Ghi nhận thông tin thu giữ vật chứng - Lấy danh sách tủ theo phòng lưu trữ đã chọn",
        scenario: "POSITIVE",
        expected: {
          type: "value",
          description:
            "STATE — Danh sách trả về chỉ gồm các tủ thuộc phòng đã chọn — (quan sát: query)",
          observable: "query",
        },
        testData: {
          target: {
            scope: "aggregate",
            fields: ["tuLuuTru"],
            constraint: "Danh sách tủ phụ thuộc phòng lưu trữ đã chọn",
          },
          input: { phongLuuTru: "P01" },
        },
      },
    });
    assert.equal(result.decision?.primary?.name, "StorageRoomGetAllQueryHandler");
    assert.ok(!result.decision?.primary?.pathRel.includes("AppSettings"));
  });

  it("ignores proposed identifiers that the repository does not contain", async () => {
    const result = await createUnitApproveResolver(forensicRuntime(), {
      proposeSymbols: async () => ({
        symbols: ["RejectOccupiedCompartmentValidator"],
        paths: ["src/Invented/NotThere.cs"],
      }),
    })(vietnameseRequest());

    assert.notEqual(result.status, "RESOLVED");
    assert.ok(
      !result.decision?.primary?.pathRel.includes("Invented"),
      "an unverified proposal must never become the primary"
    );
  });
});
