/**
 * Portable layerHint / sourceSignal → DTO|Validator primary promote.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLayerHintPrimaryPromotion,
  findLayerHintPrimaryPath,
  parseUnitLayerHint,
  parseUnitSourceSignal,
  preferDtoValidatorForHints,
} from "./unitLayerHint.js";
import type { UnitIntent } from "./unitIntentAliases.js";

const emptyIntent = (): UnitIntent => ({
  classes: [],
  uiOnly: false,
  codePatterns: [],
  rulePatterns: [],
  featureTokens: [],
  classFeatureTokens: [],
  requiresBodyRule: false,
});

describe("unitLayerHint", () => {
  it("parses layerHint and sourceSignal Type.Member", () => {
    const td =
      "trace: VALIDATION/x\nlayerHint: dto\nsourceSignal: EvidenceDto.SeizureLocation Required";
    assert.equal(parseUnitLayerHint(td), "dto");
    const sig = parseUnitSourceSignal(td);
    assert.equal(sig?.typeName, "EvidenceDto");
    assert.equal(sig?.memberName, "SeizureLocation");
  });

  it("preferDtoValidatorForHints from layerHint without intent", () => {
    assert.equal(
      preferDtoValidatorForHints(emptyIntent(), "layerHint: validator"),
      true
    );
    assert.equal(
      preferDtoValidatorForHints(emptyIntent(), "layerHint: handler"),
      false
    );
  });

  it("promotes primary to DTO when layerHint+sourceSignal match index path", () => {
    const testData =
      "layerHint: dto\nsourceSignal: WidgetDto.Name Required";
    const allPaths = [
      "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      "src/App/Commands/Widget/WidgetCreateCommand.cs",
      "src/App/Commands/Widget/WidgetAssignCaseCommand.cs",
      "src/App/Dtos/WidgetDto.cs",
      "src/App/Dtos/OtherDto.cs",
    ];
    const hit = findLayerHintPrimaryPath({
      testData,
      entryPathRel: "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      allPaths,
      featureTokens: ["Widget", "Create"],
    });
    assert.equal(hit, "src/App/Dtos/WidgetDto.cs");

    const applied = applyLayerHintPrimaryPromotion({
      testData,
      primaryPath: "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      relatedPaths: [
        "src/App/Commands/Widget/WidgetCreateCommand.cs",
        "src/App/Commands/Widget/WidgetAssignCaseCommand.cs",
      ],
      allPaths,
      featureTokens: ["Widget"],
    });
    assert.equal(applied.promoted, true);
    assert.equal(applied.primaryPath, "src/App/Dtos/WidgetDto.cs");
    assert.ok(
      applied.relatedPaths.some((p) =>
        p.includes("WidgetCreateCommandHandler")
      ),
      JSON.stringify(applied.relatedPaths)
    );
  });

  it("does not promote when layerHint is handler", () => {
    const applied = applyLayerHintPrimaryPromotion({
      testData: "layerHint: handler",
      primaryPath: "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
      relatedPaths: [],
      allPaths: ["src/App/Dtos/WidgetDto.cs"],
      featureTokens: ["Widget"],
    });
    assert.equal(applied.promoted, false);
  });
});
