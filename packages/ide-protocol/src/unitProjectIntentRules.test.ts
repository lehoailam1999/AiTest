/**
 * Project unit-intent-rules — portable schema (no product hardcode in core).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractUnitIntent } from "./unitIntentAliases.js";
import {
  applyProjectIntentRules,
  filterStrongBodyRulePatterns,
  hasStrongWriteBackSignal,
  parseUnitProjectIntentRules,
  resolveSutMapPin,
} from "./unitProjectIntentRules.js";
import { bodyRulePatternsForIntent, findBodyRuleHits } from "./unitBodyRuleScore.js";

describe("unitProjectIntentRules", () => {
  it("parses intents array", () => {
    const rules = parseUnitProjectIntentRules({
      intents: [
        {
          id: "auto_generate_code",
          whenTitleOrStepsMatch: "(?i)auto.?generat|empty.?code",
          requiredBodyPatterns: ["(?i)EntityCode|CODE_"],
          preferSutMapKey: "auto_generate_code",
          scopeAction: { backend: "allow", frontend: "FAIL_FEATURE_GAP" },
        },
      ],
    });
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "auto_generate_code");
  });

  it("auto_generate_code forces body-rule and preferSutMapKey", () => {
    const base = extractUnitIntent({
      title: "Create entity - empty code - auto generate",
      module: "Create entity",
      steps: "EntityCode empty",
      expectedResult: "auto generate",
    });
    const rules = parseUnitProjectIntentRules({
      intents: [
        {
          id: "auto_generate_code",
          whenTitleOrStepsMatch: "(?i)auto.?generat|empty.?code",
          requiredBodyPatterns: ["(?i)EntityCode|CODE_"],
          preferSutMapKey: "auto_generate_code",
        },
      ],
    });
    const applied = applyProjectIntentRules(base, rules, {
      title: "Create entity - empty code - auto generate",
      module: "Create entity",
      unitScope: "backend",
    });
    assert.ok(applied.matchedIds.includes("auto_generate_code"));
    assert.equal(applied.preferSutMapKey, "auto_generate_code");
    assert.equal(applied.intent.requiresBodyRule, true);
    assert.ok(
      applied.intent.rulePatterns.some((p) => /EntityCode|CODE_/i.test(p)),
      JSON.stringify(applied.intent.rulePatterns)
    );
  });

  it("Create/Add alone are weak body-rule patterns", () => {
    assert.deepEqual(filterStrongBodyRulePatterns(["Create", "Add", "EntityCode"]), [
      "EntityCode",
    ]);
    const intent = extractUnitIntent({
      title: "Create succeeds",
      module: "Create",
    });
    const pats = bodyRulePatternsForIntent(intent);
    assert.ok(!pats.some((p) => /^create$/i.test(p)));
    const hits = findBodyRuleHits(
      "public class FooCreateCommandHandler { Create(); Add(); }",
      ["Create", "Add"]
    );
    assert.equal(hits.length, 0);
  });

  it("resolveSutMapPin prefers intent key then module phrase", () => {
    const pin = resolveSutMapPin(
      {
        auto_generate_code: "src/App/Commands/Foo/FooCreateCommandHandler.cs",
        "Create entity": "src/App/Other.cs",
      },
      { preferSutMapKey: "auto_generate_code", module: "Create entity" }
    );
    assert.match(pin || "", /FooCreateCommandHandler/);
  });

  it("ui intent under backend scopeRefuse", () => {
    const base = extractUnitIntent({
      title: "Create master",
      module: "master data",
    });
    const applied = applyProjectIntentRules(
      base,
      [
        {
          id: "ui_master_create",
          whenTitleOrStepsMatch: "(?i)master",
          scopeAction: { backend: "FAIL_FEATURE_GAP", frontend: "allow" },
        },
      ],
      { title: "Create master", module: "master data", unitScope: "backend" }
    );
    assert.equal(applied.scopeRefuse, "FAIL_FEATURE_GAP");
  });

  it("P0.1: soft writeBack rejects generic throw/BadRequest/Create alone", () => {
    assert.equal(
      hasStrongWriteBackSignal({
        pathRel: "src/App/Commands/Foo/FooCreateCommandHandler.cs",
        ruleHits: ["throw", "BadRequest", "Create"],
        preferTokens: [],
      }),
      false
    );
    assert.equal(
      hasStrongWriteBackSignal({
        pathRel: "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
        ruleHits: ["throw", "BadRequest"],
        preferTokens: ["Widget"],
      }),
      true
    );
    assert.equal(
      hasStrongWriteBackSignal({
        pathRel: "src/App/Commands/Foo/FooCreateCommandHandler.cs",
        ruleHits: ["MaxFileSize"],
        preferTokens: [],
      }),
      true
    );
    assert.equal(
      hasStrongWriteBackSignal({
        pathRel: "src/Services/BarService.cs",
        ruleHits: ["Create"],
        hits: ["phrase:tạo mới widget"],
        preferTokens: [],
      }),
      true
    );
    assert.equal(
      hasStrongWriteBackSignal({
        pathRel: "src/App/Commands/Alpha/AlphaCreateCommandHandler.cs",
        ruleHits: [],
        hits: ["phrase:create", "techStem:Create", "prefer:Create"],
        preferTokens: ["Create", "item"],
      }),
      false
    );
  });

  it("duplicate_reject project overlay maps to validate_reject + body patterns", () => {
    const base = extractUnitIntent({
      title: "Create widget - duplicate code - reject",
      module: "Create widget",
      steps: "Input duplicate code",
      expectedResult: "BadRequest",
    });
    const applied = applyProjectIntentRules(
      base,
      [
        {
          id: "duplicate_reject",
          whenTitleOrStepsMatch: "(?i)duplicate|trùng",
          requiredBodyPatterns: ["(?i)CheckCode|Exists|BadRequest"],
          preferSutMapKey: "duplicate_reject",
        },
      ],
      {
        title: "Create widget - duplicate code - reject",
        module: "Create widget",
        unitScope: "backend",
      }
    );
    assert.ok(applied.matchedIds.includes("duplicate_reject"));
    assert.equal(applied.preferSutMapKey, "duplicate_reject");
    assert.ok(applied.intent.classes.includes("validate_reject"));
    assert.equal(applied.intent.requiresBodyRule, true);
    assert.ok(
      applied.intent.rulePatterns.some((p) => /CheckCode|Exists/i.test(p)),
      JSON.stringify(applied.intent.rulePatterns)
    );
  });
});
