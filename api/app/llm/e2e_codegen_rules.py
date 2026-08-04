"""
E2ECG — E2E Code Generation Specification (System-tier).

Two pillars for multi-project Playwright codegen:
  I.  Execution Context Resolution (Rules 1–6) — WHO / auth / role / session
  II. Implementation Mapping (Rules 7–19) — HOW from Source + DOM + convention

Approved TC = *what* to test. Source/DOM/convention = *how*.
Analysis ``executionContexts`` + TC precondition/testData = business context.
Project Convention / auth_mode overlay = login *mechanism* only — never invent role.

Cursor: ``.cursor/rules/e2e-codegen.mdc`` — keep in sync.
Injected once via ``e2e_system_prompt`` — do NOT restate in user prompt essays.
"""

from __future__ import annotations

import re

# Compact Spec — fits with slim journey under ~9k system budget.
E2E_CODEGEN_SPEC = """\
# E2ECG — E2E Code Generation (multi-project)

## Split of duties
- Analysis `executionContexts` + Approved TC → WHO (actor/role/authRequired) + WHAT.
- Source / DOM / Project Convention / auth_mode overlay → HOW (login mechanism only).
- NEVER default login, invent role, or hardcode credentials/accounts.

## I. Auth & Role Context (before any Playwright line)
1. AUTHENTICATION CONTEXT: Resolve authRequired from Analysis/TC. If true → authenticate
   before Feature entry. If explicit PUBLIC only → no login artifacts. Missing →
   `[Thiếu Context]`; do NOT invent.
2. AUTHORIZATION / ROLE: Roles come ONLY from Analysis actors/executionContexts + TC
   precondition/testData — never infer RBAC from source. Map → `E2E_ROLE` /
   `E2E_<ROLE>_USERNAME|PASSWORD`. No role → single default env only.
3. LOGIN STRATEGY (HOW): From auth_mode overlay + project convention ONLY:
   storageState | ensureAuthenticated(UI) | Login-TC UI | PUBLIC.
   Learn locators/routes from Source/DOM — never hardcode accounts or invent /login path
   when FE uses another entry.
4. SESSION REUSE: Prefer one valid storageState for the role (batch of feature TCs).
   Else one visible step-0 ensureAuthenticated. Never point config at missing JSON;
   never soft-skip login wall; never re-login every step inside one test.
5. MULTI-ROLE / TRANSITION: ≥2 actors in TC → ≥2 contexts/storageStates or explicit
   logout→login between roles; assert outcomes per role (Rule 6).
6. PERMISSION VERIFY: RBAC/forbidden → assert hidden|disabled|403|redirect per Expected —
   login alone is not enough.

## II. Implementation Mapping (TC intent → code via Source)
7. WORKFLOW: Map every numbered TC Step → `test.step`; order = Auth → Feature entry →
   Arrange → Act → Assert. Step indexes MUST be continuous `0..N` (never restart at 1
   after Arrange). Guard renumbers after Auth/Feature inject. Phase 2 guard FAILS
   codegen if Auth/Entry/Act missing or reordered.
8. UI REVERSE: Routes/menus/forms from FE source (routerLink, Routes, templates) —
   never invent `/admin/...`.
9. ELEMENT DISCOVERY: Fields/buttons from DOM snapshot + FE attrs only.
10. LOCATOR RESOLUTION: priority data-cy|data-testid → #id → name|formControlName →
    getByLabel/Placeholder → getByRole+visible name → getByText last.
11. LOCATOR VALIDATION: Sync getters `get*|find*|locate*` return Locator (not Promise);
    `readonly foo: Locator` init in constructor; scope duplicates;
    native `<select>` → selectOption({label|value: string}) — NEVER RegExp label.
    Path/fixture helpers (`*Path`/`*Fixture`/`ensure*File`) MUST be sync `(): string` —
    NEVER `async (): Promise<string>` (Playwright setInputFiles/getByText coerce Promise →
    "[object Promise]" / TypeError path).
    Imports: `import { Foo, type Bar }` or `import type { Bar }` — NEVER orphan
    `import { Foo, type }` (breaks tsc/Playwright).
12. ACTIONABILITY: Wait visible/enabled before click/fill; open dialog/tab if fields
    live there (list vs form). NEVER `locator('input:not([type=hidden]), textarea').first()`
    — use FE-proven label/role/testid (file/checkbox are often first and break fill).
13. SYNC: goto waitUntil `domcontentloaded` (never networkidle); landmark after entry.
14. ASSERTION: Expected on feature UI; Validation → disable/error not happy-submit.
    POM expect*/assert* = Promise<void> → Spec `await pom.expectX(...)` ONLY.
    NEVER expect(await pom.expectX()).toBeVisible · getByText(pom.expectX)/Promise →
    "[object Promise]" · String(object) → "[object Object]" (unpack string fields; skip
    fixture paths). toBeVisible only on real Locators.
15. CONVENTION: AItest/E2ETest/{Req}/{TC}/specs + config; POM/auth/shim under
    AItest/E2ETest/_shared/; reuse existing _shared/pages/*.page.ts when present.
16. SELF-CHECK: no invented route/role/credential · DOM/FE locators · no empty POM stubs ·
    no expect(await expect*) · Rules 18–19.
17. NO DUPLICATE: one path per page/spec/config; overwrite same path — no hash twins.
18. RUNNABLE: test(/describe; *.spec.ts+*.page.ts; import ExactClass = export class;
    `new ExactClass(page)` never static; Spec+POM one shot; one canonical spec; FE labels.
19. ACT/ARRANGE (all projects): ground in this FE+DOM/Spec args — no app hardcode.
    Prefer E2E_FEATURE_PATH deep-link (gotoFeature ≠ auto-Create); menu no-op if
    shell/dialog visible; Create via openCreate* + modal before fill; fill/select/
    open*Combobox via getByRole|Label|testid from DOM/FE; wizard Next from Spec/DOM.
    Spec passes values; unpack object asserts. Guard heal = safety net only.
    Missing DOM/FE hook → Phase-3 ungrounded (E2E_GROUNDING fail-closed) — never
    invent `button.first()` / Save-regex click.

## Forbidden
Hardcode accounts · invent PUBLIC/routes/testids · skip Feature entry · modify app source ·
duplicate/static POM · expect(await pom.expect*) · Promise/String(object) into getByText ·
invent locators when Inspect empty · input.first() fill · missing storage JSON.
"""


