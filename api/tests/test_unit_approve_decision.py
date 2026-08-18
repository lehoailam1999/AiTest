from __future__ import annotations

import asyncio
import json
import uuid
from types import SimpleNamespace

from app.models.domain import TestCase as DomainTestCase
from app.routers.testcases import (
    approve_unit_testcase,
    unit_testcase_content_revision,
)
from app.serializers import testcase_dto as serialize_testcase


class _Request:
    def __init__(self, body: dict):
        self.body = body

    async def json(self):
        return self.body


class _Query:
    def __init__(self, tc: DomainTestCase):
        self.tc = tc

    def filter(self, *_args, **_kwargs):
        return self

    def with_for_update(self):
        return self

    def first(self):
        return self.tc


class _Db:
    def __init__(self, tc: DomainTestCase):
        self.tc = tc
        self.commits = 0

    def query(self, _model):
        return _Query(self.tc)

    def commit(self):
        self.commits += 1

    def refresh(self, _value):
        pass


def _tc() -> DomainTestCase:
    return DomainTestCase(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        test_case_code="TC-013",
        title="Reject blank description",
        module="Evidence",
        type="Unit",
        priority="Cao",
        severity="Nặng",
        precondition="Evidence DTO exists",
        steps="Pass a blank Description",
        expected_result="Validation fails",
        actual_result=None,
        test_data="Description: blank",
        automation_ready=False,
        is_ai_generated=True,
        review_status="Draft",
        reviewed_by=None,
        reviewed_at=None,
        review_comment=None,
        execution_status="Pending",
        generated_from_hash=None,
        generated_from_version=None,
    )


def _decision(tc: DomainTestCase, *, outcome: str = "READY") -> dict:
    readiness = {
        "READY": "READY_FOR_CODEGEN",
        "NOT_READY": "NOT_READY",
        "FEATURE_GAP": "FEATURE_GAP",
    }[outcome]
    return {
        "schema": "aitest-unit-approve-decision-v2",
        "decisionId": "sha256:" + "a" * 64,
        "canonicalHash": "sha256:" + "a" * 64,
        "emittedAt": "2026-08-16T12:00:00Z",
        "requestId": "req-1",
        "testCase": {
            "id": tc.test_case_code,
            "revisionHash": unit_testcase_content_revision(tc),
            "ir": {
                "schema": "aitest-unit-tc-ir-v1",
                "testCaseId": tc.test_case_code,
                "title": tc.title,
                "testData": {"input": {"Description": " "}},
            },
        },
        "outcome": outcome,
        "readiness": readiness,
        "authoritative": outcome == "READY",
    }


def _call(tc: DomainTestCase, body: dict):
    db = _Db(tc)
    user = SimpleNamespace(id=uuid.uuid4())
    response = asyncio.run(
        approve_unit_testcase(  # type: ignore[arg-type]
            str(tc.id), _Request(body), db, user
        )
    )
    return response, db, json.loads(response.body.decode())


def test_ready_decision_atomically_approves_and_enables_automation():
    tc = _tc()
    decision = _decision(tc)
    response, db, payload = _call(
        tc, {"decision": decision, "testData": "Description: projected blank"}
    )

    assert response.status_code == 200
    assert db.commits == 1
    assert tc.review_status == "Approved"
    assert tc.automation_ready is True
    assert json.loads(tc.unit_decision_json or "{}") == decision
    assert json.loads(tc.unit_tc_ir_json or "{}") == decision["testCase"]["ir"]
    assert tc.unit_decision_id == decision["decisionId"]
    assert tc.test_data == "Description: projected blank"
    assert tc.unit_content_revision == unit_testcase_content_revision(tc)
    assert payload["unitDecision"] == decision
    assert payload["unitTcIr"] == decision["testCase"]["ir"]


def test_feature_gap_approves_but_is_not_automation_ready():
    tc = _tc()
    decision = _decision(tc, outcome="FEATURE_GAP")
    response, db, _payload = _call(tc, {"decision": decision})

    assert response.status_code == 200
    assert db.commits == 1
    assert tc.review_status == "Approved"
    assert tc.automation_ready is False


def test_dto_publishes_the_revision_clients_must_send_back():
    tc = _tc()
    dto = serialize_testcase(tc)

    assert dto["unitContentRevisionCurrent"] == unit_testcase_content_revision(tc)

    decision = _decision(tc)
    decision["testCase"]["revisionHash"] = dto["unitContentRevisionCurrent"]
    response, db, _payload = _call(tc, {"decision": decision})

    assert response.status_code == 200
    assert db.commits == 1


def test_revision_conflict_returns_409_without_mutation_or_commit():
    tc = _tc()
    decision = _decision(tc)
    tc.steps = "Content changed after IDE resolve"
    response, db, payload = _call(tc, {"decision": decision})

    assert response.status_code == 409
    assert payload["errors"] == ["test case content revision conflict"]
    assert db.commits == 0
    assert tc.review_status == "Draft"
    assert tc.unit_decision_json is None
