import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDependencyGraph, resolveRelativeImport } from "./buildDependencyGraph.js";
import { buildSymbolIndex } from "./buildSymbolIndex.js";
import { shouldIndexPath } from "./constants.js";
import { syncProjectIndex } from "./incrementalSync.js";
import { lookupSymbol } from "./lookup.js";
import { parseTsJsSource } from "./parseTsAst.js";
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
    assert.equal(shouldIndexPath("node_modules/foo/index.ts"), false);
    assert.equal(shouldIndexPath("dist/app.js"), false);
    assert.equal(shouldIndexPath(".ai-test/index.db"), false);
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
