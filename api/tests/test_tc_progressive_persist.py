"""Progressive TC persist helpers — same insert/dedupe rules, early save per module."""

from __future__ import annotations

import re
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.routers.jobs import _coerce_draft_type, _persist_generated_drafts
from app.services.testcase_dedup import dup_key


def test_coerce_draft_type_unit_e2e_unchanged():
    assert _coerce_draft_type("API", "unit") == "Unit"
    assert _coerce_draft_type("Chức năng", "e2e") == "E2E"
    assert _coerce_draft_type("E2E", None) == "E2E"
    assert _coerce_draft_type("Unit", None) == "Unit"


def test_persist_generated_drafts_dedupes_and_counts():
    db = MagicMock()
    # project already has 2 TCs
    db.query.return_value.filter.return_value.count.return_value = 2

    d1 = SimpleNamespace(
        title="Login ok",
        steps="1. open",
        module="Auth",
        type="Unit",
        priority="Cao",
        severity="Nặng",
        precondition="",
        expected_result="ok",
        test_data="",
        automation_ready=False,
    )
    d2 = SimpleNamespace(
        title="Login ok",
        steps="1. open",
        module="Auth",
        type="Unit",
        priority="Cao",
        severity="Nặng",
        precondition="",
        expected_result="ok",
        test_data="",
        automation_ready=False,
    )
    d3 = SimpleNamespace(
        title="Logout",
        steps="1. click",
        module="Auth",
        type="Unit",
        priority="TB",
        severity="Nhe",
        precondition="",
        expected_result="out",
        test_data="",
        automation_ready=False,
    )

    keys = {dup_key(d1.title, d1.steps)}
    # first draft already in keys → skip; d3 new
    n = _persist_generated_drafts(
        db,
        project_id=uuid.uuid4(),
        job_id=uuid.uuid4(),
        source_id=None,
        snap_id=uuid.uuid4(),
        drafts=[d1, d2, d3],
        existing_keys=keys,
        default_module="Auth",
        preferred_engine="unit",
        doc_hash=None,
        doc_version=1,
    )
    assert n == 1
    assert db.add.call_count == 1
    db.commit.assert_called_once()
    assert dup_key(d3.title, d3.steps) in keys


def test_parse_saved_count_from_progress():
    def parse_saved_count(msg: str) -> int | None:
        m = re.search(r"tổng đã lưu\s+(\d+)", msg, re.I)
        if not m:
            return None
        return int(m.group(1))

    assert parse_saved_count("[progressive] «Auth» đã lưu +3 TC · tổng đã lưu 7") == 7
    assert parse_saved_count("Module 1/3: xong (+2 TC)") is None
    assert parse_saved_count("Hoàn tất — 10 test case · tổng đã lưu 10") == 10
