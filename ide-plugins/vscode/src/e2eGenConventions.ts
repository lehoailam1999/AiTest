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

## Write POM (*.page.ts)
- Locators: data-cy / data-testid → getByLabel → getByRole.
- gotoFeature: page.goto(featurePath) only.
- Methods only for actions in TC steps.

## Auth
- Prefer storageState / ensureAuthenticated. Role only from TC / packet — never invent Admin.

## Output format (required)
For each file emit:

### FILE: AItest/E2ETest/.../path.ts
\`\`\`ts
// full file content
\`\`\`

At least one spec under .../specs/*.spec.ts and one page under .../_shared/pages/*.page.ts when the TC has UI steps.
`.trim();
