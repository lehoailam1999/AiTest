"""PUT /testcases/{id} partial update — marker sync must not clear Function or demote Approved."""

from __future__ import annotations

from types import SimpleNamespace

from app import constants as C
from app.routers.testcases import apply_testcase_patch


def test_test_data_only_keeps_module_and_approved():
    tc = SimpleNamespace(
        title="TC",
        module="Chọn vị trí lưu trữ",
        precondition=None,
        steps="1. Act",
        expected_result="OK",
        test_data="trace: x",
        automation_ready=True,
        review_status=C.REVIEW_APPROVED,
        reviewed_by="u1",
        reviewed_at="t",
        review_comment=None,
        actual_result=None,
        priority="Cao",
        severity="Cao",
        type="Unit",
        execution_status="Pending",
    )
    apply_testcase_patch(
        tc,  # type: ignore[arg-type]
        {"testData": "path: src/Foo.cs\ncode: Foo\ntrace: x"},
    )
    assert tc.module == "Chọn vị trí lưu trữ"
    assert tc.review_status == C.REVIEW_APPROVED
    assert tc.reviewed_by == "u1"
    assert "path:" in tc.test_data


def test_module_edit_demotes_approved():
    tc = SimpleNamespace(
        title="TC",
        module="Old",
        precondition=None,
        steps="1. Act",
        expected_result="OK",
        test_data="t",
        automation_ready=True,
        review_status=C.REVIEW_APPROVED,
        reviewed_by="u1",
        reviewed_at="t",
        review_comment=None,
        actual_result=None,
        priority="Cao",
        severity="Cao",
        type="Unit",
        execution_status="Pending",
    )
    apply_testcase_patch(tc, {"module": "New Function"})  # type: ignore[arg-type]
    assert tc.module == "New Function"
    assert tc.review_status == C.REVIEW_DRAFT
    assert tc.reviewed_by is None


def test_missing_module_key_does_not_clear():
    tc = SimpleNamespace(
        module="Keep Me",
        review_status=C.REVIEW_APPROVED,
        reviewed_by="u",
        reviewed_at="t",
        review_comment=None,
        title="T",
        steps="s",
        expected_result="e",
        precondition=None,
        test_data="old",
        automation_ready=True,
        actual_result=None,
        priority="Cao",
        severity="Cao",
        type="Unit",
        execution_status="Pending",
    )
    apply_testcase_patch(tc, {"testData": "new"})  # type: ignore[arg-type]
    assert tc.module == "Keep Me"
    assert tc.review_status == C.REVIEW_APPROVED
