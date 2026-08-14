/**
 * Shared Unit Gen conventions SoT — Desktop seeds `.ai-test/unit-conventions.md`;
 * Extension reads file or falls back to UNIT_CONVENTIONS_CORE.
 *
 * Gen-time only: do NOT paste Approve pipeline / shortlist / FAIL_UNGATED here —
 * Desktop already gated + resolved primary SUT before CLI runs.
 */
/** Quantified limits (architecture invariants). */
export declare const UNIT_GEN_LIMITS: {
    readonly maxRelatedFiles: 4;
    readonly maxExcerptChars: 8000;
    readonly maxTcMdChars: 8000;
    readonly maxConventionsChars: 8000;
    readonly genTimeoutMs: 240000;
    readonly transportRetryMax: 1;
};
export declare const UNIT_LAYOUT_RULE = "[{packagePrefix}/]AItest/UnitTest/{RequirementOrModule}/{TestFile}";
/** Preferred production layers for Unit SUT (rank + Gen). */
export declare const UNIT_LOGIC_LAYERS: readonly ["Business Logic — rules, conditions, calculations, workflow", "Service / Use Case — primary feature orchestration", "Validation — input, format, boundary, invalid data", "Domain Logic — entity, state transition, domain rule", "Utility / Helper — pure function, formatter, calculator, mapper", "Permission / Authorization — role, permission, access condition", "Error Handling — exception, fallback, failure branch", "Dependency Behavior — mock ports; assert how logic reacts to success/fail"];
export declare const UNIT_CONVENTIONS_CORE: string;
