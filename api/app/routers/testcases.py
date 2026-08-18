from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.models.domain import GenerationTask, Job, Project, Source, TestCase, WorkspaceRun
from app.models.user import User
from app.responses import errors, ok, page, page_params
from app.serializers import testcase_dto
from app.services.e2e_tc_pre_approve_enrich import enrich_e2e_tc_before_approve
from app.services.requirement_content import source_content_hash
from app.services.unit_tc_revision import unit_testcase_content_revision
from app.services.vietnamese_labels import (
    normalize_engine_type,
    priority_order_expr,
    priority_vi,
    severity_vi,
    type_vi,
)

router = APIRouter(prefix="/api", tags=["testcases"], dependencies=[Depends(get_current_user)])

_E2E_ACTIONS = {
    "NAVIGATE",
    "INPUT",
    "SELECT",
    "CHECK",
    "CLICK",
    "SUBMIT",
    "WAIT",
    "ASSERT",
}
_CTX_PATH_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n]+)"
)
_CTX_AUTH_REQ_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:authRequired|auth_required)\s*[:=]\s*(true|false|yes|no|1|0)"
)
_CTX_ROLE_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:authContext|authRole|auth_role|role|actor)\s*[:=]\s*([^\n]+)"
)
_CTX_BASE_URL_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:baseURL|base_url)\s*[:=]\s*(https?://[^\s]+)"
)
_MISSING_CONTEXT_RE = re.compile(r"\[(?:MISSING CONTEXT|Thiếu Context)\]", re.I)
_SCENARIO_RE = re.compile(
    r"\b(positive|negative|boundary|validation|exception|happy path|error flow)\b",
    re.I,
)
_TESTDATA_VAGUE_RE = re.compile(
    r"\b(một\s+\w+\s+hợp\s*lệ|valid\s+value|some\s+valid|dữ\s*liệu\s*hợp\s*lệ)\b",
    re.I,
)
_FORBIDDEN_LOCATOR_RE = re.compile(
    r"(data-testid|data-cy|xpath|css\s*selector|page\.locator|getByRole|getByTestId|getByText|#[A-Za-z_][\w-]*)",
    re.I,
)
_AMBIGUOUS_STEP_RE = re.compile(
    r"^\s*(?:\d+[\).\-\s]*)?(thực\s*hiện\s*thao\s*tác|tiếp\s*tục|kiểm\s*tra|nhập\s*thông\s*tin\s*cần\s*thiết)\s*$",
    re.I,
)
_ACTIONABLE_STEP_RE = re.compile(
    r"(?:nhấn|bấm|click|chọn|select|điền|fill|nhập|type|enter|mở|open|tạo|create|"
    r"thêm|add|xóa|delete|upload|lưu|save|submit|goto|navigate|truy\s*cập|assert|verify)",
    re.I,
)


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _is_e2e_case(tc: TestCase) -> bool:
    return normalize_engine_type(tc.type) == "E2E"


_UNIT_DECISION_SCHEMA = "aitest-unit-approve-decision-v2"
_UNIT_TC_IR_SCHEMA = "aitest-unit-tc-ir-v1"
_SHA256_RE = re.compile(r"^sha256:[a-f0-9]{64}$", re.I)


