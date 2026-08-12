/**
 * Portable core for `.ai-test/e2e-conventions.md` — injected into Cursor/IDE Gen.
 * No product nouns. Approved TC = WHAT; FE source + DOM = HOW.
 */
export const E2E_CONVENTIONS_CORE = `
# E2E conventions (AITest — portable)

## Split of duties
| Source | Role |
| --- | --- |
| Approved TC (MD / DB) | WHAT — title, steps, expected, precondition, testData, ruleRef |
| TC grounding markers | \`path:\` / \`featurePath:\`, \`authRole:\`, \`authRequired:\` |
| FE source (.ts/.html) | HOW — labels, data-cy, formControlName, create button, modal fields |
| Inspect DOM (optional) | HOW — live selectors when auth works |
| This file + profile | Layout, locator priority, auth strategy |

IDE / Cursor CLI must implement Spec+POM from **TC steps + FE source**. Do not invent routes, roles, or locators.

## Packet AITest pushes to Gen (do not ignore)
1. Approved TC fields (title, steps, expectedResult, precondition, testData)
2. \`featurePath\` / \`path\` (AbsolutePath ASCII)
3. \`executionContext\` / authRole when known
4. FE primary + related HTML/TS excerpts
5. \`locatorContract\` (testid/data-cy/label candidates from FE±DOM)
6. This conventions file excerpt (\`projectRules\`)
7. Optional: \`pomScaffold\` **only** when Inspect returned feature DOM — otherwise omit and derive methods from TC steps + FE only

## Write Spec (*.spec.ts)
- One \`test\` (or focused describe) per TC intent.
- **TC-literal steps:** each numbered TC step → one \`test.step('…')\` with the same text.
  Do not invent upload / select / submit / navigate steps the TC does not list.
- Order: Auth (if authRequired) → Feature entry (\`path\`) → \`openCreateModal\` when
  precondition says popup/dialog → Act steps → Assert Expected.
- Pass concrete labels/values from TC testData into POM — no empty \`selectOption()\`.
- Never call POM methods that throw \`Phase 3: ungrounded\` — that aborts Playwright
  mid-run (browser closes) before later steps. Implement from FE or omit.

## Write POM (*.page.ts)
- Locators: \`data-cy\` / \`data-testid\` → getByLabel → getByRole → formControlName (same as profile locatorPolicy).
- Sync getters return \`Locator\`; actions \`async\` return \`Promise<void>\`.
- \`gotoFeature\`: \`page.goto(featurePath)\` only. Opening create modal = separate method
  (\`openCreateModal\`) — click the FE create button from HTML (e.g. create-evidence), not sidebar guess.
- Methods **only** for actions in TC steps (tick checkbox → \`toggleCheckbox\` / getByLabel).
  Do **not** invent \`selectOption\` / \`submitForm\` / upload helpers unless the TC step says so.
- Assert Expected fields with getByLabel/role from FE — no \`main|h1\` shell asserts (R6).
- Forbidden: empty stubs that \`throw new Error('Phase 3…')\`; giant copied helpers; hardcoding another product's routes.

## Modal / wizard (common SPA)
- List AbsolutePath (e.g. \`/admin/…\`) is the navigable entry. Create UI is often NgbModal — URL may not change.
- Precondition "đã mở popup bước …" → Gen must: goto list → open create → then Act.
- Wizard steps: follow TC; Next only when step text requires it.

## Auth
- Prefer storageState / ensureAuthenticated from project auth strategy.
- Role only from TC / Auth Discover / profile — never invent Admin.

## Verify / Playwright run (SoT = profile JSON — not a separate MD)
Runtime Verify reads \`.ai-test/project.profile.json\` → \`playwrightRun\` only.
Do **not** maintain \`.ai-test/e2e-playwright-run.md\` for the engine (unused by Gen/CLI).

| Profile field | Meaning |
| --- | --- |
| \`playwrightRun.defaultBaseURL\` / \`baseURLEnv\` | App under test |
| \`playwrightRun.testIdAttribute\` | e.g. data-cy |
| \`playwrightRun.storageState.*\` | Auth artifact paths + discover dirs |
| \`playwrightRun.run.*\` | workers, timeoutMs (≥1000), headless, browser |
| \`playwrightRun.envAllowlist\` | Env keys injected for Spec/POM |

Flow: Approve TC → Gen (this conventions + TC + FE) → Verify (profile.playwrightRun + storageState).

## Forbidden
- Invent AbsolutePath from Vietnamese title slug
- Treat baseURL as path
- Gen against login wall DOM as if it were the feature
- Duplicate page/spec with hash suffixes when overwriting same TC
- Copy-paste locators from a previous SUT
`.trim();
