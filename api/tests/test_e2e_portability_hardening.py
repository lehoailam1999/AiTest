"""Tests for E2E DoR annotate + invented env guard (Rule 23)."""

from __future__ import annotations

import pytest

from app.llm.base import E2EFile
from app.llm.base import TestCaseDraft as TcDraft
from app.services.e2e_codegen_guard import (
    E2EStrictGateError,
    _rewrite_or_assert_e2e_env_usage,
)
from app.services.e2e_tc_dor_annotate import annotate_e2e_tc_drafts


def test_annotate_flags_missing_path():
    drafts = [
        TcDraft(
            title="Tạo phòng kho",
            type="E2E",
            steps="1. Kiểm tra màn hình",
            expected_result="OK",
            test_data="authRole: admin",
        )
    ]
    out = annotate_e2e_tc_drafts(drafts)
    assert "[Thiếu Context]" in (out[0].test_data or "")
    assert "path:" in (out[0].test_data or "").lower() or "thiếu path" in (
        out[0].test_data or ""
    ).lower()


def test_annotate_skips_login():
    drafts = [
        TcDraft(
            title="Đăng nhập admin",
            type="E2E",
            steps="Nhập user",
            expected_result="Dashboard",
            test_data="",
        )
    ]
    out = annotate_e2e_tc_drafts(drafts)
    assert "[Thiếu Context]" not in (out[0].test_data or "")


def test_annotate_ok_with_path_and_action():
    drafts = [
        TcDraft(
            title="Tạo phòng",
            type="E2E",
            steps="1. Nhấn nút Tạo mới\n2. Điền tên phòng A",
            expected_result="Phòng hiện trong list",
            test_data="path: /storage/rooms\nauthRole: admin",
        )
    ]
    out = annotate_e2e_tc_drafts(drafts)
    assert "[Thiếu Context]" not in (out[0].test_data or "")


def test_annotate_flags_missing_auth_role_post_login():
    drafts = [
        TcDraft(
            title="Tạo phòng",
            type="E2E",
            steps="1. Nhấn nút Tạo mới",
            expected_result="OK",
            test_data="path: /storage/rooms",
            precondition="Đã đăng nhập",
        )
    ]
    out = annotate_e2e_tc_drafts(drafts)
    assert "[Thiếu Context]" in (out[0].test_data or "")
    assert "authrole" in (out[0].test_data or "").lower()


def test_annotate_rejects_vn_slug_as_usable_path():
    drafts = [
        TcDraft(
            title="Tạo phòng",
            type="E2E",
            steps="1. Nhấn nút Tạo mới",
            expected_result="OK",
            test_data="path: /tạo-mới-vật-chứng\nauthRole: admin",
        )
    ]
    out = annotate_e2e_tc_drafts(drafts)
    assert "[Thiếu Context]" in (out[0].test_data or "")


def test_invented_e2e_env_raises_context_missing():
    files = [
        E2EFile(
            path="AItest/E2ETest/M/TC/specs/x.spec.ts",
            kind="spec",
            content=(
                "import { test } from '@playwright/test';\n"
                "test('x', async () => {\n"
                "  const room = process.env.E2E_STORAGE_ROOM_NAME;\n"
                "  if (!room) throw new Error('ContextMissing');\n"
                "});\n"
            ),
        )
    ]
    with pytest.raises(E2EStrictGateError) as ei:
        _rewrite_or_assert_e2e_env_usage(files, test_data="path: /rooms")
    assert ei.value.category == "ContextMissing"
    assert "E2E_STORAGE_ROOM_NAME" in str(ei.value)


def test_invented_e2e_env_rewrites_from_testdata():
    files = [
        E2EFile(
            path="AItest/E2ETest/M/TC/specs/x.spec.ts",
            kind="spec",
            content=(
                "const room = process.env.E2E_STORAGE_ROOM_NAME;\n"
                "await page.fill('#a', room || '');\n"
            ),
        )
    ]
    _rewrite_or_assert_e2e_env_usage(
        files, test_data="path: /rooms\nroomName: Kho-A\nSTORAGE_ROOM_NAME: Kho-A"
    )
    assert "Kho-A" in files[0].content
    assert "process.env.E2E_STORAGE_ROOM_NAME" not in files[0].content


def test_allowed_e2e_env_keys_pass():
    files = [
        E2EFile(
            path="AItest/E2ETest/M/TC/specs/x.spec.ts",
            kind="spec",
            content="const u = process.env.E2E_USERNAME;\nconst p = process.env.E2E_FEATURE_PATH;\n",
        )
    ]
    _rewrite_or_assert_e2e_env_usage(files, test_data="")
    assert "E2E_USERNAME" in files[0].content
