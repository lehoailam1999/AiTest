import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodeIndexIo } from "../codeIndex/types.js";
import { syncProjectIndex } from "../codeIndex/incrementalSync.js";
import { buildIndexBackedContext } from "./buildFromRetrieve.js";
import type { TestCase } from "../../api/types.js";

function memoryIo(files: Record<string, string>): CodeIndexIo {
  return {
    listFiles: async () =>
      Object.keys(files).filter((p) => !p.includes(".ai-test/")),
    readFile: async (_r, p) => {
      if (!(p in files)) throw new Error(`missing ${p}`);
      return files[p];
    },
    writeFile: async (_r, p, c) => {
      files[p] = c;
    },
    readFileOptional: async (_r, p) => (p in files ? files[p] : null),
  };
}

function fakeTc(partial: Partial<TestCase> & { title: string; type: string }): TestCase {
  return {
    id: "tc-1",
    projectId: "p1",
    testCaseId: "TC-1",
    title: partial.title,
    type: partial.type,
    module: partial.module ?? "Order",
    priority: "P1",
    severity: "Major",
    precondition: partial.precondition ?? "",
    steps: partial.steps ?? "1. act",
    expectedResult: partial.expectedResult ?? "ok",
    testData: partial.testData ?? "",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "NotRun",
    createdAt: new Date().toISOString(),
  };
}

describe("contextBuilder Phase 4", () => {
  it("builds budgeted packet from index retrieve (Unit)", async () => {
    const files: Record<string, string> = {
      "src/order/order.service.ts": `
import { PaymentService } from "./payment.service";
export class OrderService {
  constructor(private pay: PaymentService) {}
  create() { return this.pay.charge(); }
}
`,
      "src/order/payment.service.ts": `
export class PaymentService { charge() { return 1; } }
`,
      "src/pages/CheckoutPage.tsx": `export function CheckoutPage() { return null; }`,
    };
    const io = memoryIo(files);
    await syncProjectIndex("/proj", io);
    const built = await buildIndexBackedContext({
      projectRoot: "/proj",
      testCase: fakeTc({
        title: "CreateOrder charges payment",
        type: "Unit",
        module: "Order",
        steps: "Mock PaymentService; Call OrderService.create; Assert",
        testData:
          "path: src/order/order.service.ts\ncode: OrderService",
      }),
      io,
      syncIfMissing: false,
      forceTestType: "Unit",
      language: "TypeScript",
      framework: "jest",
    });
    assert.equal(built.plan.testType, "Unit");
    assert.ok(built.packet.files.length >= 1);
    assert.ok(built.packet.files.length <= 10);
    assert.ok(built.packet.files[0].content.includes("OrderService") || built.packet.files.some((f) => f.content.includes("OrderService")));
    assert.ok(built.packet.unitStrategy?.forbidden?.length);
    assert.match(built.packet.diagnostics.seedReason || "", /implementation-plan|index-retrieve|business|deps/i);
    assert.ok(built.implementationPlan);
    assert.equal(built.implementationPlan?.status, "ready");
    assert.ok(
      built.packet.files.some((f) => f.pathRel.includes("payment")),
      "multi-layer dep PaymentService expected"
    );
  });

  it("builds e2eFe bundle for E2E plan", async () => {
    const files: Record<string, string> = {
      "src/pages/LoginPage.tsx": `
export function LoginPage() {
  return <form data-testid="login"><button>Login</button></form>;
}
`,
      "src/pages/HomePage.tsx": `export function HomePage() { return <div/> }`,
      "src/order/order.service.ts": `export class OrderService {}`,
    };
    const io = memoryIo(files);
    await syncProjectIndex("/proj", io);
    const built = await buildIndexBackedContext({
      projectRoot: "/proj",
      testCase: fakeTc({
        title: "Login",
        type: "E2E",
        module: "Auth",
        testData: "path: /login",
        steps: "Fill form; Click login",
      }),
      io,
      syncIfMissing: false,
      forceTestType: "E2E",
    });
    assert.equal(built.plan.testType, "E2E");
    assert.ok(built.e2eFe?.sourceCode);
    assert.match(built.e2eFe!.sourceFileName, /Login|login|Home|Page/i);
  });
});
