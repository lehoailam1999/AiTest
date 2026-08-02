"""E2E codegen prompt — locator grounding + step mapping."""

from __future__ import annotations

import json

from app.llm.base import (
    E2ERequest,
    _compact_dom_for_e2e_prompt,
    _e2e_steps_checklist,
    e2e_system_prompt,
    e2e_user_prompt,
)


def test_compact_dom_keeps_selector_candidates():
    dom = json.dumps(
        {
            "targetUrl": "http://x",
            "source": "url",
            "routes": ["/"],
            "elements": [
                {
                    "tag": "input",
                    "role": "textbox",
                    "name": "Email",
                    "placeholder": "Email",
                    "selector_candidates": [
                        'getByRole("textbox", { name: "Email" })',
                        '[data-testid="email"]',
                    ],
                }
            ],
        }
    )
    out = _compact_dom_for_e2e_prompt(dom)
    assert "selector_candidates" in out
    assert "getByRole" in out
    assert "locatorHint" in out


def test_steps_checklist_numbers_and_mentions_test_step():
    chk = _e2e_steps_checklist("Mo form\nNhap title", "Hien title moi", "title=abc")
    assert "1. Mo form" in chk
    assert "2. Nhap title" in chk
    assert "test.step" in chk
    assert "Hien title moi" in chk


def test_e2e_system_prompt_has_locator_and_step_rules():
    sys_p = e2e_system_prompt()
    assert "E2ECG" in sys_p
    assert "LOCATOR" in sys_p or "data-cy" in sys_p
    assert "SELECT" in sys_p or "selectOption" in sys_p or "Implementation Mapping" in sys_p
    assert "Feature journey" in sys_p or "FEATURE ENTRY" in sys_p or "Feature entry" in sys_p
    assert "Anti-patterns" in sys_p or "invent" in sys_p.lower()
    assert len(sys_p) < 9000  # E2ECG + slim journey; still bounded
    # No legacy locator essay / host path duplicate of E2ECG 15.
    assert "LOCATOR (HTML-first)" not in sys_p
    assert sys_p.count("domcontentloaded") <= 2  # E2ECG + optional thin host
    heal = e2e_system_prompt(heal=True)
    assert "E2ECG" in heal
    assert "selectOption" in heal or "LOCATOR" in heal or "data-cy" in heal
    assert "Feature journey" in heal or "FEATURE ENTRY" in heal
    assert "AUTH" in heal or "storageState" in heal or "ensureAuthenticated" in heal
    assert "domcontentloaded" in heal or "networkidle" in heal
    slim_auth = e2e_system_prompt(has_storage_state=True)
    assert "storageState" in slim_auth
    assert "AUTH overlay" in slim_auth
    assert "{Req}" in sys_p or "Requirement" in sys_p or "E2ETest" in sys_p


def test_e2e_user_prompt_includes_journey_checklist():
    req = E2ERequest(
        test_case_title="Boundary max 255 — Không chấp nhận",
        test_case_type="E2E-Boundary",
        priority="P1",
        steps="1. Mo form\n2. Nhap 256 ky tu",
        expected_result="Khong chap nhan",
        precondition="Da dang nhap; vao /admin/evidence",
        target_url="http://localhost:9000",
    )
    up = e2e_user_prompt(req)
    assert "Feature entry checklist" in up or "Feature entry" in up
    assert "VALIDATION" in up or "BOUNDARY" in up or "Validation" in up
    assert "Auth resolved" in up
    # No long auth-strategy essay (lives in E2ECG + AUTH overlay).
    assert "Auth strategy (no storageState yet)" not in up
    assert up.count("ensureAuthenticated") <= 2


def test_e2e_user_prompt_grounds_dom_and_steps():
    dom = json.dumps(
        {
            "elements": [
                {
                    "tag": "button",
                    "name": "Lưu",
                    "selector_candidates": ['getByRole("button", { name: "Lưu" })'],
                }
            ]
        }
    )
    req = E2ERequest(
        test_case_title="Cap nhat title",
        test_case_type="E2E",
        priority="Cao",
        steps="1. Click Luu",
        expected_result="OK",
        test_data="title=x",
        dom_snapshot=dom,
        source_code='data-testid="todo-item"',
    )
    up = e2e_user_prompt(req)
    assert "GROUND TRUTH" in up
    assert "selector_candidates" in up
    assert "Step → code mapping" in up
    assert "data-testid" in up
