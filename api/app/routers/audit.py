from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.domain import (
    ApplyAudit,
    GenerationCampaign,
    GenerationTask,
    Project,
    VerifyReportRecord,
    WorkspaceRun,
)
from app.models.user import User
from app.responses import errors, ok
from app.serializers import (
    apply_audit_dto,
    campaign_dto,
    generation_task_dto,
    verify_report_dto,
    workspace_run_dto,
)

router = APIRouter(prefix="/api", tags=["audit"], dependencies=[Depends(get_current_user)])


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _get_project(db: Session, project_id: uuid.UUID) -> Project | None:
    return (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )


def _upsert_workspace_run(
    db: Session,
    *,
    project_id: uuid.UUID,
    local_run_id: str,
    test_type: str,
    test_case_id: uuid.UUID | None,
    module: str | None,
    status: str,
    provider: str | None,
    context_source: str | None = None,
    agent_confidence: float | None = None,
    agent_override: bool | None = None,
) -> WorkspaceRun:
    row = (
        db.query(WorkspaceRun)
        .filter(
            WorkspaceRun.project_id == project_id,
            WorkspaceRun.local_run_id == local_run_id,
            WorkspaceRun.deleted_at.is_(None),
        )
        .first()
    )
    now = _utcnow()
    if row is None:
        row = WorkspaceRun(
            project_id=project_id,
            local_run_id=local_run_id,
            test_type=test_type,
            test_case_id=test_case_id,
            module=module,
            status=status,
            provider=provider,
            context_source=context_source,
            agent_confidence=agent_confidence,
            agent_override=bool(agent_override) if agent_override is not None else False,
            started_at=now,
        )
        db.add(row)
    else:
        row.test_type = test_type or row.test_type
        row.test_case_id = test_case_id or row.test_case_id
        row.module = module if module is not None else row.module
        row.status = status
        if provider:
            row.provider = provider
        if context_source:
            row.context_source = context_source
        if agent_confidence is not None:
            row.agent_confidence = agent_confidence
        if agent_override is not None:
            row.agent_override = bool(agent_override)
        if row.started_at is None:
            row.started_at = now
    if status in ("applied", "pass", "fail", "discarded"):
        row.finished_at = now
    db.commit()
    db.refresh(row)
    return row


@router.post("/audit/workspace-run")
async def upsert_workspace_run_route(
    request: Request, db: Annotated[Session, Depends(get_db)]
):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    local_run_id = (body.get("localRunId") or "").strip()
    if project_id is None or not local_run_id:
        return errors(400, "projectId and localRunId required")
    if _get_project(db, project_id) is None:
        return errors(404, "Project not found")

    tc_id = _uuid(str(body.get("testCaseId") or "")) if body.get("testCaseId") else None
    row = _upsert_workspace_run(
        db,
        project_id=project_id,
        local_run_id=local_run_id,
        test_type=(body.get("testType") or "unit").strip() or "unit",
        test_case_id=tc_id,
        module=(body.get("module") or "").strip() or None,
        status=(body.get("status") or "draft").strip() or "draft",
        provider=(body.get("provider") or "").strip() or None,
        context_source=(body.get("contextSource") or "").strip() or None,
        agent_confidence=(
            float(body["agentConfidence"])
            if body.get("agentConfidence") is not None
            else None
        ),
        agent_override=(
            bool(body.get("agentOverride")) if "agentOverride" in body else None
        ),
    )
    return ok(workspace_run_dto(row))


