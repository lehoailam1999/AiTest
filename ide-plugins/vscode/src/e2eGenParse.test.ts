import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyE2eFileKind,
  jailE2eOutputPath,
  parseE2eFilesFromRaw,
  buildE2eAgentPrompt,
} from "./e2eGenParse.ts";

const specHint = "AItest/E2ETest/Req/TC-1/specs/login.spec.ts";

describe("e2eGenParse", () => {
  it("parses ### FILE fences and jails under E2ETest", () => {
    const raw = `
### FILE: specs/login.spec.ts
\`\`\`ts
import { test } from '@playwright/test';
test('x', async ({ page }) => {});
\`\`\`

### FILE: pages/login.page.ts
\`\`\`ts
export class LoginPage {}
\`\`\`
`;
    const files = parseE2eFilesFromRaw(raw, specHint);
    assert.equal(files.length, 2);
    assert.ok(files[0].path.includes("E2ETest"));
    assert.equal(files[0].kind, "spec");
    assert.equal(files[1].kind, "page");
    assert.match(files[1].path, /_shared\/pages/);
  });

  it("parses JSON files payload", () => {
    const raw = JSON.stringify({
      files: [
        {
          path: "AItest/E2ETest/R/T/specs/a.spec.ts",
          content: "test('a', () => {})",
          kind: "spec",
        },
      ],
    });
    const files = parseE2eFilesFromRaw(raw, specHint);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "AItest/E2ETest/R/T/specs/a.spec.ts");
  });

  it("remaps relative paths into E2ETest jail", () => {
    const p = jailE2eOutputPath("src/app.ts", specHint);
    assert.match(p, /E2ETest/);
    assert.doesNotMatch(p, /^src\//);
  });

  it("classifies spec vs page", () => {
    assert.equal(classifyE2eFileKind("AItest/E2ETest/x/specs/a.spec.ts"), "spec");
    assert.equal(classifyE2eFileKind("AItest/E2ETest/_shared/pages/a.page.ts"), "page");
  });
});

describe("buildE2eAgentPrompt", () => {
  it("includes featurePath and locatorContract", () => {
    const p = buildE2eAgentPrompt({
      suggestedSpecPath: specHint,
      conventions: "no invent routes",
      item: {
        testCaseId: "tc-1",
        title: "Login ok",
        locatorContract: "data-cy=login",
        featurePath: "/login",
        steps: "1. Open login",
      },
    });
    assert.match(p, /featurePath: \/login/);
    assert.match(p, /data-cy=login/);
    assert.match(p, /FILE:/);
  });
});
