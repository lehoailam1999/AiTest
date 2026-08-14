/**
 * Shared Unit Gen conventions SoT — Desktop seeds `.ai-test/unit-conventions.md`;
 * Extension reads file or falls back to UNIT_CONVENTIONS_CORE.
 *
 * Gen-time only: do NOT paste Approve pipeline / shortlist / FAIL_UNGATED here —
 * Desktop already gated + resolved primary SUT before CLI runs.
 */
/** Quantified limits (architecture invariants). */
export const UNIT_GEN_LIMITS = {
    maxRelatedFiles: 4,
    maxExcerptChars: 8000,
    maxTcMdChars: 8000,
    maxConventionsChars: 8000,
    genTimeoutMs: 240_000,
    transportRetryMax: 1,
};
export const UNIT_LAYOUT_RULE = "[{packagePrefix}/]AItest/UnitTest/{RequirementOrModule}/{TestFile}";
/** Preferred production layers for Unit SUT (rank + Gen). */
export const UNIT_LOGIC_LAYERS = [
    "Business Logic — rules, conditions, calculations, workflow",
    "Service / Use Case — primary feature orchestration",
    "Validation — input, format, boundary, invalid data",
    "Domain Logic — entity, state transition, domain rule",
    "Utility / Helper — pure function, formatter, calculator, mapper",
    "Permission / Authorization — role, permission, access condition",
    "Error Handling — exception, fallback, failure branch",
    "Dependency Behavior — mock ports; assert how logic reacts to success/fail",
];
export const UNIT_CONVENTIONS_CORE = `# Unit test conventions (AITest)

> SoT for Extension Gen + Desktop Gen. Lives on the **target repo** at \`.ai-test/unit-conventions.md\`.
> AITest orchestrates Approve/resolve; this file is **Gen policy only**.

## Ownership (who does what)

| Stage | Owner | AITest role |
| --- | --- | --- |
| Analyze + draft **Unit TCs** | API job + AI connection / AICLI | Trigger job, Review, Approve |
| Ground \`path:\` / \`code:\` | Desktop Approve sync (\`index.db\`) | Write markers + TC MD |
| Generate **unit test code** | IDE Extension → Cursor AI CLI | Packet + Desktop gate + collect staging |
| Repair failing unit test | Same Extension AI CLI | Pass repairContext |
| Verify + Apply | Desktop verifyEngine | Scaffold, overlay, path jail \`AItest/\` |

- Extension does **not** fuzzy re-resolve SUT when Desktop packet + markers exist (\`unit.allowDiskReresolve\` default **false**).
- Never invent BR / MaxLength / product APIs in Gen or Repair.

## Limits (quantified)

- Max related SUT files: **${UNIT_GEN_LIMITS.maxRelatedFiles}**
- Max excerpt / TC MD / conventions chars in prompt: **${UNIT_GEN_LIMITS.maxExcerptChars}**
- Gen timeout: **${UNIT_GEN_LIMITS.genTimeoutMs / 1000}s**
- Approved TC markdown required before Extension Gen (written on Approve)
- Gen requires Test Data \`path:\` + \`code:\` — unresolved → Desktop blocks with FAIL_NEEDS_MARKER (no CLI)

## 0. Gen grounding (primary SUT already decided)

1. Primary SUT in the packet / Test Data \`path:\` + \`code:\` is **authoritative**. Do **not** re-resolve against \`index.db\`, pick another Handler, or invent a different primary.
2. Approved TC MD = **scenario intent**. Map it to the **closest observable behavior** already in the SUT (+ related) excerpts (throw/BadRequest, duplicate check, permission deny, happy-path create, etc.).
3. **Prefer generate** when a primary SUT excerpt is provided. Wizard/step/form wording in the TC title alone is **not** a refuse reason if the resolved Handler/Service has related logic to exercise.
4. Use \`FAIL_FEATURE_GAP\` / \`FAIL_SUT_MISMATCH\` **only** when excerpts contain **no** API/branch that can support any faithful assert for this TC — do not invent BR/MaxLength/stage machines absent from excerpts.
5. Behavior TCs (validate / reject): never invent anemic entity/POCO behavior; exercise the provided \`*Handler\` / \`*Service\`.

## 1. Approved Test Case markdown (required)

- Gen **one TC → one unit test file**. Match the Sync MD artifact:
  - Path: \`.ai-test/test-cases/{module}/{testCaseId}.md\`
- Treat frontmatter + Grounding + Steps / Expected / Precondition / Test Data as **scenario intent**.
- Do **not** invent a different scenario. If the MD is missing, **fail** (Approve the TC first).

## 2. Unified output folder (path jail)

- Write **only** under:
  - \`${UNIT_LAYOUT_RULE}\`
- \`RequirementOrModule\` = Requirement title when known, else TC \`module\`, else \`General\`.
- \`TestFile\` = one test file for that TC (uniquified by TC id short hash when \`suggestedPath\` is supplied).
- **Forbidden:** \`src/\`, \`app/\`, \`__tests__/\`, \`test/\`, next to production files, or \`AItest/src/...\`.

## 3. Unit scope = logic layers only (SUT allow-list)

Unit tests target **production logic**, not UI shells or HTTP clients. Prefer SUT in these layers:

1. **Business Logic** — rules, conditions, calculations, workflow
2. **Service / Use Case** — primary feature handling
3. **Validation** — input, format, boundary, invalid data
4. **Domain Logic** — entity, state transition, domain rule
5. **Utility / Helper** — function, formatter, calculator, mapper
6. **Permission / Authorization** — role, permission, access condition
7. **Error Handling** — exception, fallback, failure case
8. **Dependency Behavior** — mock repository / external service; assert success vs fail handling

**Preferred path / symbol shapes:** \`*Handler\`, \`*Service\`, \`*UseCase\`, \`*Validator\`, \`*Policy\`, \`*Command\`, \`*Query\` (app layer), domain entity/value-object, pure helpers under \`domain/\` \`application/\` \`services/\`.

**Do NOT switch primary away from the packet SUT to:**
- FE / SPA trees: \`ClientApp/\`, \`client-app/\`, Angular/React \`components/\` \`pages/\` \`*.component.ts\`
- Thin HTTP upload/chunk clients when the TC is about BR / domain rules
- Controllers that only forward when the rule lives in the service/handler already provided
- Existing tests under \`test/\`, \`*.Test/\`, \`*Test.cs\`, Integration suites
- Process entrypoints (\`main.ts\`, \`Program.cs\`, \`wsgi.py\`, Nest \`bootstrap\`)

\`path:\` must be **repo-relative** (never absolute). \`code:\` must be the **type/symbol** — not a kebab filename stem.

## 4. Exercise the provided SUT (fail-closed on invent)

- Import / exercise the primary SUT named in the prompt and markers.
- Mock **ports** at lower tiers; do not invent BR/MaxLength outside excerpts.
- Assertions must match **actual** APIs / attributes / constants in the SUT (+ related) excerpts.
- Domain mismatch with the packet SUT → \`FAIL_DOMAIN_GUARD\` (Desktop usually gates first).
- Unified refuse codes (empty fence + one line) — only when generation is impossible without invention:
  \`FAIL_NEEDS_MARKER\` | \`FAIL_DOMAIN_GUARD\` | \`FAIL_FEATURE_GAP\` | \`FAIL_SUT_MISMATCH\`.

## 5. No invented production rules

- **Forbidden in the test file:** local \`Br*\` validator classes, hardcoded \`AllowedExtensions\` / mime lists, invented \`MAX_LENGTH = N\` + Length asserts, unless those symbols exist in the SUT excerpt.
- MaxLength / StringLength / allow-lists / BR rules must be **read from production code**. If absent from SUT, fail or skip that assertion — do not invent.

## 6. Stack / extension match (fail-closed)

- File extension must match generated language:
  - \`.cs\` → C# (xUnit/NUnit) only — never Jest/Angular/TypeScript content
  - \`.ts\` / \`.tsx\` → TypeScript test runner only — never \`using\` / \`[Fact]\`
- Follow project profile framework hints. One coherent scenario = the Approved TC.

## 7. Output contract

- Return **one** unit test source in a **single** markdown code fence. No prose outside the fence.
- Refuse protocol: empty fence + single line refuse code only:
  \`FAIL_NEEDS_MARKER\` | \`FAIL_DOMAIN_GUARD\` | \`FAIL_FEATURE_GAP\` | \`FAIL_SUT_MISMATCH\`.
- Include Spec ID / TC code in a comment or test name when the framework allows.
- Prefer naming \`{Action}_{Condition}_{Expected}\` when it fits the stack.
- Structure Arrange / Act / Assert; mock dependencies for layer 8 scenarios.
`;