_ROLE_HINT_RE = re.compile(
    r"(?i)\b(?:role|actor|authRole|auth_role|vai\s*trò|quyền)\s*[:=]\s*([^\n;,|]+)"
)
_AUTH_REQ_RE = re.compile(
    r"(?i)(?:authRequired|auth_required|cần\s*đăng\s*nhập)\s*[:=]\s*(true|false|yes|no|1|0)"
)
_EXEC_LINE_RE = re.compile(
    r"(?i)^\s*(?:exec(?:ution)?(?:Context)?|context)\s*[:=]\s*(.+)$",
    re.MULTILINE,
)


def e2ecg_system_block() -> str:
    from app.llm.e2e_grounding_rules import e2e_grounding_system_pointer

    return E2E_CODEGEN_SPEC.strip() + "\n" + e2e_grounding_system_pointer()


def derive_execution_context_block(
    *,
    title: str = "",
    precondition: str = "",
    test_data: str = "",
    steps: str = "",
    execution_context: str = "",
) -> str:
    """
    User-prompt data block: surface resolved hints from TC / optional Analysis snippet.
    Does not invent roles — only echoes explicit signals.
    """
    explicit = (execution_context or "").strip()
    blob = f"{precondition}\n{test_data}\n{steps}\n{title}"
    roles = [m.group(1).strip() for m in _ROLE_HINT_RE.finditer(blob) if m.group(1).strip()]
    auth_m = _AUTH_REQ_RE.search(blob)
    auth_req = auth_m.group(1).lower() if auth_m else ""
    exec_lines = [m.group(1).strip() for m in _EXEC_LINE_RE.finditer(test_data or "")]
    lines = [
        "## Execution Context / Auth+Role (resolve BEFORE codegen — Rules 1–6)",
        "Sources: Analysis executionContexts + actors + this TC (WHO only). "
        "auth_mode / Source / DOM = login mechanism (HOW) only — never invent role.",
    ]
    if explicit:
        lines.append(f"Provided context:\n{explicit}")
    if exec_lines:
        lines.append("From testData exec/context: " + " | ".join(exec_lines[:4]))
    if roles:
        # de-dupe preserve order
        seen: set[str] = set()
        uniq: list[str] = []
        for r in roles:
            k = r.lower()
            if k in seen:
                continue
            seen.add(k)
            uniq.append(r)
        lines.append("Roles/actors signaled: " + ", ".join(uniq[:6]))
        if len(uniq) >= 2:
            lines.append("MULTI-ROLE: use separate context/storageState per role (Rule 4).")
    if auth_req in ("false", "no", "0"):
        lines.append("authRequired=false signaled — PUBLIC only if explicit; verify Rule 2.")
    elif auth_req in ("true", "yes", "1"):
        lines.append("authRequired=true — authenticate before Feature entry.")
    if not explicit and not roles and not exec_lines and not auth_req:
        lines.append(
            "No explicit Execution Context on TC — infer ONLY from clear precondition "
            "(đã đăng nhập / PUBLIC / Login TC). Else comment `[Thiếu Context]` — do not invent role."
        )
    lines.append(
        "Credential source: E2E_* / E2E_<ROLE>_* env — never hardcode username/password."
    )
    return "\n".join(lines) + "\n"
