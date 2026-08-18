/**
 * Fallback when SUT `.ai-test/e2e-conventions.md` is missing.
 */
export const EMBEDDED_E2E_CONVENTIONS = `
# E2E conventions (AITest — portable)

Approved TC = WHAT. FE source + locatorContract = HOW. Do not invent routes, roles, or locators.

## Write Spec (*.spec.ts)
- One test per TC. Each numbered TC step → test.step with the same text.
- Order: Auth (if required) → Feature entry (featurePath) → Act → Assert Expected.
- Never call POM methods that throw ungrounded errors.
- Each \`await test.step(...)\` must be on its own line. Never chain multiple steps on one line.
- Remove unnecessary blank lines between steps.
- If a UI field displays VN datetime like \`HH:mm dd/MM/yyyy\`, do not parse with \`new Date(raw)\`.
- Parse VN datetime manually and validate before assertion, e.g. split into time/date parts and build
  \`new Date(year, month - 1, day, hour, minute)\`.
- Before comparing parsed dates, assert \`expect(parsed.getTime()).not.toBeNaN()\`.

## Write POM (*.page.ts)
- Locators: data-cy / data-testid → getByLabel → getByRole.
- gotoFeature: page.goto(featurePath) only.
- Methods only for actions in TC steps.
- Reuse one shared page object per feature/module when possible. Do not duplicate the same page file under multiple TC folders.

## Auth
- Prefer storageState / ensureAuthenticated. Role only from TC / packet — never invent Admin.
- In generated specs, import shared auth helper instead of inlining ad-hoc login logic when auth is required.

## Output format (required)
For each file emit:

### FILE: AItest/E2ETest/.../path.ts
\`\`\`ts
// full file content
\`\`\`

Canonical layout:
- Spec: \`AItest/E2ETest/{Requirement}/{TC}/specs/{slug}.{TCCode}.spec.ts\`
  Example: \`AItest/E2ETest/ghi-nhan-vat-chung/xoa-trong-thoi-gian/specs/xoa-thoi-gian.TC103.spec.ts\`
- Config: \`AItest/E2ETest/{Requirement}/{TC}/playwright.config.ts\`
- Shared POM: \`AItest/E2ETest/{Requirement}/_shared/pages/*.page.ts\`
- Shared fixtures/types live under \`AItest/E2ETest/_shared/{fixtures|types}/...\`
- tsconfig: \`AItest/E2ETest/tsconfig.json\` (emit once if missing)
- Type shim: \`AItest/E2ETest/_shared/types/playwright-shim.d.ts\` (emit once if missing)

File naming rules (same convention as Unit tests):
- {TCCode} is the human-readable test case code (TC-103 → TC103), NOT a UUID hash.
- Spec file slug is derived from TC title, max 40 chars, kebab-case.
- Do NOT generate random hash suffixes — use TCCode for uniqueness.

At least one spec under \`.../specs/*.spec.ts\` and one page under \`.../_shared/pages/*.page.ts\` when the TC has UI steps.
Do not emit duplicate copies of the same spec/page/config with different hash suffixes for one TC run.
`.trim();
