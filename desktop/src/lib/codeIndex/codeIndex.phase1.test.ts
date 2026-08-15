import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDependencyGraph, resolveRelativeImport, resolveImportSpecifier } from "./buildDependencyGraph.js";
import { buildSymbolIndex } from "./buildSymbolIndex.js";
import { shouldIndexPath, toProjectRelativePath } from "./constants.js";
import { syncProjectIndex } from "./incrementalSync.js";
import { loadIndexSnapshot } from "./indexStore.js";
import { lookupSymbol } from "./lookup.js";
import { parseTsJsSource } from "./parseTsAst.js";
import { parseCsharpSource } from "./parseCsharp.js";
import type { CodeIndexIo } from "./types.js";

function memoryIo(files: Record<string, string>): CodeIndexIo {
  return {
    listFiles: async () =>
      Object.keys(files).filter((p) => !p.endsWith(".ai-test/index.db") && !p.includes(".ai-test/")),
    readFile: async (_root, pathRel) => {
      if (!(pathRel in files)) throw new Error(`missing ${pathRel}`);
      return files[pathRel];
    },
    writeFile: async (_root, pathRel, content) => {
      files[pathRel] = content;
    },
    readFileOptional: async (_root, pathRel) =>
      pathRel in files ? files[pathRel] : null,
  };
}

