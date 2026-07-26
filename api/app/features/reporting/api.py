"""Reporting — coverage meta upload / list (P7 / W6)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.domain import CoverageUpload, ReportRecord
from app.responses import errors, ok, page, page_params

router = APIRouter(prefix="/api", tags=["reporting"], dependencies=[Depends(get_current_user)])


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


@router.post("/projects/{project_id}/coverage")
async def upload_coverage(
    project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    body = await request.json()
    fmt = (body.get("format") or "lcov").strip()[:40]
    summary = body.get("summary") or {}
    raw = body.get("content")
    if isinstance(raw, str) and raw.strip():
        from app.ports.coverage import parse_coverage

        summary = {**summary, **parse_coverage(fmt, raw)}
    row = CoverageUpload(
        project_id=pid,
        execution_id=_uuid(body["executionId"]) if body.get("executionId") else None,
        format=fmt,
        line_pct=float(summary.get("linePct") or 0),
        branch_pct=float(summary["branchPct"])
        if summary.get("branchPct") is not None
        else None,
        meta_json=json.dumps(summary, ensure_ascii=False),
        file_name=(body.get("fileName") or None),
        uploaded_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ok(
        {
            "id": str(row.id),
            "projectId": str(row.project_id),
            "format": row.format,
            "linePct": row.line_pct,
            "branchPct": row.branch_pct,
            "uploadedAt": row.uploaded_at.isoformat(),
        }
    )


@router.get("/projects/{project_id}/coverage")
def list_coverage(project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(CoverageUpload).filter(
        CoverageUpload.project_id == pid, CoverageUpload.deleted_at.is_(None)
    )
    total = q.count()
    items = (
        q.order_by(CoverageUpload.uploaded_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    return ok(
        page(
            [
                {
                    "id": str(r.id),
                    "format": r.format,
                    "linePct": r.line_pct,
                    "branchPct": r.branch_pct,
                    "fileName": r.file_name,
                    "uploadedAt": r.uploaded_at.isoformat() if r.uploaded_at else None,
                }
                for r in items
            ],
            total,
            page_number,
            size,
        )
    )


@router.post("/projects/{project_id}/reports")
async def create_report(
    project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    body = await request.json()
    title = (body.get("title") or "Report").strip()[:300]
    row = ReportRecord(
        project_id=pid,
        title=title,
        format=(body.get("format") or "html").strip()[:40],
        meta_json=json.dumps(body.get("meta") or {}, ensure_ascii=False),
        created_at_report=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ok({"id": str(row.id), "title": row.title, "format": row.format})


@router.get("/projects/{project_id}/reports")
def list_reports(project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(ReportRecord).filter(
        ReportRecord.project_id == pid, ReportRecord.deleted_at.is_(None)
    )
    total = q.count()
    items = (
        q.order_by(ReportRecord.created_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    return ok(
        page(
            [
                {
                    "id": str(r.id),
                    "title": r.title,
                    "format": r.format,
                    "createdAt": r.created_at.isoformat() if r.created_at else None,
                }
                for r in items
            ],
            total,
            page_number,
            size,
        )
    )
