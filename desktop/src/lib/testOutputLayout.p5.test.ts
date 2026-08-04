/**
 * P5 — package-aware AItest layout (any monorepo; no fixed project names).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeAitestTargetRel,
  buildRequirementTcModule,
  coerceAitestApplyPath,
  isFlatAitestTarget,
  rewriteSutImports,
  sutModuleSpecifier,
  underGeneratedTestFolder,
  uniquifyTestTargetRel,
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

  it("coerce collapses duplicated nested AItest/E2ETest path", () => {
    const out = coerceAitestApplyPath(
      "backend/AItest/E2ETest/To-do/tmp/AItest/E2ETest/Cap-nhat/fixtures/storageState.json",
      {
        kind: "e2e",
        module: "To-do",
        sourceFileName: "backend/src/todo/todo.service.ts",
        packagePrefix: "backend",
      }
    );
    assert.equal(out, "backend/AItest/E2ETest/Cap-nhat/fixtures/storageState.json");
  });

  it("Apply coerce PRESERVES uniquify + Requirement folder (never rebuild from basename)", () => {
    const staged =
      "backend/AItest/UnitTest/Todo-App-SRS/package-lock.1b899cf6.test.ts";
    const out = coerceAitestApplyPath(staged, {
      kind: "unit",
      // Intentionally wrong/missing module — Apply must not invent a new folder.
      module: null,
      sourceFileName: "backend/src/todos/todos.service.ts",
      packagePrefix: "backend",
      preserveLayout: true,
    });
    assert.equal(out, staged);
  });

  it("Apply coerce relocates package root but keeps AItest tail", () => {
    const out = coerceAitestApplyPath(
      "AItest/UnitTest/Req/foo.abc12345.test.ts",
      {
        kind: "unit",
        packagePrefix: "apps/api",
        preserveLayout: true,
      }
    );
    assert.equal(out, "apps/api/AItest/UnitTest/Req/foo.abc12345.test.ts");
  });

  it("Apply coerce with empty packagePrefix strips nested pkg prefix", () => {
    const out = coerceAitestApplyPath("backend/AItest/UnitTest/X/a.test.ts", {
      kind: "unit",
      packagePrefix: "",
      preserveLayout: true,
    });
    assert.equal(out, "AItest/UnitTest/X/a.test.ts");
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

  it("rewriteSutImports rewrites @/ alias to SUT", () => {
    const testRel = "web/AItest/UnitTest/Home/home.test.tsx";
    const src = "web/src/pages/home.tsx";
    const fixed = rewriteSutImports(
      "import Home from '@/pages/home';\n",
      { testRel, sourceRel: src }
    );
    assert.match(fixed, /from 'src\/pages\/home'/);
  });

  it("rewriteSutImports rewrites secondary relatives as if next to SUT", () => {
    const testRel = "AItest/UnitTest/Auth/auth.service.spec.ts";
    const src = "src/auth/auth.service.ts";
    const fixed = rewriteSutImports(
      [
        "import { AuthService } from './auth.service';",
        "import { CreateUserDto } from './dto/create-user.dto';",
        "import { UserEntity } from '../entities/user.entity';",
        "import { Injectable } from '@nestjs/common';",
      ].join("\n"),
      { testRel, sourceRel: src }
    );
    assert.match(fixed, /from 'src\/auth\/auth\.service'/);
    assert.match(fixed, /from 'src\/auth\/dto\/create-user\.dto'/);
    assert.match(fixed, /from 'src\/entities\/user\.entity'/);
    assert.match(fixed, /from '@nestjs\/common'/);
  });

  it("rewriteSutImports normalizes deep \.\./src paths", () => {
    const fixed = rewriteSutImports(
      "import { Todo } from '../../../../src/todos/entities/todo.entity';\n",
      {
        testRel: "AItest/UnitTest/Xem danh sách todo/todo.entity.test.ts",
        sourceRel: "src/todos/entities/todo.entity.ts",
      }
    );
    assert.match(fixed, /from 'src\/todos\/entities\/todo\.entity'/);
    assert.doesNotMatch(fixed, /\.\.\//);
  });

  it("uniquifyTestTargetRel keeps each TC on its own file", () => {
    const a = uniquifyTestTargetRel(
      "AItest/UnitTest/Todo/package-lock.test.ts",
      "1b899cf6-3353-4dcb-99f4-c86e09963c25"
    );
    const b = uniquifyTestTargetRel(
      "AItest/UnitTest/Todo/package-lock.test.ts",
      "33b5cf67-aaaa-bbbb-cccc-dddddddddddd"
    );
    assert.equal(a, "AItest/UnitTest/Todo/package-lock.1b899cf6.test.ts");
    assert.equal(b, "AItest/UnitTest/Todo/package-lock.33b5cf67.test.ts");
    assert.notEqual(a, b);
    assert.equal(
      uniquifyTestTargetRel(a, "1b899cf6-3353-4dcb-99f4-c86e09963c25"),
      a
    );
  });

  it("Unit output keeps Requirement parent only", () => {
    assert.equal(
      buildRequirementTcModule("Todo App SRS", "Lọc tất cả - Happy path", "FeatureX"),
      "Todo-App-SRS/Lọc-tất-cả-Happy-path"
    );
    assert.equal(buildRequirementTcModule("To do", "AC-00 PATCH", null), "To-do/AC-00-PATCH");
    const path = underGeneratedTestFolder("unit", "todos.service.test.ts", null, {
      requirementTitle: "Todo App SRS",
      testCaseTitle: "Lọc tất cả - Happy path",
      packagePrefix: "",
    });
    assert.equal(path, "AItest/UnitTest/Todo-App-SRS/todos.service.test.ts");
  });

  it("E2E shared root + module-as-req with TC", async () => {
    const {
      e2eSharedRoot,
      e2eModuleRoot,
      e2eStorageStateRel,
      buildRequirementTcModule: buildMod,
    } = await import("./testOutputLayout.js");
    assert.equal(e2eSharedRoot(), "AItest/E2ETest/_shared");
    assert.equal(e2eSharedRoot({ packagePrefix: "backend" }), "backend/AItest/E2ETest/_shared");
    assert.equal(
      buildMod(null, "Login OK", "Auth"),
      "Auth/Login-OK"
    );
    assert.equal(
      e2eModuleRoot("Auth", { requirementTitle: "Req", testCaseTitle: "TC1" }),
      "AItest/E2ETest/Req/TC1"
    );
    assert.equal(
      e2eStorageStateRel("Auth"),
      "AItest/E2ETest/_shared/fixtures/storageState.json"
    );
  });

});

describe("AItest Jest tsconfig scaffold", () => {
  it("avoids deprecated baseUrl and moduleResolution node", async () => {
    const { buildAitestJestTsconfig } = await import(
      "./unitWorkspace/ensureAitestJestTsconfig.js"
    );
    const raw = buildAitestJestTsconfig(["/tmp/node_modules/@types"]);
    const cfg = JSON.parse(raw) as {
      extends?: string;
      compilerOptions: Record<string, unknown>;
    };
    assert.equal(cfg.extends, undefined);
    assert.equal(cfg.compilerOptions.baseUrl, undefined);
    assert.equal(cfg.compilerOptions.moduleResolution, "bundler");
    assert.equal(cfg.compilerOptions.module, "commonjs");
    const paths = cfg.compilerOptions.paths as Record<string, string[]>;
    assert.deepEqual(paths["src/*"], ["../src/*"]);
    assert.deepEqual(paths["@/*"], ["../src/*"]);
  });
});
