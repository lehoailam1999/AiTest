import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindTargetPropertyInTestData,
  buildFieldPropertyShortlist,
  resolvePropertyFromFieldAliases,
  resolveFieldFromIndex,
} from "./resolveFieldFromIndex.ts";
import { acceptFieldShortlistPick } from "./llmPickUnitField.ts";
import type { CodeIndexSnapshot } from "../codeIndex/types.ts";

function snapWithEvidenceDto(): CodeIndexSnapshot {
  const dtoPath = "src/Forensic.Dto/EvidenceDto.cs";
  const handler =
    "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs";
  return {
    meta: {
      schema: "aitest-code-index-v1",
      createdAt: "",
      updatedAt: "",
      fileCount: 2,
      symbolCount: 10,
      edgeCount: 0,
      parser: "test",
    },
    files: {
      [dtoPath]: {
        pathRel: dtoPath,
        language: "cs",
        contentHash: "x",
        byteSize: 1,
        symbolCount: 5,
        importCount: 0,
        indexedAt: "",
      },
      [handler]: {
        pathRel: handler,
        language: "cs",
        contentHash: "x",
        byteSize: 1,
        symbolCount: 1,
        importCount: 0,
        indexedAt: "",
      },
    },
    symbolsByFile: {
      [dtoPath]: [
        { name: "EvidenceDto", kind: "class", line: 1, exported: true },
        { name: "EvidenceCode", kind: "variable", line: 2, parent: "EvidenceDto" },
        { name: "Name", kind: "variable", line: 3, parent: "EvidenceDto" },
        { name: "CaseCode", kind: "variable", line: 4, parent: "EvidenceDto" },
        { name: "SeizureLocation", kind: "variable", line: 5, parent: "EvidenceDto" },
      ],
      [handler]: [
        { name: "EvidenceCreateCommandHandler", kind: "class", line: 1, exported: true },
      ],
    },
    importsByFile: {},
    exportsByFile: {},
    symbolIndex: {},
    dependencyGraph: { nodes: [], edges: [] },
  };
}

describe("resolveFieldFromIndex deterministic only", () => {
  const dtoBody = `
public class EvidenceDto {
  [Required]
  [Display(Name = "Địa điểm thu giữ")]
  public string SeizureLocation { get; set; }
  public string? EvidenceCode { get; set; }
  [Required]
  public string Name { get; set; }
}
`;

  it("resolves VI label from DTO Display attribute", () => {
    const prop = resolveFieldFromIndex({
      fieldLabel: "Địa điểm thu giữ",
      dtoExcerpts: { "src/App/EvidenceDto.cs": dtoBody },
    });
    assert.equal(prop, "SeizureLocation");
  });

  it("returns Latin field label unchanged when in props", () => {
    const prop = resolveFieldFromIndex({
      fieldLabel: "SeizureLocation",
      dtoExcerpts: { "src/App/EvidenceDto.cs": dtoBody },
    });
    assert.equal(prop, "SeizureLocation");
  });

  it("does NOT echo unbound Latin-looking labels when shortlist is empty", () => {
    const prop = resolveFieldFromIndex({
      fieldLabel: "hoSoVuAn",
      inputKeys: ["hoSoVuAn"],
      primaryPath: "src/unknown/Handler.cs",
      codeIndex: {
        meta: {
          schema: "aitest-code-index-v1",
          createdAt: "",
          updatedAt: "",
          fileCount: 0,
          symbolCount: 0,
          edgeCount: 0,
          parser: "test",
        },
        files: {},
        symbolsByFile: {},
        importsByFile: {},
        exportsByFile: {},
        symbolIndex: {},
        dependencyGraph: { nodes: [], edges: [] },
      },
    });
    assert.equal(prop, null);
  });

  it("does NOT treat unbound VI camelCase property as already bound", () => {
    const td =
      "target.field: hoSoVuAn\n" +
      "target.property: hoSoVuAn\n" +
      'input: {"hoSoVuAn":[]}\n';
    const bound = bindTargetPropertyInTestData(td, {
      primaryPath:
        "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      codeIndex: snapWithEvidenceDto(),
      propertyOverride: "CaseCode",
    });
    assert.equal(bound.bound, true);
    assert.equal(bound.property, "CaseCode");
    assert.match(bound.testData, /target\.property:\s*CaseCode/);
  });

  it("does NOT role-guess VI label without Display (LLM shortlist instead)", () => {
    const prop = resolveFieldFromIndex({
      fieldLabel: "Mã vật chứng",
      inputKeys: ["maVatChung"],
      primaryPath:
        "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      codeIndex: snapWithEvidenceDto(),
    });
    assert.equal(prop, null);
  });

  it("PascalCase / camelCase input key matches property", () => {
    const prop = resolveFieldFromIndex({
      fieldLabel: "something",
      inputKeys: ["evidenceCode"],
      primaryPath:
        "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      codeIndex: snapWithEvidenceDto(),
    });
    assert.equal(prop, "EvidenceCode");
  });

  it("buildFieldPropertyShortlist includes DTO props near primary", () => {
    const list = buildFieldPropertyShortlist({
      codeIndex: snapWithEvidenceDto(),
      primaryPath:
        "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
    });
    assert.ok(list.includes("EvidenceCode"));
    assert.ok(list.includes("Name"));
  });

  it("discovers DTO properties across TypeScript projects", () => {
    const dtoPath = "src/orders/CreateOrderRequest.ts";
    const list = buildFieldPropertyShortlist({
      primaryPath: "src/orders/CreateOrderHandler.ts",
      relatedPaths: [dtoPath],
      dtoExcerpts: {
        [dtoPath]:
          "export interface CreateOrderRequest {\n" +
          "  customerReference: string;\n" +
          "  quantity?: number;\n" +
          "}",
      },
    });
    assert.ok(list.includes("customerReference"), JSON.stringify(list));
    assert.ok(list.includes("quantity"), JSON.stringify(list));
  });
});