def _validate_unit_approval_decision(
    tc: TestCase, decision: object
) -> tuple[str | None, dict | None]:
    if not isinstance(decision, dict):
        return "decision must be an object", None
    if decision.get("schema") != _UNIT_DECISION_SCHEMA:
        return f"decision.schema must be {_UNIT_DECISION_SCHEMA}", None
    decision_id = decision.get("decisionId")
    if not isinstance(decision_id, str) or not _SHA256_RE.fullmatch(decision_id):
        return "decision.decisionId must be a sha256 digest", None

    test_case = decision.get("testCase")
    if not isinstance(test_case, dict):
        return "decision.testCase must be an object", None
    accepted_ids = {str(tc.id), tc.test_case_code}
    if str(test_case.get("id") or "") not in accepted_ids:
        return "decision.testCase.id does not match the test case", None
    revision = test_case.get("revisionHash")
    if not isinstance(revision, str) or not _SHA256_RE.fullmatch(revision):
        return "decision.testCase.revisionHash must be a sha256 digest", None
    ir = test_case.get("ir")
    if not isinstance(ir, dict) or ir.get("schema") != _UNIT_TC_IR_SCHEMA:
        return f"decision.testCase.ir.schema must be {_UNIT_TC_IR_SCHEMA}", None
    if str(ir.get("testCaseId") or "") not in accepted_ids:
        return "decision.testCase.ir.testCaseId does not match the test case", None

    outcome = decision.get("outcome")
    readiness = decision.get("readiness")
    authoritative = decision.get("authoritative")
    expected_readiness = {
        "READY": "READY_FOR_CODEGEN",
        "NOT_READY": "NOT_READY",
        "FEATURE_GAP": "FEATURE_GAP",
    }
    if outcome not in expected_readiness or readiness != expected_readiness[outcome]:
        return "decision outcome/readiness are inconsistent", None
    if not isinstance(authoritative, bool):
        return "decision.authoritative must be boolean", None
    if authoritative and (
        outcome != "READY" or readiness != "READY_FOR_CODEGEN"
    ):
        return "only READY_FOR_CODEGEN decisions may be authoritative", None
    return None, ir


def _has_actionable_step(steps: str) -> bool:
    for raw in [ln.strip() for ln in (steps or "").splitlines() if ln.strip()]:
        if _AMBIGUOUS_STEP_RE.match(raw):
            continue
        if _ACTIONABLE_STEP_RE.search(raw):
            return True
    return False


