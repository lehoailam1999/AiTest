/**
 * P5 — package-aware AItest layout (any monorepo; no fixed project names).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeAitestTargetRel,
  coerceAitestApplyPath,
  isFlatAitestTarget,
  rewriteSutImports,
  sutModuleSpecifier,
  underGeneratedTestFolder,
} from "./testOutputLayout.js";

describe("P5 AItest path jail", () => {
  it("accepts AItest at apply root (single-package repo)", () => {
    const p = "AItest/UnitTest/Order/foo.test.ts";
    assert.equal(assertSafeAitestTargetRel(p), p);
    assert.equal(isFlatAitestTarget(p), true);
  });

  it("accepts {pkg}/AItest for nested packages", () => {
    const p = "svc-api/AItest/UnitTest/Todo/x.test.ts";
    assert.equal(assertSafeAitestTargetRel(p), p);
  });

  it("rejects .. and production mirror under AItest", () => {
    assert.throws(() => assertSafeAitestTargetRel("AItest/../secrets.txt"));
    assert.throws(() => assertSafeAitestTargetRel("src/Order/OrderTests.cs"));
    assert.throws(() =>
      assertSafeAitestTargetRel("AItest/UnitTest/WebSpa/src/app/x.test.ts")
    );
  });

  it("coerce rewrites bare root AItest into package AItest when source is nested", () => {
    const out = coerceAitestApplyPath("AItest/UnitTest/Todo/todos.service.test.ts", {
      kind: "unit",
      module: "Todo",
      sourceFileName: "svc-api/src/todos/todos.service.ts",
      packagePrefix: "svc-api",
    });
    assert.equal(out, "svc-api/AItest/UnitTest/Todo/todos.service.test.ts");
  });

  it("coerce keeps single-package root AItest for src/", () => {
    const out = coerceAitestApplyPath("src/Order/Services/OrderServiceTests.cs", {
      kind: "unit",
      module: "Order",
      sourceFileName: "src/Order/Services/OrderService.cs",
    });
    assert.equal(out, "AItest/UnitTest/Order/OrderServiceTests.cs");
  });

  it("underGeneratedTestFolder nests under any src package", () => {
    const path = underGeneratedTestFolder("unit", "home.test.tsx", null, {
      module: "Home",
      sourceFileName: "web-app/src/pages/home.tsx",
    });
    assert.equal(path, "web-app/AItest/UnitTest/Home/home.test.tsx");
  });

  it("rewriteSutImports prefers src/ baseUrl path", () => {
    const testRel = "svc-api/AItest/UnitTest/Todo/todos.service.test.ts";
    const src = "svc-api/src/todos/todos.service.ts";
    assert.equal(sutModuleSpecifier(testRel, src), "src/todos/todos.service");
    const fixed = rewriteSutImports(
      "import { TodosService } from '../../../src/todos/todos.service';\n",
      { testRel, sourceRel: src }
    );
    assert.match(fixed, /from 'src\/todos\/todos\.service'/);
    assert.doesNotMatch(fixed, /\.\.\/\.\.\/\.\.\/src/);
  });
});
