#!/usr/bin/env python3
"""Dry-run TC-138 end-to-end: generate guards → staging → verify preflight."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# repo roots
AITEST = Path(__file__).resolve().parents[1]
FORENSIC = Path("D:/Xlab/Forensic/forensic")
TC_ID = "2a938f4b-cb75-4ad5-a996-d603586ce614"
TC_CODE = "TC-138"

sys.path.insert(0, str(AITEST))

from app.llm.base import E2EFile  # noqa: E402
from app.services.e2e_codegen_guard import apply_e2e_codegen_guards  # noqa: E402
from app.services.e2e_orchestrator import (  # noqa: E402
    _ensure_auth_env_from_project,
    e2e_verify_preflight_notes,
)


def collect(regex: str, blob: str) -> list[str]:
    return list(dict.fromkeys(m.group(1) for m in re.finditer(regex, blob, re.I)))


def build_locator_contract(fe_blob: str, feature_path: str = "/admin/evidence") -> str:
    data_cy = collect(r'data-cy\s*=\s*["\'`]([^"\'`]+)["\'`]', fe_blob)
    data_tid = collect(r'data-testid\s*=\s*["\'`]([^"\'`]+)["\'`]', fe_blob)
    ids = collect(r'\sid\s*=\s*["\'`]([^"\'`]+)["\'`]', fe_blob)
    names = collect(r'\sname\s*=\s*["\'`]([^"\'`]+)["\'`]', fe_blob)
    fcn = collect(r'formControlName\s*=\s*["\'`]([^"\'`]+)["\'`]', fe_blob)
    lines = [
        f"data-cy: {', '.join(data_cy) or '(none)'}",
        f"data-testid: {', '.join(data_tid) or '(none)'}",
        f"id: {', '.join(ids) or '(none)'}",
        f"name: {', '.join(names) or '(none)'}",
        f"formControlName: {', '.join(fcn) or '(none)'}",
        f"routes: {feature_path}",
    ]
    return "\n".join(lines)


def tc138_sample_files() -> list[E2EFile]:
    """Minimal codegen shape that previously failed on name=caseRecords."""
    slug = "Gán-vật-chứng-Để-trống-hồ-sơ-vụ-án-2a938f4b"
    req = "Create-evidence"
    base = f"AItest/E2ETest/{req}/{slug}"
    page = E2EFile(
        path=f"AItest/E2ETest/_shared/pages/evidence-case-record-required.page.ts",
        kind="page",
        content=(
            "import type { Page } from '@playwright/test';\n"
            "export class EvidenceCaseRecordRequiredPage {\n"
            "  constructor(public page: Page) {}\n"
            "  caseRecords = this.page.locator('[name=\"caseRecords\"]');\n"
            "  async clickNextStep() {\n"
            "    await this.page.getByRole('button', { name: /Bước 2|Tiếp/i }).click();\n"
            "  }\n"
            "  async expectRequiredError() {\n"
            "    await this.page.locator('#field_caseRecords').locator('..').getByText(/không được để trống/i).waitFor();\n"
            "  }\n"
            "}\n"
        ),
    )
    spec = E2EFile(
        path=f"{base}/specs/evidence-case-record-required.spec.ts",
        kind="spec",
        content=(
            "import { test, expect } from '@playwright/test';\n"
            "import { ensureAuthenticated } from '../../../_shared/fixtures/auth.helper';\n"
            "import { EvidenceCaseRecordRequiredPage } from '../../../_shared/pages/evidence-case-record-required.page';\n"
            "test('TC-138 required case record', async ({ page }) => {\n"
            "  await ensureAuthenticated(page);\n"
            "  await page.goto('/admin/evidence');\n"
            "  await page.getByRole('button', { name: /Tạo mới|Create/i }).click();\n"
            "  const pom = new EvidenceCaseRecordRequiredPage(page);\n"
            "  await pom.clickNextStep();\n"
            "  await pom.expectRequiredError();\n"
            "});\n"
        ),
    )
    cfg = E2EFile(
        path=f"{base}/playwright.config.ts",
        kind="config",
        content=(
            "import { defineConfig } from '@playwright/test';\n"
            "export default defineConfig({\n"
            "  testDir: './specs',\n"
            "  use: { baseURL: process.env.E2E_BASE_URL || 'http://localhost:4200' },\n"
            "});\n"
        ),
    )
    auth = E2EFile(
        path="AItest/E2ETest/_shared/fixtures/auth.helper.ts",
        kind="fixture",
        content=(
            "import type { Page } from '@playwright/test';\n"
            "export async function ensureAuthenticated(page: Page) {\n"
            "  // ui_helper path\n"
            "  await page.goto('/');\n"
            "}\n"
        ),
    )
    return [page, spec, cfg, auth]


def check(name: str, ok: bool, detail: str = "") -> dict:
    return {"step": name, "ok": ok, "detail": detail}


def main() -> int:
    results: list[dict] = []
    ws = FORENSIC / ".ai-test"
    tc_md = ws / "test-cases" / "E2ETest" / "Gán-vật-chứng-vào-hồ-sơ-vụ-án" / f"{TC_CODE}.md"
    profile_path = ws / "project.profile.json"
    auth_dir = ws / "auth"
    staging_root = ws / "staging"

    # 0 — TC artifact
    results.append(check("TC-138 markdown", tc_md.is_file(), str(tc_md)))

    # 1 — FE source for contract
    fe_html = FORENSIC / "src/Forensic/ClientApp/src/app/admin/evidence/create/evidence-create-modal.component.html"
    fe_ts = FORENSIC / "src/Forensic/ClientApp/src/app/admin/evidence/create/evidence-create-modal.component.ts"
    fe_blob = ""
    if fe_html.is_file():
        fe_blob += fe_html.read_text(encoding="utf-8", errors="replace")
    if fe_ts.is_file():
        fe_blob += "\n" + fe_ts.read_text(encoding="utf-8", errors="replace")
    contract = build_locator_contract(fe_blob)
    has_case_records = "caseRecords" in contract and "field_caseRecords" in contract
    results.append(check("FE hooks (caseRecords)", has_case_records, contract[:400]))

    # 2 — Generate guards (locator contract)
    files = tc138_sample_files()
    guard_err = ""
    guard_ok = True
    try:
        apply_e2e_codegen_guards(
            files,
            locator_contract=contract,
            test_case_title=TC_CODE + " required case record",
            auth_hints="authRequired: true\npath: /admin/evidence",
            enforce_journey=True,
            enforce_stubs=True,
            dom_snapshot="",
            use_storage=False,
        )
    except Exception as e:  # noqa: BLE001
        guard_ok = False
        guard_err = str(e)
    results.append(check("Generate guards (name=caseRecords bridge)", guard_ok, guard_err or "passed"))

    # 3 — Staging overlay for TC-138
    tc_staging: list[str] = []
    if staging_root.is_dir():
        for m in staging_root.glob("*/manifest.e2e.json"):
            try:
                data = json.loads(m.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            if data.get("testCaseId") == TC_ID:
                tc_staging.append(m.parent.name)
    overlay_has_tc138 = any(
        (staging_root / run / "overlay").exists()
        and list((staging_root / run / "overlay").rglob("*case-record*"))
        for run in tc_staging
    )
    results.append(
        check(
            "Staging overlay TC-138",
            overlay_has_tc138,
            f"runs={tc_staging or '(none)'}; case-record files={'yes' if overlay_has_tc138 else 'no'}",
        )
    )

    # 4 — Auth / profile preflight
    profile = json.loads(profile_path.read_text(encoding="utf-8")) if profile_path.is_file() else {}
    auth_strategy = (profile.get("auth") or {}).get("strategy", "?")
    auth_seeds = list(auth_dir.glob("*.json")) if auth_dir.is_dir() else []
    storage_states = [
        p
        for p in auth_seeds
        if "cookies" in p.read_text(encoding="utf-8", errors="replace")
    ]
    has_creds = any(
        "username" in p.read_text(encoding="utf-8", errors="replace") for p in auth_seeds
    )
    auth_ok = bool(storage_states) or (auth_strategy == "uiLogin" and has_creds)
    results.append(
        check(
            "Auth ready for verify",
            auth_ok,
            f"strategy={auth_strategy}; storageStateCookies={len(storage_states)}; credSeeds={len(auth_seeds)}",
        )
    )

    # 5 — Verify preflight (API)
    pkg_root = (profile.get("playwrightRun") or {}).get("packageRoot", "")
    preflight = e2e_verify_preflight_notes(
        target_url=(profile.get("playwrightRun") or {}).get("defaultBaseURL", ""),
        storage_state_rel="",
        env_extra={"E2E_USERNAME": "admin", "E2E_PASSWORD": "admin"},
    )
    pw_pkg = Path(pkg_root) / "package.json"
    results.append(
        check(
            "Playwright packageRoot",
            pw_pkg.is_file(),
            str(pw_pkg),
        )
    )
    preflight_warn = "WARN:" in (preflight or "")
    results.append(
        check(
            "Verify preflight notes",
            not preflight_warn,
            preflight or "clean",
        )
    )

    # 6 — On-disk AItest/E2ETest TC-138 tree
    e2e_tc = FORENSIC / "AItest" / "E2ETest"
    tc_specs = list(e2e_tc.rglob("*2a938f4b*")) + list(e2e_tc.rglob("*case-record*"))
    results.append(
        check(
            "Published E2E files on disk",
            len(tc_specs) > 0,
            ", ".join(str(p.relative_to(FORENSIC)) for p in tc_specs[:5]) or "(none)",
        )
    )

    # 7 — Auth env parity (Desktop playwrightEnvFromConfig / API _ensure_auth_env)
    env_probe: dict[str, str] = {
        "E2E_BASE_URL": "http://localhost:4200",
        "E2E_USERNAME": "admin",
        "E2E_PASSWORD": "admin",
    }
    _ensure_auth_env_from_project(str(FORENSIC), env_probe)
    force_ui = env_probe.get("E2E_FORCE_UI_LOGIN") == "1"
    results.append(
        check(
            "Auth env injection (E2E_FORCE_UI_LOGIN)",
            force_ui,
            f"E2E_FORCE_UI_LOGIN={env_probe.get('E2E_FORCE_UI_LOGIN', '(unset)')}",
        )
    )

    print("=== TC-138 dry-run checklist ===\n")
    blockers: list[str] = []
    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        print(f"[{mark}] {r['step']}")
        if r["detail"]:
            print(f"       {r['detail'][:800]}")
        if not r["ok"]:
            blockers.append(r["step"])

    print()
    if blockers:
        print("BOTTLENECK(s):", " -> ".join(blockers))
        return 1
    print("All checklist steps passed — re-run Generate+Verify in Desktop should proceed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