def _validate_e2e_approve_readiness(tc: TestCase) -> list[str]:
    issues: list[str] = []
    module = (tc.module or "").strip()
    title = (tc.title or "").strip()
    steps = (tc.steps or "").strip()
    precondition = (tc.precondition or "").strip()
    expected = (tc.expected_result or "").strip()
    test_data = (tc.test_data or "").strip()
    blob = "\n".join([precondition, test_data, steps, expected, title, module])

    # 1) Meta essentials
    if not (tc.test_case_code or "").strip():
        issues.append("Meta thiếu Code")
    if not title:
        issues.append("Meta thiếu Title")
    if not module:
        issues.append("Meta thiếu Module/Function")
    if not (tc.priority or "").strip():
        issues.append("Meta thiếu Priority")
    if not (tc.severity or "").strip():
        issues.append("Meta thiếu Severity")

    # 2) Business context essentials
    if not _SCENARIO_RE.search(blob):
        issues.append("Business Context thiếu Scenario type (Positive/Negative/Boundary/Validation/Exception)")
    if not _CTX_ROLE_RE.search(blob):
        issues.append("Business Context thiếu Actor/Role")
    if not re.search(r"(requirement|business\s*rule|BR-|FR-|AC-)", blob, re.I):
        issues.append("Business Context thiếu Requirement/Business Rule reference")

    # 3) Preconditions
    if not precondition:
        issues.append("Preconditions bị trống")

    # 4) Test data quality
    if not test_data:
        issues.append("Test Data bị trống")
    if _TESTDATA_VAGUE_RE.search(test_data):
        issues.append("Test Data mơ hồ (ví dụ 'một mã hợp lệ')")
    if test_data and not re.search(r"[:=]", test_data):
        issues.append("Test Data chưa đủ cụ thể (thiếu cặp key:value)")

    # 5) E2E context
    if not _CTX_PATH_RE.search(blob):
        issues.append("E2E Context thiếu path/route/featurePath")
    if not _CTX_AUTH_REQ_RE.search(blob):
        issues.append("E2E Context thiếu authRequired")
    if not _CTX_ROLE_RE.search(blob):
        issues.append("E2E Context thiếu authContext/role")
    if _MISSING_CONTEXT_RE.search(blob):
        issues.append("Còn placeholder [MISSING CONTEXT]/[Thiếu Context]")
    # baseURL may come from environment; require either explicit or route context.
    if not _CTX_BASE_URL_RE.search(blob) and not _CTX_PATH_RE.search(blob):
        issues.append("E2E Context thiếu baseURL hoặc path/route")

    # 6) Steps structure & ambiguity
    if not steps:
        issues.append("Steps bị trống")
    else:
        has_valid_action = False
        for raw in [ln.strip() for ln in steps.splitlines() if ln.strip()]:
            if _AMBIGUOUS_STEP_RE.match(raw):
                issues.append(f"Step mơ hồ: '{raw}'")
                continue
            line = re.sub(r"^\d+[\).\-\s]*", "", raw).strip()
            action = line.split()[0].upper() if line else ""
            if action in _E2E_ACTIONS:
                has_valid_action = True
                if action in {"INPUT", "SELECT", "CHECK", "CLICK", "ASSERT", "NAVIGATE", "SUBMIT"}:
                    if "target:" not in line.lower():
                        issues.append(f"Step thiếu Target: '{raw}'")
                if action in {"INPUT", "SELECT", "CHECK"} and "value:" not in line.lower():
                    issues.append(f"Step thiếu Value: '{raw}'")
                if "expected:" not in line.lower() and action != "WAIT":
                    issues.append(f"Step thiếu Expected: '{raw}'")
        if not has_valid_action and not _has_actionable_step(steps):
            issues.append(
                "Steps thiếu action chuẩn NAVIGATE|INPUT|SELECT|CHECK|CLICK|SUBMIT|WAIT|ASSERT"
            )

    # 7) Expected result + postcondition + locator ban
    if not expected:
        issues.append("Expected Result bị trống")
    if expected and re.search(r"(thành công|ok)$", expected.strip(), re.I):
        issues.append("Expected Result quá chung, chưa verify được")
    if not re.search(r"(postcondition|sau\s*test|sau\s*khi|không\s*tạo|không\s*cập\s*nhật|không\s*xóa|dữ\s*liệu)", blob, re.I):
        issues.append("Thiếu Postconditions")
    if _FORBIDDEN_LOCATOR_RE.search(blob):
        issues.append("TC chứa locator kỹ thuật (data-testid/xpath/page.locator...) — chỉ dùng semantic target")

    dedup: list[str] = []
    seen: set[str] = set()
    for item in issues:
        key = item.strip().lower()
        if key and key not in seen:
            seen.add(key)
            dedup.append(item)
    return dedup[:12]


def _split_e2e_readiness_issues(issues: list[str]) -> tuple[list[str], list[str]]:
    """
    Critical issues => hard-block approve.
    Non-critical issues => approve allowed, but mark tc.automation_ready=False + note.
    """
    # [MISSING CONTEXT] is soft after pre-approve enrich (DoR draft flag).
    # Hard-block only truly unblockable content for Approve.
    critical_tokens = (
        "steps bị trống",
        "step mơ hồ",
        "locator kỹ thuật",
        "test data bị trống",
    )
    critical: list[str] = []
    soft: list[str] = []
    for issue in issues:
        key = issue.strip().lower()
        if any(tok in key for tok in critical_tokens):
            critical.append(issue)
        else:
            soft.append(issue)
    return critical, soft


