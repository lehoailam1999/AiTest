import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodeIndexSnapshot } from "../codeIndex/types.js";
import { planFromTestCase } from "../testPlanner/index.js";
import {
  clampTopK,
  isExcludedFromE2eRetrieve,
  isExcludedFromUnitRetrieve,
  isUnsuitableE2ePrimary,
  retrieveBusinessContext,
  retrieveE2eSources,
  retrieveForPlan,
  retrieveUnitSources,
} from "./index.js";

function sampleSnapshot(): CodeIndexSnapshot {
  const now = new Date().toISOString();
  return {
    meta: {
      schema: "aitest-code-index-v1",
      createdAt: now,
      updatedAt: now,
      fileCount: 5,
      symbolCount: 5,
      edgeCount: 2,
      parser: "test",
    },
    files: {
      "src/order/order.service.ts": {
        pathRel: "src/order/order.service.ts",
        language: "ts",
        contentHash: "a",
        byteSize: 100,
        symbolCount: 1,
        importCount: 1,
        indexedAt: now,
      },
      "src/order/payment.service.ts": {
        pathRel: "src/order/payment.service.ts",
        language: "ts",
        contentHash: "b",
        byteSize: 100,
        symbolCount: 1,
        importCount: 0,
        indexedAt: now,
      },
      "src/user/user.service.ts": {
        pathRel: "src/user/user.service.ts",
        language: "ts",
        contentHash: "c",
        byteSize: 100,
        symbolCount: 1,
        importCount: 0,
        indexedAt: now,
      },
      "src/pages/CheckoutPage.tsx": {
        pathRel: "src/pages/CheckoutPage.tsx",
        language: "tsx",
        contentHash: "d",
        byteSize: 200,
        symbolCount: 1,
        importCount: 0,
        indexedAt: now,
      },
      "src/pages/LoginPage.tsx": {
        pathRel: "src/pages/LoginPage.tsx",
        language: "tsx",
        contentHash: "e",
        byteSize: 150,
        symbolCount: 0,
        importCount: 0,
        indexedAt: now,
      },
    },
    symbolsByFile: {
      "src/order/order.service.ts": [
        { name: "OrderService", kind: "class", line: 1, exported: true },
      ],
      "src/order/payment.service.ts": [
        { name: "PaymentService", kind: "class", line: 1, exported: true },
      ],
      "src/user/user.service.ts": [
        { name: "UserService", kind: "class", line: 1, exported: true },
      ],
      "src/pages/CheckoutPage.tsx": [
        { name: "CheckoutPage", kind: "function", line: 1, exported: true },
      ],
      "src/pages/LoginPage.tsx": [],
    },
    importsByFile: {
      "src/order/order.service.ts": [
        { from: "./payment.service", names: ["PaymentService"], line: 1 },
      ],
      "src/order/payment.service.ts": [],
      "src/user/user.service.ts": [],
      "src/pages/CheckoutPage.tsx": [],
      "src/pages/LoginPage.tsx": [],
    },
    exportsByFile: {},
    symbolIndex: {
      orderservice: ["src/order/order.service.ts"],
      paymentservice: ["src/order/payment.service.ts"],
      userservice: ["src/user/user.service.ts"],
      checkoutpage: ["src/pages/CheckoutPage.tsx"],
    },
    dependencyGraph: {
      "src/order/order.service.ts": ["./payment.service"],
      "src/order/payment.service.ts": [],
      "src/user/user.service.ts": [],
      "src/pages/CheckoutPage.tsx": [],
      "src/pages/LoginPage.tsx": [],
    },
  };
}

