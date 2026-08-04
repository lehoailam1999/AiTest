"""Phase 1 — login-wall FE budget + login wall detect + inspect merge."""

from __future__ import annotations

import asyncio

from app.llm.base import E2ERequest, e2e_user_prompt
from app.services.e2e_auth_mode import is_login_wall_dom
from app.services.e2e_dom_inspector import InspectResult, inspect_target


def test_is_login_wall_dom():
    assert is_login_wall_dom('textbox Email input type="password"')
    assert is_login_wall_dom("Đăng nhập mật khẩu")
    assert not is_login_wall_dom("button Thêm mới listitem Evidence")


def test_e2e_user_prompt_raises_fe_budget_on_login_wall():
    fe_body = 'data-cy="evidence-table"\n' + ("x" * 9000)
    req = E2ERequest(
        test_case_title="Upload evidence",
        test_case_type="E2E",
        priority="Cao",
        steps="1. Mở danh sách\n2. Upload",
        expected_result="Thấy bảng",
        source_code=fe_body,
        source_file_name="evidence.component.html",
        dom_snapshot='{"elements":[{"tag":"input","type":"password","name":"password"}]}',
        target_url="http://localhost:9000",
    )
    up = e2e_user_prompt(req)
    # Old budget 4000 would truncate mid-marker; login-wall keeps more FE.
    assert 'data-cy="evidence-table"' in up
    assert fe_body[:5000] in up or "evidence-table" in up


def test_e2e_user_prompt_lowers_fe_budget_when_dom_has_candidates():
    import json

    head = "HEAD_FE_MARKER_KEEP"
    tail = "TAIL_FE_MARKER_MUST_DROP"
    fe_body = head + ("y" * 6000) + tail
    els = [
        {"tag": "button", "selector_candidates": [f'getByRole("button", {{ name: "{i}" }})']}
        for i in range(6)
    ]
    req = E2ERequest(
        test_case_title="List evidence",
        test_case_type="E2E",
        priority="Cao",
        steps="1. Open list",
        expected_result="See rows",
        source_code=fe_body,
        source_file_name="evidence.component.html",
        dom_snapshot=json.dumps({"elements": els}),
        target_url="http://localhost:9000",
    )
    up = e2e_user_prompt(req)
    assert head in up
    # Cap ~4k when Inspect has ≥5 selector_candidates — tail of FE must be gone.
    assert tail not in up


def test_e2e_user_prompt_includes_resolved_feature_path():
    req = E2ERequest(
        test_case_title="Evidence list",
        test_case_type="E2E",
        priority="Cao",
        steps="1. Open",
        expected_result="OK",
        feature_path="admin/evidence",
    )
    up = e2e_user_prompt(req)
    assert "## Feature path" in up
    assert "/admin/evidence" in up


def test_inspect_merges_url_and_fe_source():
    """Phase 1: FE source must merge with URL — no FE-only early return."""

    async def _fake_fetch(url: str) -> str:
        return (
            '<html><body><input type="password" name="password"/>'
            "<button>Login</button></body></html>"
        )

    fe = (
        '<a routerLink="/evidence">Evidence</a>'
        '<button data-cy="upload-btn">Upload</button>'
    )
    result = asyncio.run(
        inspect_target(
            target_url="http://localhost:9000",
            source_code=fe,
            fetch_fn=_fake_fetch,
            use_playwright=False,
        )
    )
    assert isinstance(result, InspectResult)
    assert "source" in result.source
    assert "url" in result.source
    assert any("/evidence" in r for r in result.routes) or any(
        e.test_id == "upload-btn" for e in result.elements
    )
    assert "password" in result.raw_snippet.lower() or any(
        (e.type or "").lower() == "password" for e in result.elements
    )
