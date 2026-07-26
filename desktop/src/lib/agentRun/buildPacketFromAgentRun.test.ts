import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPacketFromAgentRun } from "./buildPacketFromAgentRun.ts";

describe("buildPacketFromAgentRun", () => {
  it("merges retrieved files into primary + dependency packet", async () => {
    const built = await buildPacketFromAgentRun({
      intent: {
        action: "Update",
        entity: "Evidence",
        expectedResults: ["Saved"],
        businessRules: [],
        validationRules: [],
        externalDeps: ["IEvidenceRepo"],
        domainTerms: [],
        searchHints: ["EvidenceService", "UpdateAsync"],
      },
      retrieved: [
        {
          path: "Services/EvidenceService.cs",
          role: "search-symbol",
          score: 0.9,
          snippet: "public class EvidenceService { public void Update() {} }",
          symbolIds: ["EvidenceService"],
        },
        {
          path: "Interfaces/IEvidenceRepo.cs",
          role: "search-symbol",
          score: 0.7,
          snippet: "public interface IEvidenceRepo {}",
        },
      ],
      confidence: {
        candidates: [
          {
            symbol: "EvidenceService",
            path: "Services/EvidenceService.cs",
            score: 0.9,
            rationale: "hit",
          },
        ],
        overall: 0.9,
        enough: true,
        missingHints: [],
      },
      testCase: {
        id: "11111111-1111-1111-1111-111111111111",
        module: "Forensic",
        title: "Cập nhật vật chứng",
      },
      projectId: "22222222-2222-2222-2222-222222222222",
      readFile: async (p) => `// disk ${p}`,
    });

    assert.equal(built.contextSource, "agent-ide");
    assert.equal(built.primaryPath, "Services/EvidenceService.cs");
    assert.equal(built.language, "C#");
    assert.equal(built.framework, "xunit");
    assert.ok(built.packet.files.some((f) => f.role === "primary"));
    assert.ok(built.packet.files.length >= 2);
    assert.ok(built.packet.unitStrategy?.whatToTest?.includes("Evidence"));
  });
});
