from __future__ import annotations

import hashlib
import json

from app.models.domain import TestCase
from app.services.vietnamese_labels import normalize_engine_type


def unit_testcase_content_revision(tc: TestCase) -> str:
    """Stable CAS revision over user-editable Unit TC content.

    Single source of truth: clients must read this value from the TestCase DTO
    instead of recomputing it, otherwise Approve fails with a revision conflict.
    """
    content = {
        "testCaseId": tc.test_case_code,
        "title": tc.title,
        "module": tc.module,
        "type": normalize_engine_type(tc.type),
        "priority": tc.priority,
        "severity": tc.severity,
        "precondition": tc.precondition,
        "steps": tc.steps,
        "expectedResult": tc.expected_result,
        "testData": tc.test_data,
    }
    canonical = json.dumps(
        content, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