describe("codeIndex Phase 1", () => {
  it("shouldIndexPath skips node_modules and dist", () => {
    assert.equal(shouldIndexPath("src/order.service.ts"), true);
    assert.equal(shouldIndexPath("src/App/PersonGetAllQueryHandler.cs"), true);
    assert.equal(shouldIndexPath("node_modules/foo/index.ts"), false);
    assert.equal(shouldIndexPath("dist/app.js"), false);
    assert.equal(shouldIndexPath(".ai-test/index.db"), false);
  });

  it("normalizes scanner and legacy index keys to repository-relative paths", async () => {
    assert.equal(
      toProjectRelativePath("D:\\Repo", "D:\\Repo\\src\\Foo.cs"),
      "src/Foo.cs"
    );
    assert.equal(toProjectRelativePath("D:\\Repo", "C:\\Other\\Foo.cs"), "");
    const absolute = "D:/Repo/src/Foo.cs";
    const raw = JSON.stringify({
      meta: {
        schema: "aitest-code-index-v1",
        projectRootHint: "D:/Repo",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        fileCount: 1,
        symbolCount: 1,
        edgeCount: 0,
        parser: "lightweight-ts-js-cs-v1",
      },
      files: {
        [absolute]: {
          pathRel: absolute,
          language: "cs",
          contentHash: "a".repeat(64),
          byteSize: 10,
          symbolCount: 1,
          importCount: 0,
          indexedAt: "2026-01-01T00:00:00Z",
        },
      },
      symbolsByFile: {
        [absolute]: [{ name: "Foo", kind: "class", line: 1 }],
      },
      importsByFile: { [absolute]: [] },
      exportsByFile: { [absolute]: [] },
      symbolIndex: { foo: [absolute] },
      dependencyGraph: { [absolute]: [] },
    });
    const snap = await loadIndexSnapshot("D:\\Repo", {
      listFiles: async () => [],
      readFile: async () => raw,
      writeFile: async () => undefined,
      readFileOptional: async () => raw,
    });
    assert.ok(snap?.files["src/Foo.cs"]);
    assert.equal(snap?.files["src/Foo.cs"]?.pathRel, "src/Foo.cs");
    assert.deepEqual(snap?.symbolIndex.foo, ["src/Foo.cs"]);
  });

  it("parses C# class/handler methods for Approve symbol rank", () => {
    const src = `
namespace App.Queries.Person;
public class PersonGetAllQueryHandler
{
    public async Task<List<PersonDto>> Handle(PersonGetAllQuery request, CancellationToken ct)
    {
        var term = (request.SearchTerm ?? string.Empty).Trim().ToLower();
        return people.Where(p => p.FullName.ToLower().Contains(term)).ToList();
    }
}
`;
    const parsed = parseCsharpSource(
      "src/App/Queries/Person/PersonGetAllQueryHandler.cs",
      src
    );
    assert.ok(parsed);
    assert.equal(parsed!.language, "cs");
    assert.ok(
      parsed!.symbols.some(
        (s) => s.name === "PersonGetAllQueryHandler" && s.kind === "class"
      )
    );
    assert.ok(
      parsed!.symbols.some(
        (s) => s.name === "Handle" && s.kind === "method"
      )
    );
    const handle = parsed!.symbols.find(
      (s) => s.name === "Handle" && s.kind === "method"
    );
    assert.ok(handle);
    assert.ok(
      typeof handle!.endLine === "number" && handle!.endLine! >= handle!.line,
      `Handle endLine expected, got ${JSON.stringify(handle)}`
    );
    const cls = parsed!.symbols.find(
      (s) => s.name === "PersonGetAllQueryHandler" && s.kind === "class"
    );
    assert.ok(cls);
    assert.ok(
      typeof cls!.endLine === "number" && cls!.endLine! >= cls!.line,
      `class endLine expected, got ${JSON.stringify(cls)}`
    );
  });

  it("indexes C# auto-property names (SearchTerm) for Approve bridges", () => {
    const src = `
public class ContactSearchQuery {
  public string? SearchTerm { get; set; }
  public int Page { get; set; }
}
`;
    const parsed = parseCsharpSource(
      "src/App/Queries/Contact/ContactSearchQuery.cs",
      src
    );
    assert.ok(parsed);
    assert.ok(
      parsed!.symbols.some((s) => s.name === "ContactSearchQuery"),
      JSON.stringify(parsed!.symbols)
    );
    assert.ok(
      parsed!.symbols.some((s) => s.name === "SearchTerm"),
      JSON.stringify(parsed!.symbols)
    );
  });

  it("syncProjectIndex indexes .cs into symbolIndex", async () => {
    const files: Record<string, string> = {
      "src/App/Queries/Person/PersonGetAllQueryHandler.cs": `
public class PersonGetAllQueryHandler {
  public Task Handle(PersonGetAllQuery request) {
    var t = request.SearchTerm.ToLower();
    return people.Where(p => p.FullName.ToLower().Contains(t));
  }
}
`,
      "src/app/order.service.ts": `export class OrderService { create() {} }`,
    };
    const io = memoryIo(files);
    const first = await syncProjectIndex("/proj", io, { force: true });
    assert.ok(first.snapshot.files["src/App/Queries/Person/PersonGetAllQueryHandler.cs"]);
    const hits = lookupSymbol(first.snapshot, "PersonGetAllQueryHandler");
    assert.ok(hits.length >= 1, JSON.stringify(hits));
    assert.match(hits[0]!.pathRel, /PersonGetAllQueryHandler\.cs$/);
  });

  it("indexes C# Handler + Dto + Validator symbols for Unit related expand", async () => {
    const files: Record<string, string> = {
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
public class WidgetCreateCommandHandler {
  public Task Handle(WidgetCreateCommand request) { return Task.CompletedTask; }
}
`,
      "src/App/Commands/Widget/WidgetCreateCommand.cs": `
public class WidgetCreateCommand {
  public string Name { get; set; }
}
`,
      "src/App/Dtos/WidgetCreateDto.cs": `
public class WidgetCreateDto {
  [Required]
  public string Name { get; set; }
}
`,
      "src/App/Validators/WidgetCreateCommandValidator.cs": `
public class WidgetCreateCommandValidator {
  public WidgetCreateCommandValidator() {}
}
`,
    };
    const io = memoryIo(files);
    const synced = await syncProjectIndex("/proj", io, { force: true });
    for (const name of [
      "WidgetCreateCommandHandler",
      "WidgetCreateCommand",
      "WidgetCreateDto",
      "WidgetCreateCommandValidator",
    ]) {
      const hits = lookupSymbol(synced.snapshot, name);
      assert.ok(hits.length >= 1, `missing symbol ${name}: ${JSON.stringify(hits)}`);
    }
  });

  it("syncProjectIndex indexes C# Handler + Dto + Validator symbols", async () => {
    const files: Record<string, string> = {
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs": `
public class WidgetCreateCommandHandler {
  public Task Handle(WidgetCreateCommand request) { return Task.CompletedTask; }
}
`,
      "src/App/Commands/Widget/WidgetCreateCommand.cs": `
public class WidgetCreateCommand {
  [Required] public string Name { get; set; }
}
`,
      "src/App/Dtos/WidgetCreateDto.cs": `
public class WidgetCreateDto {
  public string Name { get; set; }
}
`,
      "src/App/Validators/WidgetCreateValidator.cs": `
public class WidgetCreateValidator {
  public void Validate(WidgetCreateDto dto) {}
}
`,
    };
    const io = memoryIo(files);
    const first = await syncProjectIndex("/proj", io, { force: true });
    for (const name of [
      "WidgetCreateCommandHandler",
      "WidgetCreateCommand",
      "WidgetCreateDto",
      "WidgetCreateValidator",
    ]) {
      const hits = lookupSymbol(first.snapshot, name);
      assert.ok(hits.length >= 1, name + " " + JSON.stringify(hits));
    }
  });

  it("parses class, methods, imports, exports", () => {
    const src = `
import { Payment } from "./payment.service";
import type { OrderDto } from "./order.dto";

@Injectable()
export class OrderService {
  constructor(private readonly payment: Payment) {}

  async createOrder(dto: OrderDto) {
    return this.payment.charge(dto);
  }
}

export function helper() {}
`;
    const parsed = parseTsJsSource("src/order/order.service.ts", src);
    assert.ok(parsed);
    assert.ok(parsed!.symbols.some((s) => s.name === "OrderService" && s.kind === "class"));
    assert.ok(
      parsed!.symbols.some(
        (s) => s.name === "createOrder" && s.kind === "method" && s.parent === "OrderService"
      )
    );
    assert.ok(parsed!.imports.some((i) => i.from.includes("payment.service")));
    assert.ok(parsed!.exports.some((e) => e.name === "OrderService"));
  });

  it("syncProjectIndex incremental + lookupSymbol", async () => {
    const files: Record<string, string> = {
      "src/order.service.ts": `
export class OrderService {
  create() {}
}
`,
      "src/payment.service.ts": `
import { OrderService } from "./order.service";
export class PaymentService {
  pay(svc: OrderService) {}
}
`,
    };
    const io = memoryIo(files);
    const first = await syncProjectIndex("/proj", io);
    assert.equal(first.scanned, 2);
    assert.equal(first.parsed, 2);
    assert.ok(first.snapshot.meta.symbolCount >= 2);

    const hits = lookupSymbol(first.snapshot, "OrderService");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].pathRel, "src/order.service.ts");

    // Second sync: no content change → reuse
    const second = await syncProjectIndex("/proj", io);
    assert.equal(second.reused, 2);
    assert.equal(second.parsed, 0);

    // Change one file
    files["src/order.service.ts"] = `
export class OrderService {
  create() {}
  update() {}
}
`;
    const third = await syncProjectIndex("/proj", io);
    assert.equal(third.parsed, 1);
    assert.equal(third.reused, 1);
    assert.ok(lookupSymbol(third.snapshot, "update").length >= 1);
  });

  it("parses C# usings and ctor type refs for related/planner", () => {
    const src = `
using System;
using System.Threading;
using App.Contracts;
using Microsoft.Extensions.Logging;

namespace App.Handlers;
public class CreateOrderHandler
{
    private readonly IOrderRepository _repo;
    private readonly OrderDto _seed;
    public CreateOrderHandler(IOrderRepository repo, ILogger<CreateOrderHandler> log)
    {
        _repo = repo;
    }
    public Task Handle(CreateOrderCommand cmd, CancellationToken ct) => Task.CompletedTask;
}
`;
    const parsed = parseCsharpSource(
      "src/App/Handlers/CreateOrderHandler.cs",
      src
    );
    assert.ok(parsed);
    assert.ok(
      parsed!.imports.some((i) => i.from === "App.Contracts"),
      "keeps project using"
    );
    assert.ok(
      !parsed!.imports.some((i) => /^System\b/.test(i.from)),
      "skips System usings"
    );
    assert.ok(
      parsed!.imports.some((i) => i.from === "IOrderRepository"),
      "field/ctor type IOrderRepository"
    );
    assert.ok(
      parsed!.imports.some((i) => i.from === "OrderDto"),
      "field type OrderDto"
    );
    assert.ok(
      !parsed!.imports.some((i) => i.from === "ILogger"),
      "skips ILogger BCL-ish"
    );
  });

  it("resolves C# type import via symbolIndex to pathRel", () => {
    const known = new Set([
      "src/App/Handlers/CreateOrderHandler.cs",
      "src/App/Contracts/IOrderRepository.cs",
      "src/App/Dtos/OrderDto.cs",
    ]);
    const symbolIndex = {
      iorderrepository: ["src/App/Contracts/IOrderRepository.cs"],
      orderdto: ["src/App/Dtos/OrderDto.cs"],
      createorderhandler: ["src/App/Handlers/CreateOrderHandler.cs"],
    };
    assert.equal(
      resolveImportSpecifier(
        "src/App/Handlers/CreateOrderHandler.cs",
        "IOrderRepository",
        known,
        { symbolIndex }
      ),
      "src/App/Contracts/IOrderRepository.cs"
    );
  });

  it("buildDependencyGraph resolves C# types when symbolIndex provided", () => {
    const known = new Set([
      "src/App/Handlers/CreateOrderHandler.cs",
      "src/App/Contracts/IOrderRepository.cs",
    ]);
    const symbolIndex = {
      iorderrepository: ["src/App/Contracts/IOrderRepository.cs"],
    };
    const deps = buildDependencyGraph(
      {
        "src/App/Handlers/CreateOrderHandler.cs": [
          { from: "IOrderRepository", names: ["IOrderRepository"], line: 1 },
        ],
      },
      { knownFiles: known, symbolIndex }
    );
    assert.deepEqual(deps["src/App/Handlers/CreateOrderHandler.cs"], [
      "src/App/Contracts/IOrderRepository.cs",
    ]);
  });

  it("buildSymbolIndex and dependency graph", () => {
    const symbolsByFile = {
      "a.ts": [{ name: "Foo", kind: "class" as const, line: 1 }],
      "b.ts": [{ name: "Foo", kind: "interface" as const, line: 2 }],
    };
    const idx = buildSymbolIndex(symbolsByFile);
    assert.deepEqual(idx.foo, ["a.ts", "b.ts"]);

    const deps = buildDependencyGraph({
      "b.ts": [{ from: "./a", names: ["Foo"], line: 1 }],
    });
    assert.deepEqual(deps["b.ts"], ["./a"]);

    const known = new Set(["a.ts"]);
    assert.equal(resolveRelativeImport("b.ts", "./a", known), "a.ts");
  });
});
