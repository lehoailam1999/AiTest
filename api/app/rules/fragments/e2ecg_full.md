# E2ECG — E2E Code Generation (multi-project)

## Split of duties
- Analysis `executionContexts` + Approved TC → WHO (actor/role/authRequired) + WHAT.
- Source / DOM / Project Convention / auth_mode overlay → HOW (login mechanism only).
- NEVER default login, invent role, or hardcode credentials/accounts.

## I. Auth & Role Context (before any Playwright line)
1. AUTHENTICATION CONTEXT: Resolve authRequired from Analysis/TC. If true authenticate before Feature entry.
2. AUTHORIZATION / ROLE: Roles come ONLY from Analysis actors/executionContexts + TC precondition/testData.
3. LOGIN STRATEGY (HOW): From auth_mode overlay + project convention ONLY: storageState | ensureAuthenticated(UI) | Login-TC UI | PUBLIC.
4. SESSION REUSE: Prefer one valid storageState for the role; never re-login every step.
5. MULTI-ROLE / TRANSITION: >=2 actors in TC → separate contexts/storageStates or explicit role transition.
6. PERMISSION VERIFY: RBAC/forbidden → assert hidden|disabled|403|redirect per Expected.

## II. Implementation Mapping (TC intent → code via Source)
7. WORKFLOW (TC-literal): Every numbered TC step → one `test.step` with the **same wording**.
   Order = Auth (if authRequired) → Feature entry (`path`) → open create/modal **when
   precondition says popup/dialog** → Act steps → Assert Expected. Do not invent extra
   steps (upload/select/submit) that TC does not list. Step indexes continuous `0..N`.
   Phase 2 guard FAILS codegen if Auth/Entry/Act missing or reordered.
8. UI REVERSE: Routes/menus/forms from FE source; never invent routes.
9. ELEMENT DISCOVERY: Fields/buttons from DOM snapshot + FE attrs only.
10. LOCATOR RESOLUTION: `data-testid|data-cy` → label → role → #id|name|formControlName → placeholder → text last.
11. LOCATOR VALIDATION: locator getters sync; avoid Promise locators; avoid broken type imports.
12. ACTIONABILITY: wait visible/enabled; do not use brittle first-input selectors.
13. SYNC: `domcontentloaded` (never `networkidle`) + landmark assert.
14. ASSERTION: assert expected behavior after actions; no `expect(await expectX())`.
15. CONVENTION: `AItest/E2ETest/{Req}/{TC}` + `_shared`; reuse existing helpers first.
16. SELF-CHECK: no invented route/role/credential; **Act stubs click/fill or throw** —
   never `console.warn`+return (silent no-op hides missing locators); never bind
   `*Button` to `main|body`. Empty Act must fail-closed, not skip to a bogus assert.
17. NO DUPLICATE: one canonical page/spec/config path.
18. RUNNABLE: compile + import class exact + `new Page(page)`.
19. ACT/ARRANGE: ground in FE+DOM+Spec args; no app hardcode. Precondition popup →
   `openCreateModal` via `getByTestId('entityCreateButton')` / `#jh-create-entity` /
   Create|Add. Wizard Next = dialog button `Tiếp theo|Next|Continue` (not main|body).
   Spec passes expected text into `expect*` (R6); incomplete-step TCs assert Next
   `toBeDisabled`. Missing DOM/FE hook → Phase-3 ungrounded throw — never soft-skip.

## III. Definition of Ready (hard gate before writing/running tests)
20. REQUIRED CONTEXT: featurePath + role/authRef + landmark + expected outcome, else `ContextMissing`.
21. LOCATOR CONTRACT: prefer one FE/DOM hook; fallback via `.or(...)` not CSS comma-OR; no brittle nth-child.
22. BUSINESS PRECONDITION: assert correct route/feature/role before Act.
23. TEST DATA READY: use TC testData; do not invent `process.env.E2E_*`.
24. ASSERT STYLE: major action must have business assertion.
25. WAIT/RETRY: use Playwright auto-wait/expect, avoid blind sleep.
26. STANDARD ERRORS: `ContextMissing` | `PreconditionFailed` | `LocatorNotFound` | `BusinessAssertionFailed`.
27. DONE CRITERIA: at least one local pass with clear step/locator evidence.
28. EXECUTION GATE: run module-scoped verify command before mark done.

## IV. Portable across ANY project (hard)
29. PROJECT-AGNOSTIC: no hardcoded product names/routes/testids/credentials.
30. LAYOUT: keep standardized POM/spec under AItest tree.
31. FAIL CLOSED: missing feature hooks/context must fail fast (ungrounded).
32. STACK: Playwright TypeScript only; consistent locator priority.
33. RUNNABLE: Spec+POM compile; await POM expects; no production edits.

## Forbidden
Hardcode accounts, invent PUBLIC/routes/testids, skip Feature entry, modify app source,
duplicate POM/spec, use Promise/object as locator text, invent locators when inspect is empty.