def apply_testcase_patch(tc: TestCase, body: dict) -> bool:
    """
    Partial PUT: only keys present in body are written.
    Returns True when substantive content changed (demotes Approved → Draft).
    testData-only (Approve marker sync) does NOT clear module or demote review.
    """
    content_changed = False
    if "title" in body and body.get("title"):
        tc.title = body["title"]
        content_changed = True
    if "module" in body:
        tc.module = body.get("module")
        content_changed = True
    if "priority" in body and body.get("priority"):
        tc.priority = priority_vi(body["priority"])
        content_changed = True
    if "severity" in body and body.get("severity"):
        tc.severity = severity_vi(body["severity"])
        content_changed = True
    if "type" in body and body.get("type"):
        tc.type = type_vi(body["type"])
        content_changed = True
    if "precondition" in body:
        tc.precondition = body.get("precondition")
        content_changed = True
    if "steps" in body and body.get("steps"):
        tc.steps = body["steps"]
        content_changed = True
    if "expectedResult" in body and body.get("expectedResult"):
        tc.expected_result = body["expectedResult"]
        content_changed = True
    if "actualResult" in body:
        tc.actual_result = body.get("actualResult")
    if "testData" in body:
        tc.test_data = body.get("testData")
    if "automationReady" in body:
        tc.automation_ready = bool(body.get("automationReady"))
    if "executionStatus" in body and body.get("executionStatus"):
        tc.execution_status = body["executionStatus"]

    if content_changed and tc.review_status in (C.REVIEW_APPROVED, C.REVIEW_REJECTED):
        tc.review_status = C.REVIEW_DRAFT
        tc.reviewed_by = None
        tc.reviewed_at = None
        tc.review_comment = None
    return content_changed


