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
    assert "LOCATOR" in sys_p
    assert "test.step" in sys_p or "Map numbered" in sys_p
    assert len(sys_p) < 3500  # slim vs legacy wall-of-text
    heal = e2e_system_prompt(heal=True)
    assert "LOCATOR" in heal
    slim_auth = e2e_system_prompt(has_storage_state=True)
    assert "storageState present" in slim_auth
    assert "ensureAuthenticated" not in slim_auth or "AUTH: storageState" in slim_auth


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
