import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeIntent, extractFeaturePath, planFromTestCase } from "./index.js";
import type { PlannerTestCaseInput } from "./types.js";

/** Fixture corpus — KPI Phase 2: ≥90% correct Unit vs E2E. */
const FIXTURES: { tc: PlannerTestCaseInput; expect: "Unit" | "E2E" | "API" | "Integration" }[] = [
  {
    expect: "Unit",
    tc: {
      title: "CreateOrder validates inventory",
      type: "Unit",
      module: "Order",
      steps: "1. Mock InventoryService\n2. Call OrderService.create\n3. Assert stock decremented",
    },
  },
  {
    expect: "Unit",
    tc: {
      title: "PaymentService.charge returns receipt",
      type: "Functional",
      module: "Payment",
      steps: "Arrange SUT PaymentService; Act charge(); Assert receipt id",
    },
  },
  {
    expect: "E2E",
    tc: {
      title: "User creates order on checkout page",
      type: "E2E",
      module: "Order",
      testData: "path: /checkout",
      steps: "1. Navigate to checkout\n2. Click Place order\n3. See success toast",
    },
  },
  {
    expect: "E2E",
    tc: {
      title: "Đăng nhập admin",
      type: "E2E-Validation",
      steps: "Mở trang login, điền form, nhấn Đăng nhập",
      testData: "path: /login",
    },
  },
  {
    expect: "E2E",
    tc: {
      title: "Browse product list",
      type: "UI",
      steps: "Open page /products, click first item, locator visible",
      testData: "path: /products",
    },
  },
  {
    expect: "API",
    tc: {
      title: "POST /api/orders returns 201",
      type: "API",
      module: "Order",
      steps: "POST /api/orders with body; assert status code 201",
    },
  },
  {
    expect: "Integration",
    tc: {
      title: "Order flow across services",
      type: "Integration",
      module: "Order",
      steps: "Call Order API then Payment and Inventory integration",
    },
  },
  {
    expect: "Unit",
    tc: {
      title: "OrderService rejects empty cart",
      type: "",
      module: "Order",
      steps: "mock repository; assert throws ValidationError",
    },
  },
  {
    expect: "E2E",
    tc: {
      title: "Checkout happy path",
      type: "",
      testData: "path: /cart/checkout",
      steps: "fill address, click submit, see confirmation",
    },
  },
  {
    expect: "Unit",
    tc: {
      title: "Helper formats currency",
      type: "Unit",
      module: "Shared",
      steps: "Call formatMoney(1000); assert string",
    },
  },
];

describe("testPlanner Phase 2", () => {
  it("extractFeaturePath from testData", () => {
    assert.equal(
      extractFeaturePath({ testData: "path: /orders/new", title: "x" }),
      "/orders/new"
    );
  });

  it("extractFeaturePath accepts featurePath/route markers", () => {
    assert.equal(
      extractFeaturePath({ testData: "featurePath: /admin/evidence", title: "x" }),
      "/admin/evidence"
    );
    assert.equal(
      extractFeaturePath({ testData: "route: /portal/cases", title: "x" }),
      "/portal/cases"
    );
  });

  it("extractFeaturePath rejects Thiếu Context placeholder", () => {
    assert.equal(
      extractFeaturePath({ testData: "path: [Thiếu Context]", title: "x" }),
      undefined
    );
  });

  it("planFromTestCase returns roadmap shape", () => {
    const plan = planFromTestCase(
      {
        title: "Create order",
        type: "Unit",
        module: "Order",
        steps: "mock PaymentService; assert createOrder",
      },
      { requirement: { featureNames: ["Order", "Payment"], language: "TypeScript" } }
    );
    assert.equal(plan.testType, "Unit");
    assert.equal(plan.module, "Order");
    assert.ok(plan.action);
    assert.ok(plan.keywords.length >= 1);
    assert.ok(plan.hints.confidence && plan.hints.confidence > 0.5);
    assert.equal(plan.hints.framework, "jest");
  });

  it("forceTestType override", () => {
    const plan = planFromTestCase(
      { title: "X", type: "E2E", testData: "path: /a", steps: "click" },
      { forceTestType: "Unit" }
    );
    assert.equal(plan.testType, "Unit");
  });

  it("KPI ≥90% Unit vs E2E (and API/Integration) on fixture corpus", () => {
    let ok = 0;
    for (const row of FIXTURES) {
      const intent = analyzeIntent(row.tc);
      if (intent.testType === row.expect) ok++;
      else {
        console.error("mismatch", row.tc.title, "got", intent.testType, intent.reasons);
      }
    }
    const rate = ok / FIXTURES.length;
    assert.ok(
      rate >= 0.9,
      `expected ≥90% correct, got ${(rate * 100).toFixed(0)}% (${ok}/${FIXTURES.length})`
    );
  });
});
