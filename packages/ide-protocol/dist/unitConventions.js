/**
 * Shared Unit Gen conventions SoT — Desktop seeds `.ai-test/unit-conventions.md`;
 * Extension reads file or falls back to UNIT_CONVENTIONS_CORE.
 *
 * Gen-time only: IDE Repository Intelligence already locked an authoritative
 * decision before CLI runs. Do not describe Desktop `index.db` resolve here.
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
> This file is **Gen policy only**. Unit Approve / SUT resolve is owned by **IDE Repository Intelligence**;
> Gen must **consume** an immutable authoritative decision — never re-resolve.

## Ownership (who does what)

| Stage | Owner | AITest role |
| --- | --- | --- |
| Analyze + draft **Unit TCs** | API job + AI connection / AICLI | Trigger job, Review |
| Ground source + behavior | IDE Repository Intelligence during Approve | Read source/symbols and emit immutable decision |
| Persist projections | Desktop + API | Project the IDE decision to DB + \`AItest/test-cases\`; never re-resolve |
| Generate **unit test code** | IDE Extension → Cursor AI CLI | Packet + Desktop gate + Tool-internal draft |
| Repair failing unit test | Same Extension AI CLI | Pass repairContext; update Tool draft |
| Verify + Update | Desktop verifyEngine | Stage temporarily, restore source, then path-jailed Update to \`AItest/UnitTest/\` |

- Unit Gen is **consume-only**: it never searches for or replaces the primary SUT.
- Never invent BR / MaxLength / product APIs in Gen or Repair.

## Limits (quantified)

- Max related SUT files: **${UNIT_GEN_LIMITS.maxRelatedFiles}**
- Max excerpt / TC MD / conventions chars in prompt: **${UNIT_GEN_LIMITS.maxExcerptChars}**
- Gen timeout: **${UNIT_GEN_LIMITS.genTimeoutMs / 1000}s**
- Approved TC markdown required before Extension Gen (written on Approve)
- Gen requires an authoritative, hash-fresh companion \`.grounding.json\`; MD \`path:\` / \`code:\` are matching projections only.
- \`NOT_READY\`, \`FEATURE_GAP\`, stale hashes, incomplete bindings, and missing decisions are blocked before Cursor Gen.

## 0. Gen grounding (primary SUT already decided)

1. The authoritative companion \`.grounding.json\` is the source-grounding SoT. Do **not** search for, rerank, or invent another primary.
2. Approved TC MD = **scenario intent**. Map it to the **closest observable behavior** already in the SUT (+ related) excerpts (throw/BadRequest, duplicate check, permission deny, happy-path create, etc.).
3. **Prefer generate** when primary + related excerpts support the TC intent. Wizard/step/form wording in the TC title alone is **not** a refuse reason if the resolved Handler/Service (or related DTO/validator) has observable logic to exercise.
4. For \`primaryBucket: VALIDATION_DATA\`, Approve already verified required / MaxLength / duplicate evidence. Gen consumes that evidence exactly.
5. Missing production behavior is an Approve-time \`FEATURE_GAP\`; Cursor Gen is not invoked.
6. Behavior TCs (validate / reject): never invent anemic entity/POCO behavior; exercise the provided \`*Handler\` / \`*Service\` (or DTO when layerHint=dto).

## 1. Approved Test Case markdown (required)

- Gen **one TC → one unit test file**. Match the Sync MD artifact:
  - Path: \`AItest/test-cases/UnitTest/{module}/{testCaseId}.md\` (E2E → \`E2ETest/\`)
- Treat frontmatter + Grounding + Steps / Expected / Precondition / Test Data as **scenario intent**.
- Do **not** invent a different scenario. If the MD is missing, **fail** (Approve the TC first).

## 2. Unified output folder (path jail)

- Write **only** under:
  - \`${UNIT_LAYOUT_RULE}\`
- \`RequirementOrModule\` = Requirement title when known, else TC \`module\`, else \`General\`.
- \`TestFile\` = one test file for that TC (uniquified by compact TC id when \`suggestedPath\` is supplied).
- \`AItest/test-cases/**\` contains specifications only and must never be emitted, compiled, or run as test code.
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
- If packet and source excerpt disagree at Gen time, stop with a generation error; never resolve another SUT.

## 5. No invented production rules

- **Forbidden in the test file:** local \`Br*\` validator classes, hardcoded \`AllowedExtensions\` / mime lists, invented \`MAX_LENGTH = N\` + Length asserts, unless those symbols exist in the SUT excerpt.
- MaxLength / StringLength / allow-lists / BR rules must already exist in approved source evidence. If absent, Approve returns \`FEATURE_GAP\`.

## 6. Stack / extension match (fail-closed)

- File extension must match generated language:
  - \`.cs\` → C# (xUnit/NUnit) only — never Jest/Angular/TypeScript content
  - \`.ts\` / \`.tsx\` → TypeScript test runner only — never \`using\` / \`[Fact]\`
- Follow project profile framework hints. One coherent scenario = the Approved TC.

## 7. Output contract

- Return **one** unit test source in a **single** markdown code fence. No prose outside the fence.
- If the locked packet cannot be exercised faithfully, return no source and report a generation error; do not choose another SUT.
- Include Spec ID / TC code in a comment or test name when the framework allows.
- Prefer naming \`{Action}_{Condition}_{Expected}\` when it fits the stack.
- Structure Arrange / Act / Assert; mock dependencies for layer 8 scenarios.
- Keep generated tests **portable**: do not import private helper namespaces like \`*.Test.Common\` or custom constants like \`TestTrait\` unless those symbols are already part of the target AItest project.
`;