describe("acceptFieldShortlistPick", () => {
  it("accepts property in shortlist", () => {
    const got = acceptFieldShortlistPick(
      { property: "EvidenceCode", confidence: 0.9 },
      ["EvidenceCode", "Name", "CaseCode"]
    );
    assert.equal(got?.property, "EvidenceCode");
  });

  it("refuses invented property", () => {
    const got = acceptFieldShortlistPick(
      { property: "HackField", confidence: 0.99 },
      ["EvidenceCode", "Name"]
    );
    assert.equal(got, null);
  });

  it("refuses low confidence", () => {
    const got = acceptFieldShortlistPick(
      { property: "EvidenceCode", confidence: 0.4 },
      ["EvidenceCode"]
    );
    assert.equal(got, null);
  });
});

describe("bindTargetPropertyInTestData", () => {
  it("binds code-aliases.fields by input key before index/LLM", () => {
    const td =
      "target.field: Mã mục\n" +
      'input: {"maMuc":""}\n';
    const property = resolvePropertyFromFieldAliases(td, {
      maMuc: "ItemCode",
    });
    assert.equal(property, "ItemCode");
    const bound = bindTargetPropertyInTestData(td, {
      propertyOverride: property,
    });
    assert.equal(bound.bound, true);
    assert.match(bound.testData, /target\.property:\s*ItemCode/);
    assert.match(bound.testData, /input:\s*\{"ItemCode":""\}/);
  });

  it("applies propertyOverride from LLM shortlist", () => {
    const td =
      "primaryBucket: VALIDATION_DATA\n" +
      "target.field: Mã vật chứng\n" +
      "target.constraint: required\n" +
      'input: {"maVatChung":""}\n';
    const r = bindTargetPropertyInTestData(td, {
      primaryPath:
        "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      codeIndex: snapWithEvidenceDto(),
      propertyOverride: "EvidenceCode",
    });
    assert.equal(r.bound, true);
    assert.equal(r.property, "EvidenceCode");
    assert.match(r.testData, /target\.property:\s*EvidenceCode/);
    assert.match(r.testData, /"EvidenceCode"\s*:/);
  });

  it("does not bind VI without override or Display", () => {
    const td =
      "target.field: Mã vật chứng\n" + 'input: {"maVatChung":""}\n';
    const r = bindTargetPropertyInTestData(td, {
      primaryPath:
        "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      codeIndex: snapWithEvidenceDto(),
    });
    assert.equal(r.bound, false);
  });
});
