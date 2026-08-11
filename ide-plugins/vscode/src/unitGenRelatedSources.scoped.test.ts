/**
 * Scoped family accept — Gen recovery without full allowDiskReresolve.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptScopedFamilyPrimary } from "./unitGenRelatedSources.js";

describe("acceptScopedFamilyPrimary", () => {
  it("accepts same Evidence family + Compartment op hit", () => {
    assert.equal(
      acceptScopedFamilyPrimary({
        candidatePath:
          "src/App/Commands/Evidence/EvidenceAssignCompartmentCommandHandler.cs",
        familyAnchors: [
          "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
        ],
        opTokens: ["Compartment", "Storage"],
      }),
      true
    );
  });

  it("rejects AssignCase when op tokens require Compartment", () => {
    assert.equal(
      acceptScopedFamilyPrimary({
        candidatePath:
          "src/App/Commands/Evidence/EvidenceAssignCaseCommandHandler.cs",
        familyAnchors: [
          "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
        ],
        opTokens: ["Compartment", "Storage"],
      }),
      false
    );
  });

  it("rejects cross-family Account when anchor is Evidence", () => {
    assert.equal(
      acceptScopedFamilyPrimary({
        candidatePath: "src/App/Commands/Account/AccountCreateCommandHandler.cs",
        familyAnchors: [
          "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
        ],
        opTokens: [],
      }),
      false
    );
  });
});