@router.post("/audit/verify-report")
async def post_verify_report(
    request: Request, db: Annotated[Session, Depends(get_db)]
):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    local_run_id = (body.get("localRunId") or "").strip()
    if project_id is None or not local_run_id:
        return errors(400, "projectId and localRunId required")

    run = _upsert_workspace_run(
        db,
        project_id=project_id,
        local_run_id=local_run_id,
        test_type=(body.get("testType") or "unit").strip() or "unit",
        test_case_id=_uuid(str(body.get("testCaseId") or ""))
        if body.get("testCaseId")
        else None,
        module=(body.get("module") or "").strip() or None,
        status="pass" if body.get("overallPass") else "fail",
        provider=None,
    )

    stages = body.get("stages")
    summary_payload: dict | list = stages if isinstance(stages, list) else []
    if body.get("coverageSync") is not None:
        summary_payload = {
            "stages": stages if isinstance(stages, list) else [],
            "coverageSync": body.get("coverageSync"),
        }
    summary = json.dumps(summary_payload) if summary_payload else None
    compile_status = None
    test_status = None
    coverage_status = None
    if isinstance(stages, list):
        for s in stages:
            if not isinstance(s, dict):
                continue
            stage = (s.get("stage") or "").lower()
            ok_flag = "pass" if s.get("success") else "fail"
            if stage == "compile":
                compile_status = ok_flag
            elif stage in ("test", "headless"):
                test_status = ok_flag
            elif stage == "coverage":
                coverage_status = ok_flag
            elif stage == "artifacts" and s.get("success"):
                coverage_status = coverage_status or "synced"

    # Infer coverage_status from synced artifacts when stage skipped but sync succeeded
    cov_sync = body.get("coverageSync")
    if (
        coverage_status is None
        and isinstance(cov_sync, dict)
        and int(cov_sync.get("uploaded") or 0) > 0
    ):
        coverage_status = "synced"
    rec = VerifyReportRecord(
        workspace_run_id=run.id,
        compile_status=compile_status,
        test_status=test_status,
        coverage_status=coverage_status,
        overall_pass=bool(body.get("overallPass")),
        summary_json=summary,
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return ok(verify_report_dto(rec, run))


@router.post("/audit/apply")
async def post_apply_audit(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    local_run_id = (body.get("localRunId") or "").strip()
    if project_id is None or not local_run_id:
        return errors(400, "projectId and localRunId required")

    run = _upsert_workspace_run(
        db,
        project_id=project_id,
        local_run_id=local_run_id,
        test_type=(body.get("testType") or "unit").strip() or "unit",
        test_case_id=_uuid(str(body.get("testCaseId") or ""))
        if body.get("testCaseId")
        else None,
        module=None,
        status="applied" if body.get("success", True) else "fail",
        provider=None,
    )

    files = body.get("filesApplied") or []
    if not isinstance(files, list):
        files = []
    rec = ApplyAudit(
        workspace_run_id=run.id,
        files_applied_json=json.dumps([str(x) for x in files]),
        success=bool(body.get("success", True)),
        rollback_used=bool(body.get("rollbackUsed")),
        actor_user_id=user.id,
        applied_at=_utcnow(),
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return ok(apply_audit_dto(rec, run))


@router.get("/audit/workspace-runs")
def list_workspace_runs(
    db: Annotated[Session, Depends(get_db)],
    projectId: str,
    page: int = 1,
    pageSize: int = 50,
    testType: str | None = None,
):
    pid = _uuid(projectId)
    if pid is None:
        return errors(400, "projectId required")
    page = max(1, page)
    pageSize = min(max(1, pageSize), 100)
    q = (
        db.query(WorkspaceRun)
        .filter(WorkspaceRun.project_id == pid, WorkspaceRun.deleted_at.is_(None))
        .order_by(WorkspaceRun.created_at.desc())
    )
    tt = (testType or "").strip().lower()
    if tt == "e2e":
        q = q.filter(WorkspaceRun.test_type == "e2e")
    elif tt == "unit":
        # Unit board: unit + api (không lẫn E2E)
        q = q.filter(WorkspaceRun.test_type.in_(("unit", "api")))
    elif tt:
        q = q.filter(WorkspaceRun.test_type == tt)
    total = q.count()
    rows = q.offset(max(0, page - 1) * pageSize).limit(pageSize).all()

    # Step U2 — attach latest verify snapshot per run (for job board)
    verify_by_run: dict[uuid.UUID, VerifyReportRecord] = {}
    if rows:
        run_ids = [r.id for r in rows]
        verifies = (
            db.query(VerifyReportRecord)
            .filter(VerifyReportRecord.workspace_run_id.in_(run_ids))
            .order_by(VerifyReportRecord.created_at.desc())
            .all()
        )
        for v in verifies:
            if v.workspace_run_id not in verify_by_run:
                verify_by_run[v.workspace_run_id] = v

    items = []
    for r in rows:
        dto = workspace_run_dto(r)
        v = verify_by_run.get(r.id)
        if v is not None:
            dto["latestVerify"] = {
                "overallPass": v.overall_pass,
                "compileStatus": v.compile_status,
                "testStatus": v.test_status,
                "coverageStatus": v.coverage_status,
                "summaryJson": v.summary_json,
            }
        else:
            dto["latestVerify"] = None
        items.append(dto)

    return ok(
        {
            "items": items,
            "page": page,
            "pageSize": pageSize,
            "total": total,
        }
    )


@router.get("/audit/workspace-runs/{run_key}")
def get_workspace_run_detail(
    run_key: str,
    db: Annotated[Session, Depends(get_db)],
    projectId: str,
):
    """
    Phase U2 — chi tiết Unit Job: run + verify reports + apply audits.
    run_key: UUID của workspace_runs.id hoặc localRunId.
    """
    pid = _uuid(projectId)
    if pid is None:
        return errors(400, "projectId required")
    rid = _uuid(run_key)
    q = db.query(WorkspaceRun).filter(
        WorkspaceRun.project_id == pid, WorkspaceRun.deleted_at.is_(None)
    )
    if rid is not None:
        row = q.filter(WorkspaceRun.id == rid).first()
    else:
        row = q.filter(WorkspaceRun.local_run_id == run_key.strip()).first()
    if row is None:
        return errors(404, "workspace run not found")

    verifies = (
        db.query(VerifyReportRecord)
        .filter(VerifyReportRecord.workspace_run_id == row.id)
        .order_by(VerifyReportRecord.created_at.desc())
        .limit(10)
        .all()
    )
    applies = (
        db.query(ApplyAudit)
        .filter(ApplyAudit.workspace_run_id == row.id)
        .order_by(ApplyAudit.created_at.desc())
        .limit(10)
        .all()
    )
    return ok(
        {
            "run": workspace_run_dto(row),
            "verifies": [verify_report_dto(v, row) for v in verifies],
            "applies": [apply_audit_dto(a, row) for a in applies],
        }
    )


@router.post("/campaigns")
async def create_campaign(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    if project_id is None:
        return errors(400, "projectId required")
    if _get_project(db, project_id) is None:
        return errors(404, "Project not found")

    row = GenerationCampaign(
        project_id=project_id,
        kind=(body.get("kind") or "unit").strip() or "unit",
        scope_level=(body.get("scopeLevel") or "").strip() or None,
        scope_label=(body.get("scopeLabel") or "").strip() or None,
        status="Running",
        started_at=_utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ok(campaign_dto(row, tasks=[]))


@router.patch("/campaigns/{campaign_id}")
async def patch_campaign(
    campaign_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    cid = _uuid(campaign_id)
    if cid is None:
        return errors(400, "invalid campaign id")
    row = (
        db.query(GenerationCampaign)
        .filter(GenerationCampaign.id == cid, GenerationCampaign.deleted_at.is_(None))
        .first()
    )
    if row is None:
        return errors(404, "campaign not found")
    body = await request.json()
    if "status" in body:
        row.status = str(body["status"])
    if body.get("finished"):
        row.finished_at = _utcnow()
    db.commit()
    db.refresh(row)
    tasks = (
        db.query(GenerationTask)
        .filter(GenerationTask.campaign_id == cid, GenerationTask.deleted_at.is_(None))
        .order_by(GenerationTask.sort_order.asc())
        .all()
    )
    return ok(campaign_dto(row, tasks))


@router.post("/campaigns/{campaign_id}/tasks")
async def add_campaign_tasks(
    campaign_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    cid = _uuid(campaign_id)
    if cid is None:
        return errors(400, "invalid campaign id")
    campaign = (
        db.query(GenerationCampaign)
        .filter(GenerationCampaign.id == cid, GenerationCampaign.deleted_at.is_(None))
        .first()
    )
    if campaign is None:
        return errors(404, "campaign not found")
    body = await request.json()
    items = body.get("tasks") or []
    if not isinstance(items, list):
        return errors(400, "tasks array required")

    created: list[GenerationTask] = []
    for i, raw in enumerate(items):
        if not isinstance(raw, dict):
            continue
        tc_id = _uuid(str(raw.get("testCaseId") or "")) if raw.get("testCaseId") else None
        task = GenerationTask(
            campaign_id=cid,
            test_case_id=tc_id,
            local_run_id=(raw.get("localRunId") or "").strip() or None,
            status=(raw.get("status") or "pending").strip() or "pending",
            error=(raw.get("error") or "").strip() or None,
            sort_order=int(raw.get("sortOrder") if raw.get("sortOrder") is not None else i),
        )
        db.add(task)
        created.append(task)
    db.commit()
    for t in created:
        db.refresh(t)
    return ok({"tasks": [generation_task_dto(t) for t in created]})


@router.get("/campaigns")
def list_campaigns(
    db: Annotated[Session, Depends(get_db)],
    projectId: str,
    page: int = 1,
    pageSize: int = 30,
    kind: str | None = None,
):
    pid = _uuid(projectId)
    if pid is None:
        return errors(400, "projectId required")
    page = max(1, page)
    pageSize = min(max(1, pageSize), 100)
    q = (
        db.query(GenerationCampaign)
        .filter(GenerationCampaign.project_id == pid, GenerationCampaign.deleted_at.is_(None))
        .order_by(GenerationCampaign.started_at.desc())
    )
    kind_f = (kind or "").strip().lower()
    if kind_f:
        q = q.filter(GenerationCampaign.kind == kind_f)
    total = q.count()
    rows = q.offset(max(0, page - 1) * pageSize).limit(pageSize).all()
    items = []
    for c in rows:
        tasks = (
            db.query(GenerationTask)
            .filter(GenerationTask.campaign_id == c.id, GenerationTask.deleted_at.is_(None))
            .order_by(GenerationTask.sort_order.asc())
            .all()
        )
        items.append(campaign_dto(c, tasks))
    return ok({"items": items, "page": page, "pageSize": pageSize, "total": total})