describe("retrieval Phase 3", () => {
  it("clampTopK stays in 5–10", () => {
    assert.equal(clampTopK(3), 5);
    assert.equal(clampTopK(8), 8);
    assert.equal(clampTopK(99), 10);
  });

  it("UnitRetriever prefers Order/Payment over User and pages", () => {
    const snap = sampleSnapshot();
    const plan = planFromTestCase({
      title: "CreateOrder validates payment",
      type: "Unit",
      module: "Order",
      steps: "Mock PaymentService; Call OrderService.create; Assert",
    });
    const res = retrieveUnitSources(snap, plan, { topK: 5 });
    assert.ok(res.files.length >= 1 && res.files.length <= 10);
    assert.ok(res.primary);
    assert.ok(
      /order\.service|payment\.service/.test(res.primary!.pathRel),
      `primary should be order/payment related, got ${res.primary!.pathRel}`
    );
    const paths = res.files.map((f) => f.pathRel);
    assert.ok(paths.some((p) => p.includes("order.service")));
    assert.ok(paths.some((p) => p.includes("payment")));
    // UserService should rank lower than order/payment
    const orderIdx = paths.findIndex((p) => p.includes("order.service"));
    const userIdx = paths.findIndex((p) => p.includes("user.service"));
    if (userIdx >= 0 && orderIdx >= 0) assert.ok(orderIdx < userIdx);
  });

  it("E2eRetriever prefers Checkout page for path /checkout", () => {
    const snap = sampleSnapshot();
    const plan = planFromTestCase({
      title: "Checkout happy path",
      type: "E2E",
      module: "Order",
      testData: "path: /checkout",
      steps: "Click place order; see toast",
    });
    const res = retrieveE2eSources(snap, plan, { topK: 5 });
    assert.ok(res.primary);
    assert.match(res.primary!.pathRel, /CheckoutPage/);
    assert.ok(res.files.length <= 10);
  });

  it("E2eRetriever defers when only shape-bonus hits (no TC token overlap)", () => {
    const now = new Date().toISOString();
    const snap = sampleSnapshot();
    snap.files["src/app/admin/case-person/update/case-person-update.component.ts"] = {
      pathRel: "src/app/admin/case-person/update/case-person-update.component.ts",
      language: "ts",
      contentHash: "cp",
      byteSize: 100,
      symbolCount: 0,
      importCount: 0,
      indexedAt: now,
    };
    snap.files["src/app/admin/evidence/create/evidence-create.component.ts"] = {
      pathRel: "src/app/admin/evidence/create/evidence-create.component.ts",
      language: "ts",
      contentHash: "ev",
      byteSize: 100,
      symbolCount: 0,
      importCount: 0,
      indexedAt: now,
    };
    snap.symbolsByFile[
      "src/app/admin/case-person/update/case-person-update.component.ts"
    ] = [];
    snap.symbolsByFile[
      "src/app/admin/evidence/create/evidence-create.component.ts"
    ] = [];
    // Vietnamese title/module — no latin slug matching English FE folders
    const plan = planFromTestCase({
      title: "Tao moi vat chung - de trong ten",
      type: "E2E",
      module: "Vat chung",
      steps: "Mo form tao moi; de trong ten; assert bat buoc",
    });
    const res = retrieveE2eSources(snap, plan, { topK: 5 });
    assert.equal(res.primary, null);
    assert.equal(res.files.length, 0);
    assert.ok(res.notes.some((n) => /shape-only|legacy FE/i.test(n)));
  });

  it("BusinessRetriever is TC-first without Knowledge", () => {
    const plan = planFromTestCase({
      title: "X",
      type: "Unit",
      module: "Order",
      steps: "1. call create",
      expectedResult: "order created",
    });
    const biz = retrieveBusinessContext(plan, {
      steps: "1. call create",
      expectedResult: "order created",
    });
    assert.ok(biz.snippets.some((s) => s.kind === "fromTc"));
    assert.ok(biz.notes.some((n) => /TC-first|TC only/i.test(n)));
    assert.equal(
      biz.snippets.filter((s) => s.kind === "acceptance").length,
      0
    );
  });

  it("BusinessRetriever adds Knowledge only on keyword hit", () => {
    const plan = planFromTestCase({
      title: "Create order",
      type: "Unit",
      module: "Order",
      steps: "assert",
      expectedResult: "ok",
    });
    const biz = retrieveBusinessContext(
      plan,
      { expectedResult: "ok", steps: "assert" },
      {
        knowledge: {
          acceptanceCriteria: [
            { text: "Order must decrease inventory" },
            { text: "Unrelated shipping SLA forever" },
          ],
          businessRules: [{ id: "BR-1", text: "Payment required before Order" }],
        },
      }
    );
    assert.ok(biz.snippets.some((s) => s.kind === "fromTc"));
    assert.ok(
      biz.snippets.some(
        (s) => s.kind === "acceptance" && /inventory/i.test(s.text)
      )
    );
  });

  it("retrieveForPlan routes E2E vs Unit", () => {
    const snap = sampleSnapshot();
    const unit = retrieveForPlan(
      snap,
      planFromTestCase({
        title: "OrderService create",
        type: "Unit",
        module: "Order",
        steps: "mock assert OrderService",
      }),
      { steps: "mock", expectedResult: "ok" }
    );
    assert.match(unit.files.primary!.pathRel, /order/);

    const e2e = retrieveForPlan(
      snap,
      planFromTestCase({
        title: "Checkout",
        type: "E2E",
        testData: "path: /checkout",
        steps: "click",
      }),
      { steps: "click", expectedResult: "done", testData: "path: /checkout" }
    );
    assert.match(e2e.files.primary!.pathRel, /Checkout/);
    assert.ok(e2e.business.snippets.length >= 1);
  });

  it("excludes E2E page paths from Unit retrieve", () => {
    assert.equal(
      isExcludedFromUnitRetrieve("test/Forensic.E2E/support/pages/admin/evidence.page.ts"),
      true
    );
    assert.equal(
      isExcludedFromUnitRetrieve(
        "src/Forensic/ClientApp/src/app/entities/evidence/service/evidence.service.ts"
      ),
      false
    );
  });

  it("excludes generated AItest POM from E2E FE retrieve", () => {
    assert.equal(
      isExcludedFromE2eRetrieve("AItest/E2ETest/Evidence/TC1/pages/evidence.page.ts"),
      true
    );
    assert.equal(isUnsuitableE2ePrimary("AItest/E2ETest/_shared/pages/login.page.ts"), true);
    assert.equal(isExcludedFromE2eRetrieve("src/pages/CheckoutPage.tsx"), false);
  });

  it("excludes Playwright fixture / *.E2E trees from E2E FE retrieve (S1)", () => {
    assert.equal(
      isExcludedFromE2eRetrieve(
        "test/App.E2E/support/fixtures/auth.fixture.ts"
      ),
      true
    );
    assert.equal(
      isExcludedFromE2eRetrieve(
        "D:/Xlab/Demo/test/Demo.E2E/support/fixtures/auth.fixture.ts"
      ),
      true
    );
    assert.equal(isExcludedFromE2eRetrieve("src/app/auth/auth.fixture.ts"), true);
    assert.equal(
      isExcludedFromE2eRetrieve(
        "src/ClientApp/src/app/admin/orders/create/order-create.component.html"
      ),
      false
    );
    assert.equal(isUnsuitableE2ePrimary("test/App.E2E/support/fixtures/auth.fixture.ts"), true);
  });

  it("modulePathTokenBonus prefers path sharing module tokens (S1)", async () => {
    const { modulePathTokenBonus, extractDomainTokens, e2ePathBonus } = await import(
      "./rankScore.js"
    );
    const tokens = extractDomainTokens("Orders", "/admin/orders", "create order");
    assert.ok(tokens.includes("orders"));
    const ordersHtml =
      "src/app/admin/orders/create/order-create-modal.component.html";
    const otherHtml =
      "src/app/admin/customers/create/customer-create-dialog.component.html";
    assert.ok(modulePathTokenBonus(ordersHtml, tokens) > modulePathTokenBonus(otherHtml, tokens));
    assert.ok(e2ePathBonus("src/app/account/activate/activate.service.ts") < 0);
  });

  it("E2eRetriever ignores generated POM even if keywords match", () => {
    const snap = sampleSnapshot();
    snap.files["AItest/E2ETest/Checkout/pages/checkout.page.ts"] = {
      pathRel: "AItest/E2ETest/Checkout/pages/checkout.page.ts",
      language: "ts",
      contentHash: "pom",
      byteSize: 80,
      symbolCount: 1,
      importCount: 0,
      indexedAt: new Date().toISOString(),
    };
    snap.symbolsByFile["AItest/E2ETest/Checkout/pages/checkout.page.ts"] = [
      { name: "CheckoutPage", kind: "class", line: 1, exported: true },
    ];
    const plan = planFromTestCase({
      title: "Checkout",
      type: "E2E",
      testData: "path: /checkout",
      steps: "click checkout",
    });
    const hit = retrieveE2eSources(snap, plan);
    assert.ok(hit.primary);
    assert.match(hit.primary!.pathRel, /CheckoutPage/);
    assert.ok(!/aitest/i.test(hit.primary!.pathRel));
  });

  it("UnitRetriever never returns .page.ts as primary", () => {
    const snap = sampleSnapshot();
    snap.files["test/Forensic.E2E/support/pages/order.page.ts"] = {
      pathRel: "test/Forensic.E2E/support/pages/order.page.ts",
      language: "ts",
      contentHash: "z",
      byteSize: 50,
      symbolCount: 0,
      importCount: 0,
      indexedAt: new Date().toISOString(),
    };
    snap.symbolsByFile["test/Forensic.E2E/support/pages/order.page.ts"] = [
      { name: "OrderPage", kind: "class", line: 1 },
    ];
    snap.symbolIndex.orderpage = ["test/Forensic.E2E/support/pages/order.page.ts"];
    const plan = planFromTestCase({
      title: "CreateOrder",
      type: "Unit",
      module: "Order",
      steps: "Call OrderService",
    });
    const res = retrieveUnitSources(snap, plan, { topK: 5 });
    assert.ok(res.files.every((f) => !f.pathRel.includes(".page.ts")));
    assert.ok(res.files.every((f) => !/e2e/i.test(f.pathRel)));
  });
});
