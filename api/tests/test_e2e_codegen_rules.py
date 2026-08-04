"""E2ECG — E2E codegen Execution Context + Implementation Mapping."""

from __future__ import annotations

from app.llm.base import E2ERequest, e2e_system_prompt, e2e_user_prompt
from app.llm.e2e_codegen_rules import (
    E2E_CODEGEN_SPEC,
    derive_execution_context_block,
    e2ecg_system_block,
)


def test_e2ecg_covers_both_pillars():
    text = E2E_CODEGEN_SPEC
    assert "Auth & Role" in text or "Execution Context" in text
    assert "Implementation Mapping" in text
    for n in range(1, 20):
        assert f"{n}." in text or str(n) in text
    assert "ACT/ARRANGE" in text
    assert "ungrounded" in text.lower()
    assert "NO DUPLICATE" in text or "duplicate" in text.lower()
    assert "RUNNABLE" in text
    assert "expect(await" in text.lower() or "NEVER" in text
    assert "Promise<void>" in text or "void" in text.lower()
    assert "NEVER default login" in text or "never invent role" in text.lower() or "NEVER" in text
    assert "storageState" in text
    assert "LOCATOR" in text or "data-cy" in text


def test_system_prompt_injects_e2ecg_once():
    p = e2e_system_prompt(auth_mode="ui_helper")
    assert "# E2ECG" in p
    assert p.count("# E2ECG") == 1
    assert "Feature journey" in p or "FEATURE ENTRY" in p or "Feature entry" in p
    assert "AUTH overlay" in p
    assert "LOCATOR (HTML-first)" not in p  # moved into E2ECG — no duplicate essay
    assert len(p) < 9000


def test_derive_execution_context_multi_role():
    block = derive_execution_context_block(
        title="RBAC",
        precondition="role: Admin; role: Staff",
        test_data="authRole: Admin\nexec: dual-role approve",
        steps="1. Admin duyệt",
    )
    assert "MULTI-ROLE" in block
    assert "Admin" in block
    assert "E2E_*" in block or "E2E_" in block


def test_user_prompt_includes_execution_context_block():
    req = E2ERequest(
        test_case_title="Phân quyền Staff",
        test_case_type="E2E",
        priority="Cao",
        steps="1. Mở màn",
        expected_result="Không có nút Duyệt",
        precondition="role: Staff; đã đăng nhập",
        test_data="authRole: Staff",
        execution_context="actor=Staff; authRequired=true",
    )
    up = e2e_user_prompt(req)
    assert "Execution Context" in up
    assert "Staff" in up
    assert e2ecg_system_block()[:20] not in up  # Spec stays in system, not user
    assert "Auth resolved" in up
    assert "Auth strategy (no storageState yet)" not in up


def test_system_prompt_thinner_than_legacy_auth_essay():
    """ui_helper overlay is short; discovery detail lives in E2ECG once."""
    p = e2e_system_prompt(auth_mode="ui_helper")
    assert "AUTH overlay: ui_helper" in p
    assert "E2E_LOGIN_PATH + common routes" not in p
    assert "# E2ECG" in p