@router.get("/testcases")
def list_testcases(request: Request, db: Annotated[Session, Depends(get_db)]):
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(TestCase)
    qp = request.query_params
    if v := qp.get("projectId"):
        if pid := _uuid(v):
            q = q.filter(TestCase.project_id == pid)
    if v := qp.get("jobId"):
        if jid := _uuid(v):
            q = q.filter(TestCase.job_id == jid)
    for key in ("requirementId", "sourceId"):
        if v := qp.get(key):
            if sid := _uuid(v):
                q = q.filter(TestCase.source_id == sid)
    if v := (qp.get("reviewStatus") or "").strip():
        q = q.filter(TestCase.review_status == v)
    total = q.count()
    items = (
        q.order_by(
            priority_order_expr(TestCase.priority).asc(),
            TestCase.created_at.desc(),
        )
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    source_ids = {t.source_id for t in items if t.source_id}
    hash_by_source: dict[uuid.UUID, str | None] = {}
    if source_ids:
        for src in db.query(Source).filter(Source.id.in_(source_ids)).all():
            hash_by_source[src.id] = source_content_hash(src.content, src.description)
    return ok(
        page(
            [
                testcase_dto(t, hash_by_source.get(t.source_id) if t.source_id else None)
                for t in items
            ],
            total,
            page_number,
            size,
        )
    )


@router.post("/testcases")
async def create_testcase(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    source_id = _uuid(str(body.get("sourceId") or "")) or _uuid(
        str(body.get("requirementId") or "")
    )
    if project_id is None and source_id is not None:
        src = db.query(Source).filter(Source.id == source_id).first()
        if src:
            project_id = src.project_id
    title = body.get("title") or ""
    steps = body.get("steps") or ""
    expected = body.get("expectedResult") or ""
    if project_id is None or not title or not steps or not expected:
        return errors(400, "projectId, title, steps, expectedResult required")

    count = db.query(TestCase).filter(TestCase.project_id == project_id).count()
    tc = TestCase(
        project_id=project_id,
        source_id=source_id,
        job_id=_uuid(str(body.get("jobId") or "")),
        test_case_code=f"TC-{count + 1:03d}",
        title=title,
        module=body.get("module"),
        type=type_vi(body.get("type")),
        priority=priority_vi(body.get("priority")),
        severity=severity_vi(body.get("severity")),
        precondition=body.get("precondition"),
        steps=steps,
        expected_result=expected,
        test_data=body.get("testData"),
        automation_ready=bool(body.get("automationReady", False)),
        is_ai_generated=False,
        review_status=C.REVIEW_DRAFT,
        execution_status="Pending",
    )
    db.add(tc)
    db.commit()
    db.refresh(tc)
    return ok(testcase_dto(tc))


@router.post("/testcases/bulk")
async def bulk_save_testcases(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_cases = body.get("testCases") or []
    if project_id is None or not test_cases:
        return errors(400, "projectId and testCases required")

    job_id = _uuid(str(body.get("jobId") or ""))
    source_id = _uuid(str(body.get("sourceId") or ""))
    if job_id is not None and source_id is None:
        job = db.query(Job).filter(Job.id == job_id).first()
        if job:
            source_id = job.source_id

    count = db.query(TestCase).filter(TestCase.project_id == project_id).count()
    created: list[TestCase] = []
    for i, item in enumerate(test_cases):
        title = (item.get("title") or "").strip()
        steps = (item.get("steps") or "").strip()
        expected = (item.get("expectedResult") or "").strip()
        if not title or not steps or not expected:
            db.rollback()
            return errors(400, f"testCases[{i}]: title, steps, expectedResult required")
        count += 1
        tc = TestCase(
            project_id=project_id,
            source_id=source_id,
            job_id=job_id,
            test_case_code=f"TC-{count:03d}",
            title=title,
            module=item.get("module"),
            type=type_vi(item.get("type")),
            priority=priority_vi(item.get("priority")),
            severity=severity_vi(item.get("severity")),
            precondition=item.get("precondition"),
            steps=steps,
            expected_result=expected,
            test_data=item.get("testData"),
            automation_ready=bool(item.get("automationReady", False)),
            is_ai_generated=True,
            review_status=C.REVIEW_DRAFT,
            execution_status="Pending",
        )
        db.add(tc)
        created.append(tc)

    if job_id is not None:
        job = db.query(Job).filter(Job.id == job_id).first()
        if job:
            job.status = C.JOB_COMPLETED
            job.completed_at = datetime.now(timezone.utc)
            job.error = None
    db.commit()
    for tc in created:
        db.refresh(tc)
    return ok({"count": len(created), "testCases": [testcase_dto(t) for t in created]})


@router.get("/testcases/{tc_id}")
def get_testcase(tc_id: str, db: Annotated[Session, Depends(get_db)]):
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")
    return ok(testcase_dto(tc))


@router.put("/testcases/{tc_id}")
async def update_testcase(tc_id: str, request: Request, db: Annotated[Session, Depends(get_db)]):
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")
    body = await request.json()
    if not isinstance(body, dict):
        return errors(400, "invalid body")

    apply_testcase_patch(tc, body)
    db.commit()
    db.refresh(tc)
    return ok(testcase_dto(tc))


@router.delete("/testcases/{tc_id}")
def delete_testcase(tc_id: str, db: Annotated[Session, Depends(get_db)]):
    """Hard-delete test case row from database (not soft-delete)."""
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")

    db.query(GenerationTask).filter(GenerationTask.test_case_id == tid).delete(
        synchronize_session=False
    )
    db.query(WorkspaceRun).filter(WorkspaceRun.test_case_id == tid).update(
        {WorkspaceRun.test_case_id: None},
        synchronize_session=False,
    )
    db.delete(tc)
    db.commit()
    return ok({"status": "ok", "deleted": True})


def _transition(
    db: Session, tc_id: str, to: str, user: User, comment: str | None
):
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")
    e2e_soft_issues: list[str] = []
    if to == C.REVIEW_APPROVED:
        normalized_type = normalize_engine_type(tc.type)
        if normalized_type == "E2E":
            proj_default_role: str | None = None
            proj = db.get(Project, tc.project_id) if tc.project_id else None
            if proj and proj.meta:
                try:
                    _pmeta = json.loads(proj.meta)
                    proj_default_role = (
                        _pmeta.get("defaultAuthRole")
                        or _pmeta.get("authRole")
                        or _pmeta.get("default_role")
                    )
                except Exception:
                    pass
            enrich_e2e_tc_before_approve(tc, project_default_role=proj_default_role)
            issues = _validate_e2e_approve_readiness(tc)
            critical, soft = _split_e2e_readiness_issues(issues)
            if critical:
                return errors(
                    400,
                    "E2E Approve bị chặn: chưa đạt E2E_READY",
                    *critical,
                )
            e2e_soft_issues = soft
    if not C.can_transition_review(tc.review_status, to):
        return errors(400, f"cannot transition from {tc.review_status} to {to}")
    tc.review_status = to
    now = datetime.now(timezone.utc)
    if to in (C.REVIEW_APPROVED, C.REVIEW_REJECTED):
        tc.reviewed_by = user.id
        tc.reviewed_at = now
        tc.review_comment = comment
        if to == C.REVIEW_APPROVED:
            # R1.5 — Journey/UI/e2e → E2E; unit → Unit; api → API
            tc.type = normalize_engine_type(tc.type)
            if tc.type == "E2E":
                if e2e_soft_issues:
                    tc.automation_ready = False
                    tc.review_comment = (
                        "E2E chưa đủ chuẩn (soft): " + " | ".join(e2e_soft_issues[:4])
                    )
                else:
                    tc.automation_ready = True
            elif tc.type == "Unit":
                # API approval precedes Desktop source grounding. Only the
                # authoritative grounding write-back may promote this flag.
                tc.automation_ready = False
    else:
        tc.reviewed_by = None
        tc.reviewed_at = None
        tc.review_comment = None
    db.commit()
    db.refresh(tc)
    return ok(testcase_dto(tc))


@router.post("/testcases/{tc_id}/submit")
def submit_testcase(
    tc_id: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    return _transition(db, tc_id, C.REVIEW_IN_REVIEW, user, None)


@router.post("/testcases/{tc_id}/approve")
def approve_testcase(
    tc_id: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    return _transition(db, tc_id, C.REVIEW_APPROVED, user, None)


@router.post("/testcases/{tc_id}/approve-unit")
async def approve_unit_testcase(
    tc_id: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = (
        db.query(TestCase)
        .filter(TestCase.id == tid)
        .with_for_update()
        .first()
    )
    if tc is None:
        return errors(404, "not found")
    if normalize_engine_type(tc.type) != "Unit":
        return errors(400, "approve-unit only supports Unit test cases")

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return errors(400, "invalid JSON body")
    if not isinstance(body, dict):
        return errors(400, "invalid body")
    decision = body.get("decision", body)
    validation_error, ir = _validate_unit_approval_decision(tc, decision)
    if validation_error:
        return errors(400, validation_error)
    assert isinstance(decision, dict) and ir is not None

    decision_revision = decision["testCase"]["revisionHash"]
    explicit_revision = body.get("expectedRevision") or body.get(
        "expectedContentRevision"
    )
    if explicit_revision is not None and explicit_revision != decision_revision:
        return errors(
            400, "expected revision does not match decision.testCase.revisionHash"
        )
    current_revision = unit_testcase_content_revision(tc)
    if decision_revision != current_revision:
        return errors(409, "test case content revision conflict")
    if not C.can_transition_review(tc.review_status, C.REVIEW_APPROVED):
        return errors(
            400,
            f"cannot transition from {tc.review_status} to {C.REVIEW_APPROVED}",
        )

    # Mutate only after every validation/CAS check; one commit makes the
    # approval, decision, IR and marker projection atomic.
    if "testData" in body:
        test_data = body.get("testData")
        if test_data is not None and not isinstance(test_data, str):
            return errors(400, "testData must be a string or null")
        tc.test_data = test_data
    tc.unit_decision_json = json.dumps(
        decision, ensure_ascii=False, separators=(",", ":")
    )
    tc.unit_tc_ir_json = json.dumps(ir, ensure_ascii=False, separators=(",", ":"))
    tc.unit_decision_id = decision["decisionId"]
    tc.review_status = C.REVIEW_APPROVED
    tc.reviewed_by = user.id
    tc.reviewed_at = datetime.now(timezone.utc)
    tc.review_comment = None
    tc.type = "Unit"
    tc.automation_ready = bool(
        decision["readiness"] == "READY_FOR_CODEGEN"
        and decision["authoritative"] is True
    )
    tc.unit_content_revision = unit_testcase_content_revision(tc)
    db.commit()
    db.refresh(tc)
    return ok(testcase_dto(tc))


@router.post("/testcases/{tc_id}/reject")
async def reject_testcase(
    tc_id: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — empty body allowed
        body = {}
    return _transition(db, tc_id, C.REVIEW_REJECTED, user, (body or {}).get("comment"))
